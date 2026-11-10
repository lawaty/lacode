// Pure pool selection: which scored models become slots, and when a limited
// model is worth retrying. Imported by scripts/score-models.mjs; refresh-pool
// consumes the resulting `selection` and does not repeat this policy.

export const MIN_CONTEXT = 100_000
export const SMALL_CONTEXT_MAX = 200_000
export const MIN_SCORE = 60
export const POOL_SIZE = 10
export const MAX_ZEN = 1
export const LARGE_RESERVE = 3
export const MAX_PER_PROVIDER = 2
export const MAX_PER_PROVIDER_LARGE = 1
export const DEFAULT_QUOTA_RETRY_MS = 15 * 60 * 1000
export const CREDIT_RETRY_MS = 6 * 60 * 60 * 1000
export const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000
export const STATED_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000
// A transient failure with no stated reset gets a bounded retry instead of
// vanishing from the pool until the next full scan. 45 minutes is long enough
// for a gateway hiccup or a short provider outage to clear, short enough that a
// recovered model is back well before the 6-hour timer.
export const SYNTHETIC_RETRY_MS = 45 * 60 * 1000

// Scan order, not selection order: the pool's core providers are probed first so
// a wall-clock budget can never starve them behind a slow paid catalogue. This is
// ordering only -- never an exclusion.
export const providerRank = (provider) => {
  const name = String(provider ?? "")
  if (name === "opencode-go" || name === "opencode") return 0
  if (name === "console-openrouter" || name === "openrouter") return 2
  return 1
}

// One classifier, shared by the scorer (live probe outcome) and the selector
// (persisted row). The reason text is the fallback for rows written before the
// classifier existed or by a provider that gives only prose.
const FAILURE_KINDS = [
  ["agreement", /model\s+agreement|terms\s+of\s+(?:service|use)|\btos\b/i],
  ["credit", /out\s+of\s+credits|insufficient\s+credits|credit\s+balance|requires\s+more\s+credits|payment\s+required|billing|purchase|\b402\b/i],
  ["rate-limited", /rate[\s_-]?limit|usage\s+limit|too\s+many\s+requests|overloaded|limits?[\s_-]?(?:reached|exceeded)|free[-\s]?tier|freelimiterror|quota|\b429\b/i],
  ["credential", /\b401\b|unauthori[sz]ed|not\s+authori[sz]ed|invalid[\s_-]+(?:api[\s_-]?(?:key|token)|token|credential|bearer)|api[\s_-]?key\s+(?:is\s+)?(?:invalid|missing|expired|not\s+valid)|authentication\s+(?:failed|error|required)|incorrect[\s_-]?api[\s_-]?key/i],
  ["not-served", /\b404\b|no\s+such\s+model|model\s+not\s+found|does\s+not\s+exist|is\s+not\s+available|not\s+served|not\s+found/i],
  ["timeout", /timeout|timed\s+out|ETIMEDOUT|no\s+answer|no\s+response/i],
  ["network", /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch\s+failed|socket\s+hang\s+up|unreachable/i],
  ["server", /\b5\d\d\b|internal\s+server|bad\s+gateway|service\s+unavailable|gateway\s+timeout/i],
]

// A credit exhaustion is transient over hours, not permanent: the balance can be
// topped up, and the retry schedule is what carries it. Agreement, credential
// and not-served failures are permanent for this model until a human acts.
const TRANSIENT_KINDS = new Set(["rate-limited", "credit", "timeout", "network", "server"])

export const isTransientKind = (kind) => TRANSIENT_KINDS.has(String(kind ?? "").toLowerCase())

export function classifyFailure({ status, reason, kind } = {}) {
  if (kind) return String(kind).toLowerCase()
  const text = String(reason ?? "")
  const code = Number(status)
  if (code === 402) return "credit"
  if (code === 429) return "rate-limited"
  if (code === 401) return "credential"
  if (code === 403) {
    const named = FAILURE_KINDS.find(([, re]) => re.test(text))?.[0]
    return named === "agreement" || named === "credit" ? named : "credential"
  }
  if (code === 404) return "not-served"
  if (code >= 500 && code <= 599) return "server"
  for (const [name, re] of FAILURE_KINDS) if (re.test(text)) return name
  return "unknown"
}

export const isTransientFailure = (row) => {
  if (row?.ok !== false) return false
  if (row.kind) return isTransientKind(row.kind)
  return isTransientKind(classifyFailure({ status: row.status, reason: row.reason }))
}

const isLimitText = (text) =>
  /rate[\s_-]?limit|usage limit|too many requests|quota|freelimiterror|free[-\s]?tier|overloaded|limits?[\s_-]?(?:reached|exceeded)|\b429\b/i.test(
    String(text ?? ""),
  )

const isDailyLimit = (text) => /per[\s-]?day|daily|free-models-per-day|requests?\s+per\s+day/i.test(String(text ?? ""))

const isCreditText = /out of credits|insufficient credits|credit balance|requires more credits|payment required|billing|purchase|\b402\b/i

const bounded = (ms) => (Number.isFinite(ms) && ms > 0 && ms <= STATED_COOLDOWN_MAX_MS ? ms : undefined)

export const statedCooldownMs = (text) => {
  const value = String(text ?? "")
  const hm = /resets?\s+in\s+(\d+)\s*(?:hour|hr|h)s?\s*(\d+)?\s*(?:minute|min|m)?s?/i.exec(value)
  if (hm) return bounded((Number(hm[1]) * 60 + (hm[2] ? Number(hm[2]) : 0)) * 60 * 1000)
  const m = /resets?\s+in\s+(\d+)\s*(?:minute|min|m)s?/i.exec(value)
  if (m) return bounded(Number(m[1]) * 60 * 1000)
  const s = /retry[\s-]?in\s+(\d+)\s*(?:second|sec|s)s?/i.exec(value)
  if (s) return bounded(Number(s[1]) * 1000)
  return undefined
}

const retryAfterHeaderMs = (value) => {
  if (!value) return undefined
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return bounded(Number(text) * 1000)
  const at = Date.parse(text)
  return Number.isFinite(at) ? bounded(at - Date.now()) : undefined
}

export function retryAfterMs(text, header, now = Date.now()) {
  const headerMs = retryAfterHeaderMs(header)
  if (headerMs) return now + headerMs
  const stated = statedCooldownMs(text)
  if (stated) return now + stated
  const normalized = String(text ?? "")
  if (isDailyLimit(text)) {
    const d = new Date(now)
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)
    return next > now ? next : now + MAX_RETRY_DELAY_MS
  }
  if (isCreditText.test(normalized)) return now + CREDIT_RETRY_MS
  if (isLimitText(text)) return now + DEFAULT_QUOTA_RETRY_MS
  return undefined
}

const rowsOf = (providers) =>
  Array.isArray(providers)
    ? providers.flatMap((entry) => (Array.isArray(entry?.rows) ? entry.rows : []))
    : []

const providerOf = (model) => String(model ?? "").split("/")[0]

export function selectPool({
  providers,
  previousProviders,
  minContext = MIN_CONTEXT,
  minScore = MIN_SCORE,
  poolSize = POOL_SIZE,
  maxZen = MAX_ZEN,
  now = Date.now,
} = {}) {
  const rankable = (row) =>
    row?.ok === true &&
    typeof row.score === "number" &&
    Number.isFinite(row.score) &&
    row.score >= minScore &&
    (row.context == null || row.context >= minContext)
  const byScore = (a, b) => b.score - a.score || String(a.model).localeCompare(String(b.model))
  const nowMs = typeof now === "function" ? Number(now()) : Number(now)
  const normalize = (row) => {
    if (row?.ok !== false || !isTransientFailure(row)) return row
    const at = Number(row.retryAfter)
    if (Number.isFinite(at) && at > nowMs) return row
    return { ...row, retryAfter: nowMs + SYNTHETIC_RETRY_MS }
  }

  const rows = rowsOf(providers).map(normalize)
  const previousRows = rowsOf(previousProviders)
  const currentByModel = new Map(rows.map((row) => [row.model, row]))
  const scannedProviders = new Set(
    (Array.isArray(providers) ? providers : []).map((entry) => String(entry?.provider ?? "")),
  )
  const erroredProviders = new Set(
    (Array.isArray(providers) ? providers : [])
      .filter((entry) => entry?.error)
      .map((entry) => String(entry.provider ?? "")),
  )
  const truncatedProviders = new Set(
    (Array.isArray(providers) ? providers : [])
      .filter((entry) => entry?.truncated)
      .map((entry) => String(entry.provider ?? "")),
  )

  // A model the previous run scored is kept when this run could not reach it
  // for a transient reason, when its provider was not scanned at all (a
  // targeted scan), or when the scan budget cut that provider off. A model the
  // provider says is gone is not kept.
  const fallback = previousRows.filter((row) => {
    if (!rankable(row)) return false
    const current = currentByModel.get(row.model)
    if (current) return isTransientFailure(current)
    const provider = providerOf(row.model)
    return !scannedProviders.has(provider) || truncatedProviders.has(provider) || erroredProviders.has(provider)
  })

  const merge = (pick) => {
    const seen = new Set()
    const out = []
    for (const row of [...rows, ...fallback]) {
      if (!pick(row) || !rankable(row) || seen.has(row.model)) continue
      seen.add(row.model)
      out.push(row)
    }
    return out.sort(byScore)
  }

  const go = merge((row) => providerOf(row.model) === "opencode-go")
  const other = merge((row) => providerOf(row.model) !== "opencode-go" && providerOf(row.model) !== "opencode")
  const zen = merge((row) => providerOf(row.model) === "opencode")

  const small = other
    .filter((row) => row.context != null && row.context < SMALL_CONTEXT_MAX)
    .sort(byScore)
  const large = other
    .filter((row) => row.context == null || row.context >= SMALL_CONTEXT_MAX)
    .sort(byScore)

  const capPerProvider = (rows, max) => {
    const counts = new Map()
    const out = []
    for (const row of rows) {
      const provider = providerOf(row.model)
      const count = counts.get(provider) ?? 0
      if (count >= max) continue
      counts.set(provider, count + 1)
      out.push(row)
    }
    return out
  }

  const cappedSmall = capPerProvider(small, MAX_PER_PROVIDER)
  const cappedLarge = capPerProvider(large, MAX_PER_PROVIDER_LARGE)

  // Reserve the last slot for zen when a rankable one exists. Without the
  // reservation a full field of other providers squeezes zen out entirely, which
  // is the opposite of "exactly one zen slot at the end".
  const zenReserve = zen.length > 0 ? Math.max(0, Math.min(maxZen, poolSize - go.length)) : 0
  const remaining = Math.max(0, poolSize - go.length - zenReserve)
  const pickedLarge = cappedLarge.slice(0, Math.min(LARGE_RESERVE, remaining))
  const pickedSmall = cappedSmall.slice(0, Math.max(0, remaining - pickedLarge.length))

  if (pickedLarge.length + pickedSmall.length < remaining) {
    const need = remaining - pickedLarge.length - pickedSmall.length
    pickedLarge.push(...cappedLarge.slice(pickedLarge.length, pickedLarge.length + need))
  }
  if (pickedLarge.length + pickedSmall.length < remaining) {
    const need = remaining - pickedLarge.length - pickedSmall.length
    pickedSmall.push(...cappedSmall.slice(pickedSmall.length, pickedSmall.length + need))
  }

  const pickedZen = zen.slice(0, zenReserve)

  const selection = [
    ...go.map((row) => ({ model: row.model, weight: 4, context: row.context ?? null })),
    ...pickedSmall.map((row) => ({ model: row.model, weight: 2, context: row.context ?? null })),
    ...pickedLarge.map((row) => ({ model: row.model, weight: 1, context: row.context ?? null })),
    ...pickedZen.map((row) => ({ model: row.model, weight: 2, bucket: "opencode", context: row.context ?? null })),
  ]

  const warnings = []
  for (const entry of Array.isArray(providers) ? providers : []) {
    if (entry?.error) {
      warnings.push(`${entry.provider}: ${entry.error}`)
      continue
    }
    const entryRows = Array.isArray(entry?.rows) ? entry.rows : []
    if (entryRows.length === 0 || entryRows.some(rankable)) continue
    const kinds = new Map()
    for (const row of entryRows) {
      if (row?.ok !== false) continue
      const kind = row.kind ?? classifyFailure({ status: row.status, reason: row.reason })
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    }
    const [dominant, count] = [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [
      "unknown",
      0,
    ]
    warnings.push(`${entry.provider}: ${entryRows.length} probed, 0 rankable — dominant failure: ${dominant} (${count})`)
  }
  const total = selection.length
  if (total === 0) warnings.push("no scorable model at or above the minimum score is available")
  else if (total < poolSize) warnings.push(`only ${total} scorable model(s) available, wanted ${poolSize}`)

  const limited = rows.filter((row) => row?.ok === false && isTransientFailure(row) && Number.isFinite(row.retryAfter))
  const retry =
    limited.length > 0
      ? {
          after: new Date(Math.min(...limited.map((row) => row.retryAfter))).toISOString(),
          models: limited.map((row) => row.model),
        }
      : undefined

  return { selection, warnings, retry }
}
