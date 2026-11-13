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
// A model that fails transiently scan after scan is not having a bad moment; it
// is a bad slot. Keep it (benched in place) for this many consecutive scans, then
// let it vacate the pool. A successful scan resets the streak, so a model that
// genuinely recovers returns on the next run. This is what stops a model that
// times out on every single request from being retained forever because the
// failure kind is nominally "transient".
export const MAX_TRANSIENT_STREAK = 3

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
  ["credit", /out\s+of\s+credits|insufficient\s+credits|credit\s+balance|requires\s+more\s+credits|payment\s+required|billing|purchase|budget\s+exhausted|api\s+budget|quota\s+exhausted|\b402\b/i],
  ["rate-limited", /rate[\s_-]?limit|usage\s+limit|too\s+many\s+requests|overloaded|limits?[\s_-]?(?:reached|exceeded)|free[-\s]?tier|freelimiterror|quota|\b429\b/i],
  ["credential", /\b401\b|unauthori[sz]ed|not\s+authori[sz]ed|invalid[\s_-]+(?:api[\s_-]?(?:key|token)|token|credential|bearer)|api[\s_-]?key\s+(?:is\s+)?(?:invalid|missing|expired|not\s+valid)|authentication\s+(?:failed|error|required)|incorrect[\s_-]?api[\s_-]?key/i],
  ["not-served", /\b404\b|no\s+such\s+model|model\s+not\s+found|does\s+not\s+exist|is\s+not\s+available|not\s+served|not\s+found/i],
  ["timeout", /timeout|timed\s+out|ETIMEDOUT|no\s+answer|no\s+response/i],
  ["network", /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch\s+failed|socket\s+hang\s+up|unreachable/i],
  ["server", /\b5\d\d\b|internal\s+server|bad\s+gateway|service\s+unavailable|gateway\s+timeout/i],
]

// An empty balance is not a bad moment: the provider has said it will not serve
// this account until someone tops it up (or the reset date arrives). Retaining
// the slot only benches a seat forever, so credit exhaustion vacates it like a
// missing model. A later scan that answers re-admits it automatically. Rate
// limits and outages are the kinds that stay retained.
const TRANSIENT_KINDS = new Set(["rate-limited", "timeout", "network", "server"])

/**
 * Failure kinds that vacate a pool slot for good: the model is gone, the
 * credential is wrong, the terms are unsigned, or the balance is empty. Every
 * other failure mode keeps the slot — benched, not deleted.
 */
export const HARD_DEAD_KINDS = new Set(["not-served", "credential", "agreement", "credit"])

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

// Which providers spend ONE shared quota window across their free models.
// `opencode` (Zen) is the known case: every free model draws from the same free
// bucket, which is why the primary selector tags it `b:opencode`. `opencode-go`
// is known to publish a per-model window. For any other provider the scorer
// cannot claim two models are independent, so fallback disjointness treats the
// provider as one shared window (the safe direction). The primary selection is
// unchanged unless a bucket is explicit or the provider is a known shared one.
export const SHARED_PROVIDER_BUCKETS = { opencode: "opencode" }
const PER_MODEL_PROVIDERS = new Set(["opencode-go"])

/** The quota group a candidate actually spends: declared, known-shared, or its own model. */
export function effectiveBucketFor(model, declared) {
  if (declared) return declared
  const provider = providerOf(model)
  if (PER_MODEL_PROVIDERS.has(provider)) return model
  return SHARED_PROVIDER_BUCKETS[provider] ?? provider
}

/** The bucket that must be written into pool.txt for a slot, when it is a known shared one. */
export function bucketToWriteFor(model, declared) {
  return declared ?? SHARED_PROVIDER_BUCKETS[providerOf(model)]
}

/** How many disjoint models the secondary pool keeps. */
export const FALLBACK_POOL_SIZE = 5
// Fallback seats are real capacity, not a token gesture: give each enough weight
// to run work, and allow up to two models from one fallback provider so a
// provider with several distinct models is not reduced to a single w1 seat.
export const FALLBACK_WEIGHT = 2
const MAX_FALLBACK_PER_PROVIDER = 2

// The fallback-section marker inside pool.txt, shared with the runtime parser.
const FALLBACK_MARKER = /^(?:#\s*-*\s*fallback(?:\s+slots)?\s*-*|\[fallback\])$/i

/**
 * Read `# exclude-provider: name[,name]` directives from a pool.txt header.
 *
 * A listed provider is not probed at all and is removed from the primary pool,
 * the fallback pool, and the retention source. The directive lives in the
 * header, which refresh preserves, so a provider whose account is out of budget
 * (or otherwise unwanted) stays out across regenerations without hand-editing
 * a generated file. Removing the line is all it takes to bring it back.
 */
export function parsePoolDirectives(text) {
  const excluded = new Set()
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^#\s*exclude-provider\s*:\s*(.+)$/i.exec(line.trim())
    if (!match) continue
    for (const name of match[1].split(/[,\s]+/)) {
      const provider = name.trim()
      if (provider) excluded.add(provider)
    }
  }
  return excluded
}

/**
 * Parse pool.txt slot lines into [{ model, weight, bucket?, context?, ceiling?, fallback? }].
 * Comments and blanks are ignored; weight defaults to 1. A line that is exactly
 * `# --- fallback ---` (or `[fallback]`) starts the fallback section.
 */
export function parsePoolSlots(text) {
  const out = []
  let section = "primary"
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (FALLBACK_MARKER.test(line.trim())) {
      section = "fallback"
      continue
    }
    const code = line.split("#")[0].trim()
    if (!code || !code.includes("/")) continue
    const [model, weight] = code.split(/\s+/)
    if (!model || !model.includes("/")) continue
    const bucket = /b:([^\s]+)/.exec(code)?.[1]
    const context = /c:(\d+)/.exec(code)?.[1]
    const ceiling = /ceil:(\d+)/.exec(code)?.[1]
    out.push({
      model,
      weight: Number(weight) > 0 ? Number(weight) : 1,
      ...(ceiling ? { ceiling: Number(ceiling) } : {}),
      ...(bucket ? { bucket } : {}),
      context: context ? Number(context) : null,
      ...(section === "fallback" ? { fallback: true } : {}),
    })
  }
  return out
}

/**
 * Pure structural verdict for a pool slot list (formatted lines or selection
 * entries). The contract: an opencode-go head (every go slot first, weight 4),
 * exactly one opencode tail (last, weight 2, b:opencode), POOL_SIZE slots.
 * Returns { valid, problems[] } — valid covers head+tail; count is reported
 * separately so a short-but-structured pool reads as short, not broken.
 */
export function poolStructureValid(slots) {
  const problems = []
  const parsed =
    typeof slots === "string"
      ? parsePoolSlots(slots)
      : Array.isArray(slots)
        ? slots.flatMap((entry) => (typeof entry === "string" ? parsePoolSlots(entry) : [entry]))
        : []
  const lines = parsed.map((entry) => ({
    model: entry?.model ?? "",
    weight: Number(entry?.weight) || 0,
    bucket: entry?.bucket,
    fallback: entry?.fallback === true,
  })).filter((entry) => entry.model.includes("/") && !entry.fallback)
  const go = lines.filter((entry) => providerOf(entry.model) === "opencode-go")
  const tails = lines.filter((entry) => providerOf(entry.model) === "opencode")
  if (go.length === 0) problems.push("missing opencode-go head")
  for (let i = 0; i < go.length; i++) {
    if (lines[i] !== go[i]) {
      problems.push("opencode-go slots must all come first")
      break
    }
    if (go[i].weight !== 4) {
      problems.push("opencode-go head slots must have weight 4")
      break
    }
  }
  if (tails.length !== 1) problems.push(`expected exactly one opencode tail, found ${tails.length}`)
  else {
    const tail = tails[0]
    if (lines[lines.length - 1] !== tail) problems.push("opencode tail slot must be last")
    if (tail.weight !== 2 || tail.bucket !== "opencode") problems.push("opencode tail must be weight 2 with b:opencode")
  }
  if (lines.length !== POOL_SIZE) problems.push(`expected ${POOL_SIZE} slots, found ${lines.length}`)
  const structural = problems.filter((p) => !p.startsWith(`expected ${POOL_SIZE}`))
  return { valid: structural.length === 0, problems, count: lines.length }
}

/**
 * Hard-dead check for retention: only these failure kinds vacate a slot.
 */
export const isHardDeadRow = (row) => {
  if (!row || row.ok !== false) return false
  const kind = String(row.kind ?? classifyFailure({ status: row.status, reason: row.reason }) ?? "").toLowerCase()
  return HARD_DEAD_KINDS.has(kind)
}

export function selectPool({
  providers,
  previousProviders,
  currentSlots = [],
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
    (row.context == null || row.context >= minContext) &&
    // A stale success carried beside a current failure is rankable only while the
    // failure streak is short. Once the model has failed MAX_TRANSIENT_STREAK
    // scans in a row, the old score stops being evidence about the present.
    Number(row?.failStreak ?? 0) < MAX_TRANSIENT_STREAK
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
  // A ceiling is the slot's hard concurrency cap (max parallel sessions). It is
  // carried from the current pool through the report so a refresh never silently
  // drops it; only a ceiling that still fits the slot's weight is kept.
  const ceilingByModel = new Map(
    (Array.isArray(currentSlots) ? currentSlots : [])
      .filter((slot) => slot && typeof slot.model === "string" && Number.isFinite(Number(slot.ceiling)))
      .map((slot) => [slot.model, Number(slot.ceiling)]),
  )
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

  const warnings = []

  // Pool-level retention: a current member stays unless this run proved it
  // hard-dead. A healthy-but-unselected model (caps, score floors) is NOT
  // retained — the caps decided that. A transiently failed, unscanned, or
  // budget-cut model is retained and benched in place by the writer; only a
  // catalogue removal on a cleanly scanned provider vacates the slot. Head
  // and tail are never vacated by a failed or partial scan.
  const rowByModel = new Map(rows.map((row) => [row.model, row]))
  const cleanlyScanned = (model) => {
    const provider = providerOf(model)
    return scannedProviders.has(provider) && !truncatedProviders.has(provider) && !erroredProviders.has(provider)
  }
  const placedModels = new Set([...go, ...cappedSmall, ...cappedLarge, ...pickedZen].map((row) => row.model))
  const shouldRetain = (model) => {
    if (!model.includes("/") || placedModels.has(model)) return false
    const row = rowByModel.get(model)
    // Retain a failed member only while its consecutive-failure streak is short.
    // Past the cap the slot has proved it cannot serve; leaving it in the pool
    // just benches a seat every refresh and hands work to it between refreshes.
    if (row) return row.ok === false && !isHardDeadRow(row) && Number(row.failStreak ?? 0) < MAX_TRANSIENT_STREAK
    return !cleanlyScanned(model)
  }
  const retainedHead = []
  const retainedMiddle = []
  let retainedTail = null
  for (const slot of Array.isArray(currentSlots) ? currentSlots : []) {
    const model = String(slot?.model ?? "")
    if (!shouldRetain(model)) continue
    const weight = Number(slot?.weight)
    if (providerOf(model) === "opencode-go") {
      retainedHead.push({ model, weight: 4, context: slot?.context ?? null, retained: true })
    } else if (providerOf(model) === "opencode") {
      if (!retainedTail) retainedTail = { model, weight: 2, bucket: "opencode", context: slot?.context ?? null, retained: true }
    } else {
      retainedMiddle.push({
        model,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 2,
        ...(slot?.bucket ? { bucket: slot.bucket } : {}),
        context: slot?.context ?? null,
        retained: true,
      })
    }
  }

  const toSmall = (row) => ({ model: row.model, weight: 2, context: row.context ?? null })
  const toLarge = (row) => ({ model: row.model, weight: 1, context: row.context ?? null })
  const middle = [...pickedSmall.map(toSmall), ...pickedLarge.map(toLarge)]
  for (const entry of retainedMiddle) {
    if (!middle.some((existing) => existing.model === entry.model)) middle.push(entry)
  }
  if (retainedTail && !pickedZen.some((row) => providerOf(row.model) === "opencode")) {
    middle.push({ ...retainedTail })
    retainedTail = { ...retainedTail, placed: true }
  }
  const head = [
    ...retainedHead,
    ...go.filter((row) => !retainedHead.some((entry) => entry.model === row.model)).map((row) => ({ model: row.model, weight: 4, context: row.context ?? null })),
  ]
  const tail = pickedZen.map((row) => ({ model: row.model, weight: 2, bucket: "opencode", context: row.context ?? null }))
  let selection = [...head, ...middle, ...tail]
  // The report carries each slot's ceiling as a fact: a configured ceiling from
  // the current pool survives regeneration, and a slot with none stays weight-only.
  selection = selection.map((entry) => {
    const ceiling = ceilingByModel.get(entry.model)
    return ceiling !== undefined && ceiling >= Number(entry.weight) ? { ...entry, ceiling } : entry
  })
  // Two provider ids can front the same upstream model (an `openrouter` and a
  // `console-openrouter` alias, for example). They draw on one quota window, so
  // giving both a slot burns capacity twice and both fall over together. When
  // the provider names are aliases (one is a suffix of the other) and the model
  // id past the provider prefix is identical, keep only the first, score-ranked
  // occurrence. A plain `provider/model` id is never collapsed, so different
  // providers serving the same model name keep their independent slots.
  const upstreamOf = (model) => {
    const slash = String(model).indexOf("/")
    const upstream = slash < 0 ? "" : String(model).slice(slash + 1)
    return upstream.includes("/") ? upstream : ""
  }
  const seenUpstream = new Map()
  selection = selection.filter((entry) => {
    const upstream = upstreamOf(entry.model)
    if (!upstream) return true
    const provider = providerOf(entry.model)
    const prior = seenUpstream.get(upstream)
    if (prior && (provider.endsWith(prior) || prior.endsWith(provider))) return false
    seenUpstream.set(upstream, provider)
    return true
  })
  // Fit the contract size without ever vacating head or tail: trim the middle
  // from the back (lowest score first), skipping retained slots. If even that
  // cannot fit, the head wins and a warning says so.
  while (selection.length > poolSize) {
    let index = -1
    for (let i = selection.length - 1; i >= 0; i--) {
      const entry = selection[i]
      if (!entry.retained && providerOf(entry.model) !== "opencode-go" && providerOf(entry.model) !== "opencode") {
        index = i
        break
      }
    }
    if (index === -1) {
      warnings.push(`pool head exceeds the contract size ${poolSize}; keeping every head slot`)
      break
    }
    selection.splice(index, 1)
  }

  const retainedCount = selection.filter((entry) => entry.retained).length
  if (retainedCount > 0) {
    warnings.push(
      `retained ${retainedCount} current slot(s) benched in place: ${selection
        .filter((entry) => entry.retained)
        .map((entry) => entry.model)
        .join(", ")}`,
    )
  }

  // A fallback pool for the case where every primary slot is cooling at once.
  // Candidates are score-ranked and must spend a different quota window from
  // every primary slot: a same-bucket model would be benched by the same limit,
  // so it cannot serve as a fallback. A provider may contribute up to
  // MAX_FALLBACK_PER_PROVIDER distinct models; a shared bucket is written only
  // when it is a known fact (Zen).
  const selectedModels = new Set(selection.map((entry) => entry.model))
  const primaryBuckets = new Set(selection.map((entry) => effectiveBucketFor(entry.model, entry.bucket)))
  const fallbackSelection = []
  const fallbackCounts = new Map()
  for (const row of merge(() => true)) {
    if (fallbackSelection.length >= FALLBACK_POOL_SIZE) break
    if (!rankable(row) || selectedModels.has(row.model)) continue
    if (primaryBuckets.has(effectiveBucketFor(row.model, undefined))) continue
    const provider = providerOf(row.model)
    const count = fallbackCounts.get(provider) ?? 0
    if (count >= MAX_FALLBACK_PER_PROVIDER) continue
    fallbackCounts.set(provider, count + 1)
    const bucket = bucketToWriteFor(row.model, undefined)
    fallbackSelection.push({ model: row.model, weight: FALLBACK_WEIGHT, ...(bucket ? { bucket } : {}), context: row.context ?? null })
  }

  for (const entry of Array.isArray(providers) ? providers : []) {
    if (entry?.error) {
      warnings.push(`${entry.provider}: ${entry.error}`)
      continue
    }
    const entryRows = Array.isArray(entry?.rows) ? entry.rows : []
    if (entry?.degraded) {
      warnings.push(`${entry.provider}: degraded — stopped after consecutive transient failures; previous rows kept`)
    }
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

  return { selection, fallback: fallbackSelection, warnings, retry }
}
