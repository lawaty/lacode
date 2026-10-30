import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PACKAGE_ROOT } from "./package-root.ts"

// Shared model pool for every free-model agent type.
//
// One set of slots is shared by ALL pooled agent types (explore,
// implement, context). A slot is a model, not an agent: load is
// counted per SLOT across every agent type, so total pressure on each slot is
// balanced no matter which kind of work is running. Slot N of any base is the
// same slot, so `explore-2` and `context-2` share one load counter. Two slots may
// name the same model; each keeps its own counter, so listing a model twice gives
// it two independent budgets.
//
// Every slot carries a `weight` (the preset), and that is the only knob. A slot's
// weight is its active-session budget: routing walks the usable slots in
// declaration order and fills each to its weight. There is no second pass and no
// 2x ceiling. When every usable slot is at its weight the pool is at capacity
// (the sum of the weights); a burst past that degrades to even spreading over the
// least-loaded usable slot rather than blocking the caller.
//
// This module holds the state and the decision; src/plugins/agent-pool.ts owns
// the hooks (task routing, limit detection, hang reaping) and
// src/plugins/context-autoupdate.ts borrows a slot directly, because it spawns
// its agent through the session API rather than the task tool and so never
// passes through the task hook.
//
// Which models fill the slots comes from the preset resolution chain (see
// resolveModels), resolved into State.slots and shared by every hook in the
// process. A watcher in src/plugins/agent-pool.ts calls reloadSlots() when a
// source file changes, so an edit reaches the running process.
//
// COST IS THE USER'S CHOICE (US-7). Nothing here, and nothing in the preset
// loader, asks what a model costs or whether it is free: any provider/model-id
// string is accepted, paid or not. The bundled preset happens to be built from
// free models because that is a good default, not because the pool requires it.
// Validation below is STRUCTURAL ONLY -- shape of the models object, weights in
// range, repeats allowed, no slot cap.

export const CLAIM_TTL_MS = 10 * 60 * 1000
export const UNBOUND_CLAIM_MS = 2 * 60 * 1000
export const DEAD_FILE_MS = 2 * CLAIM_TTL_MS
export const ORPHAN_TMP_MS = 60 * 1000
export const CATALOG_TTL_MS = 10 * 60 * 1000
export const PROVIDER_LIST_TTL_MS = 60 * 1000
export const STUCK_MIN_AGE_MS = 5 * 60 * 1000
export const STUCK_IDLE_MS = 3 * 60 * 1000
/** Absolute ceiling on a claim's life. The silence check below can be reset by
 * any message event, so a task that hangs while still trickling output would
 * otherwise never be condemned. This bounds it regardless. */
export const MAX_CLAIM_AGE_MS = 30 * 60 * 1000
export const HANG_COOLDOWN_MS = 10 * 60 * 1000
// A transient upstream outage self-resolves, so it is cooled briefly and re-probed
// rather than escalated like a strike. See coolUnavailable().
export const UNAVAILABLE_COOLDOWN_MS = 60 * 1000
/**
 * The reason a transient outage is filed under.
 *
 * It is not a quota and it is not a strike: such a record benches a model for
 * one short flat window and must never enter the strike memory, or the next
 * real failure on that model would start at strike 2 and get a window twice as
 * long as the first one.
 */
export const UNAVAILABLE_REASON = "endpoint-unavailable"
// A weight is a slot's active-session budget. With no second pass the pool's
// whole capacity is the sum of the slot weights, so this only bounds one line's
// share. Past it the number stops describing concurrency and becomes a way to
// silence load balancing entirely, which is a config error rather than a value to
// honour.
export const MAX_WEIGHT = 100
/** How many active sessions a slot may hold at once: its weight. To give a
 * model more capacity, list it again on another line with its own weight. */
export const slotCeiling = (slot: Slot) => slot.weight

/** The quota group a slot belongs to. Default: the model is its own bucket. */
export const slotBucket = (slot: Slot) => slot.bucket ?? slot.model
// The pool has no fixed slot count: src/agents.ts generates exactly one hidden
// variant per base per resolved slot, and the watcher creates a variant when the
// table grows. This is a loud sanity threshold, not a cap -- a malformed file
// that expands to hundreds of slots is reported but still honoured.
export const SLOTS_WARN_AT = 64
const COOLDOWN_BASE_MS = 60 * 1000
const COOLDOWN_MAX_MS = 15 * 60 * 1000
// A provider quota/limit is not a transient blip: it reopens on the provider's
// own schedule, so a limit-shaped failure is cooled on a far longer curve than a
// generic rate-limit guess. Without this a daily quota produced a fresh 60s window
// every time the previous one lapsed, so the same dead model was re-admitted (and
// its 6 upstream retries re-burned) all day long. `stated` resets -- "Resets in
// 35min" -- still win outright, which is the exact "until the quota restores" case.
export const QUOTA_COOLDOWN_BASE_MS = 15 * 60 * 1000
export const QUOTA_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000
const STRIKE_DECAY_MS = 30 * 60 * 1000

/**
 * Ceiling on a provider-STATED reset ("retry in 45min"), whatever it claims.
 *
 * A stated window is still trusted over the computed backoff, because it is the
 * provider telling us when it reopens. But it is TEXT parsed out of an upstream
 * error, and an uncapped parse turns one bad number into a permanent bench: a
 * real `account_rate_limit` carrying "retry in 329917s" (~3.8 days) cooled a
 * slot for 91.6 hours, so a provider that had already recovered stayed excluded
 * for days while every delegated spawn queued behind the two survivors.
 *
 * The quota cap is the right ceiling: long enough to honour a genuine daily
 * reset, short enough that a malformed number cannot remove a model for days.
 * Beyond the cap the value is DISCARDED rather than clamped, so the caller falls
 * back to the ordinary strike backoff instead of treating "at least 6h" as fact.
 */
export const STATED_COOLDOWN_MAX_MS = QUOTA_COOLDOWN_MAX_MS

/**
 * A failure reason that describes a provider quota/allowance rather than a
 * transient blip. Used to pick the longer cooldown curve; the scraper in
 * src/plugins/agent-pool.ts supplies reasons like `quota`, `usage-limit`,
 * `rate-limit`, `too-many-requests`, `overloaded` and `free_tier_limit`.
 * `hang` (the reaper) and `endpoint-unavailable` are deliberately NOT quota
 * reasons: neither is the provider saying "you are out of allowance".
 */
export const isQuotaReason = (reason: string) => /quota|limit|rate|too-many|overloaded|429/i.test(reason)

/**
 * The reason a model id the provider does not serve is filed under.
 *
 * A withdrawn or mistyped model is not a quota: it does not reopen on a
 * schedule, so re-probing it every few minutes only spends requests. It is
 * benched for the quota cap instead, and a later probe re-admits it if the
 * provider starts serving it again.
 */
export const MODEL_MISSING_REASON = "model-missing"
export const MODEL_MISSING_COOLDOWN_MS = QUOTA_COOLDOWN_MAX_MS
export const AUTH_FAILURE_REASON = "auth-failed"
export const AUTH_FAILURE_COOLDOWN_MS = QUOTA_COOLDOWN_MAX_MS
// The wording opencode uses when a provider does not know a model id:
// "Model not found: provider/model. Did you mean: ...". Deliberately textual --
// a bare 404 can be a gateway route, and benching a healthy model for it would
// take a slot out over a missing endpoint.
const MODEL_MISSING_PATTERN = /model\s+(?:not\s+found|does\s+not\s+exist|is\s+not\s+available)|(?:unknown|no\s+such)\s+model/i
export const isModelMissingText = (text: string) => MODEL_MISSING_PATTERN.test(text)

const AUTH_FAILURE_PATTERN =
  /\b401\b|\b403\b|unauthori[sz]ed|not\s+authori[sz]ed|invalid[\s_-]+(?:api[\s_-]?(?:key|token)|token|credential|bearer)|api[\s_-]?key\s+(?:is\s+)?(?:invalid|missing|expired|not\s+valid)|authentication\s+(?:failed|error|required)|incorrect[\s_-]+api[\s_-]?key/i

export const isAuthFailureText = (text: string) => AUTH_FAILURE_PATTERN.test(text)

export type Slot = { index: number; model: string; weight: number; bucket?: string }

export type Claim = {
  v: string
  k: number
  m: string
  /** When the claim was taken. Never moved, so hang-age stays anchored to the spawn. */
  t: number
  /**
   * Last proof the target session is alive, refreshed by every message event.
   * Abandonment (TTL) is measured from here, NOT from `t`: a long task that keeps
   * working must keep occupying its slot, otherwise the shared count silently
   * drops it mid-run and the slot oversubscribes.
   */
  hb?: number
  /** Failed abort attempts. The claim is held (not freed) until this gives up. */
  n?: number
  s?: string
  g?: string
}
export type Strike = { model: string; until: number; strikes: number; reason: string; last: number }
export type Sibling = { id: string; claims: Claim[] }
export type Snapshot = {
  counts: Map<number, number>
  cooling: Map<string, Strike>
  siblings: Sibling[]
  own: Map<string, Claim>
  dirReady: boolean
}

export const BASES = ["explore", "implement", "context"]

// ---------------------------------------------------------------------------
// Preset resolution chain
// ---------------------------------------------------------------------------
//
// The pool's slots are configuration, not code. Three sources are consulted in
// this order, and the first one that yields usable slots wins:
//
//   1. plugin options   ["@lawaty/lacode", { "models": { "slots": [...] } }]
//   2. user config      ~/.config/lacode/pool.txt (flat, preferred)
//   3. user config      ~/.config/lacode/pool.json
//   4. bundled preset   <package root>/presets/free-tier.json
//
// Anything missing or unusable falls through silently to the next link; the
// built-in FALLBACK_SLOTS below is the last resort so routing always works. A
// typo in a preset is a logged warning, never an exception -- a pool that cannot
// route takes every parallel spawn in the process down with it.
//
// The explicit `modelsFile` option (tests, and anyone pointing at one file
// explicitly) short-circuits the chain.

/**
 * Package root discovery lives in ./package-root.ts so lightweight consumers
 * (the CLI, the self-updater) can import the path without pulling in this whole
 * module. Re-exported here to keep the `./pool` public surface unchanged.
 */
export { PACKAGE_ROOT }
export const PRESETS_DIR = join(PACKAGE_ROOT, "presets")
export const DEFAULT_PRESET = join(PRESETS_DIR, "free-tier.json")
/** The user's own pool file. Absent is normal and never an error. */
export const USER_CONFIG_DIR = join(homedir(), ".config", "lacode")
export const USER_MODELS_PATH = join(USER_CONFIG_DIR, "pool.json")
/** The flat, hand-edited pool file: `model [weight]` per line. Preferred over pool.json. */
export const USER_MODELS_TXT = join(USER_CONFIG_DIR, "pool.txt")

export const FALLBACK_SLOTS: Slot[] = [
  { index: 1, model: "opencode/big-pickle", weight: 3 },
  { index: 2, model: "opencode-go/beam-free", weight: 2 },
  { index: 3, model: "opencode/deepseek-v4.1-flash-free", weight: 1 },
  { index: 4, model: "opencode/glm-5.3-flash-free", weight: 1 },
]

export type SlotFile = { slots: Slot[]; problems: string[] }

/** Human-readable origin of a slot list, used in log lines and warnings. */
export type ModelsSource = { slots: Slot[]; problems: string[]; origin: string }

// Slot indices are the array position, so the source is the only place a slot
// number exists; nothing downstream can disagree with it. Every entry is
// validated on its own: one bad slot is dropped with a warning, the rest still
// route, unless nothing survives and the built-in defaults take over.
//
// Weight is the slot's active-session budget, so a bad one warns and falls back to 1
// rather than dropping the slot -- losing a model because of a typo in a count would
// cost real capacity. A slot with no weight at all is weight 1.
export function parseSlots(parsed: unknown, origin: string): SlotFile {
  const problems: string[] = []
  const entries = (parsed as { slots?: unknown })?.slots
  if (!Array.isArray(entries) || entries.length === 0) {
    return { slots: FALLBACK_SLOTS, problems: [`${origin} has no non-empty "slots" array; using built-in defaults`] }
  }
  const slots: Slot[] = []
  entries.forEach((entry, i) => {
    const model = typeof (entry as { model?: unknown })?.model === "string" ? ((entry as { model: string }).model).trim() : ""
    const at = `slot ${i + 1}`
    // The only per-model rule there is: a slot must be addressable. Whether it
    // costs money is never inspected (US-7), and a model may appear on more than
    // one line: each line is its own slot with its own weight.
    if (!model.includes("/")) return problems.push(`${at}: model must be written provider/model-id, got "${model}"`)
    const weight = readWeight(entry, at, model, problems)
    const rawBucket = (entry as { bucket?: unknown })?.bucket
    const bucket = typeof rawBucket === "string" ? rawBucket.trim() : undefined
    if (rawBucket !== undefined && !bucket) {
      problems.push(`${at} (${model}): bucket must be a non-empty name; using the model id`)
    }
    slots.push({ index: slots.length + 1, model, weight, ...(bucket ? { bucket } : {}) })
  })
  if (slots.length > SLOTS_WARN_AT) {
    problems.push(`${origin}: ${slots.length} slots is unusually large, but every entry is kept (the pool has no slot cap)`)
  }
  if (slots.length === 0) {
    problems.push(`${origin} yielded no usable slot; using built-in defaults`)
    return { slots: FALLBACK_SLOTS, problems }
  }
  return { slots, problems }
}

/**
 * Parse the flat, hand-edited pool file: one
 * `<provider>/<model-id> [weight] [b:<bucket>]` per line. `#` starts a comment
 * (whole-line or trailing); blank lines are ignored; a missing weight is 1. A
 * `b:<bucket>` token declares a shared quota group: a limit on any line in the
 * bucket benches every line in it. Without one, the model id is its own bucket.
 * Entries go through the SAME `parseSlots` validation as every other source, so
 * the rules (first-slash split, weight in range, repeats allowed, no slot cap)
 * are identical everywhere.
 */
export function parseTextSlots(text: string, origin: string): SlotFile {
  const entries: Array<{ model: string; weight?: string; bucket?: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim()
    if (!line) continue
    const [model, ...rest] = line.split(/\s+/)
    let weight: string | undefined
    let bucket: string | undefined
    for (const token of rest) {
      if (token.startsWith("b:")) {
        if (bucket === undefined) bucket = token.slice(2)
      } else if (weight === undefined) {
        weight = token
      }
    }
    entries.push({ model, ...(weight === undefined ? {} : { weight }), ...(bucket === undefined ? {} : { bucket }) })
  }
  return parseSlots({ slots: entries }, origin)
}

/**
 * Parse a slot file that may be JSON (a leading `{`) or the flat line format, so a
 * user can keep either shape in the same file without the loader caring which.
 */
export function parseSlotText(text: string, origin: string): SlotFile {
  if (text.trimStart().startsWith("{")) {
    try {
      return parseSlots(JSON.parse(text), origin)
    } catch (error) {
      return { slots: FALLBACK_SLOTS, problems: [`${origin} is not valid JSON (${String(error)}); using built-in defaults`] }
    }
  }
  return parseTextSlots(text, origin)
}

const readJSON = (path: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

// Present so a user who finds the preset loader surprising has one place to look.
// An absent user file is NOT a problem to report -- it is the normal case for
// everyone but the package author -- so only an unreadable/!JSON file warns.
function readOptional(path: string, origin: string, problems: string[]) {
  const result = readJSON(path)
  if (!result.ok) {
    if (existsSync(path)) problems.push(`${origin} unreadable (${result.error}); trying the next source`)
    return undefined
  }
  return result.value
}

/** Read a file as text; absent is undefined, unreadable warns once and is undefined. */
function readTextOptional(path: string, origin: string, problems: string[]): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    problems.push(`${origin} unreadable (${String(error)}); trying the next source`)
    return undefined
  }
}

/**
 * Resolve the slot list through the chain documented above.
 *
 * @param input.models     inline `{ slots: [...] }` from plugin options (highest priority)
 * @param input.modelsFile an explicit file, which short-circuits the chain
 */
export function resolveModels(input: { models?: unknown; modelsFile?: string } = {}): ModelsSource {
  const problems: string[] = []

  if (input.models !== undefined) {
    const origin = "plugin options"
    if (typeof input.models !== "object" || input.models === null || Array.isArray(input.models)) {
      return { slots: FALLBACK_SLOTS, problems: [`${origin}: "models" must be an object like {"slots":[...]}`], origin }
    }
    const parsed = parseSlots(input.models, origin)
    return { slots: parsed.slots, problems: [...problems, ...parsed.problems], origin }
  }

  if (input.modelsFile) {
    const parsed = readSlotFile(input.modelsFile)
    return { slots: parsed.slots, problems: parsed.problems, origin: input.modelsFile }
  }

  // 2. the user's own file — the flat pool.txt first, then the JSON pool.json —
  //    then 3. the bundled preset.
  const text = readTextOptional(USER_MODELS_TXT, USER_MODELS_TXT, problems)
  if (text !== undefined) {
    const parsed = parseSlotText(text, USER_MODELS_TXT)
    if (parsed.slots !== FALLBACK_SLOTS) return { slots: parsed.slots, problems: [...problems, ...parsed.problems], origin: USER_MODELS_TXT }
    problems.push(...parsed.problems)
  }

  const user = readOptional(USER_MODELS_PATH, USER_MODELS_PATH, problems)
  if (user !== undefined) {
    const parsed = parseSlots(user, USER_MODELS_PATH)
    // parseSlots returns the FALLBACK_SLOTS array itself when it had to give up,
    // which is the honest signal that the user's file was structurally broken:
    // fall through to the bundled preset rather than leaving the pool on the
    // generic fallback while a real preset is sitting right there.
    if (parsed.slots !== FALLBACK_SLOTS) return { slots: parsed.slots, problems, origin: USER_MODELS_PATH }
    problems.push(...parsed.problems)
  }

  const preset = readOptional(DEFAULT_PRESET, DEFAULT_PRESET, problems)
  if (preset !== undefined) {
    const parsed = parseSlots(preset, "presets/free-tier.json")
    return { slots: parsed.slots, problems: [...problems, ...parsed.problems], origin: "presets/free-tier.json" }
  }

  return { slots: FALLBACK_SLOTS, problems: [...problems, `no pool source found (${USER_MODELS_TXT}, ${USER_MODELS_PATH}, ${DEFAULT_PRESET}); using built-in defaults`], origin: "built-in defaults" }
}

export function readSlotFile(path: string): SlotFile {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    return { slots: FALLBACK_SLOTS, problems: [`${path} unreadable (${String(error)}); using built-in defaults`] }
  }
  return parseSlotText(text, path)
}

/**
 * Make `~/.config/lacode/` exist so a user can drop a `pool.txt` (or `pool.json`) into it without
 * first having to `mkdir`. Called once at plugin startup, never during a read:
 * a library that creates directories as a side effect of being asked a question
 * is a library nobody trusts. Never throws -- an unwritable HOME just means the
 * bundled preset is used, which is the normal case anyway.
 */
export function ensureUserConfigDir(): boolean {
  try {
    mkdirSync(USER_CONFIG_DIR, { recursive: true })
    return true
  } catch {
    return false
  }
}

// `weight` is the slot's active-session budget; absent means 1. `tier` is the
// pre-weight spelling, accepted as a deprecated alias
// (primary -> 2, overflow -> 1) so a host that has not been re-deployed keeps two
// slots' worth of headroom instead of silently collapsing to a budget of one each.
function readWeight(entry: unknown, at: string, model: string, problems: string[]): number {
  const raw = (entry as { weight?: unknown })?.weight
  if (raw === undefined) {
    const legacy = (entry as { tier?: unknown })?.tier
    if (legacy !== undefined) {
      // One line per distinct value: warnOnce collapses the repeats, so a whole
      // legacy file logs once for "primary" and once for "overflow".
      problems.push(
        `weight: "tier" is deprecated; write "weight" instead (primary is weight 2, overflow is weight 1), got ${JSON.stringify(legacy)}`,
      )
      if (legacy === "primary" || legacy === "overflow") return legacy === "primary" ? 2 : 1
    }
    return 1
  }
  const weight = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT) {
    problems.push(`${at} (${model}): weight must be a number in (0, ${MAX_WEIGHT}], got ${JSON.stringify(raw)}; using weight 1`)
    return 1
  }
  return weight
}

// A transient upstream outage ("Endpoint is unavailable"). Recognized as
// limit-shaped so it is not reported as an unrecognized failure, but handled by
// its own path: it lifts on its own, so it must not accumulate strikes.
const UNAVAILABLE_PATTERN = /endpoint\s+is\s+unavailable/i

const LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /usage limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /freelimiterror/i,
  /overloaded/i,
  UNAVAILABLE_PATTERN,
]

// A provider with its own limit vocabulary: "limit reached", "daily limit
// reached", "usage limit exceeded", "you have reached your limit".
//
// The CONTEXT family is excluded on purpose. "context limit reached" is a
// prompt that is too long, not a provider that has run out of allowance, and
// benching a model for it would take a healthy provider out of the pool over
// the user's own prompt.
const LIMIT_REACHED_PATTERN = /\blimits?[\s_-]?(?:reached|exceeded)\b|\breached\s+(?:your|the|its)\s+limit\b/i
const CONTEXT_LIMIT_PATTERN = /(?:context|token|length|window|prompt|char|character|byte|size)\s*(?:limit|length|size|window)/i

// The vocabulary a limit is NAMED by. The first alternative that matches
// anywhere in the text wins, so "rate limit reached" is named "rate-limit" and
// "daily limit reached" is named "limit-reached".
const LIMIT_REASON_PATTERN = /rate[\s_-]?limit|usage limit|too many requests|quota|freelimiterror|overloaded|limits?[\s_-]?(?:reached|exceeded)/i

export const isLimitText = (text: string) =>
  LIMIT_PATTERNS.some((re) => re.test(text)) ||
  (LIMIT_REACHED_PATTERN.test(text) && !CONTEXT_LIMIT_PATTERN.test(text))

/**
 * The name of the limit a text reports, for a cooldown file's `reason`.
 *
 * One vocabulary, read from one place: the pool, the prober and the fail-over
 * path all take the reason from here, so a log line and a cooldown file never
 * spell the same fault two ways. Returns undefined when the text carries no
 * limit at all -- the caller decides what to call that.
 *
 * The SAME predicate that decides whether a text is a limit decides this, so
 * the two cannot disagree: a text the matcher excludes on purpose -- "context
 * limit reached", a prompt that is too long rather than a provider out of
 * allowance -- is given no reason at all, and neither a cooldown file nor the
 * prober's short reason ever calls it a limit.
 */
export const limitReason = (text: string): string | undefined => {
  if (!isLimitText(text)) return undefined
  return text.match(LIMIT_REASON_PATTERN)?.[0]?.toLowerCase().replace(/[\s_]/g, "-")
}

export const isUnavailableText = (text: string) => UNAVAILABLE_PATTERN.test(text)

// A gateway that cannot serve the request right now: a queue budget exhausted,
// a request aborted on timeout. Like an unavailable endpoint it self-resolves,
// so it is cooled flat rather than escalated as a strike. Deliberately separate
// from LIMIT_PATTERNS: quota/limit semantics must stay untouched.
const TRANSIENT_GATEWAY_PATTERNS = [/queue budget/i, /exceeded queue/i, /aborted due to timeout/i, /timeout/i]

export const isTransientGatewayText = (text: string) => TRANSIENT_GATEWAY_PATTERNS.some((re) => re.test(text))

// Providers sometimes state exactly when the window reopens; prefer that over a
// guessed backoff. Handles "Resets in 35min", "Resets in 2hr 17min", "retry in 90s".
//
// Two things this must get right, and both were wrong at once:
//
//   * BOUNDED. Every branch is capped at STATED_COOLDOWN_MAX_MS, and a value
//     past the cap yields undefined rather than a clamped number -- see that
//     constant. A provider claiming a three-day window is not a source to be
//     believed, and "at least 6h" would be a guess dressed as a fact.
//   * LONGEST SPELLING FIRST. The unit alternations are ordered h|hr|hour ->
//     hour|hr|h, because "2hr 17min" otherwise matches the bare "h", leaves
//     "r 17min" unparsed, and silently reports 2h00 where the provider said
//     2h17 -- a window that is too SHORT by exactly the part it dropped.
export const statedCooldown = (text: string): number | undefined => {
  const bounded = (ms: number) =>
    Number.isFinite(ms) && ms > 0 && ms <= STATED_COOLDOWN_MAX_MS ? ms : undefined
  const hm = /resets?\s+in\s+(\d+)\s*(?:hour|hr|h)s?\s*(\d+)?\s*(?:minute|min|m)?s?/i.exec(text)
  if (hm) return bounded((Number(hm[1]) * 60 + (hm[2] ? Number(hm[2]) : 0)) * 60 * 1000)
  const m = /resets?\s+in\s+(\d+)\s*(?:minute|min|m)s?/i.exec(text)
  if (m) return bounded(Number(m[1]) * 60 * 1000)
  const s = /retry[\s-]?in\s+(\d+)\s*(?:second|sec|s)s?/i.exec(text)
  if (s) return bounded(Number(s[1]) * 1000)
  return undefined
}

export const retryAfterMs = (headers?: Record<string, string>): number | undefined => {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "retry-after") continue
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds > 0) {
      const ms = seconds * 1000
      if (ms > STATED_COOLDOWN_MAX_MS) return undefined
      return ms
    }
    const when = Date.parse(value)
    if (Number.isFinite(when)) {
      const delay = when - Date.now()
      if (delay > STATED_COOLDOWN_MAX_MS) return undefined
      return Math.max(delay, 1000)
    }
  }
  return undefined
}

type State = {
  own: Map<string, Claim>
  models: Map<string, string>
  known: Set<string>
  warned: Set<string>
  initialized: boolean
  dirReady: boolean
  catalog: Map<string, string>
  catalogAt: number
  cooling: Map<string, Strike>
  /**
   * Every strike record still inside its decay window, INCLUDING a cooldown whose
   * `until` has already passed. `cooling` is the active subset the router excludes;
   * this is the memory that lets a repeat failure escalate instead of restarting at
   * strike 1. See readLimits.
   */
  strikes: Map<string, Strike>
  activity: Map<string, number>
  /**
   * Sessions this process opened to PROBE a cooled model (see ./probe.ts).
   *
   * A probe is a health check, not work, and three things must be able to tell the
   * difference. Limit detection must not count its failure as new evidence about
   * the provider, or a model that is still limited would be re-cooled a little
   * further every cycle until it could never come back however long it waited. The
   * provider-wide cooldown must not fire from it either — a probe that 429s is
   * evidence about one request, and letting it bench a whole provider turns the
   * prober into a denial of service against its own pool. And the cartographer's
   * idle trigger must skip it, because a probe is a root session like any other and
   * would otherwise start a context run nobody asked for.
   *
   * Held here because this is the one state object every plugin in a process
   * already shares; the probes themselves live in ./probe.ts.
   */
  probes: Set<string>
  /** True while a probe run is in flight, so two runs cannot overlap. */
  probing: boolean
  /** When a probe run last did anything, so the status can say when it last checked. */
  lastProbe: number
  /**
   * Recently seen `session.created` children, newest last, per parent session.
   * `bindChild` only matches a claim that already exists, so a child that is
   * created before its claim is taken is never bound and the claim can never be
   * aborted. This ring lets the reaper recover that binding later without
   * guessing at unrelated sessions: only children of the claim's own parent,
   * created at or after the claim, are eligible.
   */
  children: Map<string, { id: string; t: number }[]>
  reaped: number
  reaping: boolean
  lastSweep: number
  /** When the shared state directory was last swept of stale files. */
  lastDirSweep: number
  /** provider ids opencode reported as connected */
  connected: Set<string>
  /** when the list was last fetched (0 = never) */
  connectedAt: number
  /** true after the first successful fetch, even if the set is empty */
  connectedReady: boolean
  /** providers with positive credential evidence from provider.list() (key, apiKey, env, local baseURL) */
  credentialed: Set<string>
  /** providers whose resolved opencode config has a non-empty apiKey (config hook resolves {env:...}) */
  configCreds: Set<string>
  id: string
  dir: string
  modelsFile?: string
  /** Inline `{ slots: [...] }` from plugin options, if the caller passed one. */
  inlineModels?: unknown
  origin: string
  slots: Slot[]
}

export function state(opts: { id?: string; dir?: string; modelsFile?: string; models?: unknown } = {}): State {
  const id = opts.id ?? String(process.pid)
  const dir = opts.dir ?? join(homedir(), ".local", "share", "opencode", "agent-pool")
  const modelsFile = opts.modelsFile
  const models = opts.models
  // Keyed by identity so every hook in one process shares one state (same id +
  // dir + models source), while separate ids stay independent. Inline plugin
  // options are keyed by presence, not by value: two calls with the same models
  // object still share, which is what lets the router and the cartographer agree
  // on which slot each other are holding.
  const key = Symbol.for(`agent-pool:state:${id}:${dir}:${modelsFile ?? ""}:${models === undefined ? "" : "inline"}`)
  const g = globalThis as Record<symbol, State | undefined>
  if (!g[key]) {
    g[key] = {
      own: new Map(),
      models: new Map(),
      known: new Set(),
      warned: new Set(),
      initialized: false,
      dirReady: false,
      catalog: new Map(),
      catalogAt: 0,
      cooling: new Map(),
      strikes: new Map(),
      activity: new Map(),
      probes: new Set(),
      probing: false,
      lastProbe: 0,
      children: new Map(),
      reaped: 0,
      reaping: false,
      lastSweep: 0,
      lastDirSweep: 0,
      connected: new Set(),
      connectedAt: 0,
      connectedReady: false,
      credentialed: new Set(),
      configCreds: new Set(),
      id,
      dir,
      modelsFile,
      inlineModels: models,
      origin: "unresolved",
      slots: [],
    }
  }
  return g[key]
}

// Read once per process, on first use. A pool-file watcher reaches a fresh table
// through reloadSlots() below rather than through this cache.
export function ensureSlots(s: State, onWarn: (m: string) => void) {
  if (s.slots.length > 0) return s.slots
  const { slots, problems, origin } = resolveModels({ models: s.inlineModels, modelsFile: s.modelsFile })
  s.slots = slots
  s.origin = origin
  for (const problem of problems) onWarn(problem)
  return slots
}

/**
 * Identity of a resolved slot table, by VALUE.
 *
 * resolveModels returns the shared FALLBACK_SLOTS array by reference on several
 * paths, so reference equality says nothing. The origin is part of the identity:
 * deleting pool.txt and falling through to pool.json with the same models still
 * changes where the table came from, and the status line must say so.
 */
const slotSignature = (origin: string, slots: Slot[]) =>
  `${origin}\u0000${slots.map((slot) => `${slot.index}:${slot.model}:${slot.weight}:${slot.bucket ?? ""}`).join("|")}`

export type SlotReload = { changed: boolean; slots: Slot[]; origin: string }

/**
 * Re-resolve the chain and install the result when the slot table changed.
 *
 * ensureSlots() is a read-once cache, so the watcher must come through here.
 * Assigning a new `s.slots` array is safe: every consumer reads it at call time,
 * `snapshot()` counts load by CLAIM.SLOT (claim.k), and `release()` deletes claims by key.
 * What the caller MUST do on a change is re-bind the variant agents -- their model
 * is written by the config hook, not read from `s.slots` at spawn time.
 *
 * A comment or whitespace edit resolves to the same table and reports
 * `changed: false`, so it neither re-binds an agent nor spends a probe.
 */
export function reloadSlots(s: State, onWarn: (m: string) => void): SlotReload {
  const { slots, problems, origin } = resolveModels({ models: s.inlineModels, modelsFile: s.modelsFile })
  const changed = slotSignature(origin, slots) !== slotSignature(s.origin, s.slots)
  if (!changed) return { changed, slots, origin }
  s.slots = slots
  s.origin = origin
  for (const problem of problems) onWarn(problem)
  return { changed, slots, origin }
}

/**
 * The files whose contents can change the resolved slot table, in chain order.
 *
 * An inline `models` option has no file to watch; an explicit `modelsFile`
 * replaces the whole chain. Absent files are included on purpose: watchFile fires
 * when the user creates `pool.txt` for the first time.
 */
export function slotSources(input: { models?: unknown; modelsFile?: string } = {}): string[] {
  if (input.models !== undefined) return []
  if (input.modelsFile) return [input.modelsFile]
  return [USER_MODELS_TXT, USER_MODELS_PATH, DEFAULT_PRESET]
}

export const claimKey = (sessionID: string, callID: string) => `${sessionID}:${callID}`
export const selfFile = (id: string) => `claims.${id}.json`
const limitFile = (model: string) => `limit.${model.replace(/[^a-zA-Z0-9._-]/g, "__")}.json`

export function init(s: State, onWarn: (m: string) => void) {
  ensureSlots(s, onWarn)
  if (s.initialized) return
  s.initialized = true
  try {
    mkdirSync(s.dir, { recursive: true })
    s.dirReady = true
    try { unlinkSync(join(s.dir, selfFile(s.id))) } catch {} // dead process with a recycled id
  } catch {
    onWarn(`claim dir ${s.dir} unusable; pool load tracked in memory only`)
  }
}

/** How long a stale-file sweep may be deferred.
 *
 * Hourly rather than daily because these files are not merely litter: a stale
 * claims file is re-read on EVERY routing decision, so the window in which one
 * lingers is a window in which the pool is reasoning about a process that no
 * longer exists. The cost is one `readdirSync` of a directory holding a handful
 * of small files, once an hour.
 *
 * Deliberately a TIME WINDOW, not its own timer: the plugin already runs a 30s
 * watchdog, and this rides it as a gate that compares a timestamp and returns.
 * That is one `Date.now()` per tick instead of a second interval to leak when a
 * plugin is torn down. Do not "optimise" this into its own setInterval.
 */
export const STATE_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Remove stale files from the shared state directory.
 *
 * `readSiblings` and `readLimits` already reclaim dead claims and lapsed
 * cooldowns -- but only as a SIDE EFFECT of being called, and they are called
 * from `snapshot()`, which only runs when something spawns. So the directory is
 * only ever cleaned by traffic: an idle machine, or one whose process was killed
 * before its next spawn, keeps a dead process's claims file and every lapsed
 * cooldown indefinitely, and those files are read on every routing decision.
 *
 * This is the same policy with no activity required, safe to call on a timer.
 * It deliberately does NOT touch:
 *   * this process's own claims file -- rewritten on every publish
 *   * a cooldown that is still running
 *   * a LAPSED cooldown still inside its strike-decay window, because deleting
 *     that throws the strike count away and restarts the backoff at 1 (the same
 *     reason `readLimits` keeps it).
 *
 * Returns the removed file names so a caller can log them and a test can assert.
 */
export function sweepStateDir(s: State): string[] {
  const removed: string[] = []
  if (!s.dirReady) return removed
  let entries: string[]
  try {
    entries = readdirSync(s.dir)
  } catch {
    return removed
  }
  const now = Date.now()
  const drop = (name: string) => {
    try {
      unlinkSync(join(s.dir, name))
      removed.push(name)
    } catch {
      /* another process won the race; nothing to do */
    }
  }
  for (const entry of entries) {
    let age: number
    try {
      age = now - statSync(join(s.dir, entry)).mtimeMs
    } catch {
      continue
    }
    // A partial write left by a process that died between write and rename.
    // Nothing ever reads it; it is litter.
    if (entry.endsWith(".tmp")) {
      if (age > ORPHAN_TMP_MS) drop(entry)
      continue
    }
    const claim = /^claims\.(.+)\.json$/.exec(entry)
    if (claim) {
      if (claim[1] === s.id) continue
      // A numeric owner is a pid: if it is gone the file holds no work, exactly
      // as readSiblings decides. Reclaim immediately rather than waiting out
      // DEAD_FILE_MS, which is what made a crashed process look busy.
      if (/^\d+$/.test(claim[1]) && !isPidAlive(Number(claim[1]))) {
        drop(entry)
        continue
      }
      if (age > DEAD_FILE_MS) drop(entry)
      continue
    }
    if (entry.startsWith("limit.") && entry.endsWith(".json")) {
      try {
        const strike = JSON.parse(readFileSync(join(s.dir, entry), "utf8")) as Strike
        if (typeof strike.until !== "number") {
          drop(entry)
          continue
        }
        if (strike.until > now) continue
        if (typeof strike.last === "number" && now - strike.last < STRIKE_DECAY_MS) continue
        drop(entry)
      } catch {
        drop(entry) // unreadable or corrupt: the same policy readLimits applies
      }
    }
  }
  return removed
}

const claimExpired = (claim: Claim, now: number) =>
  now - (claim.hb ?? claim.t) > CLAIM_TTL_MS || (!claim.g && now - claim.t > UNBOUND_CLAIM_MS)

export function pruneOwn(s: State) {
  const now = Date.now()
  let removed = false
  for (const [key, claim] of s.own)
    if (claimExpired(claim, now)) {
      s.own.delete(key)
      removed = true
    }
  if (removed) publish(s)
}

// Bound the two per-session maps that would otherwise grow for the life of the
// process. Nothing ever removed an entry from either one: `activity` was written
// on EVERY message event (whatever the session) and `children` on every
// `session.created`, so a long-running server accumulated one entry per session
// it had ever seen and held them forever.
//
// Both are only read inside narrow windows, so anything outside them is dead
// weight: `activity` is consulted only for a claim's bound target (idleFor), and
// `children` only for children inside CHILD_MEMORY_MS (backfillChild). An entry
// that is neither a live target nor recent cannot change a routing decision.
function pruneActivity(s: State, now: number) {
  if (s.activity.size === 0) return
  const live = new Set<string>()
  for (const claim of s.own.values()) if (claim.g) live.add(claim.g)
  for (const [id, seen] of s.activity) {
    if (live.has(id)) continue
    if (now - seen > CLAIM_TTL_MS) s.activity.delete(id)
  }
}

function pruneChildren(s: State, now: number) {
  if (s.children.size === 0) return
  for (const [parent, ring] of s.children) {
    const fresh = ring.filter((child) => now - child.t <= CHILD_MEMORY_MS)
    if (fresh.length === 0) s.children.delete(parent)
    else if (fresh.length !== ring.length) s.children.set(parent, fresh)
  }
}

/**
 * The periodic sweep of the two per-session maps, both bounded by AGE rather than
 * by an explicit release. snapshot() calls it on every spawn and the reaper calls
 * it on every sweep, so a process stays bounded whether it is busy or idle -- a
 * server can see thousands of sessions' message events with never a spawn in
 * between. Deliberately does NOT prune own claims: a TTL-expired claim must be
 * found and ABORTED by the reaper (its session would otherwise be orphaned), not
 * dropped here. That is pruneOwn's job, and snapshot() calls it separately.
 */
export function pruneSessions(s: State) {
  const now = Date.now()
  pruneActivity(s, now)
  pruneChildren(s, now)
}

export function publish(s: State) {
  if (!s.dirReady) return
  const now = Date.now()
  const payload: Record<string, Claim> = {}
  for (const [key, claim] of s.own) if (!claimExpired(claim, now)) payload[key] = claim
  try {
    writeFileSync(join(s.dir, `${selfFile(s.id)}.tmp`), JSON.stringify(payload))
    renameSync(join(s.dir, `${selfFile(s.id)}.tmp`), join(s.dir, selfFile(s.id)))
  } catch {
    s.dirReady = false
  }
}

/** Signal-0 liveness probe: true if `pid` is running. EPERM means alive but not ours. */
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function readSiblings(s: State): Sibling[] {
  const siblings: Sibling[] = []
  let entries: string[]
  try {
    entries = readdirSync(s.dir)
  } catch {
    return siblings
  }
  const now = Date.now()
  for (const entry of entries) {
    const path = join(s.dir, entry)
    let age: number
    try {
      age = now - statSync(path).mtimeMs
    } catch {
      continue
    }
    if (entry.endsWith(".tmp")) {
      if (age > ORPHAN_TMP_MS) try { unlinkSync(path) } catch {}
      continue
    }
    const match = /^claims\.(.+)\.json$/.exec(entry)
    if (!match || match[1] === s.id) continue
    if (age > DEAD_FILE_MS) {
      try { unlinkSync(path) } catch {}
      continue
    }
    // A claim file whose owning process is gone holds no work, so it must not
    // count as load. Reclaim it immediately rather than waiting out DEAD_FILE_MS:
    // that window left a crashed process's slots looking busy -- and therefore
    // unavailable -- for up to 20 minutes after it died.
    if (/^\d+$/.test(match[1]) && !isPidAlive(Number(match[1]))) {
      try { unlinkSync(path) } catch {}
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, Claim>
      const claims = Object.values(parsed).filter(
        (c) => c && typeof c.v === "string" && typeof c.m === "string" && typeof c.k === "number" && Number.isFinite(c.k) && !claimExpired(c as Claim, now),
      )
      siblings.push({ id: match[1], claims })
    } catch {
      // a sibling that vanished or is unreadable is skipped, never fatal
    }
  }
  return siblings
}

export function readLimits(s: State): Map<string, Strike> {
  const cooling = new Map<string, Strike>()
  const memory = new Map<string, Strike>()
  let entries: string[]
  try {
    entries = readdirSync(s.dir)
  } catch {
    s.cooling = cooling
    s.strikes = memory
    return cooling
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith("limit.") || !entry.endsWith(".json")) continue
    const path = join(s.dir, entry)
    try {
      const strike = JSON.parse(readFileSync(path, "utf8")) as Strike
      if (typeof strike.until !== "number" || typeof strike.model !== "string") continue
      // An outage is not a strike: it benches the model for one flat window and
      // must not count towards the streak, or the next real failure on this
      // model would start at strike 2 and get twice the first window.
      const countsAsStrike = strike.reason !== UNAVAILABLE_REASON
      if (strike.until > now) {
        cooling.set(strike.model, strike)
        if (countsAsStrike) memory.set(strike.model, strike)
      } else if (typeof strike.last === "number" && now - strike.last < STRIKE_DECAY_MS) {
        // Lapsed, but recent enough that a new failure is still the same streak.
        // Keep the record -- strikes intact -- so the NEXT failure escalates
        // instead of restarting at strike 1. Only its absence from `cooling`
        // re-admits the model; deleting the file here threw the strike count
        // away and reset the backoff on every lapse.
        if (countsAsStrike) memory.set(strike.model, strike)
      } else {
        unlinkSync(path)
      }
    } catch {
      try { unlinkSync(path) } catch {}
    }
  }
  s.cooling = cooling
  s.strikes = memory
  return cooling
}

/**
 * Record a strike on a model: cool it, count it, and write the record so every
 * process sees it.
 *
 * This is the ONE place where the "an outage is a cooling record, never a
 * strike" rule is enforced, because this is the one funnel every strike passes
 * through. The reason is the discriminator -- the same one readLimits() uses
 * when it rebuilds the memory from disk -- so an outage handed in here takes
 * coolUnavailable()'s flat window and never enters the strike memory.
 *
 * It is enforced HERE rather than in the callers so that no caller can get it
 * wrong: the provider path (coolProvider) cools every slot on a provider, and
 * an outage is cooled flat and never counted as a strike. Routing one through
 * this function like any other failure would file it as strike 1, so the next
 * REAL limit on that model would start at strike 2 and take twice the window --
 * a healthy provider benched for the quota window over a moment's outage.
 */
export function recordStrike(s: State, model: string, reason: string, stated?: number) {
  if (!s.dirReady) return
  // An outage is cooled flat and is never a strike, whatever window the caller
  // stated: one short window says "not right now", and the strike memory is
  // left alone so the next real failure on this model starts at strike 1.
  if (reason === UNAVAILABLE_REASON) return coolUnavailable(s, model)
  const now = Date.now()
  // A bucket is a shared quota: a limit on one line is evidence about every
  // line in it, so the whole group is benched with the same window. Without a
  // bucket the target list is just this model, which is the old behaviour.
  const slotsForModel = s.slots.filter((candidate) => candidate.model === model)
  const buckets = [...new Set(slotsForModel.map((slot) => slotBucket(slot)))]
  const targets = buckets.length === 0
    ? [model]
    : [...new Set(
        s.slots
          .filter((candidate) => buckets.includes(slotBucket(candidate)))
          .map((candidate) => candidate.model),
      )]
  if (targets.length === 0) targets.push(model)
  // The strike streak belongs to the quota group, so take the worst prior.
  const prior = targets
    .map((target) => s.strikes.get(target))
    .filter((candidate): candidate is Strike => Boolean(candidate))
    .reduce<Strike | undefined>((worst, candidate) => (!worst || candidate.strikes > worst.strikes ? candidate : worst), undefined)
  const strikes = prior && now - prior.last < STRIKE_DECAY_MS ? prior.strikes + 1 : 1
  const quota = isQuotaReason(reason)
  const base = quota ? QUOTA_COOLDOWN_BASE_MS : COOLDOWN_BASE_MS
  const cap = quota ? QUOTA_COOLDOWN_MAX_MS : COOLDOWN_MAX_MS
  const backoff = Math.min(cap, base * 2 ** (strikes - 1))
  const statedOk = typeof stated === "number" && Number.isFinite(stated) && stated > 0 && stated <= STATED_COOLDOWN_MAX_MS
  const until = now + (statedOk ? stated : backoff)
  let strike: Strike | undefined
  for (const target of targets) {
    const record: Strike = { model: target, until, strikes, reason, last: now }
    s.cooling.set(target, record)
    s.strikes.set(target, record)
    const path = join(s.dir, limitFile(target))
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(record))
      renameSync(`${path}.tmp`, path)
    } catch {
      /* cooldown stays local to this process */
    }
    if (target === model) strike = record
  }
  return strike
}

/**
 * A transient upstream outage ("Endpoint is unavailable") self-resolves, so it is
 * deliberately NOT recorded as a strike: accumulating strikes would escalate the
 * cooldown and leave a healthy model benched long after the endpoint is back. It
 * gets one short, flat window instead -- enough to route new work to a slot that
 * answers, short enough to re-probe soon. A longer cooldown already in force (a
 * real rate limit) still wins.
 */
export function coolUnavailable(s: State, model: string) {
  if (!s.dirReady) return
  const now = Date.now()
  const prior = s.cooling.get(model)
  const until = now + UNAVAILABLE_COOLDOWN_MS
  if (prior && prior.until > until) return prior
  const strike: Strike = { model, until, strikes: 1, reason: UNAVAILABLE_REASON, last: now }
  s.cooling.set(model, strike)
  // The record goes into the COOLING map -- the model is benched -- and into the
  // file, so every process sees the window. It never enters the STRIKE memory:
  // an outage lifts on its own, so the next real failure on this model must
  // start at strike 1 and get the first window, not an escalated one.
  const path = join(s.dir, limitFile(model))
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(strike))
    renameSync(`${path}.tmp`, path)
  } catch {
    /* cooldown stays local to this process */
  }
  return strike
}

/** What a re-admission reports back: the model, why it was benched, and how long it had left. */
export type ClearedCooldown = { model: string; reason: string; strikes: number; secondsLeft: number }

/**
 * Re-admit cooled models: delete their cooldown files and drop the in-memory record.
 *
 * This is the MECHANISM, not a policy. Nothing calls it to un-bench a model on a
 * schedule or on request — the only caller is a probe that has just watched the
 * model answer (see ./probe.ts), which is the whole difference between a fact and
 * the guess the cooldown file was in the first place.
 *
 * The whole FILE goes, not just its `until`. The strike count is the pool's memory
 * of how badly this model misbehaved, and a model that has demonstrably recovered is
 * not that model any more, so the next failure starts at strike 1 rather than
 * escalating straight back into a long window it has already been cleared of.
 *
 * Deleting the file is also the whole propagation mechanism: `readLimits` rebuilds
 * `cooling`/`strikes` from the directory on every `snapshot()`, so no running
 * opencode process needs a restart and none is asked for.
 *
 * `models` narrows the re-admission to named models. A file that names no readable
 * model cannot be matched against that filter, so it is left for `readLimits` to
 * discard; an unfiltered call takes it with everything else.
 */
export function clearCooldowns(s: State, models?: string[]): ClearedCooldown[] {
  const cleared: ClearedCooldown[] = []
  const now = Date.now()
  const wanted = models && models.length > 0 ? new Set(models) : undefined
  let entries: string[]
  try {
    entries = readdirSync(s.dir)
  } catch {
    return cleared // no state dir: every cooldown is already in memory only
  }
  for (const entry of entries) {
    if (!entry.startsWith("limit.") || !entry.endsWith(".json")) continue
    const path = join(s.dir, entry)
    let strike: Strike | undefined
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Strike
      if (parsed && typeof parsed.model === "string") strike = parsed
    } catch {
      strike = undefined
    }
    if (wanted && (strike === undefined || !wanted.has(strike.model))) continue
    try {
      unlinkSync(path)
    } catch {
      continue // another process re-read or removed it first; nothing left to do
    }
    if (strike === undefined) {
      cleared.push({ model: entry, reason: "unreadable cooldown file", strikes: 0, secondsLeft: 0 })
      continue
    }
    s.cooling.delete(strike.model)
    s.strikes.delete(strike.model)
    cleared.push({
      model: strike.model,
      reason: typeof strike.reason === "string" ? strike.reason : "unknown",
      strikes: typeof strike.strikes === "number" ? strike.strikes : 0,
      secondsLeft: typeof strike.until === "number" ? Math.max(0, Math.ceil((strike.until - now) / 1000)) : 0,
    })
  }
  return cleared
}

/** Mark a session as a pool health probe, so the hooks can tell it from real work. */
export const markProbe = (s: State, sessionID: string) => s.probes.add(sessionID)

export const unmarkProbe = (s: State, sessionID: string) => s.probes.delete(sessionID)

/** True for a session this process opened to probe a cooled model. */
export const isProbe = (s: State, sessionID: string) => s.probes.has(sessionID)

export function providerReady(s: State, model: string) {
  if (!s.connectedReady) return true
  const provider = providerOf(model)
  if (!s.connected.has(provider)) return false
  return s.credentialed.has(provider) || s.configCreds.has(provider) || provider === "opencode"
}

export function refreshCatalog(s: State, serverUrl?: URL) {
  if (!serverUrl || Date.now() - s.catalogAt < CATALOG_TTL_MS) return
  s.catalogAt = Date.now()
  void (async () => {
    try {
      const response = await fetch(new URL("/api/model", serverUrl).toString())
      if (!response.ok) return
      const payload = (await response.json()) as { data?: { id: string; providerID: string; status?: string }[] }
      const catalog = new Map<string, string>()
      for (const m of payload.data ?? []) catalog.set(`${m.providerID}/${m.id}`, m.status ?? "unknown")
      if (catalog.size > 0) s.catalog = catalog
    } catch {
      // advisory only
    }
  })()
}

/**
 * Whether a model may be routed to right now.
 *
 * Deliberately FAIL-OPEN in two places, and both are load-bearing:
 *
 * 1. ABSENT IS NOT UNAVAILABLE. A model the catalog has never seen reads as
 *    available. This is the gap a dead gateway falls through: when OmniRoute is
 *    down `GET /models` fails, `omniroute/<id>` is absent from the catalog
 *    entirely, and an absent entry would otherwise look exactly like a healthy
 *    one that simply has not been probed. Only an explicitly bad status
 *    disqualifies a model.
 * 2. THE POOL PREFERS A BAD MODEL TO NO MODEL. When every slot is cooling the
 *    caller re-admits them all (see pickSlot) rather than refusing the work,
 *    because a spawn that fails fast with a 429 is more useful than a spawn that
 *    never happens -- and the 429 is what produces the strike that cools it
 *    properly next time.
 *
 * The cost of both is that an unhealthy provider can take a turn it should not
 * have. That is the trade: prefer a wasted spawn over a stranded one.
 */
export function isAvailable(s: State, model: string, cooling: Map<string, Strike>) {
  if (!providerReady(s, model)) return false
  if (cooling.has(model)) return false
  const status = s.catalog.get(model)
  return status === undefined || status === "active" || status === "unknown"
}

export function snapshot(s: State): Snapshot {
  pruneOwn(s)
  pruneSessions(s)
  const siblings = readSiblings(s)
  const cooling = readLimits(s)
  const counts = new Map<number, number>()
  const bump = (k: number) => counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const claim of s.own.values()) bump(claim.k)
  for (const sibling of siblings) for (const claim of sibling.claims) bump(claim.k)
  return { counts, cooling, siblings, own: s.own, dirReady: s.dirReady }
}

const loadOf = (counts: Map<number, number>, slot: number) => counts.get(slot) ?? 0

// True while the slot still has room under its cap (slotCeiling, i.e. its weight).
// A cooling slot is never picked regardless of this.
export const underCeiling = (slot: Slot, counts: Map<number, number>) => loadOf(counts, slot.index) < slotCeiling(slot)

/**
 * The next slot the pool would hand a spawn.
 *
 * ONE ordered pass over the usable slots, in declaration order: the first slot
 * still below its weight (its active-session budget) wins. There is no second
 * pass and no 2x ceiling, so the pool's capacity is the sum of the slot weights.
 * To give a model more of it, list that model on another line with its own weight.
 *
 * When every usable slot is at its weight, the overflow goes to the least-loaded
 * usable slot; if every slot is cooling, the least-loaded slot of all. The pool
 * never refuses work.
 */
export type PoolPass = 1 | "overflow"

export function pickSlot(s: State, snap: Snapshot): Slot {
  const slots = s.slots.length > 0 ? s.slots : FALLBACK_SLOTS
  const configured = slots.filter((slot) => providerReady(s, slot.model))
  const usable = configured.filter((slot) => isAvailable(s, slot.model, snap.cooling))
  const pool = usable.length > 0 ? usable : configured.length > 0 ? configured : slots
  for (const slot of usable) {
    if (loadOf(snap.counts, slot.index) < slot.weight) return slot
  }
  // Every usable slot is at its weight, so the pool is at its summed capacity:
  // spread the burst over the least-loaded usable slot rather than refusing the
  // work. The condition is not "every slot is full" -- a cooling slot frees the
  // others.
  return pool.reduce((best, slot) => (loadOf(snap.counts, slot.index) < loadOf(snap.counts, best.index) ? slot : best), pool[0])
}

/** Which fill state routing is in: 1 while any usable slot is below its weight,
 * otherwise overflow (the pool is at its summed capacity). */
export function poolPass(s: State, snap: Snapshot): PoolPass {
  const slots = s.slots.length > 0 ? s.slots : FALLBACK_SLOTS
  const usable = slots.filter((slot) => isAvailable(s, slot.model, snap.cooling))
  if (usable.some((slot) => loadOf(snap.counts, slot.index) < slot.weight)) return 1
  return "overflow"
}

export function agentFor(base: string, slot: number) {
  return `${base}-${slot}`
}

// The base name if `name` is a hand-named pool slot variant -- `explore-2`,
// `implement-4`, and so on -- otherwise undefined.
//
// A variant is only ever the OUTPUT of routing: a caller spawns the bare base and
// the pool picks the slot. The task hook coerces a hand-named variant back to its
// base precisely so routing still owns slot choice and no provider can be pinned.
export function manualVariant(name: string): string | undefined {
  const direct = /^(.*)-([1-9][0-9]*)$/.exec(name)
  if (!direct) return undefined
  return BASES.includes(direct[1]) ? direct[1] : undefined
}

// Records an in-flight claim. `target` is the session that actually runs the
// work: for a task spawn it is the child session (bound later), for a
// plugin-spawned session it is the session itself.
export function acquire(s: State, base: string, slot: Slot, ownerSession: string, key: string, target?: string) {
  const now = Date.now()
  s.own.set(key, { v: base, k: slot.index, m: slot.model, t: now, hb: now, s: ownerSession, g: target })
  if (target) s.activity.set(target, now)
  publish(s)
}

export function release(s: State, key: string) {
  if (s.own.delete(key)) publish(s)
}

// How many recent children to remember per parent, and for how long.
const CHILD_RING = 8
const CHILD_MEMORY_MS = 30 * 60_000
// Tolerate a little clock skew when deciding whether a child predates its claim.
const CHILD_SLACK_MS = 1_000

// Every child we are told about is remembered, so a claim that missed its own
// session.created can still be bound later by backfillChild(). Bound to a ring so
// a long-lived parent cannot grow this without limit.
function noteChild(s: State, parentID: string, childID: string) {
  const ring = s.children.get(parentID) ?? []
  ring.push({ id: childID, t: Date.now() })
  while (ring.length > CHILD_RING) ring.shift()
  s.children.set(parentID, ring)
}

export function bindChild(s: State, parentID: string, childID: string) {
  noteChild(s, parentID, childID)
  const candidates = [...s.own.entries()]
    .filter(([, c]) => c.s === parentID && !c.g)
    .sort((a, b) => a[1].t - b[1].t)
  if (candidates.length === 0) return false
  candidates[0][1].g = childID
  s.activity.set(childID, Date.now())
  publish(s)
  return true
}

// Late recovery for a claim whose session.created arrived before the claim was
// taken, which bindChild cannot match because it only looks at claims that
// already exist. Deliberately conservative -- same parent, created at or after
// the claim, not already owned by another claim -- because the cost of a wrong
// guess is aborting a healthy session, while leaving a claim unbound only costs
// one reap cycle.
export function backfillChild(s: State, claim: Claim) {
  if (claim.g || !claim.s) return false
  const now = Date.now()
  const taken = new Set([...s.own.values()].map((c) => c.g).filter((g): g is string => typeof g === "string"))
  const ring = s.children.get(claim.s) ?? []
  for (let i = ring.length - 1; i >= 0; i--) {
    const child = ring[i]
    if (now - child.t > CHILD_MEMORY_MS) break
    if (child.t < claim.t - CHILD_SLACK_MS) continue
    if (taken.has(child.id)) continue
    claim.g = child.id
    s.activity.set(child.id, now)
    publish(s)
    return true
  }
  return false
}

export function noteActivity(s: State, sessionID: string) {
  const now = Date.now()
  s.activity.set(sessionID, now)
  // The message is proof the task is alive, so the claim that owns it must not be
  // aged out from under it. Without this a task that runs past the TTL stops being
  // counted while it keeps burning the provider, and the slot is handed out again.
  let touched = false
  for (const claim of s.own.values()) if (claim.g === sessionID) (claim.hb = now), (touched = true)
  if (touched) publish(s)
}

export function idleFor(s: State, claim: Claim, now: number) {
  const target = claim.g
  if (!target) return Infinity
  const seen = s.activity.get(target)
  return seen ? now - seen : Infinity
}

// The condemn rule, in exactly ONE place. The reaper (findStuck) and the status
// view (pool_status) both judge a claim with this, so a claim the status reports
// as healthy cannot be one the reaper is about to kill: two sources of truth for
// the same rule is the bug this function exists to prevent.
//
// A usage limit hangs instead of failing, so nothing releases the claim and the
// caller never regains control. An aged claim whose target has gone silent is
// presumed wedged -- but silence is only evidence when it PERSISTS, and any
// message event resets the clock, so a task that hangs while still trickling
// output would reset it forever. MAX_CLAIM_AGE_MS is the unconditional bound.
//
// The ceiling is checked FIRST, so a claim that is both past it and silent is
// reported for what actually stopped it rather than for the stale clue; "hung"
// still requires BOTH age and silence.
export function condemnReason(s: State, claim: Claim, now = Date.now()): "hung" | "overran" | undefined {
  const age = now - claim.t
  if (age > MAX_CLAIM_AGE_MS) return "overran"
  if (age > STUCK_MIN_AGE_MS && idleFor(s, claim, now) >= STUCK_IDLE_MS) return "hung"
  return undefined
}

export function findStuck(s: State, now = Date.now()) {
  const stuck: { key: string; claim: Claim; reason: "hung" | "overran" }[] = []
  for (const [key, claim] of s.own) {
    const reason = condemnReason(s, claim, now)
    if (reason) stuck.push({ key, claim, reason })
  }
  return stuck
}

export function releaseStuck(s: State, keys: string[]) {
  for (const key of keys) s.own.delete(key)
  if (keys.length > 0) publish(s)
}

export function slotFor(s: State, model: string) {
  return s.slots.find((slot) => slot.model === model)
}

// Split on the first slash only: some providers (openrouter) put a vendor
// segment in the model id itself, so a plain split("/") loses the id's tail.
export function splitModel(model: string): { provider: string; id: string } {
  const slash = model.indexOf("/")
  if (slash < 0) return { provider: model, id: "" }
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) }
}

export const providerOf = (model: string) => splitModel(model).provider

// opencode itself reports free-tier exhaustion per session as
// status.type "retry" with action.reason "free_tier_limit", the provider, and
// a `next` timestamp. That is a provider-wide signal, so every slot on that
// provider is cooled until the stated reset rather than one model at a time.
export function coolProvider(s: State, provider: string, until: number, reason: string) {
  const affected: Strike[] = []
  for (const slot of s.slots.length > 0 ? s.slots : FALLBACK_SLOTS) {
    if (providerOf(slot.model) !== provider) continue
    const existing = s.cooling.get(slot.model)
    const untilMs = Math.max(until, existing?.until ?? 0)
    const strike = recordStrike(s, slot.model, reason, untilMs - Date.now())
    if (strike) affected.push(strike)
  }
  return affected
}