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

export const isTransientFailure = (row) =>
  row?.ok === false &&
  /timeout|timed out|rate-limit|no answer|no response|unreachable|ECONN|ETIMEDOUT|fetch failed|socket hang up|credit|402/i.test(
    String(row.reason ?? ""),
  )

const isLimitText = (text) =>
  /rate[\s_-]?limit|usage limit|too many requests|quota|freelimiterror|overloaded|limits?[\s_-]?(?:reached|exceeded)|\b429\b/i.test(
    String(text ?? ""),
  )

const isDailyLimit = (text) => /per[\s-]?day|daily|free-models-per-day|requests?\s+per\s+day/i.test(String(text ?? ""))

const isCreditText = /out of credits|insufficient credits|credit balance|requires more credits|\b402\b/i

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
} = {}) {
  const rankable = (row) =>
    row?.ok === true &&
    typeof row.score === "number" &&
    Number.isFinite(row.score) &&
    row.score >= minScore &&
    (row.context == null || row.context >= minContext)
  const byScore = (a, b) => b.score - a.score || String(a.model).localeCompare(String(b.model))

  const rows = rowsOf(providers)
  const previousRows = rowsOf(previousProviders)
  const currentByModel = new Map(rows.map((row) => [row.model, row]))
  const erroredProviders = new Set(
    (Array.isArray(providers) ? providers : [])
      .filter((entry) => entry?.error)
      .map((entry) => String(entry.provider ?? "")),
  )

  // A model the previous run scored is kept when this run could not reach it
  // for a transient reason. A model the provider says is gone is not kept.
  const fallback = previousRows.filter((row) => {
    if (!rankable(row)) return false
    const current = currentByModel.get(row.model)
    if (current) return isTransientFailure(current)
    return erroredProviders.has(providerOf(row.model))
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

  const remaining = Math.max(0, poolSize - go.length)
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

  const zenSlots = Math.max(0, Math.min(maxZen, poolSize - go.length - pickedSmall.length - pickedLarge.length))
  const pickedZen = zen.slice(0, zenSlots)

  const selection = [
    ...go.map((row) => ({ model: row.model, weight: 4, context: row.context ?? null })),
    ...pickedSmall.map((row) => ({ model: row.model, weight: 2, context: row.context ?? null })),
    ...pickedLarge.map((row) => ({ model: row.model, weight: 1, context: row.context ?? null })),
    ...pickedZen.map((row) => ({ model: row.model, weight: 1, bucket: "opencode", context: row.context ?? null })),
  ]

  const warnings = []
  const total = selection.length
  if (total === 0) warnings.push("no scorable model at or above the minimum score is available")
  else if (total < poolSize) warnings.push(`only ${total} scorable model(s) available, wanted ${poolSize}`)

  const limited = rows.filter((row) => row?.ok === false && Number.isFinite(row.retryAfter))
  const retry =
    limited.length > 0
      ? {
          after: new Date(Math.min(...limited.map((row) => row.retryAfter))).toISOString(),
          models: limited.map((row) => row.model),
        }
      : undefined

  return { selection, warnings, retry }
}
