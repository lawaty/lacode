// End-to-end: score payload -> refresh-pool -> parsed pool.txt -> real plugin
// hooks. This is deliberately not a unit test of one function: it proves the
// ceiling and fallback facts survive the whole chain and actually steer routing.
//
// No network, no server: the scorer's *input* (providers/rows) is synthetic and
// the selection policy is the real `selectPool`, the writer is the real
// `buildPool`, the parser is the real `parseSlotText`, and the router is the
// real plugin default export.

import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import * as pool from "../src/lib/pool.ts"
import { selectPool, parsePoolSlots } from "../scripts/pool-selection.mjs"
import { buildPool, FALLBACK_MARKER } from "../scripts/refresh-pool.mjs"
import { bootLaCode, cleanupAll, configFor, emit, scratch, stubInput } from "./stories/_harness.mjs"

test.after(cleanupAll)

const row = (model, score, context = 1_048_576) => ({ model, ok: true, score, context })

const spawnExplore = async (hooks, callID) => {
  const out = { args: { subagent_type: "explore", prompt: "x" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID: `s${callID}`, callID }, out)
  return out.args.subagent_type
}

test("scorer payload -> pool.txt -> runtime keeps ceiling and fallback facts", () => {
  // Nine go models fill the head, one zen model is the tail reserve; the pool is
  // full at ten, so the rankable mistral row is only reachable as a fallback.
  const providers = [
    { provider: "opencode-go", rows: Array.from({ length: 9 }, (_, i) => row(`opencode-go/m${i}`, 95 - i)) },
    { provider: "opencode", rows: [row("opencode/zen", 80)] },
    { provider: "mistral", rows: [row("mistral/x", 70, 131_072)] },
  ]
  // A ceiling configured on the running pool must survive into the report.
  const currentSlots = [{ model: "opencode-go/m0", weight: 4, ceiling: 8 }]

  const { selection, fallback, warnings } = selectPool({ providers, currentSlots })
  assert.equal(selection.length, 10, "the primary selection is full")
  assert.equal(fallback.length, 1, "the disjoint mistral model is the fallback")
  assert.equal(fallback[0].model, "mistral/x")
  assert.equal(selection.find((entry) => entry.model === "opencode-go/m0").ceiling, 8)

  const built = buildPool({
    scores: { generatedAt: "2026-11-12T00:00:00.000Z", providers, selection, fallback, warnings },
    currentPoolText: "",
    now: "2026-11-12T00:00:00.000Z",
  })
  assert.ok(built.text.includes("ceil:8"), `the ceiling must be rendered:\n${built.text}`)
  assert.ok(built.text.includes(FALLBACK_MARKER), `the fallback marker must be rendered:\n${built.text}`)
  assert.ok(
    built.text.indexOf(FALLBACK_MARKER) > built.text.indexOf("opencode-go/m0"),
    "the fallback section must follow the primary slots",
  )

  const parsed = pool.parseSlotText(built.text, "e2e")
  assert.deepEqual(parsed.problems, [], `the generated pool must parse cleanly: ${parsed.problems.join("; ")}`)
  assert.equal(parsed.slots.filter((slot) => !slot.fallback).length, 10)
  assert.equal(parsed.slots.filter((slot) => slot.fallback).length, 1)
  assert.equal(parsed.slots.find((slot) => slot.model === "opencode-go/m0").ceiling, 8)
  assert.equal(parsed.slots.find((slot) => slot.model === "mistral/x").fallback, true)
})

test("a parsed pool fills in passes, then uses the fallback only when every primary is unusable", async () => {
  const text = [
    "primary/a  1  ceil:2",
    "primary/b  1",
    FALLBACK_MARKER,
    "fallback/x  1",
    "",
  ].join("\n")
  const parsed = pool.parseSlotText(text, "e2e")
  assert.deepEqual(parsed.problems, [], `unexpected parse warnings: ${parsed.problems.join("; ")}`)
  assert.equal(parsed.slots.length, 3)
  assert.equal(parsed.slots[2].fallback, true)

  const stub = stubInput()
  const dir = scratch()
  // Drive the real flat-file parser, not a pre-parsed array: booting from
  // `models` would re-parse every entry as a primary slot and drop the marker.
  const file = join(scratch(), "pool.txt")
  writeFileSync(file, text)
  const hooks = await bootLaCode(stub, { id: "e2e-route", dir, modelsFile: file })
  await hooks.config(configFor(parsed.slots.map((slot) => slot.model)))

  // Pass 1 gives one claim to a and one to b; pass 2 deepens a to its ceiling.
  assert.deepEqual(
    [await spawnExplore(hooks, "r0"), await spawnExplore(hooks, "r1"), await spawnExplore(hooks, "r2")],
    ["explore-1", "explore-2", "explore-1"],
    "routing must repeat the pass toward the ceiling",
  )

  const status = (await hooks.tool.pool_status.execute({}, {})).output
  assert.match(status, /slot 1 w1 c2/, `the status must show the explicit ceiling:\n${status}`)
  assert.match(status, /\[fallback\]/, `the status must tag the fallback slot:\n${status}`)
  assert.match(status, /1 primary slot\(s\) \+ 1 fallback slot\(s\)|2 primary slot\(s\) \+ 1 fallback slot\(s\)/, `the status must count both pools:\n${status}`)

  // While any primary slot is usable, overflow must stay in the primary.
  assert.equal(await spawnExplore(hooks, "r3"), "explore-2", "overflow must stay in the primary")
  await hooks.dispose()
})

test("fallback routing activates only after every primary slot is cooled", async () => {
  const parsed = pool.parseSlotText(`primary/a  1\nprimary/b  1\n${FALLBACK_MARKER}\nfallback/x  1\n`, "e2e")
  const stub = stubInput()
  const dir = scratch()
  const file = join(scratch(), "pool.txt")
  writeFileSync(file, `primary/a  1\nprimary/b  1\n${FALLBACK_MARKER}\nfallback/x  1\n`)
  const hooks = await bootLaCode(stub, { id: "e2e-fallback", dir, modelsFile: file })
  await hooks.config(configFor(parsed.slots.map((slot) => slot.model)))

  assert.equal(await spawnExplore(hooks, "f0"), "explore-1")
  assert.equal(await spawnExplore(hooks, "f1"), "explore-2")

  for (const [providerID, modelID] of [
    ["primary", "a"],
    ["primary", "b"],
  ]) {
    await emit(hooks, "message.updated", {
      info: { role: "assistant", providerID, modelID, error: { message: "Endpoint is unavailable" } },
    })
  }

  assert.equal(await spawnExplore(hooks, "f2"), "explore-3", "the fallback must route once the primary is exhausted")
  const status = (await hooks.tool.pool_status.execute({}, {})).output
  assert.match(status, /slot 3 .*fallback\/x.*\[fallback\]/, `the fallback slot must be the next one:\n${status}`)
  await hooks.dispose()
})

test("JSON fallbackSlots: an overlapping bucket is dropped and a reload sees the change", () => {
  const dir = scratch()
  const file = join(dir, "pool.json")
  writeFileSync(
    file,
    JSON.stringify({
      slots: [{ model: "opencode/a", weight: 1, bucket: "opencode", ceiling: 3 }],
      fallbackSlots: [
        { model: "opencode/b", weight: 1, bucket: "opencode" },
        { model: "other/c", weight: 1 },
      ],
    }),
  )

  const s = pool.state({ id: "e2e-json", dir, modelsFile: file })
  const warnings = []
  pool.init(s, (message) => warnings.push(message))

  assert.deepEqual(s.slots.map((slot) => slot.model), ["opencode/a", "other/c"])
  assert.equal(s.slots[0].ceiling, 3)
  assert.equal(s.slots[1].fallback, true)
  assert.ok(warnings.some((warning) => /shares a limit window/.test(warning)), `expected a disjointness warning: ${warnings}`)

  // The table is hot-reloadable: a new fallback and a ceiling change are a
  // changed signature, not a silent no-op.
  writeFileSync(
    file,
    JSON.stringify({
      slots: [{ model: "opencode/a", weight: 1, bucket: "opencode", ceiling: 5 }],
      fallbackSlots: [{ model: "other/c", weight: 1, ceiling: 2 }],
    }),
  )
  const reload = pool.reloadSlots(s, () => {})
  assert.equal(reload.changed, true)
  assert.equal(s.slots[0].ceiling, 5)
  assert.equal(s.slots[1].ceiling, 2)
  assert.equal(s.slots[1].fallback, true)
})

test("context-aware routing also deepens a slot toward its ceiling", () => {
  const dir = scratch()
  const s = pool.state({
    id: "e2e-context",
    dir,
    models: {
      slots: [
        { model: "ctx/a", weight: 1, ceiling: 2, context: 200_000 },
        { model: "ctx/b", weight: 1, context: 200_000 },
      ],
    },
  })
  pool.init(s, () => {})
  const [a, b] = s.slots

  pool.acquire(s, "explore", a, "ctx-1", "ctx-k1")
  let snap = pool.snapshot(s)
  assert.equal(pool.pickSlot(s, snap, 150_000)?.index, 2, "pass 1 prefers the empty slot")

  pool.acquire(s, "explore", b, "ctx-2", "ctx-k2")
  snap = pool.snapshot(s)
  assert.equal(pool.pickSlot(s, snap, 150_000)?.index, 1, "pass 2 deepens the under-ceiling slot")
  assert.equal(pool.poolPass(s, snap, 150_000), 2, "the status pass is the deepening pass")
})

test("a fallback slot naming a primary model is dropped even without an explicit bucket", () => {
  const parsed = pool.parseSlots(
    {
      slots: [{ model: "other/c", weight: 1 }],
      fallbackSlots: [{ model: "other/c", weight: 1 }],
    },
    "test",
  )
  assert.deepEqual(parsed.slots.map((slot) => slot.model), ["other/c"])
  assert.equal(parsed.slots[0].fallback, undefined)
  assert.ok(parsed.problems.some((problem) => /shares a limit window/.test(problem)))
})

test("pool_status judges structure on the primary and tags the fallback section", async () => {
  const text = [
    "opencode-go/a  4  c:1048576",
    "opencode/zen  2  b:opencode  c:1048576",
    FALLBACK_MARKER,
    "mistral/x  1  c:131072",
  ].join("\n")
  const parsed = pool.parseSlotText(text, "e2e")
  const stub = stubInput()
  const dir = scratch()
  const file = join(scratch(), "pool.txt")
  writeFileSync(file, text)
  const hooks = await bootLaCode(stub, { id: "e2e-status", dir, modelsFile: file })
  await hooks.config(configFor(parsed.slots.map((slot) => slot.model)))

  const status = (await hooks.tool.pool_status.execute({}, {})).output
  assert.match(status, /pool structure: intact/, `the fallback must not break the primary head/tail verdict:\n${status}`)
  assert.match(status, /2 primary slot\(s\) \+ 1 fallback slot\(s\)/, `the status must count both pools:\n${status}`)
  assert.match(status, /slot 3 w1  mistral\/x \[fallback\]/, `the fallback slot must be tagged:\n${status}`)
  await hooks.dispose()
})

test("structure and slot counts judge the primary only", () => {
  const text = [
    "opencode-go/a  4",
    "groq/a  2",
    "opencode/zen  2  b:opencode",
    FALLBACK_MARKER,
    "mistral/x  1",
  ].join("\n")
  const slots = parsePoolSlots(text)
  assert.equal(slots.filter((slot) => !slot.fallback).length, 3)
  assert.equal(slots.filter((slot) => slot.fallback).length, 1)
  // The head/tail contract is about the primary pool; the fallback must not
  // make a structurally sound primary read as broken.
  assert.equal(pool.parseSlotText(text, "e2e").problems.some((problem) => /structure/i.test(problem)), false)
})
