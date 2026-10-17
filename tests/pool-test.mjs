import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

// Resolved relative to this file so the suite survives a /tmp clean and can
// live anywhere inside the config tree. The config under test is the committed
// fixture plus the package's own injected agent set (see fixtures/config.mjs),
// never a personal opencode.jsonc outside the repo.
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")
const SNAPSHOT = join(HERE, "models-snapshot.json")
const PRESET = join(HERE, "..", "presets", "free-tier.json")
const cfg = shippedConfig()

// presets/free-tier.json is the single source of truth for the pool, so the test reads
// it rather than repeating the models: swapping one is not a test edit.
const SHIPPED = JSON.parse(readFileSync(join(HERE, "..", "presets", "free-tier.json"), "utf8")).slots
const SLOT_MODELS = SHIPPED.map((s) => s.model)
// presets/free-tier.json's weight is the only routing knob, so the tests talk about the
// heaviest slot and the lightest slots rather than a tier name the file no longer
// carries. Which slots those are is the file's business.
const MAX_WEIGHT = Math.max(...SHIPPED.map((s) => s.weight))
const MIN_WEIGHT = Math.min(...SHIPPED.map((s) => s.weight))
const HEAVY_MODELS = SHIPPED.filter((s) => s.weight === MAX_WEIGHT).map((s) => s.model)
const LIGHT_MODELS = SHIPPED.filter((s) => s.weight === MIN_WEIGHT).map((s) => s.model)
// A slot holds at most TWICE its weight (src/lib/pool.ts SLOT_CEILING_FACTOR): the
// weight is its share of the rotation and the ceiling is deliberately larger than that
// share, so a whole rotation can be walked twice before the pool is full. Written out
// here as a literal rather than read off the module, because the doubled ceiling is the
// rule under test, not a value to follow.
const CEILING_FACTOR = 2
const CEILINGS = SHIPPED.map((s) => s.weight * CEILING_FACTOR)
// One rotation of the run: a slot takes one turn per unit of its weight, in
// declaration order, so weights [3,2,1,1] walk 1,1,1,2,2,3,4. Derived from the file, so
// a preset change is not a test edit.
const RUN = SHIPPED.flatMap((slot, i) => Array(slot.weight).fill(i + 1))
const ROTATION = RUN.length
// The summed ceilings are where the weighted phase ends and overflow begins, so the
// depth needed to see both is derived rather than guessed: a slot cannot reach twice
// its weight on its own positions in a single rotation, so the weighted phase is
// exactly two rotations long.
const CAPACITY = ROTATION * CEILING_FACTOR
// How far the burst has to go for the overflow to have levelled the pool: it can only
// ever raise the least loaded slot, so the totals converge on the largest ceiling in
// the pool and are equal from there on -- and stay within one past it.
const LEVELED = SLOT_MODELS.length * MAX_WEIGHT * CEILING_FACTOR

const logs = []
const client = { app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) } }
const pool = await import(join(HERE, "..", "src", "lib", "pool.ts"))
const { agentPoolHooks: AgentPool } = await import(PLUGIN)

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
}
assert(
  pool.SLOT_CEILING_FACTOR === CEILING_FACTOR,
  `src/lib/pool.ts must double a slot's weight (SLOT_CEILING_FACTOR ${CEILING_FACTOR}), got ${pool.SLOT_CEILING_FACTOR}`,
)

const make = async (id, dir) => {
  const hooks = await AgentPool({ client }, { id, dir, modelsFile: PRESET })
  await hooks.config(cfg)
  const spawn = async (callID, requested, sessionID = "s1") => {
    const out = { args: { subagent_type: requested, prompt: "x" } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
    return out.args.subagent_type
  }
  const finish = async (callID, sessionID = "s1") => {
    await hooks["tool.execute.after"]({ tool: "task", sessionID, callID, args: {} }, {})
  }
  const status = async () => (await hooks.tool.pool_status.execute({}, {})).output
  return { hooks, spawn, finish, status }
}

const dir1 = mkdtempSync(join(tmpdir(), "agent-pool-solo-"))
const seq = (calls) => calls.map((c) => c.replace(/^[a-z-]+-/, "")).join(",")

// 1. routing: ORDER FIRST, THEN WEIGHT. The slots are expanded into a weighted
//    round-robin run -- one position per unit of weight, in declaration order -- and
//    each spawn scans that run from a persisted cursor, taking the first slot which is
//    available and still under its ceiling. So the run is walked in order rather than
//    the heaviest slot being drained first, a slot's ceiling is TWICE its weight (so
//    the rotation can be walked twice before any slot is full), and only past the
//    summed ceilings does the overflow spread evenly. Slot numbers, weights and pick
//    order are presets/free-tier.json's business, so what is pinned here is the
//    property, not a literal sequence.
const a = await make("solo", dir1)
const calls = []
// Deep enough to exhaust every ceiling, then overflow, and then overflow far enough
// that the overflow has levelled the totals -- whatever the shipped weights are.
const CONCURRENCY = LEVELED
for (let i = 1; i <= CONCURRENCY; i++) calls.push(await a.spawn(`c${i}`, "explore"))
// A release only means anything on a live claim, and the tests below release claims out
// of the middle of that run, so track which spawns still hold one.
const live = new Set(calls.map((_, i) => `c${i + 1}`))
const releaseCall = async (callID) => {
  await a.finish(callID)
  live.delete(callID)
}
const slotNum = (variant) => Number(/-(\d+)$/.exec(variant)[1])
const numbers = calls.map(slotNum)
assert(
  numbers.every((n) => n >= 1 && n <= SLOT_MODELS.length),
  `every spawn must land on a declared slot, got ${seq(calls)}`,
)
assert(
  new Set(numbers).size === SLOT_MODELS.length,
  `all ${SLOT_MODELS.length} slots must be used under ${CONCURRENCY} concurrent, got ${seq(calls)}`,
)
// inside the summed ceilings the pick is the NEXT TURN of the run and nothing is
// skipped: a slot's ceiling is twice its weight, so a slot cannot fill up on the
// positions it holds in a single rotation, and the weighted phase is the run walked
// twice from a cold start
const countsByModel = (ns) => {
  const m = new Map()
  for (const n of ns) m.set(SLOT_MODELS[n - 1], (m.get(SLOT_MODELS[n - 1]) ?? 0) + 1)
  return m
}
for (let i = 0; i < CAPACITY; i++) {
  assert(
    numbers[i] === RUN[i % ROTATION],
    `spawn ${i + 1} must take turn ${i % ROTATION} of the run (slot ${RUN[i % ROTATION]}), got slot ${numbers[i]} from ${seq(calls)}`,
  )
}
// the ceiling binds every slot to twice its weight, and the ONLY way past it is the
// overflow -- which is not reached until EVERY slot stands at or over its own ceiling
for (let i = 1; i <= CONCURRENCY; i++) {
  const tally = countsByModel(numbers.slice(0, i))
  const prefixLoads = SHIPPED.map((slot) => tally.get(slot.model) ?? 0)
  const above = prefixLoads.map((l, j) => l > CEILINGS[j])
  const full = prefixLoads.map((l, j) => l >= CEILINGS[j])
  assert(
    !above.some(Boolean) || full.every(Boolean),
    `a slot may pass its ceiling of ${CEILING_FACTOR}x its weight only once EVERY slot is at one, after spawn ${i}: ${SHIPPED.map((slot, j) => `${slot.model}=${prefixLoads[j]}/${CEILINGS[j]}`).join(" ")}`,
  )
}
// and the heaviest slot really does hold every position at the top of the run before
// slot 2 gets one
const heavyLead = numbers.slice(0, MAX_WEIGHT)
assert(
  heavyLead.every((n) => HEAVY_MODELS.includes(SLOT_MODELS[n - 1])),
  `the first ${MAX_WEIGHT} spawns must all be the heaviest slot, got ${seq(calls)}`,
)
// collecting twice its weight takes a whole rotation of turns, so a slot can only
// reach its ceiling on the second pass -- and then it stands at exactly that
for (const [j, slot] of SHIPPED.entries()) {
  assert(
    (countsByModel(numbers.slice(0, CAPACITY)).get(slot.model) ?? 0) === CEILINGS[j],
    `${slot.model} must reach exactly its ceiling of ${CEILINGS[j]} (weight ${slot.weight}) inside the weighted phase, got ${seq(calls)}`,
  )
}
// past every ceiling the overflow equalises instead of piling on slot 1, so the totals
// converge even though the ceilings do not
const finalTally = countsByModel(numbers)
const finalLoads = SLOT_MODELS.map((m) => finalTally.get(m) ?? 0)
assert(
  Math.max(...finalLoads) - Math.min(...finalLoads) <= 1,
  `overflow must equalise the totals once every slot is at its ceiling, got ${finalLoads.join("/")} from ${seq(calls)}`,
)
assert(
  finalLoads.reduce((x, y) => x + y, 0) === CONCURRENCY,
  `every spawn must be accounted for, got ${seq(calls)}`,
)

// 2. releasing a claim on a slot hands routing straight back to it: it drops under
//    its ceiling again, and the cursor is still pointing at that slot's next position
//    in the run, so the spawn that frees the capacity is the one that gets it back.
//    The slot is read off the run rather than assumed to be a particular number.
const heaviestSlot = slotNum(calls[0])
const heaviestCall = calls.map((v, i) => [slotNum(v), `c${i + 1}`]).filter(([n, id]) => n === heaviestSlot && live.has(id)).pop()[1]
await releaseCall(heaviestCall)
const afterRelease = slotNum(await a.spawn("r1", "explore"))
assert(
  afterRelease === heaviestSlot,
  `releasing a claim on slot ${heaviestSlot} (weight ${SHIPPED[heaviestSlot - 1].weight}) must hand routing back to it, got slot ${afterRelease}`,
)

// 3. releasing the busiest claim hands that slot the next spawn: the freed position in
//    the run is the next one the cursor reaches. Read the busiest slot off pool_status
//    rather than assuming which slot the run put on top.
const loads = async () => {
  const m = new Map()
  for (const line of (await a.status()).split("\n")) {
    const hit = SLOT_MODELS.find((model) => line.includes(model))
    if (hit) m.set(hit, Number(/load=(\d+)/.exec(line)[1]))
  }
  return m
}
const byLoad = await loads()
const busiestSlot = SLOT_MODELS.findIndex((model) => byLoad.get(model) === Math.max(...byLoad.values())) + 1
const busiestCall = calls
  .map((v, i) => [slotNum(v), `c${i + 1}`])
  .filter(([n, id]) => n === busiestSlot && live.has(id))
  .pop()[1]
await releaseCall(busiestCall)
const afterFree = slotNum(await a.spawn("r2", "explore"))
assert(
  afterFree === busiestSlot,
  `the slot whose claim was released should be refilled first, got slot ${afterFree} instead of the freed ${busiestSlot}`,
)
const back = [await a.spawn("r3", "explore"), await a.spawn("r4", "explore"), await a.spawn("r5", "explore")]
assert(
  back.every((v) => new RegExp(`^explore-[1-${SLOT_MODELS.length}]$`).test(v)),
  `released slots must still route, got ${back.join(",")}`,
)
for (const v of ["r3", "r4", "r5"]) live.add(v)

// 4. pool_status reports global load, models, weights, per-process breakdown
const statusOut = await a.status()
for (const model of SLOT_MODELS) assert(statusOut.includes(model), `status should list ${model}`)
for (const [j, slot] of SHIPPED.entries()) {
  assert(
    new RegExp(`slot ${j + 1} w${slot.weight}\\b.*load=\\d+/${CEILINGS[j]}\\b`).test(statusOut),
    `status should show slot weight and the doubled ceiling for ${slot.model}`,
  )
}
assert(/across 1 process\(es\)/.test(statusOut), "solo process should report one process")

// 5. cross-process sharing: both processes MUST share one claim dir
const dir3 = mkdtempSync(join(tmpdir(), "agent-pool-share-"))
const x = await make("proc-x", dir3)
const y = await make("proc-y", dir3)
// Enough spawns to walk every slot's positions in the run -- one full rotation, each
// heavy slot's whole share -- so the first process reaches every slot before the second
// one starts, and the two together stand the pool at exactly its summed ceilings. That
// is the depth this wants: a deeper burst would say LESS, because past the summed
// ceilings the overflow levels the loads and a heavy slot stops out-holding a light
// one. Scales with the slot count: a fixed literal only covered the four-slot pool.
const xCalls = []
for (let i = 1; i <= ROTATION; i++) xCalls.push(await x.spawn(`x${i}`, "explore"))
const xNums = xCalls.map(slotNum)
assert(
  new Set(xNums).size === SLOT_MODELS.length,
  `first process should reach all ${SLOT_MODELS.length} slots, got ${seq(xCalls)}`,
)
const yCalls = []
for (let i = 1; i <= ROTATION; i++) yCalls.push(await y.spawn(`y${i}`, "explore"))
// Both processes route over one shared run, each advancing the cursor the other one
// reads and seeing the other's claims in the shared dir. Which slot y starts on
// depends on x's residual load, so the load check below is what proves sharing; here
// only that every pick is a declared slot.
assert(
  [...xCalls, ...yCalls].every((c) => /^explore-\d+$/.test(c)),
  `routing must stay in the pool, got ${[...xCalls, ...yCalls].join(",")}`,
)
const crossStatus = await x.status()
const loadOf = (model) => {
  const line = crossStatus.split("\n").find((l) => l.includes(model))
  return line ? Number(/load=(\d+)/.exec(line)[1]) : NaN
}
// The spawns are spread over the weights, so the invariants are what hold for any
// slot count: every claim is visible to both processes, slots of equal weight stay
// load-balanced among themselves, and the heaviest slots hold more than the
// lightest. Which slot is 1 is presets/free-tier.json's business.
const loadList = SLOT_MODELS.map(loadOf)

const report = SHIPPED.map((s, i) => `${s.model}(w${s.weight})=${loadList[i]}`).join(" ")
const heavyLoads = HEAVY_MODELS.map(loadOf)
const lightLoads = LIGHT_MODELS.map(loadOf)
assert(
  loadList.reduce((a, b) => a + b, 0) === 2 * ROTATION,
  `all ${2 * ROTATION} claims must be shared, got ${report}`,
)
// Slots of the same weight hold the same number of positions in the run, so they take
// the same number of turns: loads stay within one of each other, equal when the group
// is an even size, off by one otherwise.
const spread = (xs) => Math.max(...xs) - Math.min(...xs)
assert(spread(heavyLoads) <= 1, `the heaviest slots must stay load-balanced, got ${report}`)
assert(spread(lightLoads) <= 1, `the lightest slots must stay load-balanced, got ${report}`)
assert(
  Math.min(...heavyLoads) > Math.max(...lightLoads),
  `the heaviest slots must hold more than the lightest, got ${report}`,
)
assert(/across 2 process\(es\)/.test(crossStatus), "status should count both processes")
assert(
  new RegExp(`proc-x \\(this process\\): ${ROTATION} claim\\(s\\)`).test(crossStatus) &&
    new RegExp(`proc-y: ${ROTATION} claim\\(s\\)`).test(crossStatus),
  "status should break load down per process",
)
await x.finish("x1")
const afterOneRelease = ROTATION - 1
assert(
  new RegExp(`proc-x \\(this process\\): ${afterOneRelease} claim\\(s\\)`).test(await x.status()),
  "release in one process must be visible to itself",
)
assert(
  new RegExp(`proc-x: ${afterOneRelease} claim\\(s\\)`).test(await y.status()),
  "release in one process must be visible to the other process",
)
assert(
  new RegExp(`proc-y \\(this process\\): ${ROTATION} claim\\(s\\)`).test(await y.status()),
  "a peer release must not disturb this process's own count",
)

// 6. degraded mode: unusable claim dir must not break routing
const blocked = join(dir1, "not-a-dir")
writeFileSync(blocked, "x")
const c = await make("degraded", blocked)
const degradedPick = await c.spawn("d1", "explore")
assert(/^explore-\d+$/.test(degradedPick), `degraded mode should still route, got ${degradedPick}`)
assert(logs.some((l) => l.startsWith("warn") && l.includes("claim dir")), "degraded mode should warn once")

// 7. stale claim files and orphan tmp files are pruned
const stale = join(dir3, "claims.99999.json")
const orphan = join(dir3, "claims.99998.json.tmp")
writeFileSync(stale, JSON.stringify({ k: { v: "explore-1", t: Date.now() } }))
writeFileSync(orphan, "{}")
const old = Date.now() / 1000 - 3600
utimesSync(stale, old, old)
utimesSync(orphan, old, old)
await x.spawn("x2", "explore")
assert(!existsSync(stale), "stale claim file should be pruned")
assert(!existsSync(orphan), "orphan tmp file should be pruned")

// 8. TTL: claims older than 10 min stop counting
const realNow = Date.now
Date.now = () => realNow() + 11 * 60 * 1000
const afterTtl = await a.spawn("t1", "explore")
Date.now = realNow
// Everything has aged out, so the pool is idle again and the run resumes from where
// the cursor was left, which for this preset is the heaviest slot
assert(
  HEAVY_MODELS.includes(SLOT_MODELS[slotNum(afterTtl) - 1]),
  `TTL should empty the pool, got ${afterTtl}`,
)

// 9. untouched: non-task tool, non-pool spawn, malformed args
const other = { args: { filePath: "/etc" } }
await a.hooks["tool.execute.before"]({ tool: "read", sessionID: "s1", callID: "x1" }, other)
assert(other.args.filePath === "/etc", "non-task tool must not be touched")
assert((await a.spawn("x2", "build")) === "build", "non-pool spawn must not be rewritten")
await a.hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "x5" }, {})
await a.finish("nonexistent")

// 9b. a slot variant named by hand is REFUSED, not counted and not rewritten.
//     Naming one is how a caller reaches a provider without asking the pool, and
//     counting it was never enough: it evades the ceiling, which is the number
//     that bounds the damage. The refusal must also escape the routing catch --
//     swallowed into "spawn unchanged" it would admit the spawn it forbids.
let refused = null
try {
  await a.spawn("x3", "explore-2")
} catch (error) {
  refused = String(error?.message ?? error)
}
assert(refused !== null, "naming a slot variant must be refused outright")
assert(refused.includes('Spawn "explore"'), `the refusal must name the bare base to use, got: ${refused}`)
assert(
  !/\/(usr|etc|bin)/.test(refused),
  `the refusal must be a message, not a path leak: ${refused}`,
)

// 10. config invariants: every pooled base has one hidden variant per slot in
//     presets/free-tier.json, each running that slot's model -- and none of them
//     hard-codes one, so the file really is the only place a pool model lives
const rawCfg = shippedConfig()
const BASES = ["explore", "implement", "context"]
for (const base of BASES) {
  SLOT_MODELS.forEach((_, i) => {
    const v = `${base}-${i + 1}`
    assert(rawCfg.agent[v] !== undefined, `${v} must be declared in the injected agent set`)
    assert(rawCfg.agent[v].model === undefined, `${v} must not hard-code a model; presets/free-tier.json injects it`)
  })
}
for (const base of BASES) {
  assert(cfg.agent[base], `base agent ${base} must exist`)
  SLOT_MODELS.forEach((model, i) => {
    const v = `${base}-${i + 1}`
    assert(cfg.agent[v], `${v} must exist`)
    assert(cfg.agent[v].model === model, `${v} should run ${model}, got ${cfg.agent[v].model}`)
    assert(cfg.agent[v].hidden === true, `${v} should stay hidden`)
    assert(cfg.agent[v].prompt === cfg.agent[base].prompt, `${v} should reuse the ${base} prompt`)
  })
}
// slot N means the same model for every base, which is what makes load shared
for (let i = 0; i < SLOT_MODELS.length; i++) {
  const models = BASES.map((b) => cfg.agent[`${b}-${i + 1}`].model)
  assert(new Set(models).size === 1, `slot ${i + 1} must map to one model across bases, got ${models}`)
}
for (const model of SLOT_MODELS) {
  const { provider, id } = pool.splitModel(model)
  assert(cfg.provider[provider].whitelist.includes(id), `${model} must be whitelisted on ${provider}`)
}
for (const [name, def] of Object.entries(cfg.agent)) {
  if (!def.model) continue
  const { provider, id } = pool.splitModel(def.model)
  assert(cfg.provider[provider]?.whitelist.includes(id), `agent ${name} runs unwhitelisted ${def.model}`)
}
// opencode compiles a permission pattern to an anchored regex (* -> .*) and lets
// the longest match win, so "explore*" covers the base and every variant.
// What must hold is not that each name is listed, but that a base and its variants
// resolve the same way -- otherwise the pool routes a spawn to a variant the
// caller is not allowed to run.
const compilePermission = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s")
const taskAllows = (task, target) => {
  let best
  for (const [pattern, action] of Object.entries(task)) {
    if (!compilePermission(pattern).test(target)) continue
    if (!best || pattern.length > best.pattern.length) best = { pattern, action }
  }
  return best?.action === "allow"
}
for (const [name, def] of Object.entries(cfg.agent)) {
  const task = def.permission?.task
  if (!task) continue
  for (const base of BASES) {
    for (let i = 1; i <= SLOT_MODELS.length; i++) {
      assert(
        taskAllows(task, `${base}-${i}`) === taskAllows(task, base),
        `${name}: task rule for ${base} must cover ${base}-${i} the same way`,
      )
    }
  }
}

// 10b. the one-writer agent must have no path to code execution: edit/write are
//      denied and `mkdir -p *` is denied, so an allowed `node -e *` would undo
//      every one of those rules in a single call.
const INTERPRETERS = new Set(["node", "python", "python3", "sh", "bash", "zsh", "perl", "ruby", "php", "env"])
for (const [name, def] of Object.entries(rawCfg.agent)) {
  if (!name.startsWith("context")) continue
  for (const [pattern, action] of Object.entries(def.permission?.bash ?? {})) {
    if (action !== "allow" || pattern === "*") continue
    assert(!INTERPRETERS.has(pattern.split(/\s+/)[0]), `${name} may run \`${pattern}\`, which is arbitrary code execution`)
  }
}

// 10c. only the built-in the plugin does NOT own stays disabled. The plugin's
//      bases are named explore/implement/context, so those built-in keys must
//      NOT be disabled: merge-without-clobber would keep the disable entry and
//      the real base would never be injected. "general" still shadows the pool
//      (always spawnable, full-price), so it stays disabled.
assert(rawCfg.agent["general"]?.disable === true, "general must stay disabled in the fixture config")
for (const base of ["explore", "implement", "context"]) {
  assert(rawCfg.agent[base]?.disable !== true, `${base} must not be disabled: the plugin owns that name and would otherwise never inject its base`)
}

// 11. every pool model is free (0/0 cost) per the vendored models.dev snapshot.
//     Refreshing it is part of changing the pool: the snapshot is the record of
//     what each model cost when it was picked, and a model missing from it has not
//     been checked at all. Regenerate with the helper, which reads the current
//     presets/free-tier.json so nothing has to be listed twice:
//       node tests/refresh-models-snapshot.mjs
assert(existsSync(SNAPSHOT), `missing ${SNAPSHOT}; run: node tests/refresh-models-snapshot.mjs`)
const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"))
for (const model of SLOT_MODELS) {
  const entry = snapshot.models[model]
  assert(entry, `snapshot has no ${model}; run: node tests/refresh-models-snapshot.mjs`)
  assert(entry.cost_input === 0 && entry.cost_output === 0, `${model} must be free, snapshot says ${entry.cost_input}/${entry.cost_output}`)
  assert(entry.tool_call === true, `${model} must support tool calls to be usable as an explore agent`)
}

// 12. a claim that keeps working past the TTL must still be PUBLISHED. Liveness is
//     the heartbeat everywhere else -- pruneOwn counts the claim by it, readSiblings
//     accepts it by it -- so a publisher filtering on the spawn time wrote a live
//     claim out of its own file and every other process then handed the slot out
//     again while the task still held it. The other half of block 8: a claim with no
//     heartbeat ages out; a claim with a fresh one does not.
const dir4 = mkdtempSync(join(tmpdir(), "agent-pool-hb-"))
const p = await make("proc-heartbeat", dir4)
const observer = await make("proc-observer", dir4)
const liveSlot = slotNum(await p.spawn("hb1", "explore"))
const liveModel = SLOT_MODELS[liveSlot - 1]
// The child session the claim runs in: bound the way opencode binds it, then kept
// alive by message traffic, which is the only proof the task has not been abandoned.
await p.hooks.event({ event: { type: "session.created", properties: { info: { id: "child-hb", parentID: "s1" } } } })
const wallClock = Date.now
Date.now = () => wallClock() + 11 * 60 * 1000
await p.hooks.event({ event: { type: "message.part.updated", properties: { part: { sessionID: "child-hb", type: "text" } } } })
const fromPeer = await observer.status()
Date.now = wallClock
const peerLine = fromPeer.split("\n").find((l) => l.includes(liveModel))
assert(
  new RegExp(`load=1/${CEILINGS[liveSlot - 1]}\\b`).test(peerLine ?? ""),
  `a claim past the TTL whose heartbeat is fresh must still count in another process (1 of the slot's ceiling of ${CEILINGS[liveSlot - 1]}), got:\n${fromPeer}`,
)
assert(
  new RegExp(`proc-heartbeat: 1 claim\\(s\\)`).test(fromPeer),
  `the live claim must stay in the shared file after it passes the TTL, got:\n${fromPeer}`,
)

console.log(statusOut)

// The routing log is read by the agent it routes. It must therefore never print a
// slot variant's NAME: that hands the model a valid-looking agent name in the
// exact place it decides what to spawn, and the refusals that followed showed it
// copying them straight back (implement-4 23x, explore-2 12x -- one per routed
// spawn). The slot index and the model carry the same diagnostic value.
{
  const routed = logs.filter((l) => l.includes("routed "))
  assert(routed.length > 0, "the burst must have produced routing lines to check")
  for (const line of routed) {
    assert(
      !/routed (explore|implement|context)-\d/.test(line),
      `a routing line must not name a slot variant, got: ${line}`,
    )
  }
  assert(
    routed.some((l) => /routed explore to slot \d+ on \S+/.test(l)),
    `a routing line must still name the slot and the model, got: ${routed[0]}`,
  )
}

rmSync(dir1, { recursive: true, force: true })
rmSync(dir3, { recursive: true, force: true })
rmSync(dir4, { recursive: true, force: true })
console.log("\nALL CHECKS PASSED")