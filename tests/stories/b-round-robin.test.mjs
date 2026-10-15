// Epic B — the pool's slot selection rule.
//
//   US-5  weighted round-robin gives every slot a turn per cycle
//   US-6  live pool visibility (the pool_status tool)
//
// The rule under test is ORDER-FIRST WEIGHTED ROUND ROBIN. The slot list is expanded
// into a run in which every slot occupies one position per unit of its weight --
// weights [3,2,1,1] become 1,1,1,2,2,3,4 -- a cursor persisted in the claim dir marks
// the next position in that run, and each spawn scans the run from there and takes the
// FIRST slot which is both not cooling and under its ceiling. Weight therefore says
// how OFTEN a slot is preferred; the cursor says WHICH turn comes next, and the
// ceiling is unchanged either way: a slot still holds at most `weight` claims.
//
// The difference from weight-as-priority is visible in the very first spawn. The old
// rule drained the heaviest slot first, so a light slot declared before a heavy one
// waited for the heavy one to fill; here the run is walked in order and the light slot
// takes its turn first. Two halves of that property are covered below:
//
//   1. the RUN     -- what the sequence of picks looks like with room to spare
//   2. the CURSOR  -- that the run is shared across processes, survives a restart,
//                     and is not moved by merely looking at the pool
//
// Every test drives the real plugin default export with a stub PluginInput and an
// isolated claim directory. No network, no server, no real sleeps.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { bootLaCode, cleanupAll, configFor, ROOT, scratch, stubInput } from "./_harness.mjs"

// The runner is pure and exported, so the expansion can be asserted without the disk.
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

/** Route one spawn and report the variant it was sent to. */
const spawnExplore = async (hooks, callID, sessionID = `s${callID}`) => {
  const out = { args: { subagent_type: "explore", prompt: "x" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
  return out.args.subagent_type
}

/** `n` spawns that all keep their claim: nothing is freed, so the ceilings bind. */
const burst = async (hooks, n, tag = "burst") => {
  const out = []
  for (let i = 0; i < n; i++) out.push(await spawnExplore(hooks, `${tag}-${i}`))
  return out
}

/**
 * One spawn whose claim is handed back before the next one starts -- a session doing
 * one thing at a time. Needed whenever the run is longer than the summed ceilings:
 * concurrent spawns would walk past every ceiling into the overflow path, which is a
 * different rule, while serial ones keep every pick inside the run itself.
 */
const serial = async (hooks, callID) => {
  const routed = await spawnExplore(hooks, callID)
  await hooks["tool.execute.after"]({ tool: "task", sessionID: `s${callID}`, callID, args: {} }, {})
  return routed
}

// ---------------------------------------------------------------------------
// US-5 — the run
// ---------------------------------------------------------------------------

test("[US-5] weights [3,2,1,1] expand into the run 1,1,1,2,2,3,4 across successive spawns", async () => {
  // The run is seven positions long and the summed ceilings are exactly seven, so
  // every spawn of this burst is still inside the rotation and none is an overflow
  // pick: the observed sequence IS the run, position for position.
  const slots = [
    { model: "rr/a", weight: 3 },
    { model: "rr/b", weight: 2 },
    { model: "rr/c", weight: 1 },
    { model: "rr/d", weight: 1 },
  ]
  const { hooks } = await bootPool(slots, "rr-run")
  const routed = await burst(hooks, 7)
  assert.deepEqual(
    routed,
    ["explore-1", "explore-1", "explore-1", "explore-2", "explore-2", "explore-3", "explore-4"],
    `the run must be walked in order, got ${routed}`,
  )
  await hooks.dispose()
})

test("[US-5] a light slot declared before a heavier one is served first, and the run then repeats", async () => {
  // The whole point of the change. Slot 2 is the heavier one here, so
  // weight-as-priority would send every spawn to slot 2 until its ceiling and only
  // then reach slot 1; the run [1,2,2] puts slot 1 first and gives slot 2 the two
  // turns after it. Two full rotations show it is the run, not a one-off.
  const slots = [
    { model: "rr/one", weight: 1 },
    { model: "rr/two", weight: 2 },
  ]
  const { hooks } = await bootPool(slots, "rr-light-first")
  const routed = []
  for (let i = 0; i < 6; i++) routed.push(await serial(hooks, `light-${i}`))
  assert.deepEqual(
    routed,
    ["explore-1", "explore-2", "explore-2", "explore-1", "explore-2", "explore-2"],
    `an earlier slot keeps its earlier turn in the run, got ${routed}`,
  )
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-5 — the cursor
// ---------------------------------------------------------------------------

test("[US-5] the cursor is persisted in the claim dir, so a second pool instance continues the run", async () => {
  // A cursor kept in process memory would restart the run in every opencode process,
  // and a pool whose processes all start at the top is the starvation the run exists
  // to remove. Equal weights keep the ceiling out of the evidence: slot 1 is free
  // when the second instance starts, so only the cursor can explain a pick of slot 3.
  const slots = ["rr/a", "rr/b", "rr/c"].map((model) => ({ model, weight: 1 }))
  const dir = scratch()
  const first = await bootPool(slots, "rr-cursor-first", { dir })
  const second = await bootPool(slots, "rr-cursor-second", { dir })

  // The first instance takes slots 1 and 2 and hands both claims back, so the load is
  // back to zero and only the file remembers where the run got to.
  assert.deepEqual(
    [await serial(first.hooks, "first-0"), await serial(first.hooks, "first-1")],
    ["explore-1", "explore-2"],
    "the first instance must open the run in declaration order",
  )
  const cursor = JSON.parse(readFileSync(join(dir, "cursor.json"), "utf8"))
  assert.equal(cursor.seq, 2, `the cursor must record where the run got to, got ${JSON.stringify(cursor)}`)

  // A restart at the top would answer slot 1 again.
  const resumed = await burst(second.hooks, 1, "second")
  assert.deepEqual(resumed, ["explore-3"], `the second instance must resume the run, got ${resumed}`)
  assert.deepEqual(
    [await serial(second.hooks, "second-1"), await serial(second.hooks, "second-2")],
    ["explore-1", "explore-2"],
    "and keep turning it from there, wrapping past the end",
  )

  // The control: the same pool in a dir with no cursor file starts at slot 1, so what
  // resumed above really was the file.
  const fresh = await bootPool(slots, "rr-cursor-fresh")
  assert.equal(await spawnExplore(fresh.hooks, "fresh-0"), "explore-1", "a pool with no cursor starts at the top of the run")

  await first.hooks.dispose()
  await second.hooks.dispose()
  await fresh.hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-6 — observing the rotation is not taking a turn from it
// ---------------------------------------------------------------------------

test("[US-6] pool_status shows where the rotation stands without consuming a turn", async () => {
  // The status view previews the next pick, and a preview that moved the cursor would
  // shift every spawn after it: merely looking at the pool would route for you.
  const slots = ["rr/a", "rr/b", "rr/c"].map((model) => ({ model, weight: 1 }))
  const { hooks } = await bootPool(slots, "rr-status-peek")

  assert.equal(await spawnExplore(hooks, "peek-0"), "explore-1", "the first spawn opens the run")

  const marked = async () => {
    const status = await hooks.tool.pool_status.execute({}, {})
    return status.output
      .split("\n")
      .filter((line) => line.includes("<- next"))
      .join("\n")
  }
  const before = await marked()
  const after = await marked()
  assert.ok(before.includes("slot 2"), `an idle slot beside a running one must be marked next:\n${before}`)
  assert.equal(after, before, `looking twice must not move the rotation:\n${before}\n---\n${after}`)

  assert.equal(
    await spawnExplore(hooks, "peek-1"),
    "explore-2",
    "the spawn after two status reads must still take the next turn in the run",
  )
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-5 — the expansion itself
// ---------------------------------------------------------------------------

test("[US-5] roundRobinSequence expands a slot list into one position per unit of weight", async () => {
  const slot = (index, weight) => ({ index, model: `rr/s${index}`, weight })

  // One position per unit of weight, in declaration order: a heavier slot holds more
  // positions, which is how it is preferred more often -- without being drained first.
  assert.deepEqual(
    pool.roundRobinSequence([slot(1, 3), slot(2, 2), slot(3, 1), slot(4, 1)]),
    [1, 1, 1, 2, 2, 3, 4],
    "the run is the slot list expanded by weight",
  )
  // Order, not just count: a light slot declared first keeps its earlier position, so
  // the first spawn goes to it rather than to the heavier slot behind it.
  assert.deepEqual(pool.roundRobinSequence([slot(1, 1), slot(2, 2)]), [1, 2, 2], "declaration order survives the expansion")
  assert.deepEqual(pool.roundRobinSequence([slot(1, 2), slot(2, 2)]), [1, 1, 2, 2], "equal weights give a plain round robin")
  assert.deepEqual(pool.roundRobinSequence([]), [], "no slots, no run")
})
