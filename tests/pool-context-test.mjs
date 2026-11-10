import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const pool = await import(join(HERE, "..", "src", "lib", "pool.ts"))

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
}

// parseTextSlots: c:<tokens> token
{
  const { slots, problems } = pool.parseTextSlots("opencode/model  2  c:131072  b:opencode\n", "test")
  assert(slots.length === 1, `expected 1 slot, got ${slots.length}`)
  const slot = slots[0]
  assert(slot.context === 131072, `context must be 131072, got ${slot.context}`)
  assert(slot.weight === 2, `weight must be 2, got ${slot.weight}`)
  assert(slot.bucket === "opencode", `bucket must be opencode, got ${slot.bucket}`)
  assert(slot.model === "opencode/model", `model must be opencode/model, got ${slot.model}`)
  console.log("parseTextSlots c: token ok", JSON.stringify(slot), "problems:", problems)
}

// parseTextSlots: c: token must not be consumed as weight (c: before weight)
{
  const { slots } = pool.parseTextSlots("opencode/model  c:131072  2  b:opencode\n", "test")
  assert(slots[0].context === 131072, `context must be 131072, got ${slots[0].context}`)
  assert(slots[0].weight === 2, `weight must be 2, got ${slots[0].weight}`)
  console.log("parseTextSlots c: before weight ok", JSON.stringify(slots[0]))
}

// parseSlots JSON path: context field carried through
{
  const { slots } = pool.parseSlots({ slots: [{ model: "opencode/model", weight: 2, context: 131072, bucket: "opencode" }] }, "test")
  assert(slots[0].context === 131072, `JSON context must be 131072, got ${slots[0].context}`)
  console.log("parseSlots JSON context ok", JSON.stringify(slots[0]))
}

// pickSlot with minimal State/Snapshot (same shape as tests/stories/b-slot-fill.test.mjs unitState/unitSnapshot)
const slots = [
  { index: 1, model: "unit/small", weight: 2, context: 131072 },
  { index: 2, model: "unit/large", weight: 2, context: 1048576 },
  { index: 3, model: "unit/unknown", weight: 2 },
]
const state = { slots, catalog: new Map() }
const snap = { counts: new Map(), cooling: new Map(), siblings: [], own: new Map(), dirReady: true }

{
  const picked = pool.pickSlot(state, snap, 50000)
  assert(picked.model === "unit/small", `pickSlot(50000) must be small, got ${picked.model}`)
  console.log("pickSlot 50000 ->", picked.model)
}
{
  const picked = pool.pickSlot(state, snap, 150000)
  assert(picked.model === "unit/large", `pickSlot(150000) must be large, got ${picked.model}`)
  console.log("pickSlot 150000 ->", picked.model)
}
{
  const picked = pool.pickSlot(state, snap, 2000000)
  assert(picked, "pickSlot(2000000) must return a slot, not throw")
  assert(picked.model === "unit/large", `pickSlot(2000000) must be large (largest known), got ${picked.model}`)
  console.log("pickSlot 2000000 ->", picked.model)
}
{
  const picked = pool.pickSlot(state, snap)
  assert(picked.model === "unit/small", `pickSlot() must be first declared slot small, got ${picked.model}`)
  console.log("pickSlot() ->", picked.model)
}

// MIN_SLOT_CONTEXT: a sub-threshold slot is dropped and reported (text).
{
  const { slots, problems } = pool.parseTextSlots(
    "opencode/tiny 1 c:8192\nopencode/ok 1 c:131072\n",
    "test",
  )
  assert(slots.length === 1, `expected 1 surviving slot, got ${slots.length}`)
  assert(slots[0].model === "opencode/ok", `survivor must be opencode/ok, got ${slots[0].model}`)
  assert(slots[0].context === 131072, `survivor context must be 131072, got ${slots[0].context}`)
  const mentioned = problems.some((p) => /opencode\/tiny/.test(p) && /8192/.test(p) && /dropping/i.test(p))
  assert(mentioned, `problems must mention the dropped 8192 slot, got ${JSON.stringify(problems)}`)
  console.log("text sub-threshold drop ok", slots.map((s) => s.model), "problems:", problems)
}

// MIN_SLOT_CONTEXT: a sub-threshold slot is dropped and reported (JSON).
{
  const { slots, problems } = pool.parseSlots(
    { slots: [{ model: "a/b", context: 8192 }, { model: "c/d", context: 131072 }] },
    "test",
  )
  assert(slots.length === 1, `expected 1 surviving slot, got ${slots.length}`)
  assert(slots[0].model === "c/d", `survivor must be c/d, got ${slots[0].model}`)
  assert(slots[0].context === 131072, `survivor context must be 131072, got ${slots[0].context}`)
  const mentioned = problems.some((p) => /a\/b/.test(p) && /8192/.test(p) && /dropping/i.test(p))
  assert(mentioned, `problems must mention the dropped 8192 slot, got ${JSON.stringify(problems)}`)
  console.log("JSON sub-threshold drop ok", slots.map((s) => s.model), "problems:", problems)
}

// MIN_SLOT_CONTEXT: every slot sub-threshold resolves to the built-in fallback.
{
  const { slots, problems } = pool.parseSlots(
    { slots: [{ model: "a/b", context: 8192 }, { model: "c/d", context: 99999 }] },
    "test",
  )
  assert(slots === pool.FALLBACK_SLOTS, "all-sub-threshold pool must resolve to FALLBACK_SLOTS (same reference)")
  const mentioned = problems.some((p) => /no usable slot|built-in defaults/i.test(p))
  assert(mentioned, `problems must mention the fallback, got ${JSON.stringify(problems)}`)
  console.log("all sub-threshold -> fallback ok", "problems:", problems)
}

// MIN_SLOT_CONTEXT: an unknown-context slot is still kept.
{
  const { slots, problems } = pool.parseSlots(
    { slots: [{ model: "a/b" }, { model: "c/d", context: 131072 }] },
    "test",
  )
  assert(slots.length === 2, `expected 2 slots, got ${slots.length}`)
  const unknown = slots.find((s) => s.model === "a/b")
  assert(unknown, "unknown-context slot a/b must be kept")
  assert(unknown.context === undefined, `unknown-context slot must have context undefined, got ${unknown.context}`)
  assert(!problems.some((p) => /a\/b/.test(p) && /dropping/i.test(p)), `unknown-context slot must not be dropped: ${JSON.stringify(problems)}`)
  console.log("unknown context kept ok", slots.map((s) => [s.model, s.context]), "problems:", problems)
}

console.log("\nALL CHECKS PASSED")
