import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Shared model pool for every free-model agent type.
//
// One set of slots is shared by ALL pooled agent types (explore-fast,
// implement-fast, context-manager). A slot is a model, not an agent: load is
// counted per MODEL across every agent type, so total pressure on each model is
// balanced no matter which kind of work is running. Slot N of any base is the
// same model, so `explore-fast-2` and `context-manager-2` are the same model and
// share one load counter.
//
// Every slot carries a `weight` (the preset), and that is the only knob. A
// slot's weight is a SOFT CEILING on how many claims it holds at once, and priority is
// simply that weight: the highest-weight slot that is still under its ceiling takes
// the next spawn, so the pool fills slot 1 to its number before slot 2 sees any work
// at all. Equal weights therefore give a plain round robin in declaration order, and
// 2 over 2 / 1 over 1 reproduces the old primary/overflow cycle exactly.
//
// Once EVERY slot is at or over its ceiling the weight can no longer gate anything,
// so the overflow goes to the least loaded slot -- the pool never blocks, and a burst
// past the summed ceilings degrades to even spreading rather than piling on slot 1.
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
export const HANG_COOLDOWN_MS = 10 * 60 * 1000
// A weight is a count of concurrent sessions, so this bounds both the ceiling and
// the total pool capacity (4 slots at MAX_WEIGHT each). Past it the number stops
// describing concurrency and becomes a way to silence load balancing entirely, which
// is a config error rather than a value to honour.
export const MAX_WEIGHT = 100
// opencode.jsonc -- and, for an installed package, the agent set injected by
// src/index.ts -- declares exactly one hidden variant per base per slot, and a
// pool larger than that would route to agents that do not exist, so the slot
// count is capped rather than trusted: slot 5 and beyond are dropped with a
// warning. Four is also all the pool needs -- with two providers at two slots
// each, a provider-wide limit already takes out half of it.
export const MAX_SLOTS = 4
const COOLDOWN_BASE_MS = 60 * 1000
const COOLDOWN_MAX_MS = 15 * 60 * 1000
const STRIKE_DECAY_MS = 30 * 60 * 1000

export type Slot = { index: number; model: string; weight: number }
export type Claim = { v: string; k: number; m: string; t: number; s?: string; g?: string }
export type Strike = { model: string; until: number; strikes: number; reason: string; last: number }
export type Sibling = { id: string; claims: Claim[] }
export type Snapshot = {
  counts: Map<string, number>
  cooling: Map<string, Strike>
  siblings: Sibling[]
  own: Map<string, Claim>
  dirReady: boolean
}

export const BASES = ["explore-fast", "implement-fast", "context-manager"]

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

/** Package root: two levels up from src/lib/, i.e. the repo or the installed package. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const PRESETS_DIR = join(PACKAGE_ROOT, "presets")
export const DEFAULT_PRESET = join(PRESETS_DIR, "free-tier.json")
/** The user's own pool file. Absent is normal and never an error. */
export const USER_CONFIG_DIR = join(homedir(), ".config", "lacode")
export const USER_MODELS_PATH = join(USER_CONFIG_DIR, "pool.json")

export const FALLBACK_SLOTS: Slot[] = [
  { index: 1, model: "opencode/space-bunny-free", weight: 3 },
  { index: 2, model: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", weight: 2 },
  { index: 3, model: "opencode/big-pickle", weight: 1 },
  { index: 4, model: "openrouter/thinkingmachines/inkling:free", weight: 1 },
]

export type SlotFile = { slots: Slot[]; problems: string[] }

/** Human-readable origin of a slot list, used in log lines and warnings. */
export type ModelsSource = { slots: Slot[]; problems: string[]; origin: string }

// Slot indices are the array position, so the source is the only place a slot
// number exists; nothing downstream can disagree with it. Every entry is
// validated on its own: one bad slot is dropped with a warning, the rest still
// route, unless nothing survives and the built-in defaults take over.
//
// Weight is the slot's concurrency ceiling, so a bad one warns and falls back to 1
// rather than dropping the slot -- losing a model because of a typo in a count would
// cost real capacity. A slot with no weight at all is weight 1, i.e. one session at
// a time before the next slot is considered.
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
    const result = readJSON(input.modelsFile)
    if (!result.ok) return { slots: FALLBACK_SLOTS, problems: [`${input.modelsFile} unreadable (${result.error}); using built-in defaults`], origin: input.modelsFile }
    const parsed = parseSlots(result.value, input.modelsFile)
    return { slots: parsed.slots, problems: parsed.problems, origin: input.modelsFile }
  }

  // 2. the user's own file, then 3. the bundled preset.
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

  return { slots: FALLBACK_SLOTS, problems: [...problems, `no pool source found (${USER_MODELS_PATH}, ${DEFAULT_PRESET}); using built-in defaults`], origin: "built-in defaults" }
}

export function readSlotFile(path: string): SlotFile {
  const result = readJSON(path)
  if (!result.ok) return { slots: FALLBACK_SLOTS, problems: [`${path} unreadable (${result.error}); using built-in defaults`] }
  return parseSlots(result.value, path)
}

/**
 * Make `~/.config/lacode/` exist so a user can drop a `pool.json` into it without
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

// `weight` is the soft ceiling on a slot's concurrent claims, and its priority;
// absent means 1. `tier` is the pre-weight spelling, accepted as a deprecated alias
// (primary -> 2, overflow -> 1) so a host that has not been re-deployed keeps two
// slots' worth of headroom instead of silently collapsing to one claim each.
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

const LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /usage limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /freelimiterror/i,
  /overloaded/i,
]

export const isLimitText = (text: string) => LIMIT_PATTERNS.some((re) => re.test(text))

// Providers sometimes state exactly when the window reopens; prefer that over a
// guessed backoff. Handles "Resets in 35min", "Resets in 2hr 17min", "retry in 90s".
export const statedCooldown = (text: string): number | undefined => {
  const hm = /resets?\s+in\s+(\d+)\s*(?:h|hr|hour)s?\s*(\d+)?\s*(?:m|min|minute)?s?/i.exec(text)
  if (hm) return (Number(hm[1]) * 60 + (hm[2] ? Number(hm[2]) : 0)) * 60 * 1000
  const m = /resets?\s+in\s+(\d+)\s*(?:m|min|minute)s?/i.exec(text)
  if (m) return Number(m[1]) * 60 * 1000
  const s = /retry[\s-]?in\s+(\d+)\s*(?:s|sec|second)s?/i.exec(text)
  if (s) return Number(s[1]) * 1000
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
  activity: Map<string, number>
  reaped: number
  reaping: boolean
  lastSweep: number
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
      activity: new Map(),
      reaped: 0,
      reaping: false,
      lastSweep: 0,
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

export function pruneOwn(s: State) {
  const now = Date.now()
  for (const [key, claim] of s.own) if (now - claim.t > CLAIM_TTL_MS) s.own.delete(key)
}

export function publish(s: State) {
  if (!s.dirReady) return
  const now = Date.now()
  const payload: Record<string, Claim> = {}
  for (const [key, claim] of s.own) if (now - claim.t <= CLAIM_TTL_MS) payload[key] = claim
  try {
    writeFileSync(join(s.dir, `${selfFile(s.id)}.tmp`), JSON.stringify(payload))
    renameSync(join(s.dir, `${selfFile(s.id)}.tmp`), join(s.dir, selfFile(s.id)))
  } catch {
    s.dirReady = false
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
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, Claim>
      const claims = Object.values(parsed).filter(
        (c) => c && typeof c.v === "string" && typeof c.m === "string" && now - c.t <= CLAIM_TTL_MS,
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
  let entries: string[]
  try {
    entries = readdirSync(s.dir)
  } catch {
    return cooling
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith("limit.") || !entry.endsWith(".json")) continue
    const path = join(s.dir, entry)
    try {
      const strike = JSON.parse(readFileSync(path, "utf8")) as Strike
      if (typeof strike.until !== "number" || typeof strike.model !== "string") continue
      if (strike.until > now) cooling.set(strike.model, strike)
      else unlinkSync(path)
    } catch {
      try { unlinkSync(path) } catch {}
    }
  }
  s.cooling = cooling
  return cooling
}

export function recordStrike(s: State, model: string, reason: string, stated?: number) {
  if (!s.dirReady) return
  const now = Date.now()
  const prior = s.cooling.get(model)
  const strikes = prior && now - prior.last < STRIKE_DECAY_MS ? prior.strikes + 1 : 1
  const backoff = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (strikes - 1))
  const strike: Strike = { model, until: now + (stated ?? backoff), strikes, reason, last: now }
  s.cooling.set(model, strike)
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

export function isAvailable(s: State, model: string, cooling: Map<string, Strike>) {
  if (cooling.has(model)) return false
  const status = s.catalog.get(model)
  return status === undefined || status === "active" || status === "unknown"
}

export function snapshot(s: State): Snapshot {
  pruneOwn(s)
  const siblings = readSiblings(s)
  const cooling = readLimits(s)
  const counts = new Map<string, number>()
  const bump = (m: string) => counts.set(m, (counts.get(m) ?? 0) + 1)
  for (const claim of s.own.values()) bump(claim.m)
  for (const sibling of siblings) for (const claim of sibling.claims) bump(claim.m)
  return { counts, cooling, siblings, own: s.own, dirReady: s.dirReady }
}

const loadOf = (counts: Map<string, number>, model: string) => counts.get(model) ?? 0

// True while the slot still has room under its own ceiling, i.e. while its weight
// can still gate anything. A cooling slot is never picked regardless of this.
export const underCeiling = (slot: Slot, counts: Map<string, number>) => loadOf(counts, slot.model) < slot.weight

// Priority is the weight itself, NOT load divided by weight. That is the whole point
// of a weight here: the top slot fills to its ceiling before the next one starts, so
// a main model gets its 3 concurrent sessions to itself. Weights are dynamic and
// deliberately unequal, so this never degenerates into a share calculation -- a slot
// either has room or it does not. Ties (equal weights) keep declaration order, which
// is what makes equal weights a round robin.
export function pickSlot(s: State, snap: Snapshot): Slot {
  const slots = s.slots.length > 0 ? s.slots : FALLBACK_SLOTS
  const usable = slots.filter((slot) => isAvailable(s, slot.model, snap.cooling))
  const pool = usable.length > 0 ? usable : slots
  const open = pool.filter((slot) => underCeiling(slot, snap.counts))
  if (open.length > 0) return open.reduce((best, slot) => (slot.weight > best.weight ? slot : best), open[0])
  // Every slot is at or over its ceiling, so no weight can gate the pick: spread the
  // overflow over the least loaded slot rather than refusing the work.
  return pool.reduce((best, slot) => (loadOf(snap.counts, slot.model) < loadOf(snap.counts, best.model) ? slot : best), pool[0])
}

export function agentFor(base: string, slot: number) {
  return `${base}-${slot}`
}

// Records an in-flight claim. `target` is the session that actually runs the
// work: for a task spawn it is the child session (bound later), for a
// plugin-spawned session it is the session itself.
export function acquire(s: State, base: string, slot: Slot, ownerSession: string, key: string, target?: string) {
  s.own.set(key, { v: base, k: slot.index, m: slot.model, t: Date.now(), s: ownerSession, g: target })
  if (target) s.activity.set(target, Date.now())
  publish(s)
}

export function release(s: State, key: string) {
  if (s.own.delete(key)) publish(s)
}

export function bindChild(s: State, parentID: string, childID: string) {
  const candidates = [...s.own.entries()]
    .filter(([, c]) => c.s === parentID && !c.g)
    .sort((a, b) => a[1].t - b[1].t)
  if (candidates.length === 0) return false
  candidates[0][1].g = childID
  s.activity.set(childID, Date.now())
  publish(s)
  return true
}

export function noteActivity(s: State, sessionID: string) {
  s.activity.set(sessionID, Date.now())
}

export function idleFor(s: State, claim: Claim, now: number) {
  const target = claim.g
  if (!target) return Infinity
  const seen = s.activity.get(target)
  return seen ? now - seen : Infinity
}

// A usage limit hangs instead of failing, so nothing releases the claim and the
// caller never regains control. An aged claim whose target has gone silent is
// presumed wedged.
export function findStuck(s: State, now = Date.now()) {
  const stuck: { key: string; claim: Claim }[] = []
  for (const [key, claim] of s.own) {
    if (now - claim.t <= STUCK_MIN_AGE_MS) continue
    if (idleFor(s, claim, now) < STUCK_IDLE_MS) continue
    stuck.push({ key, claim })
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