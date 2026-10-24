// Epic B — how the pool fills its slots.
//
//   US-5  ordered fill gives every slot its pass target in declaration order
//   US-6  live pool visibility (the pool_status tool)
//
// Slots fill in declaration order. A slot's weight is its active-session budget
// for one pass, and its absolute cap is twice that budget. Pass 1 walks the
// usable slots and fills each to its weight, in order; once every usable slot
// reaches its weight, pass 2 walks them again and fills each to the absolute cap.
// Preference is order, never weight, so a light slot declared before a heavy one
// is filled first.
//
// A released claim immediately reopens its slot, because live claims are the only
// state routing consults and there is no stored position. The serial release test
// is the core regression: a lower slot must not sit idle while a later slot is
// used.
//
// Every test drives the real plugin default export with a stub PluginInput and an
// isolated claim directory. No network, no server, no real sleeps.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { bootLaCode, cleanupAll, configFor, emit, fakeClock, ROOT, scratch, stubInput } from "./_harness.mjs"

// The runner is pure and exported, so the selection rule can be asserted without
// the disk.
const pool = await import(join(ROOT, "src", "lib", "pool.ts"))

test.after(cleanupAll)

/** Boot a pool whose slots are exactly the given { model, weight } list. */
const bootPool = async (slots, id, options = {}) => {
  const stub = stubInput()
  const dir = options.dir ?? scratch()
  const hooks = await bootLaCode(stub, { id, dir, models: { slots }, ...options })
  const cfg = configFor(slots.map((s) => s.model))
  await hooks.config(cfg)
  return { stub, dir, hooks, cfg, models: slots.map((s) => s.model) }
}

/** Route one spawn and report the variant sent to it. */
const spawnExplore = async (hooks, callID, sessionID = `s${callID}`) => {
  const out = { args: { subagent_type: "explore", prompt: "x" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
  return out.args.subagent_type
}

/** `n` spawns that all keep their claim: nothing is freed, so the pass targets bind. */
const burst = async (hooks, n, tag = "burst") => {
  const out = []
  for (let i = 0; i < n; i++) out.push(await spawnExplore(hooks, `${tag}-${i}`))
  return out
}

/**
 * One spawn whose claim is handed back before the next one starts -- a session
 * doing one thing at a time. The released claim reopens its slot at once, so the
 * next spawn starts again from the earliest under-target slot.
 */
const serial = async (hooks, callID) => {
  const routed = await spawnExplore(hooks, callID)
  await hooks["tool.execute.after"]({ tool: "task", sessionID: `s${callID}`, callID, args: {} }, {})
  return routed
}

/** Hand one held claim back by the call id its spawn used. */
const release = async (hooks, callID) => {
  await hooks["tool.execute.after"]({ tool: "task", sessionID: `s${callID}`, callID, args: {} }, {})
}

const weightedSlots = [
  { model: "slot/a", weight: 3 },
  { model: "slot/b", weight: 2 },
  { model: "slot/c", weight: 1 },
  { model: "slot/d", weight: 1 },
]

const FIRST_PASS = ["explore-1", "explore-1", "explore-1", "explore-2", "explore-2", "explore-3", "explore-4"]
const BOTH_PASSES = [...FIRST_PASS, ...FIRST_PASS]

// ---------------------------------------------------------------------------
// US-5 — ordered fill
// ---------------------------------------------------------------------------

test("[US-5] seven concurrent spawns fill the first pass in declaration order", async () => {
  const { hooks } = await bootPool(weightedSlots, "slot-fill-first-pass")
  const routed = await burst(hooks, 7)
  assert.deepEqual(routed, FIRST_PASS, `the first pass must fill in declaration order, got ${routed}`)
  await hooks.dispose()
})

test("[US-5] fourteen concurrent spawns fill both passes in declaration order", async () => {
  const { hooks } = await bootPool(weightedSlots, "slot-fill-both-passes")
  const routed = await burst(hooks, 14)
  assert.deepEqual(routed, BOTH_PASSES, `both passes must repeat the declaration order, got ${routed}`)
  await hooks.dispose()
})

test("[US-5] a released claim reopens the earlier slot", async () => {
  const { hooks } = await bootPool(weightedSlots, "slot-fill-reopen")
  const routed = []
  for (let i = 0; i < 6; i++) routed.push(await serial(hooks, `reopen-${i}`))
  assert.deepEqual(routed, Array(6).fill("explore-1"), `a lower slot must not sit idle while a later one is used, got ${routed}`)
  await hooks.dispose()
})

test("[US-5] a second pool instance still prefers the earlier slot", async () => {
  const dir = scratch()
  const first = await bootPool(weightedSlots, "slot-fill-first", { dir })
  const routed = []
  for (let i = 0; i < 6; i++) routed.push(await serial(first.hooks, `first-${i}`))
  assert.deepEqual(routed, Array(6).fill("explore-1"), `the first instance must keep the earlier slot open, got ${routed}`)

  const second = await bootPool(weightedSlots, "slot-fill-second", { dir })
  assert.equal(await serial(second.hooks, "second-0"), "explore-1", "a fresh instance must prefer the earlier slot too")

  // Routing keeps no position file: only live claims decide the pick.
  assert.equal(existsSync(join(dir, "cursor.json")), false, "routing keeps no position file")

  await first.hooks.dispose()
  await second.hooks.dispose()
})

test("[US-5] releasing a lower slot in pass 2 reopens it before a higher slot", async () => {
  const { hooks } = await bootPool(weightedSlots, "slot-fill-release-pass2")
  const routed = await burst(hooks, 14)
  assert.deepEqual(routed, BOTH_PASSES, `the pool must reach both pass targets before the release, got ${routed}`)

  // The first burst claim sits on slot 1. Releasing it leaves slot 1 one claim
  // below its absolute cap, so the next pick belongs to it ahead of every later slot.
  await release(hooks, "burst-0")
  assert.equal(await spawnExplore(hooks, "after-release"), "explore-1", "the released lower slot must reopen first")
  await hooks.dispose()
})

test("[US-5] all slots at the absolute cap overflow to the least-loaded slot", async () => {
  const { hooks } = await bootPool(weightedSlots, "slot-fill-overflow")
  const routed = await burst(hooks, 14)
  assert.deepEqual(routed, BOTH_PASSES, `the pool must fill to the absolute caps first, got ${routed}`)

  // Loads are 6, 4, 2, 2. The least-loaded usable slots are 3 and 4, and the
  // first of those in declaration order takes the overflow spawn.
  assert.equal(await spawnExplore(hooks, "overflow"), "explore-3", "overflow must go to the least-loaded usable slot")
  await hooks.dispose()
})

test("[US-5] a cooling slot is skipped and a recovered earlier slot is preferred again", async () => {
  const clock = fakeClock()
  const slots = [
    { model: "slot/one", weight: 1 },
    { model: "slot/two", weight: 2 },
  ]
  const { hooks } = await bootPool(slots, "slot-fill-cooling")

  // "Endpoint is unavailable" takes the flat 60s path, so the clock can move past
  // it without aging the claim into the reaper's window.
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "slot",
      modelID: "one",
      error: { message: "Endpoint is unavailable" },
    },
  })

  assert.equal(await spawnExplore(hooks, "cooling-0"), "explore-2", "a cooling slot must be skipped")

  clock.advance(61_000)
  assert.deepEqual(
    [
      await spawnExplore(hooks, "cooling-1"),
      await spawnExplore(hooks, "cooling-2"),
      await spawnExplore(hooks, "cooling-3"),
    ],
    ["explore-1", "explore-2", "explore-1"],
    "after recovery the earlier slot takes its pass-1 target, then its pass-2 target",
  )

  clock.restore()
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-6 — observing the pool leaves it unchanged
// ---------------------------------------------------------------------------

test("[US-6] pool_status reports the pass and marks the next slot without changing the pool", async () => {
  const clock = fakeClock()
  const { hooks } = await bootPool(weightedSlots, "slot-fill-status")

  const status = async () => (await hooks.tool.pool_status.execute({}, {})).output
  const markedSlot = (output) => {
    const marked = output.split("\n").filter((line) => line.includes("<- next"))
    assert.equal(marked.length, 1, `exactly one slot must be marked next:\n${output}`)
    return Number(/slot (\d)/.exec(marked[0])[1])
  }

  // Pass 1: slot 1 is at its weight, so the next spawn belongs to slot 2.
  assert.deepEqual((await burst(hooks, 3)), FIRST_PASS.slice(0, 3), "slot 1 must fill first")
  const pass1 = await status()
  assert.equal(await status(), pass1, `reading twice must not change the pool:\n${pass1}`)
  assert.match(pass1, /pass 1/, `the status must name the current pass:\n${pass1}`)
  assert.equal(markedSlot(pass1), 2, `pass 1 must mark the next under-weight slot:\n${pass1}`)
  assert.equal(await spawnExplore(hooks, "status-1"), "explore-2", "the marked slot must be the next spawn")

  // Pass 2: every slot is at its weight, and slot 4 is the only one below its cap.
  await burst(hooks, 9, "pass2")
  const pass2 = await status()
  assert.equal(await status(), pass2, `reading twice must not change the pool:\n${pass2}`)
  assert.match(pass2, /pass 2/, `the status must name the current pass:\n${pass2}`)
  assert.equal(markedSlot(pass2), 4, `pass 2 must mark the next under-cap slot:\n${pass2}`)
  assert.equal(await spawnExplore(hooks, "status-2"), "explore-4", "the marked slot must be the next spawn")

  // Overflow: every slot is at its cap, so the mark is the least-loaded one.
  const overflow = await status()
  assert.equal(await status(), overflow, `reading twice must not change the pool:\n${overflow}`)
  assert.match(overflow, /overflow/, `the status must name the overflow state:\n${overflow}`)
  assert.equal(markedSlot(overflow), 3, `overflow must mark the least-loaded slot:\n${overflow}`)
  assert.equal(await spawnExplore(hooks, "status-3"), "explore-3", "the marked slot must be the next spawn")

  clock.restore()
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-5 — the selection rule without the disk
// ---------------------------------------------------------------------------

const unitSlots = [
  { index: 1, model: "unit/a", weight: 3 },
  { index: 2, model: "unit/b", weight: 2 },
  { index: 3, model: "unit/c", weight: 1 },
  { index: 4, model: "unit/d", weight: 1 },
]
const unitState = { slots: unitSlots, catalog: new Map() }
const unitSnapshot = (counts = {}, cooling = {}) => ({
  counts: new Map(Object.entries(counts)),
  cooling: new Map(Object.entries(cooling)),
  siblings: [],
  own: new Map(),
  dirReady: true,
})
const atWeight = { "unit/a": 3, "unit/b": 2, "unit/c": 1, "unit/d": 1 }
const atCap = { "unit/a": 6, "unit/b": 4, "unit/c": 2, "unit/d": 2 }

test("[US-5] pickSlot fills in order through both passes, skips cooling, and overflows to the least-loaded slot", () => {
  // Pass 1: the lowest-index slot still below its weight.
  assert.equal(pool.pickSlot(unitState, unitSnapshot()).index, 1)
  assert.equal(pool.pickSlot(unitState, unitSnapshot({ "unit/a": 3 })).index, 2)
  assert.equal(
    pool.pickSlot(unitState, unitSnapshot({ "unit/a": 1, "unit/b": 2 })).index,
    1,
    "a lower slot under its weight comes before a higher slot that is already there",
  )

  // Pass 2 opens only once every slot reaches its weight, then fills in order.
  assert.equal(pool.pickSlot(unitState, unitSnapshot(atWeight)).index, 1)
  assert.equal(pool.pickSlot(unitState, unitSnapshot({ ...atWeight, "unit/a": 6 })).index, 2)

  // A lower slot under the current target always wins over a higher one.
  assert.equal(
    pool.pickSlot(unitState, unitSnapshot({ "unit/a": 2, "unit/b": 0 })).index,
    1,
    "pass 1 must prefer the lower slot before the higher one",
  )
  assert.equal(
    pool.pickSlot(unitState, unitSnapshot({ "unit/a": 3, "unit/b": 2, "unit/c": 1, "unit/d": 1 })).index,
    1,
    "pass 2 must prefer the lower slot before the higher one",
  )

  // A cooling slot is not usable, so the next ordered slot takes the pick.
  const cooling = { "unit/a": { model: "unit/a", until: Infinity, strikes: 1, reason: "test", last: 0 } }
  assert.equal(pool.pickSlot(unitState, unitSnapshot({}, cooling)).index, 2)

  // At the absolute cap every usable slot is skipped, and overflow spreads to
  // the least-loaded usable slot rather than piling onto the first one.
  const overflow = { "unit/a": 6, "unit/b": 4, "unit/c": 3, "unit/d": 2 }
  assert.equal(pool.pickSlot(unitState, unitSnapshot(overflow)).index, 4)
})

test("[US-5] poolPass reports pass 1, pass 2, then overflow", () => {
  assert.equal(pool.poolPass(unitState, unitSnapshot()), 1)
  assert.equal(
    pool.poolPass(unitState, unitSnapshot({ "unit/a": 0, "unit/b": 4, "unit/c": 2, "unit/d": 2 })),
    1,
    "one usable slot below its weight keeps routing in pass 1",
  )
  assert.equal(pool.poolPass(unitState, unitSnapshot(atWeight)), 2)
  assert.equal(pool.poolPass(unitState, unitSnapshot(atCap)), "overflow")
})

test("[US-5] every pick leaves all earlier usable slots at or above the current pass target", () => {
  // Deterministic pseudo-random count maps: no fuzzer, no wall clock, and the
  // same cases on every run. Pass 1 targets weight; pass 2 and overflow target
  // the absolute cap.
  let seed = 123_456_789
  const nextRandom = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return seed
  }

  for (let sample = 0; sample < 25; sample++) {
    const counts = new Map()
    for (const slot of unitSlots) counts.set(slot.model, nextRandom() % 9)
    const snap = unitSnapshot(Object.fromEntries(counts))
    const pass = pool.poolPass(unitState, snap)
    const picked = pool.pickSlot(unitState, snap)
    const target = (slot) => (pass === 1 ? slot.weight : slot.weight * 2)

    for (const lower of unitSlots.filter((slot) => slot.index < picked.index)) {
      const load = counts.get(lower.model) ?? 0
      assert.ok(
        load >= target(lower),
        `pass ${pass} picked slot ${picked.index} while lower slot ${lower.index} (load ${load}) is below its target ${target(lower)}; counts ${JSON.stringify(Object.fromEntries(counts))}`,
      )
    }
  }
})
