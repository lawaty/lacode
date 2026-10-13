// Verifies the pool is genuinely shared across agent types: explore,
// implement and context compete for the same four models, so a
// busy agent type cannot protect its own capacity. Also checks that the
// context-autoupdate plugin borrows a slot correctly.
// Run: node tests/pool-shared-test.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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
// presets/free-tier.json lists its slots in. pickSlot compares weights, not
// position: what "a workhorse slot" and "a reserve slot" mean is the file's.
const MAX_WEIGHT = Math.max(...SHIPPED.map((s) => s.weight))
const slotsOfWeight = (weight) => SHIPPED.flatMap((s, i) => (s.weight === weight ? [i + 1] : []))
const HEAVY_SLOTS = slotsOfWeight(MAX_WEIGHT)
const LIGHT_SLOTS = slotsOfWeight(Math.min(...SHIPPED.map((s) => s.weight)))
const ALL_SLOTS = SHIPPED.map((_, i) => i + 1)
const firstOf = (xs) => xs[0]
// How deep the heaviest slot goes before a lightest one is engaged, derived from the
// ratio rule rather than written as a literal: handover happens at
// weight * PRIORITY_MARGIN / weight - PRIORITY_MARGIN claims.
// The summed ceilings are where the weighted phase ends and the overflow begins.
const CAPACITY = SHIPPED.reduce((sum, s) => sum + s.weight, 0)

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

// 2. alternating base types interleave across slots rather than each taking one
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
    `mixed base types must follow the same shared cycle, got ${picks.join(",")}, want ${soloPicks.join(",")}`,
  )
  // An idle pool starts on its heaviest slots, so the leading picks are heavy ones
  // until the lightest is a full weight behind.
  assert(
    HEAVY_SLOTS.includes(picks[0]) && HEAVY_SLOTS.includes(picks[1]),
    `an idle pool must start on the heaviest slots, got ${picks.slice(0, 2).join(",")}`,
  )
  assert(new Set(picks).size === ALL_SLOTS.length, "every slot must be used when base types alternate")
}

// 3. load from one base displaces the other: a saturated explore pushes
//    implement onto the same shared slots instead of its own
{
  const t = await mk("shared-2", scratch())
  for (let i = 0; i < CAPACITY; i++) await t.spawn(`x${i}`, "explore") // deep enough to exhaust every ceiling
  const afterExplore = slotOf(await t.spawn("x4", "implement"))
  assert(
    afterExplore === firstOf(LIGHT_SLOTS),
    `implement must land on the lightest slot, got ${afterExplore}`,
  )
  assert(!HEAVY_SLOTS.includes(afterExplore), `implement must not be handed an explore-loaded heavy slot`)
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
  // an idle pool hands out its heaviest slot, whichever one the file put first
  assert(HEAVY_SLOTS.includes(slot.index), `an idle pool should hand out a heaviest slot, got ${slot.index}`)
  const agent = pool.agentFor("context", slot.index)
  assert(agent === `context-${slot.index}`, `borrowed agent name wrong: ${agent}`)
  assert(cfg.agent[agent] !== undefined, `${agent} must exist in config`)
  const key = pool.claimKey("ses_borrow", "context-autoupdate")
  pool.acquire(state, "context", slot, "ses_borrow", key, "ses_borrow")
  let busy = pool.snapshot(state)
  assert(busy.counts.get(slot.model) === 1, "the borrowed slot must show as loaded")
  assert(busy.own.get(key).g === "ses_borrow", "the claim must target the working session for the reaper")
  // A second borrow must not land on the busy slot while another slot is
  // eligible. With a single heavy slot there is nothing to switch to: the only
  // other slots are lighter and stay empty until the heavy one is a full weight
  // ahead, so handing out the same heavy slot again is the pool behaving as
  // designed, not a routing failure.
  const slot2 = pool.pickSlot(state, pool.snapshot(state))
  if (HEAVY_SLOTS.length > 1) {
    assert(slot2.index !== slot.index, `second borrow should avoid the busy slot, got ${slot2.index}`)
  }
  pool.release(state, key)
  busy = pool.snapshot(state)
  assert(busy.counts.get(slot.model) === undefined, "release must clear the borrowed slot")
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

for (const d of made) rmSync(d, { recursive: true, force: true })
if (failures === 0) console.log("\nALL SHARED-POOL CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}