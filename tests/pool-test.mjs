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
// The summed ceilings are where the weighted phase ends and overflow begins, so the
// depth needed to see both is derived rather than guessed.
const CAPACITY = SHIPPED.reduce((sum, s) => sum + s.weight, 0)

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

// 1. routing: priority IS the weight, and it is a soft ceiling. The heaviest slot
//    fills to its own weight before the next slot sees any work, slots fill in weight
//    order, and only past the summed ceilings does the overflow spread evenly. Slot
//    numbers, weights and pick order are presets/free-tier.json's business, so what is
//    pinned here is the property, not a literal sequence.
const a = await make("solo", dir1)
const calls = []
// Deep enough to exhaust every ceiling and then overflow, whatever the shipped
// weights are.
const CONCURRENCY = CAPACITY + SLOT_MODELS.length
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
// within the weighted phase, no slot is used before every heavier slot is at its own
// ceiling: the heaviest slot gets its sessions entirely to itself first
const countsByModel = (ns) => {
  const m = new Map()
  for (const n of ns) m.set(SLOT_MODELS[n - 1], (m.get(SLOT_MODELS[n - 1]) ?? 0) + 1)
  return m
}
for (let i = 0; i < CAPACITY; i++) {
  const sofar = countsByModel(numbers.slice(0, i))
  const topWeight = Math.max(...SHIPPED.filter((x) => (sofar.get(x.model) ?? 0) < x.weight).map((x) => x.weight))
  assert(
    SHIPPED[numbers[i] - 1].weight === topWeight,
    `spawn ${i + 1} must go to the heaviest slot with room (weight ${topWeight}), got ${SLOT_MODELS[numbers[i] - 1]}`,
  )
}
// and the heaviest slot really does run alone to its ceiling before slot 2 starts
const heavyLead = numbers.slice(0, MAX_WEIGHT)
assert(
  heavyLead.every((n) => HEAVY_MODELS.includes(SLOT_MODELS[n - 1])),
  `the first ${MAX_WEIGHT} spawns must all be the heaviest slot, got ${seq(calls)}`,
)
assert(
  (countsByModel(heavyLead).get(HEAVY_MODELS[0]) ?? 0) === MAX_WEIGHT,
  `the heaviest slot must reach exactly its ceiling of ${MAX_WEIGHT}, got ${seq(calls)}`,
)
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

// 2. releasing a claim on the heaviest slot hands routing straight back to it: it drops
//    under its ceiling again and, being the heaviest, outranks everything else. So the
//    pool refills what it freed rather than carrying on down the priority order. The
//    slot is read off the run rather than assumed to be a particular number.
const heaviestSlot = slotNum(calls[0])
const heaviestCall = calls.map((v, i) => [slotNum(v), `c${i + 1}`]).filter(([n, id]) => n === heaviestSlot && live.has(id)).pop()[1]
await releaseCall(heaviestCall)
const afterRelease = slotNum(await a.spawn("r1", "explore"))
assert(
  afterRelease === heaviestSlot,
  `releasing a claim on slot ${heaviestSlot} (weight ${SHIPPED[heaviestSlot - 1].weight}) must hand routing back to it, got slot ${afterRelease}`,
)

// 3. releasing the busiest claim hands that slot the next spawn: the pool refills
//    what it freed rather than opening anything new. Read the busiest slot off
//    pool_status rather than assuming which number the weights put on top.
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
for (const slot of SHIPPED) {
  assert(new RegExp(`slot ${SLOT_MODELS.indexOf(slot.model) + 1} w${slot.weight}\\b`).test(statusOut), `status should show slot weight for ${slot.model}`)
}
assert(/across 1 process\(es\)/.test(statusOut), "solo process should report one process")

// 5. cross-process sharing: both processes MUST share one claim dir
const dir3 = mkdtempSync(join(tmpdir(), "agent-pool-share-"))
const x = await make("proc-x", dir3)
const y = await make("proc-y", dir3)
// Enough spawns to fill each heavy slot twice and then walk down to the light
// ones, so the first process reaches every slot before the second one starts.
// Scales with the slot count: a fixed literal only covered the four-slot pool.
const xCalls = []
for (let i = 1; i <= CONCURRENCY; i++) xCalls.push(await x.spawn(`x${i}`, "explore"))
const xNums = xCalls.map(slotNum)
assert(
  new Set(xNums).size === SLOT_MODELS.length,
  `first process should reach all ${SLOT_MODELS.length} slots, got ${seq(xCalls)}`,
)
const yCalls = []
for (let i = 1; i <= CONCURRENCY; i++) yCalls.push(await y.spawn(`y${i}`, "explore"))
// Both processes route over one shared cycle. Which slot y starts on depends on
// x's residual load, so the load check below is what proves sharing; here only
// that every pick is a declared slot.
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
  loadList.reduce((a, b) => a + b, 0) === 2 * CONCURRENCY,
  `all ${2 * CONCURRENCY} claims must be shared, got ${report}`,
)
// Slots of the same weight have identical ratios, so routing
// always takes the smallest: loads stay within one of each other, equal when the
// group is an even size, off by one otherwise.
const spread = (xs) => Math.max(...xs) - Math.min(...xs)
assert(spread(heavyLoads) <= 1, `the heaviest slots must stay load-balanced, got ${report}`)
assert(spread(lightLoads) <= 1, `the lightest slots must stay load-balanced, got ${report}`)
assert(
  Math.min(...heavyLoads) > Math.max(...lightLoads),
  `the heaviest slots must hold more than the lightest, got ${report}`,
)
assert(/across 2 process\(es\)/.test(crossStatus), "status should count both processes")
assert(
  new RegExp(`proc-x \\(this process\\): ${CONCURRENCY} claim\\(s\\)`).test(crossStatus) &&
    new RegExp(`proc-y: ${CONCURRENCY} claim\\(s\\)`).test(crossStatus),
  "status should break load down per process",
)
await x.finish("x1")
const afterOneRelease = CONCURRENCY - 1
assert(
  new RegExp(`proc-x \\(this process\\): ${afterOneRelease} claim\\(s\\)`).test(await x.status()),
  "release in one process must be visible to itself",
)
assert(
  new RegExp(`proc-x: ${afterOneRelease} claim\\(s\\)`).test(await y.status()),
  "release in one process must be visible to the other process",
)
assert(
  new RegExp(`proc-y \\(this process\\): ${CONCURRENCY} claim\\(s\\)`).test(await y.status()),
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
// Everything has aged out, so the pool is idle again and hands out a heavy slot
assert(
  HEAVY_MODELS.includes(SLOT_MODELS[slotNum(afterTtl) - 1]),
  `TTL should empty the pool, got ${afterTtl}`,
)

// 9. untouched: non-task tool, non-pool spawn, direct variant, malformed args
const other = { args: { filePath: "/etc" } }
await a.hooks["tool.execute.before"]({ tool: "read", sessionID: "s1", callID: "x1" }, other)
assert(other.args.filePath === "/etc", "non-task tool must not be touched")
assert((await a.spawn("x2", "build")) === "build", "non-pool spawn must not be rewritten")
assert((await a.spawn("x3", "explore-2")) === "explore-2", "direct variant must not be rewritten")
await a.hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "x5" }, {})
await a.finish("nonexistent")

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

console.log(statusOut)
rmSync(dir1, { recursive: true, force: true })
rmSync(dir3, { recursive: true, force: true })
console.log("\nALL CHECKS PASSED")