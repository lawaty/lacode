import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PACKAGE_ROOT } from "./package-root.ts"

// Shared model pool for every free-model agent type.
//
// One set of slots is shared by ALL pooled agent types (explore,
// implement, context). A slot is a model, not an agent: load is
// counted per MODEL across every agent type, so total pressure on each model is
// balanced no matter which kind of work is running. Slot N of any base is the
// same model, so `explore-2` and `context-2` are the same model and
// share one load counter.
//
// Every slot carries a `weight` (the preset), and that is the only knob. A slot's
// weight is its SHARE OF THE ROTATION, and how many claims it may hold at once is a
// deliberate multiple of that share (slotCeiling: twice the weight), so the ceiling is
// never what makes a slot busy. WHICH slot comes next is an ORDER-FIRST weighted round
// robin: the slots are expanded into a run in which each one
// appears once per unit of its weight ([3,2,1,1] -> [1,1,1,2,2,3,4]), the next spawn
// takes the first slot in that run which is available and still under its ceiling, and
// a cursor shared by every opencode process remembers where it got to. So weight says
// how OFTEN a slot is preferred and the cursor says WHICH turn comes next: a heavy
// slot is not drained before the others see any work, and two processes sharing the
// pool keep rotating instead of each restarting the run. Equal weights therefore give a
// plain round robin in declaration order, and 2 over 2 / 1 over 1 reproduces the old
// primary/overflow cycle exactly.
//
// Once EVERY slot is at or over its ceiling nothing can gate anything, so the overflow
// goes to the least loaded slot -- the pool never blocks, and a burst past the summed
// ceilings degrades to even spreading rather than piling on slot 1.
//
// This module holds the state and the decision; src/plugins/agent-pool.ts owns
// the hooks (task routing, limit detection, hang reaping) and
// src/plugins/context-autoupdate.ts borrows a slot directly, because it spawns
// its agent through the session API rather than the task tool and so never
// passes through the task hook.
//
// Which models fill the slots comes from the preset resolution chain (see
// resolveModels), resolved once per process into State.slots and shared by every
// hook in the process.
//
// COST IS THE USER'S CHOICE (US-7). Nothing here, and nothing in the preset
// loader, asks what a model costs or whether it is free: any provider/model-id
// string is accepted, paid or not. The bundled preset happens to be built from
// free models because that is a good default, not because the pool requires it.
// Validation below is STRUCTURAL ONLY -- shape of the models object, weights in
// range, slots distinct and under the cap.

export const CLAIM_TTL_MS = 10 * 60 * 1000
export const DEAD_FILE_MS = 2 * CLAIM_TTL_MS
export const ORPHAN_TMP_MS = 60 * 1000
export const CATALOG_TTL_MS = 10 * 60 * 1000
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
// A weight counts the turns a slot takes per rotation, and its ceiling is a small
// multiple of that (SLOT_CEILING_FACTOR), so this bounds both the ceiling and the
// total pool capacity (4 slots at MAX_WEIGHT, each ceilinged at SLOT_CEILING_FACTOR
// times that). Past it the number stops describing concurrency and becomes a way to
// silence load balancing entirely, which is a config error rather than a value to
// honour.
export const MAX_WEIGHT = 100
// Weight is the slot's share of the rotation -- roundRobinSequence gives it one
// position per unit, so it decides how OFTEN the slot is preferred. The ceiling is
// deliberately larger than that share (twice it), so a full weighted rotation can be
// traversed twice before the pool is full: a heavy slot keeps its proportional share
// while a burst that outruns one rotation still lands on it instead of falling
// straight through to the overflow path.
export const SLOT_CEILING_FACTOR = 2
/** How many claims a slot may hold at once: twice its share of the rotation. */
export const slotCeiling = (slot: Slot) => slot.weight * SLOT_CEILING_FACTOR
// opencode.jsonc -- and, for an installed package, the agent set injected by
// src/index.ts -- declares exactly one hidden variant per base per slot, and a
// pool larger than that would route to agents that do not exist, so the slot
// count is capped rather than trusted: slot 5 and beyond are dropped with a
// warning. Four is also all the pool needs -- with two providers at two slots
// each, a provider-wide limit already takes out half of it.
export const MAX_SLOTS = 4
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

export type Slot = { index: number; model: string; weight: number }

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
  counts: Map<string, number>
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
//   2. user config      ~/.config/lacode/pool.json
//   3. bundled preset   <package root>/presets/free-tier.json
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
  { index: 1, model: "opencode/space-bunny-free", weight: 3 },
  { index: 2, model: "opencode-go/longcat-2.5-preview-free", weight: 2 },
  { index: 3, model: "opencode/big-pickle", weight: 1 },
  { index: 4, model: "opencode/longcat-2.5-preview-free", weight: 1 },
]

export type SlotFile = { slots: Slot[]; problems: string[] }

/** Human-readable origin of a slot list, used in log lines and warnings. */
export type ModelsSource = { slots: Slot[]; problems: string[]; origin: string }

// Slot indices are the array position, so the source is the only place a slot
// number exists; nothing downstream can disagree with it. Every entry is
// validated on its own: one bad slot is dropped with a warning, the rest still
// route, unless nothing survives and the built-in defaults take over.
//
// Weight is the slot's share of the rotation, and its ceiling is twice that, so a bad
// one warns and falls back to 1 rather than dropping the slot -- losing a model because
// of a typo in a count would cost real capacity. A slot with no weight at all is weight
// 1, i.e. one turn per rotation and a ceiling of two claims.
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
    if (slots.length >= MAX_SLOTS) {
      problems.push(`${at} (${model || "?"}): the pool is capped at ${MAX_SLOTS} slots (one variant agent per base per slot is declared); entry ignored`)
      return
    }
    // The only per-model rule there is: a slot must be addressable. Whether it
    // costs money is never inspected (US-7).
    if (!model.includes("/")) return problems.push(`${at}: model must be written provider/model-id, got "${model}"`)
    const weight = readWeight(entry, at, model, problems)
    if (slots.some((s) => s.model === model)) return problems.push(`${at}: ${model} is already used by another slot; slots must be distinct models`)
    slots.push({ index: slots.length + 1, model, weight })
  })
  if (slots.length === 0) {
    problems.push(`${origin} yielded no usable slot; using built-in defaults`)
    return { slots: FALLBACK_SLOTS, problems }
  }
  return { slots, problems }
}

/**
 * Parse the flat, hand-edited pool file: one `<provider>/<model-id> [weight]` per
 * line. `#` starts a comment (whole-line or trailing); blank lines are ignored; a
 * missing weight is 1. Entries go through the SAME `parseSlots` validation as every
 * other source, so the rules (<= MAX_SLOTS, distinct, first-slash split, weight in
 * range) are identical everywhere.
 */
export function parseTextSlots(text: string, origin: string): SlotFile {
  const entries: Array<{ model: string; weight?: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim()
    if (!line) continue
    const [model, weight] = line.split(/\s+/)
    entries.push(weight === undefined ? { model } : { model, weight })
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

// `weight` is the slot's share of the rotation, one turn per unit and a ceiling of
// twice that; absent means 1. `tier` is the pre-weight spelling, accepted as a
// deprecated alias
// (primary -> 2, overflow -> 1) so a host that has not been re-deployed keeps two
// slots' worth of headroom instead of silently collapsing to one turn each.
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

export const isLimitText = (text: string) => LIMIT_PATTERNS.some((re) => re.test(text))

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
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, COOLDOWN_MAX_MS)
    const when = Date.parse(value)
    if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 1000), COOLDOWN_MAX_MS)
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
      children: new Map(),
      reaped: 0,
      reaping: false,
      lastSweep: 0,
      lastDirSweep: 0,
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

// Read once per process, on first use: plugins are not hot-reloaded, so editing
// the preset means restarting opencode anyway.
export function ensureSlots(s: State, onWarn: (m: string) => void) {
  if (s.slots.length > 0) return s.slots
  const { slots, problems, origin } = resolveModels({ models: s.inlineModels, modelsFile: s.modelsFile })
  s.slots = slots
  s.origin = origin
  for (const problem of problems) onWarn(problem)
  return slots
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
 *   * `cursor.json` -- live rotation state, never stale by age
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

export function pruneOwn(s: State) {
  const now = Date.now()
  for (const [key, claim] of s.own) if (now - (claim.hb ?? claim.t) > CLAIM_TTL_MS) s.own.delete(key)
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
  for (const [key, claim] of s.own) if (now - (claim.hb ?? claim.t) <= CLAIM_TTL_MS) payload[key] = claim
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
        (c) => c && typeof c.v === "string" && typeof c.m === "string" && now - (c.hb ?? c.t) <= CLAIM_TTL_MS,
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
      if (strike.until > now) {
        cooling.set(strike.model, strike)
        memory.set(strike.model, strike)
      } else if (typeof strike.last === "number" && now - strike.last < STRIKE_DECAY_MS) {
        // Lapsed, but recent enough that a new failure is still the same streak.
        // Keep the record -- strikes intact -- so the NEXT failure escalates
        // instead of restarting at strike 1. Only its absence from `cooling`
        // re-admits the model; deleting the file here (the old behaviour) threw
        // the strike count away and reset the backoff on every lapse.
        memory.set(strike.model, strike)
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

export function recordStrike(s: State, model: string, reason: string, stated?: number) {
  if (!s.dirReady) return
  const now = Date.now()
  // Read the prior count from the whole memory map, not from `cooling`: a lapsed
  // cooldown is no longer cooling but its strike streak still counts (readLimits).
  const prior = s.strikes.get(model)
  const strikes = prior && now - prior.last < STRIKE_DECAY_MS ? prior.strikes + 1 : 1
  const quota = isQuotaReason(reason)
  const base = quota ? QUOTA_COOLDOWN_BASE_MS : COOLDOWN_BASE_MS
  const cap = quota ? QUOTA_COOLDOWN_MAX_MS : COOLDOWN_MAX_MS
  const backoff = Math.min(cap, base * 2 ** (strikes - 1))
  const strike: Strike = { model, until: now + (stated ?? backoff), strikes, reason, last: now }
  s.cooling.set(model, strike)
  s.strikes.set(model, strike)
  const path = join(s.dir, limitFile(model))
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(strike))
    renameSync(`${path}.tmp`, path)
  } catch {
    /* cooldown stays local to this process */
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
  const strike: Strike = { model, until, strikes: 1, reason: "endpoint-unavailable", last: now }
  s.cooling.set(model, strike)
  s.strikes.set(model, strike)
  const path = join(s.dir, limitFile(model))
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(strike))
    renameSync(`${path}.tmp`, path)
  } catch {
    /* cooldown stays local to this process */
  }
  return strike
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
  if (cooling.has(model)) return false
  const status = s.catalog.get(model)
  return status === undefined || status === "active" || status === "unknown"
}

export function snapshot(s: State): Snapshot {
  pruneOwn(s)
  pruneSessions(s)
  const siblings = readSiblings(s)
  const cooling = readLimits(s)
  const counts = new Map<string, number>()
  const bump = (m: string) => counts.set(m, (counts.get(m) ?? 0) + 1)
  for (const claim of s.own.values()) bump(claim.m)
  for (const sibling of siblings) for (const claim of sibling.claims) bump(claim.m)
  return { counts, cooling, siblings, own: s.own, dirReady: s.dirReady }
}

const loadOf = (counts: Map<string, number>, model: string) => counts.get(model) ?? 0

// True while the slot still has room under its own ceiling (slotCeiling, i.e. twice
// its rotation share), i.e. while that ceiling can still gate anything. A cooling slot
// is never picked regardless of this.
export const underCeiling = (slot: Slot, counts: Map<string, number>) => loadOf(counts, slot.model) < slotCeiling(slot)

/**
 * The weighted round-robin run, expanded from the slot list: every slot occupies one
 * position per unit of its weight, in declaration order. Weights `[3,2,1,1]` become
 * `[1,1,1,2,2,3,4]`. A heavier slot therefore holds more positions in the run, which
 * is how it is preferred more often -- without having to be filled to its ceiling
 * first, which is what the old highest-weight-wins rule did.
 *
 * Pure and exported so the shape can be unit tested without touching the disk. A
 * fractional weight contributes its whole part: a position in the run is a whole turn,
 * and it is the ceiling, not this expansion, that bounds how much a slot may hold.
 */
export function roundRobinSequence(slots: Slot[]): number[] {
  const seq: number[] = []
  for (const slot of slots) for (let turn = 0; turn < slot.weight; turn++) seq.push(slot.index)
  return seq
}

// Where in the run the next spawn starts looking.
//
// It has to be SHARED by every opencode process, not kept per process: a private
// cursor would restart the rotation in each one, and a pool whose processes all start
// at the top is the starvation this run is here to remove. So the cursor lives in the
// claim dir next to the limit files, written atomically the same way.
//
// Read-modify-write races between processes are deliberately NOT locked: the worst a
// lost update can do is let two processes pick the same slot, which is exactly what
// happened before any cursor existed. The value is an optimisation of the rotation,
// never a correctness requirement, so an unwritable dir, a missing file, or corrupt
// JSON all degrade to "start at the top" and nothing is ever thrown at opencode.
const CURSOR_FILE = "cursor.json"

function readCursor(s: State): number {
  try {
    const parsed = JSON.parse(readFileSync(join(s.dir, CURSOR_FILE), "utf8")) as { seq?: unknown }
    if (typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq >= 0) return parsed.seq
  } catch {
    /* no cursor yet, or one this process cannot make sense of: start at the top */
  }
  return 0
}

function writeCursor(s: State, seq: number) {
  if (!s.dirReady) return
  const path = join(s.dir, CURSOR_FILE)
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify({ seq }))
    renameSync(`${path}.tmp`, path)
  } catch {
    /* the run simply restarts at the top on the next spawn */
  }
}

/**
 * Pick the slot for the next spawn.
 *
 * ORDER FIRST, THEN WEIGHT. The old rule took the heaviest slot that still had room
 * under its ceiling, which re-decided the same way on every spawn: slot 1 filled to its
 * number while slots 2 and 3 idled, and a burst past that ceiling fell straight through
 * to the overflow path. Here the slots are expanded into a weighted round-robin run
 * (roundRobinSequence) and the scan walks that run from the shared cursor, taking the
 * first slot which is available AND under its ceiling. A slot that is cooling or full
 * is skipped rather than ending the scan, so the rotation keeps turning past a busy or
 * benched slot instead of stalling on it.
 *
 * The ceiling is TWICE a slot's weight (slotCeiling), deliberately larger than its
 * share of the rotation, so a full weighted rotation can be traversed twice before the
 * pool is full. Round robin decides which slot is PREFERRED next; the ceiling, not
 * weight alone, decides how many a slot may hold.
 *
 * Falling off the end of the run is the old overflow path, kept as it was: the least
 * loaded usable slot, or the least loaded slot of all when every one of them is cooling.
 * The pool never refuses work.
 */
/**
 * The next slot the pool would hand a spawn.
 *
 * Selection walks a weighted round-robin run from a persisted cursor, so picking a
 * slot CONSUMES its turn. `advance: false` is a pure preview: pool_status calls it
 * to show where the next spawn would land, and observing the rotation must not be
 * what moves it, or merely looking at the pool would shift every spawn after it.
 */
export function pickSlot(s: State, snap: Snapshot, options?: { advance?: boolean }): Slot {
  const advance = options?.advance !== false
  const slots = s.slots.length > 0 ? s.slots : FALLBACK_SLOTS
  // Built over the FULL slot list, not the usable subset: the run must not change
  // length every time a model goes into cooldown, or a slot appearing and
  // disappearing would silently rewind the cursor's rotation.
  const seq = roundRobinSequence(slots)
  if (seq.length > 0) {
    const byIndex = new Map(slots.map((slot) => [slot.index, slot]))
    const start = readCursor(s) % seq.length
    for (let step = 0; step < seq.length; step++) {
      const at = (start + step) % seq.length
      const slot = byIndex.get(seq[at])
      if (slot && isAvailable(s, slot.model, snap.cooling) && underCeiling(slot, snap.counts)) {
        // Resume AFTER the turn just taken, so a slot that holds several positions in
        // the run is never handed two of them back to back.
        if (advance) writeCursor(s, at + 1)
        return slot
      }
    }
  }
  const usable = slots.filter((slot) => isAvailable(s, slot.model, snap.cooling))
  // If EVERY slot is cooling, fall back to all of them rather than to none. This
  // is fail-open on purpose -- see the note on isAvailable -- and the two cost the
  // same thing: a request goes to a provider already known to be unhealthy, and
  // gets a fast, self-cooling rejection instead of no request at all.
  const pool = usable.length > 0 ? usable : slots
  // Every slot is at or over its ceiling, so no weight can gate the pick: spread the
  // overflow over the least loaded slot rather than refusing the work.
  return pool.reduce((best, slot) => (loadOf(snap.counts, slot.model) < loadOf(snap.counts, best.model) ? slot : best), pool[0])
}

export function agentFor(base: string, slot: number) {
  return `${base}-${slot}`
}

// The base name if `name` is one of the pool's own slot variants -- `explore-2`,
// `implement-4`, and so on -- otherwise undefined.
//
// A variant is only ever the OUTPUT of routing: a caller spawns the bare base and
// the pool picks the slot. Naming a variant is the one way to reach a provider
// without asking the pool, and it is not a small one: it bypasses the round-robin
// rotation AND the slot's ceiling, so naming slot 1 eight times puts eight concurrent
// claims on a weight-3 slot whose ceiling is six. Counting such a spawn, as this once
// did, cannot help -- the ceiling is precisely what it evades.
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