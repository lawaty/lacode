// OmniRoute integration core: config parsing, model filtering/selection, and
// the HTTP surface of a local OpenAI-compatible gateway.
//
// OmniRoute is OPTIONAL. An operator runs it as a separate local process that
// speaks the OpenAI `/v1` API (`GET {baseURL}/models`, chat completions) and
// this module is the only piece of lacode that knows how it is shaped:
//
//   parseConfig     the `omniroute` block of the plugin config, validated
//   normalizeBaseURL the one place a base URL is canonicalised
//   filterModels    which model ids may be routed at all, and in what order
//   orderByTier     primary-then-backup preference over an already-filtered list
//   createSelector  per-session sticky choice + per-model health and cooldowns
//   fetchModels     the gateway's own HTTP surface, with cache and health probe
//
// It lives in lib/, not plugins/, and imports nothing from @opencode-ai or
// src/plugins/ on purpose: opencode calls EVERY export of a plugins/ file with
// the plugin input and uses the return value as its hooks object, so a plain
// helper exported from there is invoked with the wrong arguments and poisons the
// hook registry (see the header of lib/pool.ts and lib/notify.ts). Nothing
// exported here is a Plugin or a Hooks factory.
//
// The same isolation is what makes it unit-testable: the only things it touches
// are global fetch, AbortController, setTimeout/clearTimeout and Date, and every
// one of those can be replaced through an injected `fetchImpl` or `deps.now`.
//
// Two rules run through the whole file:
//
//   * DEGRADE, NEVER THROW OUT OF A ROUTER. parseConfig REPORTS problems rather
//     than raising, and a present-but-invalid field disables the integration
//     outright (`config: null`) instead of falling back to half of a config.
//     Only the HTTP helpers throw, and only into callers that already catch.
//
//   * A KEY IS NEVER IN A MESSAGE. No problem string, error text or stat carries
//     the api key: error text names an HTTP status and a short reason, and
//     redactApiKey() exists so callers can scrub a key out of anything they do
//     choose to log. A silent missing key is a config problem; a leaked one is
//     an incident.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Where a locally-run OmniRoute listens by default. */
export const DEFAULT_BASE_URL = "http://localhost:20128/v1"
/** The environment variable that overrides `omniroute.apiKey`. */
export const ENV_API_KEY = "OMNIROUTE_API_KEY"
/** Default per-request budget for the gateway's own HTTP calls. */
export const DEFAULT_TIMEOUT_MS = 5000
/** How long a successfully fetched model list is trusted before a re-probe. */
export const DEFAULT_CACHE_TTL_MS = 60_000
/** First cooldown after one transient failure; every later one doubles it. */
export const COOLDOWN_BASE_MS = 1_000
/** Fifteen minutes: long enough to outlast a provider window, short enough that
 * a recovered gateway is picked up within a session. */
export const COOLDOWN_MAX_MS = 15 * 60 * 1000
/** Appended to a normalised base URL, which always ends in `/v1`. */
export const MODELS_PATH = "/models"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OmniRouteTiers = { primary: string[]; backup: string[] }

export type OmniRouteConfig = {
  baseURL: string
  apiKey?: string
  combo?: string
  models?: string[]
  tiers: OmniRouteTiers
  stickyPerSession: boolean
  healthCheck: boolean
  timeoutMs: number
}

export type ParseResult = { enabled: boolean; config: OmniRouteConfig | null; problems: string[] }

/** The smallest slice of `fetch` this module needs, so tests can inject a fake. */
export type FetchLike = (input: string, init?: any) => Promise<any>

export type ModelStat = {
  ttftEwma?: number
  requests: number
  errors: number
  strikes: number
  cooldownUntil: number
  lastFailure?: string
}

export type Selector = {
  setCandidates(ids: string[]): void
  candidates(): string[]
  select(sessionID: string): string | null
  stickyFor(sessionID: string): string | null
  recordSuccess(sessionID: string, modelID: string, ttftMs: number): void
  recordFailure(sessionID: string, modelID: string, opts?: { status?: number; retryAfterMs?: number; transient?: boolean; message?: string }): void
  isCooling(modelID: string): boolean
  stats(): Record<string, ModelStat>
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Order-preserving de-duplication; the first spelling of an id wins. */
const dedupe = (ids: string[]): string[] => {
  const out: string[] = []
  for (const id of ids) if (!out.includes(id)) out.push(id)
  return out
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => isNonEmptyString(entry))

// ---------------------------------------------------------------------------
// normalizeBaseURL
// ---------------------------------------------------------------------------

/**
 * Canonical form of an OmniRoute base URL, or null when it is not one.
 *
 * Everything downstream concatenates `MODELS_PATH` onto the result, so the
 * shape has to be predictable: scheme http/https, no query, no hash, no trailing
 * slash, and exactly one `/v1` at the end. Operators write this field by hand
 * in opencode.jsonc and every one of `http://localhost:20128`,
 * `http://localhost:20128/`, `http://localhost:20128/v1` and
 * `http://localhost:20128/v1///` means the same server, so all four have to
 * normalise to the same string rather than producing four different cache keys
 * or a `/v1/models` vs `/models` split.
 *
 * The `/v1` collapse strips ANY number of trailing `/v1` segments before
 * appending one, which is what turns `/v1/v1` (a copy-paste of a base URL into
 * a field that already had one) into `/v1` instead of nesting forever.
 *
 * Credentials embedded in the URL are dropped along the way, and that is
 * deliberate: `URL.origin` excludes userinfo, and a key in a URL is a key that
 * ends up in logs and process listings. The key belongs in `apiKey`, sent as a
 * header.
 */
export function normalizeBaseURL(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed === "") return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  // Query and hash are dropped by rebuilding from origin + pathname rather than
  // by string surgery: `new URL` has already normalised the path (case, dot
  // segments) and this keeps whatever it decided.
  let path = url.pathname.replace(/\/+$/, "")
  while (path.endsWith("/v1")) path = path.slice(0, -"/v1".length)
  return `${url.origin}${path}/v1`
}

// ---------------------------------------------------------------------------
// parseConfig
// ---------------------------------------------------------------------------

/**
 * Validate the `omniroute` config block.
 *
 * Disabled is SILENT (`problems: []`): an absent or `enabled: false` block is
 * the normal state for a user who does not run OmniRoute, and reporting a
 * warning for "not configured" would cry wolf on every startup.
 *
 * Enabled is STRICT. A missing optional field takes its default; a field that
 * is PRESENT but invalid is a problem and disables the integration entirely
 * (`config: null`). Half a config is worse than none: a base URL that failed to
 * parse alongside a valid allowlist would otherwise route through a URL nobody
 * chose, so a single bad field takes the whole block down.
 *
 * `undefined` counts as missing for every field -- that is what lets a caller
 * build the block programmatically with optional properties -- while `null`
 * counts as present and invalid, because writing `null` is a statement.
 */
export function parseConfig(raw: unknown, env: Record<string, string | undefined> = process.env): ParseResult {
  if (typeof raw !== "object" || raw === null) return { enabled: false, config: null, problems: [] }
  const block = raw as Record<string, unknown>
  // Strict boolean: `enabled: "true"` or `enabled: 1` is a mistake that would
  // otherwise silently turn the integration on with a string where a flag is
  // expected, so it is read as off rather than as truthy.
  if (block.enabled !== true) return { enabled: false, config: null, problems: [] }

  const problems: string[] = []

  let baseURL = DEFAULT_BASE_URL
  if (block.baseURL !== undefined) {
    const normalized = normalizeBaseURL(block.baseURL)
    if (normalized === null) problems.push("omniroute.baseURL is not a valid http(s) URL")
    else baseURL = normalized
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (block.timeoutMs !== undefined) {
    const value = block.timeoutMs
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      problems.push("omniroute.timeoutMs must be a positive number")
    } else {
      timeoutMs = value
    }
  }

  let stickyPerSession = true
  if (block.stickyPerSession !== undefined) {
    if (typeof block.stickyPerSession !== "boolean") problems.push("omniroute.stickyPerSession must be a boolean")
    else stickyPerSession = block.stickyPerSession
  }

  let healthCheck = true
  if (block.healthCheck !== undefined) {
    if (typeof block.healthCheck !== "boolean") problems.push("omniroute.healthCheck must be a boolean")
    else healthCheck = block.healthCheck
  }

  let combo: string | undefined
  if (block.combo !== undefined) {
    if (!isNonEmptyString(block.combo)) problems.push("omniroute.combo must be a non-empty string")
    else combo = block.combo.trim()
  }

  // The allowlist. Deduplicated because a repeated entry is only ever a
  // copy-paste, and order is preserved because it IS the routing order.
  let models: string[] | undefined
  if (block.models !== undefined) {
    if (!isStringArray(block.models)) problems.push("omniroute.models must be an array of non-empty strings")
    else models = dedupe(block.models.map((id) => id.trim()))
  }

  let tiers: OmniRouteTiers = { primary: [], backup: [] }
  if (block.tiers !== undefined) {
    const value = block.tiers
    // An array is rejected even though `typeof [] === "object"`: its keys would
    // be indices, so `primary`/`backup` read as absent and a typo like
    // `tiers: [["a"]]` would silently produce an empty routing preference --
    // exactly the half-configured state this function exists to prevent.
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push("omniroute.tiers must be an object with primary/backup string arrays")
    } else {
      const read = (list: unknown): string[] | null => {
        if (list === undefined) return []
        if (!isStringArray(list)) return null
        return dedupe(list.map((id) => id.trim()))
      }
      const group = value as Record<string, unknown>
      const primary = read(group.primary)
      const backup = read(group.backup)
      if (primary === null || backup === null) {
        problems.push("omniroute.tiers must be an object with primary/backup string arrays")
      } else {
        tiers = { primary, backup }
      }
    }
  }

  // A tier entry naming a model the allowlist excludes is a ROUTING PREFERENCE,
  // not a config error, so it is dropped rather than reported: an operator may
  // legitimately keep the tiers wider than today's allowlist and narrow that
  // list without editing both. Dropping it also keeps every tier inside the
  // allowlist, which is the only place it could have had any effect anyway.
  if (models !== undefined) {
    const allowed = new Set(models)
    tiers = {
      primary: tiers.primary.filter((id) => allowed.has(id)),
      backup: tiers.backup.filter((id) => allowed.has(id)),
    }
  }

  // Env beats the config file: a key exported into the environment is the
  // deliberate override (a shell, CI) and has to win over whatever is written
  // down in opencode.jsonc. The shape of `raw.apiKey` is validated regardless
  // of which one ends up used -- a present-but-invalid field is a problem even
  // when it loses.
  let apiKey: string | undefined
  if (block.apiKey !== undefined && typeof block.apiKey !== "string") {
    problems.push("omniroute.apiKey must be a string when set")
  }
  const fromEnv = env[ENV_API_KEY]
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") apiKey = fromEnv.trim()
  else if (typeof block.apiKey === "string" && block.apiKey.trim() !== "") apiKey = block.apiKey.trim()

  if (problems.length > 0) return { enabled: true, config: null, problems }

  // Optional keys are ABSENT rather than set to undefined: the config is
  // serialized (opencode.jsonc round-trips, debug dumps) and a pile of
  // `"combo": undefined` keys is noise that also makes structural comparison of
  // two configs fail for no reason.
  const config: OmniRouteConfig = {
    baseURL,
    tiers,
    stickyPerSession,
    healthCheck,
    timeoutMs,
  }
  if (apiKey !== undefined) config.apiKey = apiKey
  if (combo !== undefined) config.combo = combo
  if (models !== undefined) config.models = models

  return { enabled: true, config, problems: [] }
}

// ---------------------------------------------------------------------------
// filterModels / orderByTier
// ---------------------------------------------------------------------------

/**
 * Which model ids may be routed, and in what order.
 *
 * `combo` always leads: it is the operator's explicitly preferred target, so it
 * is first whether or not it happens to appear in `ids`.
 *
 * The allowlist is a HARD one -- a model outside `config.models` is never
 * returned even when the gateway advertises it. A gateway listing twenty models
 * and a config naming two means two, not twenty with two preferred; anything
 * else would silently route work to a model the operator excluded on purpose.
 */
export function filterModels(ids: string[], config: OmniRouteConfig): string[] {
  const out: string[] = []
  const push = (id: string): void => {
    // A blank id can only come from a malformed list; routing on "" would
    // produce a request the gateway rejects with a confusing 4xx.
    if (id.trim() === "") return
    if (!out.includes(id)) out.push(id)
  }
  if (config.combo !== undefined) push(config.combo)
  // An EMPTY allowlist is a hard allowlist too: it exposes nothing (except the
  // combo). Reading `[]` as "no allowlist" would invert it into "allow every
  // model the gateway advertises", the exact opposite of what was written.
  if (config.models !== undefined) {
    for (const id of config.models) if (ids.includes(id)) push(id)
  } else {
    for (const id of ids) push(id)
  }
  return out
}

/**
 * Reorder `ids` so the operator's preferences come first.
 *
 * Tiers are a list, not a sort: an entry's position in `tiers.primary` is its
 * rank, and primary as a whole outranks backup as a whole. Ids with no tier
 * entry keep their original relative order and come last, so the gateway's own
 * listing still decides anything the operator did not rank.
 */
export function orderByTier(ids: string[], tiers: OmniRouteTiers): string[] {
  const present = new Set(ids)
  const out: string[] = []
  const push = (id: string): void => {
    if (!out.includes(id)) out.push(id)
  }
  // A tier entry naming a model that is not offered is ignored rather than
  // reported: candidate lists shrink as models cool down and get delisted, and
  // a stale tier entry must not cost the caller an error at selection time.
  for (const id of tiers.primary) if (present.has(id)) push(id)
  for (const id of tiers.backup) if (present.has(id)) push(id)
  for (const id of ids) push(id)
  return out
}

// ---------------------------------------------------------------------------
// Failure classification and cooldown arithmetic
// ---------------------------------------------------------------------------

/**
 * Which HTTP statuses are worth retrying elsewhere.
 *
 * 429 and 408 are the gateway saying "not now" (rate window, its own client
 * timeout), and 5xx is the gateway saying "not me" -- all three clear on their
 * own, so a different model is a real alternative. 400/401/403/404 are the
 * REQUEST being wrong, and sending it to another model produces the same
 * error four times over: those are surfaced, never failed over (see
 * recordFailure's transient branch).
 */
export function isTransientStatus(status: number): boolean {
  if (status === 429 || status === 408) return true
  return status >= 500 && status <= 599
}

/**
 * Exponential cooldown: 1s, 2s, 4s ... capped at `capMs`.
 *
 * `strikes` is documented as >= 1 (callers clamp; see cooldownUntil). A
 * non-finite value is treated as 1 because it would otherwise produce a NaN
 * cooldown, and `NaN > now` is false -- a model that can never cool down again.
 */
export function backoffMs(strikes: number, capMs: number = COOLDOWN_MAX_MS): number {
  const count = Number.isFinite(strikes) ? strikes : 1
  return Math.min(COOLDOWN_BASE_MS * 2 ** (count - 1), capMs)
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds.
 *
 * The header is either delta-seconds or an HTTP-date, and the two are
 * indistinguishable by value: `Date.parse("2015")` is a perfectly valid
 * timestamp, so a numeric string is checked FIRST and a date only second.
 * A date in the past clamps to 0 rather than going negative.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds) || seconds < 0) return undefined
    return seconds * 1000
  }
  const when = Date.parse(trimmed)
  if (!Number.isFinite(when)) return undefined
  return Math.max(0, when - now)
}

/**
 * The wall-clock time a model stays off the list.
 *
 * A stated retry beats a guessed backoff: when the gateway says when to come
 * back, doubling from 1s because it is the third strike would be guessing over
 * an answer we were handed. Both are capped so no header can park a model for
 * an hour.
 */
export function cooldownUntil(opts: { retryAfterMs?: number; strikes?: number; now: number; capMs?: number }): number {
  const cap = opts.capMs ?? COOLDOWN_MAX_MS
  const now = opts.now ?? Date.now()
  const retryAfterMs = opts.retryAfterMs
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return now + Math.min(retryAfterMs, cap)
  }
  const strikes = opts.strikes ?? 1
  return now + backoffMs(Math.max(1, strikes), cap)
}

// ---------------------------------------------------------------------------
// createSelector
// ---------------------------------------------------------------------------

/** Error rate contribution of a stat row; a model with no traffic has none.
 * The denominator counts BOTH successes and failures, so a model that has only
 * ever failed (no successes yet) is measured as pure failure rather than as
 * pristine -- otherwise the first error on a never-used model ranks it cleanest. */
const rateOf = (stat: ModelStat): number => {
  const attempts = stat.requests + stat.errors
  return attempts > 0 ? stat.errors / attempts : 0
}
/** Mean time to first token; a model with no measurement sorts last. */
const ttftOf = (stat: ModelStat): number => stat.ttftEwma ?? Number.POSITIVE_INFINITY

/**
 * In-process model selection: sticky per session, health-aware, tier-ordered.
 *
 * State is deliberately per-process and in-memory. OmniRoute selection is a
 * latency optimisation, not a correctness requirement: losing it costs one
 * process its preferences for one session, whereas sharing it across processes
 * would need a file, a lock and a reconciliation policy for a decision that is
 * cheaper to recompute than to synchronise.
 *
 * `deps.now` is injectable so cooldown arithmetic is testable without waiting
 * for time to pass.
 */
export function createSelector(config: OmniRouteConfig, deps: { now?: () => number } = {}): Selector {
  const now = deps.now ?? Date.now
  const stats = new Map<string, ModelStat>()
  const sticky = new Map<string, string>()
  let cands: string[] = []

  const ensure = (modelID: string): ModelStat => {
    let stat = stats.get(modelID)
    if (stat === undefined) {
      // Zeroed, with the optional fields absent rather than undefined: a model
      // that has never been used must be indistinguishable from one that has
      // only ever succeeded slowly.
      stat = { requests: 0, errors: 0, strikes: 0, cooldownUntil: 0 }
      stats.set(modelID, stat)
    }
    return stat
  }

  const cooling = (modelID: string): boolean => {
    const stat = stats.get(modelID)
    return stat !== undefined && stat.cooldownUntil > now()
  }

  // Strictly-better test. Ties fall through to candidate order, which is the
  // caller's ranked list, so "no reason to prefer" means "first one".
  const better = (challenger: ModelStat, challengerIndex: number, best: ModelStat, bestIndex: number): boolean => {
    const challengerRate = rateOf(challenger)
    const bestRate = rateOf(best)
    if (challengerRate !== bestRate) return challengerRate < bestRate
    const challengerTtft = ttftOf(challenger)
    const bestTtft = ttftOf(best)
    if (challengerTtft !== bestTtft) return challengerTtft < bestTtft
    return challengerIndex < bestIndex
  }

  return {
    setCandidates(ids: string[]): void {
      const next = dedupe(ids.filter((id) => typeof id === "string" && id.trim() !== ""))
      cands = next
      // Every candidate gets a row immediately so stats() reports zeroed
      // numbers for a model that has simply not been used yet, instead of a
      // hole that reads like "unknown".
      for (const id of next) ensure(id)
    },

    candidates(): string[] {
      return [...cands]
    },

    select(sessionID: string): string | null {
      const list = cands
      if (list.length === 0) return null
      if (config.stickyPerSession) {
        // A sticky choice survives only while its model is still offered and
        // not cooling. A session that just watched its model fail over must not
        // be pinned back onto it by the next select().
        const held = sticky.get(sessionID)
        if (held !== undefined && list.includes(held) && !cooling(held)) return held
      }
      let bestID: string | null = null
      let bestStat: ModelStat | null = null
      let bestIndex = -1
      for (const [index, id] of list.entries()) {
        const stat = ensure(id)
        // Cooling models are skipped, never chosen as a last resort: routing to
        // a model we just failed on is the outcome the cooldown exists to
        // prevent, and "no model available" is honest information.
        if (stat.cooldownUntil > now()) continue
        if (bestStat === null || bestID === null || better(stat, index, bestStat, bestIndex)) {
          bestID = id
          bestStat = stat
          bestIndex = index
        }
      }
      if (bestID === null) return null
      if (config.stickyPerSession) sticky.set(sessionID, bestID)
      return bestID
    },

    stickyFor(sessionID: string): string | null {
      return sticky.get(sessionID) ?? null
    },

    recordSuccess(sessionID: string, modelID: string, ttftMs: number): void {
      // sessionID is part of the contract for symmetry with recordFailure and
      // carries no behaviour here: a model that ANSWERED keeps its sticky
      // assignment, which is the whole point of stickiness.
      void sessionID
      const stat = ensure(modelID)
      stat.requests += 1
      // A missing or bogus ttft is a missing measurement, not a fast one, so the
      // EWMA is left alone rather than dragged toward 0.
      if (typeof ttftMs === "number" && Number.isFinite(ttftMs) && ttftMs >= 0) {
        stat.ttftEwma = stat.ttftEwma === undefined ? ttftMs : stat.ttftEwma * 0.6 + ttftMs * 0.4
      }
    },

    recordFailure(sessionID: string, modelID: string, opts: { status?: number; retryAfterMs?: number; transient?: boolean; message?: string } = {}): void {
      const stat = ensure(modelID)
      stat.errors += 1
      // The message is caller-provided text, never a secret this module holds;
      // it is kept only when present so an absent message does not erase the
      // last real reason.
      if (opts.message !== undefined) stat.lastFailure = opts.message
      // No status at all means we do not know what happened, which is more like
      // a network error than like a 400: fail over.
      const transient = opts.transient ?? (opts.status === undefined ? true : isTransientStatus(opts.status))
      // NON-transient failures do not cool the model down and do not move the
      // session off it: a 400 or a 401 is the request being wrong, and retrying
      // it on another model produces four identical errors with four cooldowns
      // to show for it. Those are surfaced to the caller instead.
      if (!transient) return
      stat.strikes += 1
      const until = cooldownUntil({ retryAfterMs: opts.retryAfterMs, strikes: stat.strikes, now: now() })
      // max() with the existing cooldown: a Retry-After shorter than the strike
      // backoff must not shorten a cooldown that is already running.
      if (until > stat.cooldownUntil) stat.cooldownUntil = until
      // Drop the sticky assignment so the next select() moves this session on;
      // leaving it would re-select the cooling model the moment it recovers
      // before any other model had a chance.
      if (sticky.get(sessionID) === modelID) sticky.delete(sessionID)
    },

    isCooling(modelID: string): boolean {
      return cooling(modelID)
    },

    stats(): Record<string, ModelStat> {
      const out: Record<string, ModelStat> = {}
      for (const [id, stat] of stats) out[id] = { ...stat }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// The gateway's HTTP surface
// ---------------------------------------------------------------------------

/** Short, key-free explanation of a status, for error messages. */
const statusReason = (status: number): string => {
  const reasons: Record<number, string> = {
    400: "bad request",
    401: "unauthorized",
    403: "forbidden",
    404: "not found",
    408: "request timeout",
    429: "rate limited",
    500: "server error",
    502: "bad gateway",
    503: "unavailable",
    504: "gateway timeout",
  }
  if (Number.isFinite(status) && reasons[status] !== undefined) return reasons[status]
  return status >= 500 ? "server error" : "http error"
}

/** The id of one entry of a model list, or null when it has none. */
const entryID = (entry: unknown): string | null => {
  if (typeof entry === "string") return entry.trim() === "" ? null : entry.trim()
  if (entry !== null && typeof entry === "object") {
    const id = (entry as { id?: unknown }).id
    if (typeof id === "string") return id.trim() === "" ? null : id.trim()
  }
  return null
}

/** `{data:[...]}`, `{models:[...]}` (strings or objects) or a bare array. */
const listEntries = (body: unknown): unknown[] | null => {
  if (Array.isArray(body)) return body
  if (body === null || typeof body !== "object") return null
  const obj = body as { data?: unknown; models?: unknown }
  if (Array.isArray(obj.data)) return obj.data
  if (Array.isArray(obj.models)) return obj.models
  return null
}

/**
 * `GET {baseURL}/models`, as a de-duplicated list of ids.
 *
 * The base URL is assumed already normalised (it ends in `/v1`), which is why
 * the path is a bare concatenation. The Authorization header is sent only when
 * a key is configured: an empty bearer on a keyless gateway is a 401 that looks
 * like a configuration error.
 *
 * Every failure is a plain Error carrying an HTTP status and a short reason,
 * never the key. The URL is named because it cannot leak one (the key travels
 * in a header) and because "which gateway failed" is the first question about
 * any of these errors.
 */
export async function fetchModels(opts: {
  baseURL: string
  apiKey?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}): Promise<string[]> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = `${opts.baseURL}${MODELS_PATH}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {}
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    const status = typeof response?.status === "number" ? response.status : Number.NaN
    // `ok` when the response says so, else derived from the status, else
    // assumed: a stub that carries neither has not told us anything failed.
    const ok = typeof response?.ok === "boolean" ? response.ok : Number.isFinite(status) ? status >= 200 && status < 300 : true
    if (!ok) throw new Error(`omniroute GET ${url} failed: HTTP ${status} ${statusReason(status)}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error(`omniroute GET ${url} returned a non-JSON body`)
    }
    const entries = listEntries(body)
    if (entries === null) throw new Error(`omniroute GET ${url} returned an unsupported body shape`)
    const out: string[] = []
    for (const entry of entries) {
      const id = entryID(entry)
      if (id !== null && !out.includes(id)) out.push(id)
    }
    return out
  } catch (error) {
    // fetch reports a timeout as a bare "aborted", which says nothing about
    // which call or how long was allowed. Rewrite it while the signal state is
    // still known -- this is a plain Error either way, never the AbortError.
    if (controller.signal.aborted) throw new Error(`omniroute GET ${url} timed out after ${timeoutMs}ms`)
    throw error
  } finally {
    // Always: a leaked timer keeps the event loop alive (and, in a plugin
    // process, keeps the process from exiting on its own).
    clearTimeout(timer)
  }
}

/** Liveness probe: true when the gateway answers its model list at all. */
export async function checkHealth(opts: {
  baseURL: string
  apiKey?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}): Promise<boolean> {
  try {
    await fetchModels(opts)
    return true
  } catch {
    // Any failure is "unhealthy" for routing purposes. Swallowing the error
    // here is what keeps a down gateway from taking the caller with it; the
    // text belongs to fetchModels, which the health path already ran.
    return false
  }
}

/**
 * A TTL cache over `fetchModels`, with a stale-value fallback.
 *
 * GET /models is cheap but not free, and the list changes on the order of
 * minutes, so a fresh cache is served without a request.
 *
 * On failure a stale value is returned anyway: the gateway went away between
 * probes, and dropping every model mid-session would fail work that is still
 * running against models that are probably still fine. Only a COLD cache --
 * one that has never succeeded -- propagates the error, because then there is
 * nothing to degrade to.
 */
export function createModelCache(opts: Parameters<typeof fetchModels>[0] & {
  ttlMs?: number
  now?: () => number
}): { get(force?: boolean): Promise<string[]>; invalidate(): void } {
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS
  const now = opts.now ?? Date.now
  let cached: string[] | null = null
  let cachedAt = 0
  return {
    async get(force?: boolean): Promise<string[]> {
      if (!force && cached !== null && now() - cachedAt < ttlMs) return [...cached]
      try {
        const ids = await fetchModels(opts)
        cached = ids
        cachedAt = now()
        return [...ids]
      } catch (error) {
        if (cached !== null) return [...cached]
        throw error
      }
    },
    invalidate(): void {
      cached = null
      cachedAt = 0
    },
  }
}

// ---------------------------------------------------------------------------
// redactApiKey
// ---------------------------------------------------------------------------

/**
 * Replace every occurrence of the api key in `text` with `[redacted]`.
 *
 * Callers own logging; this is the scrubber that makes it safe. split/join
 * rather than a regex because the key is arbitrary text that would otherwise
 * need escaping, and because it replaces ALL occurrences, not just the first.
 * A missing or empty key is a no-op, so callers can apply it unconditionally.
 */
export function redactApiKey(text: string, apiKey?: string): string {
  if (typeof apiKey !== "string" || apiKey === "") return text
  return text.split(apiKey).join("[redacted]")
}
