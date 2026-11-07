// Pool selection tests: the pure policy in scripts/pool-selection.mjs.
// Run with: node --test tests/pool-selection-test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"

import { retryAfterMs, selectPool } from "../scripts/pool-selection.mjs"

const NOW = Date.parse("2026-11-06T22:12:00.000Z")
const CREDIT_RETRY = NOW + 6 * 60 * 60 * 1000

const makeProviders = () => [
  { provider: "opencode-go", error: null, rows: [
    { model: "opencode-go/beam-free", ok: true, score: 96, context: 1048576 },
    { model: "opencode-go/crouton-alpha-free", ok: true, score: 95, context: 1048576 },
    { model: "opencode-go/iceman-contributor-free", ok: true, score: 88, context: 262144 },
  ]},
  { provider: "opencode", error: null, rows: [
    { model: "opencode/best-free", ok: true, score: 94, context: 1048576 },
    { model: "opencode/second-free", ok: true, score: 90, context: 1048576 },
    { model: "opencode/below-floor", ok: true, score: 99, context: 65536 },
  ]},
  { provider: "openrouter", error: null, rows: [
    { model: "openrouter/large-1", ok: true, score: 99, context: 1048576 },
    { model: "openrouter/large-2", ok: true, score: 98, context: 262144 },
    { model: "openrouter/small-1", ok: true, score: 90, context: 131072 },
    { model: "openrouter/small-2", ok: true, score: 89, context: 128000 },
    { model: "openrouter/small-3", ok: true, score: 88, context: 131000 },
  ]},
  { provider: "console-openrouter", error: null, rows: [
    { model: "console-openrouter/large-1", ok: true, score: 97, context: 1048576 },
    { model: "console-openrouter/small-1", ok: true, score: 91, context: 131072 },
  ]},
  { provider: "google", error: null, rows: [
    { model: "google/gemini-small", ok: true, score: 92, context: 131072 },
    { model: "google/gemini-large", ok: true, score: 93, context: 1048576 },
  ]},
]

const EXPECTED_SELECTION = [
  { model: "opencode-go/beam-free", weight: 4, context: 1048576 },
  { model: "opencode-go/crouton-alpha-free", weight: 4, context: 1048576 },
  { model: "opencode-go/iceman-contributor-free", weight: 4, context: 262144 },
  { model: "google/gemini-small", weight: 2, context: 131072 },
  { model: "console-openrouter/small-1", weight: 2, context: 131072 },
  { model: "openrouter/small-1", weight: 2, context: 131072 },
  { model: "openrouter/small-2", weight: 2, context: 128000 },
  { model: "openrouter/large-1", weight: 1, context: 1048576 },
  { model: "console-openrouter/large-1", weight: 1, context: 1048576 },
  { model: "google/gemini-large", weight: 1, context: 1048576 },
]

test("selectPool selects the expected 10 in order with no warnings", () => {
  const { selection, warnings } = selectPool({ providers: makeProviders() })
  assert.deepEqual(selection, EXPECTED_SELECTION)
  assert.deepEqual(warnings, [])
  assert.equal(selection.length, 10)
})

test("below-floor and per-provider-capped models are excluded; openrouter contributes 3", () => {
  const { selection } = selectPool({ providers: makeProviders() })
  const models = selection.map((row) => row.model)
  assert.ok(!models.includes("opencode/below-floor"))
  assert.ok(!models.includes("openrouter/small-3"))
  assert.equal(models.filter((m) => m.startsWith("openrouter/")).length, 3)
})

test("small tier is <200000 weight 2, large tier is >=200000 weight 1", () => {
  const { selection } = selectPool({ providers: makeProviders() })
  const small = selection.filter((row) => row.weight === 2)
  const large = selection.filter((row) => row.weight === 1)
  assert.ok(small.length > 0)
  assert.ok(large.length > 0)
  for (const row of small) assert.ok(row.context < 200000, `${row.model} context ${row.context}`)
  for (const row of large) assert.ok(row.context >= 200000, `${row.model} context ${row.context}`)
})

test("zen is 0 when pool is full; zen cap is 1 with only go + opencode", () => {
  const { selection } = selectPool({ providers: makeProviders() })
  assert.equal(selection.filter((row) => row.model.startsWith("opencode/")).length, 0)

  const providers = [
    { provider: "opencode-go", error: null, rows: [
      { model: "opencode-go/beam-free", ok: true, score: 96, context: 1048576 },
      { model: "opencode-go/crouton-alpha-free", ok: true, score: 95, context: 1048576 },
    ]},
    { provider: "opencode", error: null, rows: [
      { model: "opencode/best-free", ok: true, score: 94, context: 1048576 },
      { model: "opencode/second-free", ok: true, score: 90, context: 1048576 },
      { model: "opencode/third-free", ok: true, score: 89, context: 1048576 },
    ]},
  ]
  const result = selectPool({ providers })
  const zen = result.selection.filter((row) => row.model.startsWith("opencode/"))
  assert.equal(zen.length, 1)
  assert.deepEqual(zen, [{ model: "opencode/best-free", weight: 1, bucket: "opencode", context: 1048576 }])
})

test("transient credit fallback keeps the previous selection", () => {
  const previousProviders = makeProviders()
  const providers = makeProviders().map((entry) => ({
    ...entry,
    rows: entry.rows.map((row) => ({ ...row, ok: false, score: null, reason: "http 402: out of credits", retryAfter: CREDIT_RETRY })),
  }))
  const { selection, retry } = selectPool({ providers, previousProviders })
  assert.deepEqual(selection, EXPECTED_SELECTION)
  assert.equal(retry.after, new Date(CREDIT_RETRY).toISOString())
})

test("hard failure drops that model from fallback", () => {
  const previousProviders = makeProviders()
  const providers = makeProviders().map((entry) => ({
    ...entry,
    rows: entry.rows.map((row) =>
      row.model === "opencode-go/beam-free"
        ? { ...row, ok: false, score: null, reason: "not served: 404" }
        : { ...row, ok: false, score: null, reason: "http 402: out of credits", retryAfter: CREDIT_RETRY },
    ),
  }))
  const { selection } = selectPool({ providers, previousProviders })
  const models = selection.map((row) => row.model)
  assert.ok(!models.includes("opencode-go/beam-free"))
  assert.ok(models.includes("opencode-go/crouton-alpha-free"))
})

test("retryAfterMs honours stated windows, headers, daily resets, and credit", () => {
  assert.equal(retryAfterMs("retry in 30 seconds", undefined, NOW), NOW + 30_000)
  assert.equal(retryAfterMs("resets in 2 hours", undefined, NOW), NOW + 7_200_000)
  assert.equal(retryAfterMs("free-models-per-day", undefined, Date.parse("2026-11-06T22:12:00Z")), Date.parse("2026-11-07T00:00:00Z"))
  assert.equal(retryAfterMs("Rate limit exceeded", "120", NOW), NOW + 120_000)
  assert.equal(retryAfterMs("http 402: out of credits", undefined, NOW), CREDIT_RETRY)
  assert.equal(retryAfterMs("answered", undefined, NOW), undefined)
})
