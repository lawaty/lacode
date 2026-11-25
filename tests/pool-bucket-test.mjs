// Shared quota buckets.
//
// A bucket groups slots that spend the same provider quota. The default is one
// bucket per model, so an existing pool is unchanged; a `b:<name>` token on a
// pool line (or a `bucket` field in JSON) declares the group explicitly. A limit
// on any line in the group benches every line in it, because the next request on
// a sibling would spend the same exhausted window.
//
// Run with: node --test tests/pool-bucket-test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { EMPTY_RESPONSE_COOLDOWN_BASE_MS, parseTextSlots, recordStrike, slotBucket, state } from "../src/lib/pool.ts"

const scratchState = (slots) => {
  const dir = mkdtempSync(join(tmpdir(), "bucket-"))
  const s = state({ dir, models: { slots } })
  s.dirReady = true
  s.slots = slots
  return { s, dir }
}

test("a pool line may declare a bucket with b:<name>", () => {
  const parsed = parseTextSlots(
    "opencode/a 2 b:opencode\nopencode/b 4 b:opencode\nother/c 1\n",
    "test",
  )
  assert.equal(parsed.problems.length, 0)
  assert.deepEqual(parsed.slots.map((slot) => slotBucket(slot)), ["opencode", "opencode", "other/c"])
  assert.deepEqual(parsed.slots.map((slot) => slot.weight), [2, 4, 1])
})

test("a missing bucket defaults to the model id", () => {
  const parsed = parseTextSlots("other/c 1\n", "test")
  assert.equal(slotBucket(parsed.slots[0]), "other/c")
})

test("an empty bucket name warns and falls back to the model id", () => {
  const parsed = parseTextSlots("other/c 1 b:\n", "test")
  assert.equal(parsed.problems.length, 1)
  assert.match(parsed.problems[0], /bucket must be a non-empty name/)
  assert.equal(slotBucket(parsed.slots[0]), "other/c")
})

test("a limit on one bucket member benches the whole bucket", () => {
  const parsed = parseTextSlots(
    "opencode/a 2 b:opencode\nopencode/b 2 b:opencode\nother/c 1\n",
    "test",
  )
  const { s, dir } = scratchState(parsed.slots)
  try {
    recordStrike(s, "opencode/a", "rate_limit", 60_000)
    assert.deepEqual([...s.cooling.keys()].sort(), ["opencode/a", "opencode/b"])
    assert.equal(s.cooling.has("other/c"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a limit on an unbucketed model benches only that model", () => {
  const parsed = parseTextSlots("opencode/a 2\nopencode/b 2\n", "test")
  const { s, dir } = scratchState(parsed.slots)
  try {
    recordStrike(s, "opencode/a", "rate_limit", 60_000)
    assert.deepEqual([...s.cooling.keys()], ["opencode/a"])
    assert.equal(s.cooling.has("opencode/b"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an empty response is benched longer than a generic blip and escalates", () => {
  const { s, dir } = scratchState([{ model: "empty/a", weight: 1 }])
  try {
    const first = recordStrike(s, "empty/a", "empty response")
    const firstUntil = s.cooling.get("empty/a").until
    assert.equal(first.reason, "empty response")
    assert.ok(firstUntil - Date.now() >= EMPTY_RESPONSE_COOLDOWN_BASE_MS - 2000)
    assert.ok(firstUntil - Date.now() > 60_000)

    const second = recordStrike(s, "empty/a", "empty response")
    const secondUntil = s.cooling.get("empty/a").until
    assert.equal(second.strikes, 2)
    assert.ok(secondUntil - Date.now() >= 18 * 60 * 1000 - 2000)
    assert.ok(secondUntil > firstUntil)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
