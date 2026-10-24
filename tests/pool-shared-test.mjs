// Verifies the pool is genuinely shared across agent types: explore,
// implement and context compete for the same four models, so a
// busy agent type cannot protect its own capacity. Also checks that the
// context-autoupdate plugin borrows a slot correctly.
// Run: node tests/pool-shared-test.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PRESET = join(HERE, "..", "presets", "free-tier.json")
const POOL = join(HERE, "..", "src", "lib", "pool.ts")
const cfg = shippedConfig()

// presets/free-tier.json owns the pool's models; the tests below refer to slot N's
// model, so swapping a model is not a test edit.
const SHIPPED = JSON.parse(readFileSync(join(HERE, "..", "presets", "free-tier.json"), "utf8")).slots
const SLOT_MODELS = SHIPPED.map((s) => s.model)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

const made = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "shared-"))
  made.push(d)
  return d
}

const logs = []
const client = { app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) } }
const { agentPoolHooks: AgentPool } = await import(join(HERE, "..", "src", "plugins", "agent-pool.ts"))
const pool = await import(POOL)

const mk = async (id, dir) => {
  const hooks = await AgentPool({ client, serverUrl: undefined }, { id, dir, modelsFile: PRESET })
  await hooks.config(cfg)
  return {
    hooks,
    spawn: async (callID, requested, sessionID = "s1") => {
      const out = { args: { subagent_type: requested, prompt: "x" } }
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
      return out.args.subagent_type
    },
    status: async () => (await hooks.tool.pool_status.execute({}, {})).output,
  }
}

const BASES = ["explore", "implement", "context"]
// A spawn the pool could not rewrite (because the injected config declares no variant
// for that slot) comes back unrouted, so return -1 rather than throwing.
const slotOf = (variant) => (variant === null || variant === undefined ? -1 : Number(/-(\d+)$/.exec(variant)?.[1] ?? -1))
// Slot numbers per weight, so these checks hold whatever weights and order
// presets/free-tier.json lists its slots in. Routing fills in declaration order;
// weight is each slot's active-session budget for one pass, so the heavy/light
// groups describe capacity and overflow rather than preference.
const MAX_WEIGHT = Math.max(...SHIPPED.map((s) => s.weight))
const slotsOfWeight = (weight) => SHIPPED.flatMap((s, i) => (s.weight === weight ? [i + 1] : []))
const HEAVY_SLOTS = slotsOfWeight(MAX_WEIGHT)
const LIGHT_SLOTS = slotsOfWeight(Math.min(...SHIPPED.map((s) => s.weight)))
const ALL_SLOTS = SHIPPED.map((_, i) => i + 1)
const firstOf = (xs) => xs[0]
// The summed absolute caps are where the two passes end and the overflow begins.
const CAPACITY = SHIPPED.reduce((sum, s) => sum + 2 * s.weight, 0)

// 1. slot N is the same model for every base, so the pool is genuinely shared
{
  for (const i of ALL_SLOTS) {
    // A slot with no declared variant in the injected config is a config gap, not a
    // sharing failure: report it instead of dereferencing undefined.
    const declared = BASES.map((b) => cfg.agent[`${b}-${i}`])
    const missing = BASES.filter((b) => !cfg.agent[`${b}-${i}`])
    if (missing.length > 0) {
      // this assert only records a failure and continues, so the body must not
      // run on the missing variants
      assert(false, `slot ${i} has no variant in the injected config for ${missing.join(",")}; add them or drop the slot from presets/free-tier.json`)
      continue
    }
    const models = declared.map((d) => d.model)
    assert(new Set(models).size === 1, `slot ${i} must be one model across bases, got ${models}`)
  }
}

// 2. alternating base types share one ordered fill rather than each taking a slot
{
  const t = await mk("shared-1", scratch())
  const picks = []
  for (let i = 0; i < 9; i++) {
    const base = BASES[i % BASES.length]
    picks.push(slotOf(await t.spawn(`c${i}`, base)))
  }
  // The claim is that base type does not matter, so the reference is the same
  // number of spawns from one base type in a fresh pool. Comparing against a run
  // instead of a literal sequence keeps this independent of both the slot
  // numbering and the weights in presets/free-tier.json.
  const solo = await mk("shared-1-solo", scratch())
  const soloPicks = []
  for (let i = 0; i < picks.length; i++) soloPicks.push(slotOf(await solo.spawn(`s${i}`, BASES[0])))
  assert(
    picks.join(",") === soloPicks.join(","),
    `mixed base types must follow the same ordered fill, got ${picks.join(",")}, want ${soloPicks.join(",")}`,
  )
  // An idle pool fills the first declared slot to its weight before moving on,
  // so the leading picks are on that slot while it is below budget.
  const first = firstOf(ALL_SLOTS)
  assert(picks[0] === first, `an idle pool must start on the first declared slot, got ${picks[0]}`)
  assert(
    picks[1] === (SHIPPED[0].weight > 1 ? first : ALL_SLOTS[1]),
    `ordered fill must keep filling the first slot until its weight, got ${picks.slice(0, 2).join(",")}`,
  )
  assert(new Set(picks).size === ALL_SLOTS.length, "every slot must be used when base types alternate")
}

// 3. load from one base displaces the other: a saturated explore pushes
//    implement onto the same shared slots instead of its own
{
  const t = await mk("shared-2", scratch())
  for (let i = 0; i < CAPACITY; i++) await t.spawn(`x${i}`, "explore") // deep enough to exhaust every absolute cap
  const afterExplore = slotOf(await t.spawn("x4", "implement"))
  assert(
    afterExplore === firstOf(LIGHT_SLOTS),
    `implement must land on the least-loaded slot, got ${afterExplore}`,
  )
  assert(!HEAVY_SLOTS.includes(afterExplore), `implement must not be handed a slot with more load`)
}

// 4. pool_status attributes load per model and names the agent types using it
{
  const t = await mk("shared-3", scratch())
  await t.spawn("s1", "explore")
  await t.spawn("s2", "implement")
  await t.spawn("s3", "context")
  const status = await t.status()
  assert(/explorex1/.test(status), `status should attribute explore load, got:\n${status}`)
  assert(/implementx1/.test(status), `status should attribute implement load, got:\n${status}`)
  assert(status.includes(SLOT_MODELS[0]), "status should name the model")
  assert(/bases: explore, implement, context/.test(status), "status should list the pooled bases")
}

// 5. context-autoupdate-style acquisition: borrow a slot, claim it, then release
{
  const dir = scratch()
  const state = pool.state({ id: "borrow", dir, modelsFile: PRESET })
  pool.init(state, () => {})
  const snap = pool.snapshot(state)
  const slot = pool.pickSlot(state, snap)
  // an idle pool starts on the first declared slot
  assert(slot.index === ALL_SLOTS[0], `an idle pool should hand out the first declared slot, got ${slot.index}`)
  const agent = pool.agentFor("context", slot.index)
  assert(agent === `context-${slot.index}`, `borrowed agent name wrong: ${agent}`)
  assert(cfg.agent[agent] !== undefined, `${agent} must exist in config`)
  const key = pool.claimKey("ses_borrow", "context-autoupdate")
  pool.acquire(state, "context", slot, "ses_borrow", key, "ses_borrow")
  let busy = pool.snapshot(state)
  assert(busy.counts.get(slot.model) === 1, "the borrowed slot must show as loaded")
  assert(busy.own.get(key).g === "ses_borrow", "the claim must target the working session for the reaper")
  // Pass 1 keeps the first declared slot until it reaches its weight, so a
  // second borrow stays on it while it is still below budget; only after the
  // budget is reached does the next declared slot take over.
  const slot2 = pool.pickSlot(state, pool.snapshot(state))
  const secondExpected = SHIPPED[0].weight > 1 ? slot.index : ALL_SLOTS[1]
  assert(slot2.index === secondExpected, `second borrow should follow the ordered fill, got ${slot2.index}, want ${secondExpected}`)
  pool.release(state, key)
  busy = pool.snapshot(state)
  assert(busy.counts.get(slot.model) === undefined, "release must clear the borrowed slot")
}

// 5b. cross-process: a sibling's live claim is load, so it decides the next slot.
//     Releasing that claim reopens its slot on the next pick.
{
  const dir = scratch()
  const state = pool.state({
    id: "cross-process",
    dir,
    models: {
      slots: [
        { model: "fixture/cross-a", weight: 1 },
        { model: "fixture/cross-b", weight: 1 },
      ],
    },
  })
  pool.init(state, () => {})
  const sibling = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"])
  const now = Date.now()
  const claim = { v: "explore", k: 1, m: "fixture/cross-a", t: now, hb: now, s: "ses_sibling" }
  writeFileSync(join(dir, `claims.${sibling.pid}.json`), JSON.stringify({ "sibling:call": claim }))
  // The first slot is at its weight, so pass 1 moves to the next declared slot.
  const next = pool.pickSlot(state, pool.snapshot(state))
  assert(next.model === "fixture/cross-b", `a live sibling claim must decide the next slot, got ${next.model}`)
  // The sibling releases its claim: pass 1 reopens the first slot at once.
  writeFileSync(join(dir, `claims.${sibling.pid}.json`), "{}")
  const reopened = pool.pickSlot(state, pool.snapshot(state))
  assert(reopened.model === "fixture/cross-a", `a released sibling claim must reopen its slot, got ${reopened.model}`)
  sibling.kill()
}

// 6. a cooled model is skipped by every base type, not just explore
{
  const t = await mk("shared-4", scratch())
  // cool the first slot's model through the shared lib for this instance's dir
  const cooled = SLOT_MODELS[0]
  const state = pool.state({ id: "shared-4", dir: made[made.length - 1], modelsFile: PRESET })
  pool.recordStrike(state, cooled, "rate-limit", 60_000)
  const cooledSlot = SLOT_MODELS.indexOf(cooled) + 1
  const picks = []
  for (let i = 0; i < 6; i++) picks.push(slotOf(await t.spawn(`y${i}`, BASES[i % BASES.length])))
  assert(!picks.includes(cooledSlot), `no base type may use a cooled model, got ${picks.join(",")}`)
  assert(/COOLING/.test(await t.status()), "status should report the cooling model")
}

// 7. isAvailable: the catalog gates a model ONLY when it reports a retirement
//    (any status other than active/unknown); an absent entry is the normal state
//    while no /api/model answer has arrived and must not gate anything. A live
//    cooldown always wins, in both directions.
{
  const state = pool.state({ id: "avail", dir: scratch(), modelsFile: PRESET })
  pool.init(state, () => {})
  const none = new Map()
  const absent = "omniroute/not-in-catalog"
  assert(pool.isAvailable(state, absent, none) === true, "a model absent from the catalog must be available")
  const matrix = [
    ["openrouter/status-active", "active", true],
    ["openrouter/status-unknown", "unknown", true],
    ["openrouter/status-deprecated", "deprecated", false],
    ["openrouter/status-disabled", "disabled", false],
  ]
  for (const [model, status, want] of matrix) {
    state.catalog.set(model, status)
    assert(
      pool.isAvailable(state, model, none) === want,
      `catalog status "${status}" must make the model ${want ? "available" : "unavailable"}`,
    )
  }
  // cooling beats the catalog: an active (and an absent) model is unavailable while
  // its cooldown is live.
  const cooledActive = "openrouter/cooled-active"
  state.catalog.set(cooledActive, "active")
  pool.recordStrike(state, cooledActive, "rate-limit", 60_000)
  assert(pool.isAvailable(state, cooledActive, state.cooling) === false, "a cooling model must be unavailable even with catalog status active")
  const cooledAbsent = "omniroute/cooled-absent"
  pool.recordStrike(state, cooledAbsent, "rate-limit", 60_000)
  assert(pool.isAvailable(state, cooledAbsent, state.cooling) === false, "a cooling model must be unavailable even when the catalog is silent")
}

// 8. pickSlot: a catalog-gated slot leaves the candidate set, so the first usable
//    slot in declaration order takes the spawn. When EVERY slot is gated the pool
//    still returns one -- it never refuses work (src/lib/pool.ts pickSlot): the
//    usable set is empty, so the full slot list is used and, every load being equal,
//    the first declared slot wins.
{
  const state = pool.state({
    id: "gate",
    dir: scratch(),
    models: {
      slots: [
        { model: "fixture/gate-a", weight: 4 },
        { model: "fixture/gate-b", weight: 2 },
        { model: "fixture/gate-c", weight: 1 },
      ],
    },
  })
  pool.init(state, () => {})
  const idle = pool.pickSlot(state, pool.snapshot(state))
  assert(idle.model === "fixture/gate-a", `an idle pool must pick the first declared slot, got ${idle.model}`)
  // retire the first slot: the next usable slot in declaration order takes over
  state.catalog.set("fixture/gate-a", "deprecated")
  const gated = pool.pickSlot(state, pool.snapshot(state))
  assert(gated.model === "fixture/gate-b", `a gated slot must fall through to the next usable slot, got ${gated.model}`)
  // every slot retired: no usable slot, so the full list is the pool and -- every
  // slot being at the same load -- the first declared slot (index 1) is returned.
  state.catalog.set("fixture/gate-b", "deprecated")
  state.catalog.set("fixture/gate-c", "disabled")
  const fallback = pool.pickSlot(state, pool.snapshot(state))
  assert(
    fallback.model === "fixture/gate-a" && fallback.index === 1,
    `when every slot is unusable pickSlot must still return a slot (first declared, index 1), got ${fallback.index}:${fallback.model}`,
  )
}

// 9. pickSlot declaration order: equal weights fill in declaration order. Pass 1
//    gives each slot its weight -- the earlier-declared slot wins until it reaches
//    its budget -- then pass 2 returns to the earlier slot up to its absolute cap.
{
  const state = pool.state({
    id: "tie",
    dir: scratch(),
    models: {
      slots: [
        { model: "fixture/tie-first", weight: 2 },
        { model: "fixture/tie-second", weight: 2 },
      ],
    },
  })
  pool.init(state, () => {})
  // Slots 1 and 2, weight 2, absolute cap 4.
  // Pass 1: spawns 1 and 2 go to slot 1, spawns 3 and 4 go to slot 2.
  // Pass 2: spawn 5 returns to slot 1 in declaration order.
  for (let i = 0; i < 2; i++) {
    const slot = pool.pickSlot(state, pool.snapshot(state))
    assert(slot.index === 1, `slot 1 should take the first 2 spawns, got slot ${slot.index}`)
    pool.acquire(state, "explore", slot, `s${i}`, `tie-${i}`)
  }
  for (let i = 2; i < 4; i++) {
    const slot = pool.pickSlot(state, pool.snapshot(state))
    assert(slot.index === 2, `slot 2 should take the next 2 spawns, got slot ${slot.index}`)
    pool.acquire(state, "explore", slot, `s${i}`, `tie-${i}`)
  }
  const fifth = pool.pickSlot(state, pool.snapshot(state))
  assert(fifth.index === 1, `once both slots reach their weight, pass 2 returns to slot 1, got slot ${fifth.index}`)
}

// The shared state directory is cleaned by traffic alone -- dead claims and
// lapsed cooldowns go when readSiblings/readLimits run, which is snapshot(),
// which only happens on a spawn. So an idle machine carries a dead process's
// claims file and every lapsed cooldown forever. sweepStateDir is that same
// policy with no activity required, which is the only cleanup an idle box gets.
// It keeps this process's own claims file, a live sibling's claims file, a
// running cooldown, and a lapsed cooldown still inside its strike-decay window.
{
  const dir = scratch()
  const s = pool.state({ id: "sweeper", dir })
  pool.init(s, () => {})

  // Pinned deliberately: the cadence is a product decision (stale files are re-read
  // on every routing decision), not an incidental constant. Hourly.
  assert(
    pool.STATE_SWEEP_INTERVAL_MS === 60 * 60 * 1000,
    `the sweep interval is hourly, got ${pool.STATE_SWEEP_INTERVAL_MS}ms`,
  )
  // It rides the existing 30s watchdog as a timestamp gate rather than owning a
  // timer, so a tick must cost nothing when it is not due.
  assert(
    typeof s.lastDirSweep === "number" && pool.STATE_SWEEP_INTERVAL_MS > 30_000,
    "the sweep must be gated on a time window, not run on every watchdog tick",
  )

  // A pid that has genuinely exited, and one that is genuinely running: the
  // dead/live distinction is the whole point of the dead-pid branch, so it must
  // be decided by a real signal rather than by a made-up number.
  const deadPid = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", "0"])
    const pid = c.pid
    c.on("exit", () => resolve(pid))
  })
  const aliveChild = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"])
  const alivePid = aliveChild.pid

  const now = Date.now()
  const write = (name, body, ageMs = 0) => {
    writeFileSync(join(dir, name), body)
    if (ageMs > 0) {
      const when = new Date(now - ageMs)
      utimesSync(join(dir, name), when, when)
    }
  }
  const strike = (untilOffsetMs, lastOffsetMs, strikes = 1) =>
    JSON.stringify({ model: "prov/m", until: now + untilOffsetMs, strikes, last: now + lastOffsetMs })

  write("claims.dead.json", "{}")
  writeFileSync(join(dir, `claims.${deadPid}.json`), "{}") // dead pid: reclaimed at once
  writeFileSync(join(dir, `claims.${alivePid}.json`), "{}") // live pid: kept
  write(pool.selfFile(s.id), "{}") // our own: never ours to delete
  write("limit.active.json", strike(3600_000, 0)) // still cooling: kept
  write("limit.decay.json", strike(-1000, -1000, 2)) // lapsed, inside decay: kept (strike memory)
  write("limit.stale.json", strike(-1000, -40 * 60_000, 3)) // lapsed past decay: removed
  write("stale.tmp", "partial", 120_000) // partial write: removed
  write("new.tmp", "partial") // too fresh to judge: kept

  const removed = pool.sweepStateDir(s)
  const gone = (name) => !existsSync(join(dir, name))
  const kept = (name) => existsSync(join(dir, name))

  assert(gone(`claims.${deadPid}.json`), "a dead pid's claims file must be reclaimed")
  assert(kept(`claims.${alivePid}.json`), "a LIVE pid's claims file must never be swept")
  assert(kept(pool.selfFile(s.id)), "our own claims file must never be swept")
  assert(kept("limit.active.json"), "a running cooldown must be kept")
  assert(kept("limit.decay.json"), "a lapsed cooldown inside its strike-decay window must be kept, or the backoff restarts at 1")
  assert(gone("limit.stale.json"), "a cooldown lapsed past strike decay must be swept")
  assert(gone("stale.tmp"), "a stale .tmp from a half-written file must be swept")
  assert(kept("new.tmp"), "a fresh .tmp is not yet knowable; it must be left alone")
  assert(!gone("claims.dead.json"), "a non-numeric owner is not a pid; only its age may remove it")
  assert(Array.isArray(removed) && removed.includes("limit.stale.json"), "sweepStateDir must report what it removed")
  aliveChild.kill()
}

for (const d of made) rmSync(d, { recursive: true, force: true })
if (failures === 0) console.log("\nALL SHARED-POOL CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}