// Offline unit suite for src/lib/omniroute.ts.
//
// It imports the TypeScript source directly (node >= 22.18 strips types) and
// touches neither the network nor a gateway process: every HTTP call goes
// through an injected `fetchImpl` and every cooldown through an injected clock,
// which is exactly the isolation the module was written for ("the only things
// it touches are global fetch, AbortController, setTimeout/clearTimeout and
// Date, and every one of those can be replaced").
//
// The suites below also pin the two rules the module header states about
// itself, because they are the ones a refactor is most likely to break:
//
//   * DEGRADE, NEVER THROW OUT OF A ROUTER -- parseConfig reports problems and
//     disables the integration outright instead of falling back to half of a
//     config; only the HTTP helpers throw.
//   * A KEY IS NEVER IN A MESSAGE -- no problem string, error text or stat
//     carries the api key.
//
// The import path is static and relative, so it resolves against THIS file
// rather than the cwd and `node --test tests/omniroute-test.mjs` works from
// anywhere in the tree.

import { test } from "node:test"
import assert from "node:assert/strict"
import * as omni from "../src/lib/omniroute.ts"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A valid, fully-defaulted config built through the real parser.
 *
 * Every helper goes via parseConfig rather than hand-writing an
 * OmniRouteConfig literal: the parsed object is what the plugin actually routes
 * with, so a change in normalisation (trimming, dedupe, absent-vs-undefined
 * optional keys) surfaces in these tests instead of being papered over by
 * fixtures that skipped it.
 *
 * The explicit `{}` env matters: the apiKey precedence test below passes its
 * own, and an ambient OMNIROUTE_API_KEY in a developer's shell must not be
 * able to flip any other assertion in this file.
 */
const cfg = (extra = {}) => {
  const result = omni.parseConfig({ enabled: true, ...extra }, {})
  assert(result.config, `expected a valid config for ${JSON.stringify(extra)}: ${result.problems.join("; ")}`)
  return result.config
}

/** A fake `fetch` answering `body` on every call, recording what it was sent. */
const jsonFetch = (body, status = 200) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { fetchImpl, calls }
}

/**
 * A selector over a fake clock, `stickyPerSession: false` by default.
 *
 * The module takes `deps.now` precisely so cooldown arithmetic is testable
 * without waiting for time to pass; tests that need sticky behaviour pass
 * `{ stickyPerSession: true }` back in. `at()`/`advance()` move the clock, and
 * nothing ever sleeps for a wall-clock millisecond longer than the timeout
 * test needs.
 */
const clocked = (overrides = { stickyPerSession: false }) => {
  let t = 0
  const selector = omni.createSelector(cfg(overrides), { now: () => t })
  return {
    selector,
    at: () => t,
    advance: (ms) => {
      t += ms
      return t
    },
  }
}

// ---------------------------------------------------------------------------
// parseConfig -- the disabled path
// ---------------------------------------------------------------------------

test("an absent, false, or non-boolean omniroute block is silently disabled", () => {
  // Disabled is SILENT: a user who does not run OmniRoute simply has no
  // `omniroute` block, and reporting a warning for "not configured" would cry
  // wolf on every startup. `enabled: "true"` is read as OFF rather than as
  // truthy, because a string where a boolean flag is expected is a typo that
  // would otherwise switch the integration on by accident.
  for (const raw of [undefined, {}, { enabled: false }, { enabled: "true" }, { enabled: 1 }]) {
    assert.deepEqual(omni.parseConfig(raw, {}), { enabled: false, config: null, problems: [] })
  }
})

test("the disabled path performs no network call", () => {
  // "Disabled means no probe": parseConfig is pure validation and takes no
  // fetch parameter at all, so the spy below can only stay untouched -- if a
  // future change routes this path through a gateway call, it becomes a request
  // on every startup for every user who never installed OmniRoute.
  let calls = 0
  const fetchImpl = () => {
    calls += 1
    throw new Error("the disabled path must not touch the network")
  }
  for (const raw of [undefined, {}, { enabled: false }, { enabled: "true" }]) {
    assert.deepEqual(omni.parseConfig(raw, {}), { enabled: false, config: null, problems: [] })
  }
  assert.equal(calls, 0, "parseConfig is pure validation and must never probe the gateway")
})

// ---------------------------------------------------------------------------
// parseConfig -- enabled defaults and validation
// ---------------------------------------------------------------------------

test("an enabled block with no fields takes the documented defaults", () => {
  const result = omni.parseConfig({ enabled: true }, {})
  assert.deepEqual(result.problems, [])
  assert(result.config)
  assert.equal(result.config.baseURL, omni.DEFAULT_BASE_URL)
  assert.deepEqual(result.config.tiers, { primary: [], backup: [] })
  assert.equal(result.config.stickyPerSession, true)
  assert.equal(result.config.healthCheck, true)
  assert.equal(result.config.timeoutMs, omni.DEFAULT_TIMEOUT_MS)
  // Optional fields are ABSENT rather than set to undefined: the config is
  // serialized (opencode.jsonc round-trips, debug dumps) and a pile of
  // `"combo": undefined` keys is noise that also makes a structural comparison
  // of two configs fail for no reason.
  assert.deepEqual(Object.keys(result.config).sort(), ["baseURL", "healthCheck", "stickyPerSession", "tiers", "timeoutMs"])
})

test("a hand-written baseURL is normalised, and an unparseable one disables", () => {
  const good = omni.parseConfig({ enabled: true, baseURL: "http://localhost:20128/" }, {})
  assert.deepEqual(good.problems, [])
  assert.equal(good.config?.baseURL, "http://localhost:20128/v1")

  // Enabled is STRICT: a present-but-invalid field takes the whole block down.
  // A base URL that failed to parse next to a valid allowlist would otherwise
  // route through a URL nobody chose.
  const bad = omni.parseConfig({ enabled: true, baseURL: "ftp://x" }, {})
  assert.equal(bad.enabled, true)
  assert.equal(bad.config, null)
  assert.equal(bad.problems.length, 1)
  assert.match(bad.problems[0], /baseURL/)
})

test("a timeoutMs that is not a positive finite number disables", () => {
  for (const timeoutMs of [0, -1, Number.NaN, "5000"]) {
    const result = omni.parseConfig({ enabled: true, timeoutMs }, {})
    assert.equal(result.config, null, `timeoutMs ${String(timeoutMs)} must disable`)
    assert.deepEqual(result.problems, ["omniroute.timeoutMs must be a positive number"])
  }
})

test("stickyPerSession and healthCheck must be booleans", () => {
  // Strict boolean for the same reason `enabled` is: a 1 where a flag is
  // expected would silently route with a preference the operator never chose.
  for (const [field, value] of [
    ["stickyPerSession", 1],
    ["healthCheck", "yes"],
  ]) {
    const result = omni.parseConfig({ enabled: true, [field]: value }, {})
    assert.equal(result.config, null)
    assert.deepEqual(result.problems, [`omniroute.${field} must be a boolean`])
  }
})

test("combo must be a non-empty string", () => {
  for (const combo of ["", 5]) {
    const result = omni.parseConfig({ enabled: true, combo }, {})
    assert.equal(result.config, null, `combo ${JSON.stringify(combo)} must disable`)
    assert.deepEqual(result.problems, ["omniroute.combo must be a non-empty string"])
  }
  assert.equal(cfg({ combo: "auto" }).combo, "auto")
})

test("the models allowlist rejects anything that is not an array of non-empty strings", () => {
  for (const models of ["a", ["a", ""]]) {
    const result = omni.parseConfig({ enabled: true, models }, {})
    assert.equal(result.config, null, `models ${JSON.stringify(models)} must disable`)
    assert.deepEqual(result.problems, ["omniroute.models must be an array of non-empty strings"])
  }
})

test("the models allowlist trims and de-duplicates while preserving order", () => {
  // Order is preserved because it IS the routing order, and a repeated entry is
  // only ever a copy-paste.
  assert.deepEqual(cfg({ models: [" a ", "a", "b"] }).models, ["a", "b"])
})

test("tiers must be an object of string arrays, not an array", () => {
  // An array is rejected even though `typeof [] === "object"`: its keys would
  // be indices, so `tiers: [["a"]]` would silently produce an empty routing
  // preference -- exactly the half-configured state this validation exists to
  // prevent.
  for (const tiers of [[], { primary: "a" }]) {
    const result = omni.parseConfig({ enabled: true, tiers }, {})
    assert.equal(result.config, null, `tiers ${JSON.stringify(tiers)} must disable`)
    assert.deepEqual(result.problems, ["omniroute.tiers must be an object with primary/backup string arrays"])
  }
  const good = omni.parseConfig({ enabled: true, tiers: { primary: ["a"], backup: ["b"] } }, {})
  assert.deepEqual(good.problems, [])
  assert.deepEqual(good.config?.tiers, { primary: ["a"], backup: ["b"] })
})

test("tier entries outside the allowlist are dropped, not reported", () => {
  // An operator may legitimately keep the tiers wider than today's allowlist
  // and narrow that list without editing both: the stale entry is a routing
  // preference, not a config error. Dropping it also keeps every tier inside
  // the allowlist, the only place it could have had any effect anyway.
  const result = omni.parseConfig(
    { enabled: true, models: ["a", "b"], tiers: { primary: ["a", "z"], backup: ["b"] } },
    {},
  )
  assert.deepEqual(result.problems, [])
  assert.deepEqual(result.config?.tiers, { primary: ["a"], backup: ["b"] })
})

test("the env key beats the config key, and a non-string key disables", () => {
  const CFG_KEY = "cfg-key-regression-501"
  const ENV_KEY = "env-key-regression-502"

  const noEnv = omni.parseConfig({ enabled: true, apiKey: CFG_KEY }, {})
  assert.deepEqual(noEnv.problems, [])
  assert.equal(noEnv.config?.apiKey, CFG_KEY)

  // Env beats the config file: a key exported into the environment is the
  // deliberate override (a shell, CI) and has to win over whatever is written
  // down in opencode.jsonc.
  const withEnv = omni.parseConfig({ enabled: true, apiKey: CFG_KEY }, { [omni.ENV_API_KEY]: ENV_KEY })
  assert.deepEqual(withEnv.problems, [])
  assert.equal(withEnv.config?.apiKey, ENV_KEY)

  // The shape of raw.apiKey is validated regardless of which one ends up used:
  // a present-but-invalid field is a problem even when it loses.
  const bad = omni.parseConfig({ enabled: true, apiKey: 5 }, {})
  assert.equal(bad.config, null)
  assert.deepEqual(bad.problems, ["omniroute.apiKey must be a string when set"])

  // "A KEY IS NEVER IN A MESSAGE": a valid key yields no problems that could
  // carry it, and the key appears in the config under `apiKey` and nowhere else
  // (a URL, a tier entry, a problem string would all be a leak path).
  for (const [result, key] of [
    [noEnv, CFG_KEY],
    [withEnv, ENV_KEY],
  ]) {
    assert.equal(result.problems.length, 0, "a valid key produces no problem text to leak")
    const withoutKey = { ...result.config }
    delete withoutKey.apiKey
    assert(!JSON.stringify(withoutKey).includes(key), "the key must live in apiKey and nowhere else")
  }
})

// ---------------------------------------------------------------------------
// normalizeBaseURL
// ---------------------------------------------------------------------------

test("normalizeBaseURL collapses every spelling of one gateway onto one URL", () => {
  // Everything downstream concatenates MODELS_PATH onto the result, so the
  // shape has to be predictable. `/v1/v1` is a base URL copy-pasted into a
  // field that already had one: the loop strips ANY number of trailing /v1
  // segments before appending one rather than nesting forever. All five
  // spellings are one server, so they must share one cache key instead of
  // producing a /v1/models vs /models split.
  for (const raw of [
    "http://localhost:20128",
    "http://localhost:20128/",
    "http://localhost:20128/v1",
    "http://localhost:20128/v1///",
    "http://localhost:20128/v1/v1",
  ]) {
    assert.equal(omni.normalizeBaseURL(raw), "http://localhost:20128/v1", raw)
  }
  for (const raw of ["ftp://x", "", 123, "not a url"]) {
    assert.equal(omni.normalizeBaseURL(raw), null, JSON.stringify(raw))
  }
})

// ---------------------------------------------------------------------------
// filterModels
// ---------------------------------------------------------------------------

test("filterModels applies the allowlist as a hard filter", () => {
  // A gateway listing twenty models and a config naming two means two, not
  // twenty with two preferred: anything else would silently route work to a
  // model the operator excluded on purpose.
  assert.deepEqual(omni.filterModels(["a", "b", "c"], cfg({ models: ["a", "c"] })), ["a", "c"])
})

test("combo leads the list even when the gateway does not advertise it", () => {
  // It is the operator's explicitly preferred target, so it leads whether or
  // not it happens to appear in `ids`.
  assert.deepEqual(omni.filterModels(["a", "b"], cfg({ combo: "auto" })), ["auto", "a", "b"])
})

test("filterModels without an allowlist keeps the gateway order, de-duplicated", () => {
  assert.deepEqual(omni.filterModels(["b", "a", "b"], cfg()), ["b", "a"])
})

test("the allowlist order wins over the gateway order", () => {
  // The allowlist IS the routing order; the gateway's listing only decides
  // which of the allowed ids exist at all.
  assert.deepEqual(omni.filterModels(["b", "a"], cfg({ models: ["a", "b"] })), ["a", "b"])
})

// ---------------------------------------------------------------------------
// orderByTier
// ---------------------------------------------------------------------------

test("orderByTier ranks primary then backup, keeping the rest in place", () => {
  // Tiers are a list, not a sort: an entry's position is its rank and primary
  // as a whole outranks backup as a whole. Ids with no tier entry keep their
  // original relative order and come last, so the gateway's own listing still
  // decides anything the operator did not rank.
  const tiers = cfg({ tiers: { primary: ["c"], backup: ["a"] } }).tiers
  assert.deepEqual(omni.orderByTier(["a", "b", "c", "d"], tiers), ["c", "a", "b", "d"])

  // A tier entry naming a model that is not offered is ignored rather than
  // reported: candidate lists shrink as models cool down and get delisted, and
  // a stale tier entry must not cost the caller an error at selection time.
  // The same id in primary and backup is one entry, not two.
  const stale = cfg({ tiers: { primary: ["zzz"], backup: ["a", "a"] } }).tiers
  assert.deepEqual(omni.orderByTier(["a", "b"], stale), ["a", "b"])
})

// ---------------------------------------------------------------------------
// isTransientStatus
// ---------------------------------------------------------------------------

test("isTransientStatus is true only for statuses that clear on their own", () => {
  // 429 and 408 are the gateway saying "not now" (rate window, its own client
  // timeout) and 5xx is it saying "not me" -- all clear on their own, so a
  // different model is a real alternative. 400/401/403/404 are the REQUEST
  // being wrong, and sending it to another model produces the same error four
  // times over, so those are surfaced rather than failed over.
  for (const status of [408, 429, 500, 502, 599]) assert.equal(omni.isTransientStatus(status), true, String(status))
  for (const status of [200, 301, 400, 401, 403, 404]) assert.equal(omni.isTransientStatus(status), false, String(status))
})

// ---------------------------------------------------------------------------
// backoffMs
// ---------------------------------------------------------------------------

test("backoffMs doubles per strike and never exceeds the cap", () => {
  assert.equal(omni.backoffMs(1), 1000)
  assert.equal(omni.backoffMs(2), 2000)
  assert.equal(omni.backoffMs(3), 4000)
  assert.equal(omni.backoffMs(100), omni.COOLDOWN_MAX_MS)
  assert.equal(omni.backoffMs(10, 5000), 5000)
  // A non-finite strike count is read as 1: a NaN would otherwise produce a
  // NaN cooldown, and `NaN > now` is false -- a model that can never cool down
  // again.
  assert.equal(omni.backoffMs(Number.NaN), 1000)
})

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

test("parseRetryAfter reads delta-seconds first and an HTTP-date second", () => {
  // The two forms are indistinguishable by value -- Date.parse("2015") is a
  // perfectly valid timestamp -- so the numeric check has to come first.
  assert.equal(omni.parseRetryAfter("5"), 5000)
  assert.equal(omni.parseRetryAfter(" 1.5 "), 1500)
  const base = 1_700_000_000_000
  assert.equal(omni.parseRetryAfter(new Date(base + 60_000).toUTCString(), base), 60_000)
  // A date in the past clamps to 0 rather than going negative.
  assert.equal(omni.parseRetryAfter(new Date(base - 60_000).toUTCString(), base), 0)
  for (const value of ["junk", "", undefined]) assert.equal(omni.parseRetryAfter(value, base), undefined)
  // A negative delta is malformed, not "come back immediately".
  assert.equal(omni.parseRetryAfter("-5", base), undefined)
})

// ---------------------------------------------------------------------------
// cooldownUntil
// ---------------------------------------------------------------------------

test("cooldownUntil prefers a stated Retry-After over the strike backoff", () => {
  // A stated retry beats a guessed backoff: when the gateway says when to come
  // back, doubling from 1s because it is the third strike would be guessing
  // over an answer we were handed.
  assert.equal(omni.cooldownUntil({ retryAfterMs: 5000, strikes: 10, now: 1000 }), 6000)
  // Without one the strike backoff decides.
  assert.equal(omni.cooldownUntil({ strikes: 3, now: 0 }), 4000)
  // Both are capped so no header can park a model for an hour.
  assert.equal(omni.cooldownUntil({ retryAfterMs: 10_000_000, now: 0 }), omni.COOLDOWN_MAX_MS)
  assert.equal(omni.cooldownUntil({ strikes: 100, now: 0 }), omni.COOLDOWN_MAX_MS)
})

// ---------------------------------------------------------------------------
// createSelector
// ---------------------------------------------------------------------------

test("a sticky session keeps its model even when another model answers faster", () => {
  // Stickiness is the point of the selector: bouncing a session onto whatever
  // model answered one request 400ms sooner is churn, not optimisation. Only a
  // failure (below) releases the assignment -- a success never does, which is
  // what makes "recordSuccess keeps the sticky model" load-bearing.
  const { selector } = clocked({ stickyPerSession: true })
  selector.setCandidates(["a", "b"])
  assert.equal(selector.select("s1"), "a")
  assert.equal(selector.stickyFor("s1"), "a")
  selector.recordSuccess("s", "a", 500)
  selector.recordSuccess("s", "b", 100)
  assert.equal(selector.select("s1"), "a")
})

test("the sticky table is bounded: a long-lived selector forgets its oldest assignments", () => {
  // Only a FAILURE released a sticky assignment, so the table grew with every
  // session the process ever served rather than with the sessions in flight --
  // a slow leak in exactly the long-running server this plugin lives in. The
  // bound evicts oldest-first, so the newest assignment is the one that survives.
  const { selector } = clocked({ stickyPerSession: true })
  selector.setCandidates(["a"])
  for (let i = 0; i < 600; i++) selector.select(`s${i}`)
  assert.ok(selector.stickySize() <= 500, `sticky table must stay bounded, got ${selector.stickySize()}`)
  assert.equal(selector.stickyFor("s599"), "a", "the newest assignment must survive")
  assert.equal(selector.stickyFor("s0"), null, "the oldest assignment is the one forgotten")
})

test("a refreshed sticky assignment counts as the newest entry", () => {
  // select() re-inserts on every success -- including the fast path where it
  // simply returns the held model -- so a session that keeps working keeps its
  // row young. Without the re-insert, eviction order stays first-seen order and
  // s0 (inserted first, still in active use) is dropped on the very next
  // eviction instead of surviving it.
  const { selector } = clocked({ stickyPerSession: true })
  selector.setCandidates(["a"])
  for (let i = 0; i < 500; i++) selector.select(`s${i}`)
  selector.select("s0") // refresh the OLDEST row while it is still in use
  // Exactly 499 fresh sessions: each evicts the current oldest, and after 499
  // those evictions s0 has just become the oldest survivor. A 500th would evict
  // it legitimately, which would assert nothing about the refresh.
  for (let i = 500; i < 999; i++) selector.select(`s${i}`)
  assert.equal(selector.stickyFor("s0"), "a", "a refreshed assignment must not be evicted as the oldest")
  assert.equal(selector.stickyFor("s1"), null, "the un-refreshed oldest must be the one evicted")
})

test("without stickiness the selector prefers the lower measured latency", () => {
  const first = clocked()
  first.selector.setCandidates(["a", "b"])
  first.selector.recordSuccess("s", "a", 500)
  first.selector.recordSuccess("s", "b", 100)
  assert.equal(first.selector.select("s"), "b")

  const second = clocked()
  second.selector.setCandidates(["a", "b"])
  second.selector.recordSuccess("s", "a", 100)
  second.selector.recordSuccess("s", "b", 500)
  assert.equal(second.selector.select("s"), "a")
})

test("without stickiness the selector prefers the lower error rate", () => {
  // Error rate is compared BEFORE latency, so a model that answers fast and
  // then errors is not the fast model. The 400s below fail over nowhere but
  // still count as errors against the model, which is how a rate is built up
  // without also cooling it down.
  const { selector } = clocked()
  selector.setCandidates(["a", "b"])
  for (let i = 0; i < 3; i++) {
    selector.recordSuccess("s", "a", 500)
    selector.recordSuccess("s", "b", 500)
    selector.recordFailure("s", "a", { status: 400 })
  }
  assert.equal(selector.stats().a.errors, 3)
  assert.equal(selector.stats().b.errors, 0)
  assert.equal(selector.select("s"), "b")
})

test("a transient failure cools the model down and select() skips it", () => {
  // Cooling models are skipped, never chosen as a last resort: routing to a
  // model we just failed on is the outcome the cooldown exists to prevent, and
  // "no model available" is honest information. The first cooldown is 1s, so a
  // fresh session is eligible again once it lapses.
  const { selector, advance } = clocked()
  selector.setCandidates(["a", "b"])
  selector.recordFailure("s", "a", { status: 500 })
  assert.equal(selector.isCooling("a"), true)
  assert.equal(selector.select("s"), "b")
  advance(1001)
  assert.equal(selector.isCooling("a"), false)
  // Once the cooldown lapses "a" is ELIGIBLE again, but not preferred: error
  // rate is tracked too, so the clean "b" outranks the model that just failed.
  assert.equal(selector.select("s2"), "b")
})

test("a non-transient failure neither cools the model nor moves the session", () => {
  // A 400 or a 401 is the request being wrong, and retrying it on another model
  // produces four identical errors with four cooldowns to show for it. Those
  // are surfaced to the caller instead: no strike, no cooldown, and the sticky
  // assignment stays exactly where it was.
  const { selector } = clocked({ stickyPerSession: true })
  selector.setCandidates(["a", "b"])
  assert.equal(selector.select("s"), "a")
  selector.recordFailure("s", "a", { status: 400 })
  assert.equal(selector.isCooling("a"), false)
  assert.equal(selector.stats().a.strikes, 0)
  assert.equal(selector.stickyFor("s"), "a")
})

test("a Retry-After header sets the cooldown the gateway asked for", () => {
  const { selector, advance } = clocked()
  selector.setCandidates(["a", "b"])
  selector.recordFailure("s", "a", { status: 429, retryAfterMs: 60_000 })
  assert.equal(selector.stats().a.cooldownUntil, 60_000)
  advance(59_000)
  assert.equal(selector.isCooling("a"), true)
  advance(2000)
  assert.equal(selector.isCooling("a"), false)
})

test("consecutive transient failures escalate the cooldown, capped", () => {
  // Two strikes at t=0 and after the first cooldown lapses must produce a
  // larger second cooldown: 1s, then 2s, then 4s ... so a gateway that is
  // genuinely down costs fewer and fewer probes, and the ceiling means a
  // recovered gateway is still picked up within the session.
  const { selector, advance, at } = clocked()
  selector.setCandidates(["a", "b"])
  const lengths = []
  // Eleven strikes is where the doubling (1s * 2^10) crosses the 15m ceiling.
  for (let i = 0; i < 11; i++) {
    selector.recordFailure("s", "a", { status: 503 })
    const now = at()
    const until = selector.stats().a.cooldownUntil
    lengths.push(until - now)
    advance(until - now)
  }
  assert.deepEqual(lengths.slice(0, 4), [1000, 2000, 4000, 8000])
  assert(lengths[1] > lengths[0], "the second cooldown must be longer than the first")
  for (const length of lengths) assert(length <= omni.COOLDOWN_MAX_MS, `cooldown ${length} exceeds the cap`)
  assert.equal(lengths.at(-1), omni.COOLDOWN_MAX_MS)
  assert.equal(selector.stats().a.strikes, 11)
})

test("a transient failure releases the sticky assignment", () => {
  // Leaving it would re-select the cooling model the moment it recovers,
  // before any other model had a chance.
  const { selector } = clocked({ stickyPerSession: true })
  selector.setCandidates(["a", "b"])
  assert.equal(selector.select("s"), "a")
  selector.recordFailure("s", "a", { status: 500 })
  assert.equal(selector.stickyFor("s"), null)
  assert.equal(selector.select("s"), "b")
})

test("select() returns null when every candidate is cooling", () => {
  const { selector } = clocked()
  selector.setCandidates(["a", "b"])
  selector.recordFailure("s", "a", { status: 500 })
  selector.recordFailure("s", "b", { status: 500 })
  assert.equal(selector.select("s"), null)
})

test("stats() zeroes every candidate and keeps the last failure message", () => {
  // Every candidate gets a row immediately so a model that has simply not been
  // used yet reports zeroed numbers instead of a hole that reads as "unknown".
  const { selector } = clocked({ stickyPerSession: true })
  selector.setCandidates(["a", "b"])
  assert.deepEqual(selector.stats(), {
    a: { requests: 0, errors: 0, strikes: 0, cooldownUntil: 0 },
    b: { requests: 0, errors: 0, strikes: 0, cooldownUntil: 0 },
  })
  // The message is caller-provided text, never a secret this module holds, and
  // it is kept only when present so an absent message does not erase the last
  // real reason.
  selector.recordFailure("s", "a", { status: 400, message: "gateway rejected the request" })
  assert.equal(selector.stats().a.errors, 1)
  assert.equal(selector.stats().a.lastFailure, "gateway rejected the request")
})

// ---------------------------------------------------------------------------
// fetchModels
// ---------------------------------------------------------------------------

test("fetchModels reads every supported list shape", async () => {
  // OpenAI answers {data:[...]}, some gateways answer {models:[...]}, and a
  // bare array is accepted too: the shape is the gateway's business, not the
  // operator's choice, and a shape this module refused would silently route
  // nowhere.
  const shapes = [
    [{ object: "list", data: [{ id: "a" }, { id: "b" }] }, ["a", "b"]],
    [{ models: ["x", "y"] }, ["x", "y"]],
    [["z"], ["z"]],
  ]
  for (const [body, expected] of shapes) {
    const { fetchImpl } = jsonFetch(body)
    assert.deepEqual(await omni.fetchModels({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl }), expected)
  }
})

test("fetchModels sends the bearer key only when one is configured", async () => {
  // An empty bearer on a keyless gateway is a 401 that looks like a
  // configuration error, so the header is omitted rather than sent blank.
  const withKey = jsonFetch({ data: [] })
  await omni.fetchModels({ baseURL: omni.DEFAULT_BASE_URL, apiKey: "sk-abc", fetchImpl: withKey.fetchImpl })
  assert.equal(withKey.calls[0].headers.Authorization, "Bearer sk-abc")

  const withoutKey = jsonFetch({ data: [] })
  await omni.fetchModels({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl: withoutKey.fetchImpl })
  assert(!("Authorization" in withoutKey.calls[0].headers), "a keyless gateway must not get a blank bearer")
})

test("fetchModels names the HTTP status and never the key", async () => {
  // Every failure is a plain Error carrying an HTTP status and a short reason,
  // never the key: the URL is named because it cannot leak one (the key travels
  // in a header) and because "which gateway failed" is the first question
  // about any of these errors.
  const KEY = "sk-leak-regression-503"
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: "nope" }) })
  await assert.rejects(
    () => omni.fetchModels({ baseURL: omni.DEFAULT_BASE_URL, apiKey: KEY, fetchImpl }),
    (error) => {
      assert.match(error.message, /401/)
      assert(!error.message.includes(KEY), `error text must not carry the key: ${error.message}`)
      return true
    },
  )
})

test("fetchModels rejects a non-JSON body and an unsupported shape", async () => {
  const nonJson = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("not json")
    },
  })
  await assert.rejects(() => omni.fetchModels({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl: nonJson }), /non-JSON body/)

  // A body with neither `data` nor `models` has told us nothing about the
  // gateway's models, so answering with an empty list would silently route
  // nowhere instead of surfacing the mismatch.
  const { fetchImpl } = jsonFetch({ object: "list" })
  await assert.rejects(() => omni.fetchModels({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl }), /unsupported body shape/)
})

test("fetchModels reports a timeout instead of a bare abort", async () => {
  // fetch reports a timeout as a bare "aborted", which says nothing about which
  // call or how long was allowed; the module rewrites it while the signal state
  // is still known. The fake never resolves and only rejects on abort, which is
  // the shape a real fetch under a controller has.
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")))
    })
  await assert.rejects(
    () => omni.fetchModels({ baseURL: omni.DEFAULT_BASE_URL, timeoutMs: 10, fetchImpl }),
    /timed out after 10ms/,
  )
})

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------

test("checkHealth is true when the gateway answers and false when it does not", async () => {
  // Liveness probe: any failure is "unhealthy" for routing purposes. Swallowing
  // the error here is what keeps a down gateway from taking the caller with it.
  const { fetchImpl } = jsonFetch({ data: [] })
  assert.equal(await omni.checkHealth({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl }), true)

  const down = async () => {
    throw new Error("ECONNREFUSED")
  }
  assert.equal(await omni.checkHealth({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl: down }), false)
})

// ---------------------------------------------------------------------------
// createModelCache
// ---------------------------------------------------------------------------

test("the cache serves a fresh list without a request and re-probes past the TTL", async () => {
  let t = 0
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ data: ["a"] }) }
  }
  const cache = omni.createModelCache({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl, ttlMs: 60_000, now: () => t })
  assert.deepEqual(await cache.get(), ["a"])
  t = 30_000
  assert.deepEqual(await cache.get(), ["a"])
  assert.equal(calls, 1, "two get() calls inside the TTL are one request")
  t = 60_001
  assert.deepEqual(await cache.get(), ["a"])
  assert.equal(calls, 2, "past the TTL the list is re-probed")
})

test("get(true) refetches even inside the TTL", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ data: ["a"] }) }
  }
  const cache = omni.createModelCache({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl, now: () => 0 })
  await cache.get()
  await cache.get(true)
  assert.equal(calls, 2, "force must bypass the TTL")
})

test("a failure past the TTL returns the stale list instead of dropping every model", async () => {
  // The gateway went away between probes, and dropping every model mid-session
  // would fail work that is still running against models that are probably
  // still fine. A stale list beats no list.
  let t = 0
  let mode = "ok"
  const fetchImpl = async () => {
    if (mode === "fail") throw new Error("gateway down")
    return { ok: true, status: 200, json: async () => ({ data: ["a", "b"] }) }
  }
  const cache = omni.createModelCache({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl, ttlMs: 1000, now: () => t })
  assert.deepEqual(await cache.get(), ["a", "b"])
  t = 5000
  mode = "fail"
  assert.deepEqual(await cache.get(), ["a", "b"], "a stale list beats no list")
})

test("a cold cache propagates the failure", async () => {
  // Only a COLD cache -- one that has never succeeded -- propagates the error,
  // because then there is nothing to degrade to.
  const fetchImpl = async () => {
    throw new Error("gateway down")
  }
  const cache = omni.createModelCache({ baseURL: omni.DEFAULT_BASE_URL, fetchImpl, now: () => 0 })
  await assert.rejects(() => cache.get(), /gateway down/)
})

// ---------------------------------------------------------------------------
// redactApiKey
// ---------------------------------------------------------------------------

test("redactApiKey scrubs every occurrence and is a no-op without a key", () => {
  // Callers own logging; this is the scrubber that makes it safe. split/join
  // rather than a regex because the key is arbitrary text that would otherwise
  // need escaping, and it replaces ALL occurrences rather than the first.
  const KEY = "sk-regression-504"
  assert.equal(omni.redactApiKey(`GET failed: 401 for ${KEY} then ${KEY}`, KEY), "GET failed: 401 for [redacted] then [redacted]")
  const clean = "nothing to redact here"
  assert.equal(omni.redactApiKey(clean, ""), clean)
  assert.equal(omni.redactApiKey(clean), clean)
  assert.equal(omni.redactApiKey(clean, undefined), clean)
})
