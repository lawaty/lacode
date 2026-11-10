// Pool selection tests: the pure policy in scripts/pool-selection.mjs.
// Run with: node --test tests/pool-selection-test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  SYNTHETIC_RETRY_MS,
  classifyFailure,
  isTransientKind,
  providerRank,
  retryAfterMs,
  selectPool,
} from "../scripts/pool-selection.mjs"

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
  { model: "openrouter/large-1", weight: 1, context: 1048576 },
  { model: "console-openrouter/large-1", weight: 1, context: 1048576 },
  { model: "google/gemini-large", weight: 1, context: 1048576 },
  { model: "opencode/best-free", weight: 2, bucket: "opencode", context: 1048576 },
]

test("selectPool selects the expected 10 in order with no warnings", () => {
  const { selection, warnings } = selectPool({ providers: makeProviders() })
  assert.deepEqual(selection, EXPECTED_SELECTION)
  assert.deepEqual(warnings, [])
  assert.equal(selection.length, 10)
})

test("below-floor and per-provider-capped models are excluded; the reserve costs openrouter one slot", () => {
  const { selection } = selectPool({ providers: makeProviders() })
  const models = selection.map((row) => row.model)
  assert.ok(!models.includes("opencode/below-floor"))
  assert.ok(!models.includes("openrouter/small-3"))
  assert.equal(models.filter((m) => m.startsWith("openrouter/")).length, 2)
})

test("small tier is <200000 weight 2, large tier is >=200000 weight 1; zen is the reserved exception", () => {
  const { selection } = selectPool({ providers: makeProviders() })
  const small = selection.filter((row) => row.weight === 2 && !row.bucket)
  const large = selection.filter((row) => row.weight === 1)
  assert.ok(small.length > 0)
  assert.ok(large.length > 0)
  for (const row of small) assert.ok(row.context < 200000, `${row.model} context ${row.context}`)
  for (const row of large) assert.ok(row.context >= 200000, `${row.model} context ${row.context}`)
  const zen = selection.find((row) => row.bucket === "opencode")
  assert.ok(zen && zen.weight === 2 && zen.context >= 200000, `zen is the weight-2 large-context reserve, got ${JSON.stringify(zen)}`)
})

test("zen is reserved exactly one slot, even when the other providers fill the pool", () => {
  const { selection } = selectPool({ providers: makeProviders() })
  const zen = selection.filter((row) => row.model.startsWith("opencode/"))
  assert.equal(zen.length, 1)
  assert.equal(zen[0].model, "opencode/best-free")
  assert.equal(zen[0].weight, 2)

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
  const secondZen = result.selection.filter((row) => row.model.startsWith("opencode/"))
  assert.equal(secondZen.length, 1)
  assert.deepEqual(secondZen, [{ model: "opencode/best-free", weight: 2, bucket: "opencode", context: 1048576 }])
})

test("transient credit fallback keeps the previous selection", () => {
  const previousProviders = makeProviders()
  const providers = makeProviders().map((entry) => ({
    ...entry,
    rows: entry.rows.map((row) => ({ ...row, ok: false, score: null, reason: "http 402: out of credits", retryAfter: CREDIT_RETRY })),
  }))
  const { selection, retry } = selectPool({ providers, previousProviders, now: NOW })
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
  const { selection } = selectPool({ providers, previousProviders, now: NOW })
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

test("classifyFailure names the fault from the status, with prose as the fallback", () => {
  assert.equal(classifyFailure({ status: 402 }), "credit")
  assert.equal(classifyFailure({ status: 429 }), "rate-limited")
  assert.equal(classifyFailure({ status: 401 }), "credential")
  assert.equal(classifyFailure({ status: 403, reason: "Forbidden: Model Agreement: ..." }), "agreement")
  assert.equal(classifyFailure({ status: 403, reason: "Forbidden" }), "credential")
  assert.equal(classifyFailure({ status: 404 }), "not-served")
  assert.equal(classifyFailure({ status: 503 }), "server")
  assert.equal(classifyFailure({ reason: "timeout after 45000ms" }), "timeout")
  assert.equal(classifyFailure({ reason: "fetch failed" }), "network")
  assert.equal(classifyFailure({ reason: "Payment required" }), "credit")
  assert.equal(classifyFailure({ reason: "free-tier quota exceeded" }), "rate-limited")
  assert.equal(classifyFailure({ reason: "something else" }), "unknown")
  assert.equal(classifyFailure({ kind: "Credit" }), "credit")
})

test("only transient kinds are retried; agreement, credential and not-served are permanent", () => {
  for (const kind of ["credit", "rate-limited", "timeout", "network", "server"]) {
    assert.equal(isTransientKind(kind), true, `${kind} must be transient`)
  }
  for (const kind of ["agreement", "credential", "not-served", "unknown"]) {
    assert.equal(isTransientKind(kind), false, `${kind} must be permanent`)
  }
})

test("a transient timeout with no reset gets a synthetic retry, a permanent 404 does not", () => {
  const transient = [
    {
      provider: "slow",
      error: null,
      rows: [{ model: "slow/a", ok: false, score: null, reason: "timeout after 45000ms", context: 200000 }],
    },
  ]
  const retried = selectPool({ providers: transient, now: NOW })
  assert.ok(retried.retry, "a transient timeout must schedule a retry")
  assert.deepEqual(retried.retry.models, ["slow/a"])
  assert.equal(retried.retry.after, new Date(NOW + SYNTHETIC_RETRY_MS).toISOString())

  const permanent = [
    {
      provider: "gone",
      error: null,
      rows: [{ model: "gone/a", ok: false, score: null, reason: "not served: 404", context: 200000 }],
    },
  ]
  assert.equal(selectPool({ providers: permanent, now: NOW }).retry, undefined)
})

test("a stored kind wins over the reason prose when deciding fallback", () => {
  const previousProviders = makeProviders()
  const mislabeled = makeProviders().map((entry) => ({
    ...entry,
    rows: entry.rows.map((row) =>
      row.model === "opencode-go/beam-free"
        ? { ...row, ok: false, score: null, reason: "timeout after 45000ms", kind: "credential" }
        : row,
    ),
  }))
  const { selection } = selectPool({ providers: mislabeled, previousProviders, now: NOW })
  assert.ok(!selection.some((row) => row.model === "opencode-go/beam-free"), "a credential kind must not fall back")

  const relabeled = makeProviders().map((entry) => ({
    ...entry,
    rows: entry.rows.map((row) =>
      row.model === "opencode-go/beam-free"
        ? { ...row, ok: false, score: null, reason: "not served: 404", kind: "timeout" }
        : row,
    ),
  }))
  const kept = selectPool({ providers: relabeled, previousProviders, now: NOW })
  assert.ok(kept.selection.some((row) => row.model === "opencode-go/beam-free"), "a timeout kind must fall back")
})

test("a provider that was not scanned keeps its previous rows", () => {
  const previousProviders = makeProviders()
  const onlyGo = [previousProviders[0]]
  const { selection } = selectPool({ providers: onlyGo, previousProviders, now: NOW })
  assert.ok(
    selection.some((row) => row.model === "google/gemini-small"),
    `unscanned providers must survive a targeted scan, got ${selection.map((r) => r.model).join(", ")}`,
  )
})

test("a truncated provider keeps its previous rows", () => {
  const previousProviders = makeProviders()
  const truncated = makeProviders().map((entry) =>
    entry.provider === "google" ? { ...entry, truncated: true, rows: [] } : entry,
  )
  const { selection } = selectPool({ providers: truncated, previousProviders, now: NOW })
  assert.ok(
    selection.some((row) => row.model.startsWith("google/")),
    `a budget-truncated provider must survive, got ${selection.map((r) => r.model).join(", ")}`,
  )
})

test("a provider with nothing rankable says so, naming the dominant failure", () => {
  const providers = [
    {
      provider: "dead",
      error: null,
      rows: [
        { model: "dead/a", ok: false, reason: "timeout after 45000ms" },
        { model: "dead/b", ok: false, reason: "timeout after 45000ms" },
        { model: "dead/c", ok: false, reason: "not served: 404" },
      ],
    },
  ]
  const { warnings } = selectPool({ providers, now: NOW })
  assert.ok(
    warnings.some((w) => w.includes("dead: 3 probed, 0 rankable") && w.includes("timeout (2)")),
    `the dead provider must be named with its dominant failure, got ${JSON.stringify(warnings)}`,
  )

  const errored = selectPool({ providers: [{ provider: "broken", error: "opencode models failed", rows: [] }], now: NOW })
  assert.ok(
    errored.warnings.some((w) => w === "broken: opencode models failed"),
    `a provider-level error must be surfaced, got ${JSON.stringify(errored.warnings)}`,
  )
})

test("providerRank scans the core providers before the paid catalogues", () => {
  assert.equal(providerRank("opencode-go"), 0)
  assert.equal(providerRank("opencode"), 0)
  assert.equal(providerRank("groq"), 1)
  assert.equal(providerRank("cloudflare-workers-ai"), 1)
  assert.equal(providerRank("console-openrouter"), 2)
  assert.equal(providerRank("openrouter"), 2)
})
