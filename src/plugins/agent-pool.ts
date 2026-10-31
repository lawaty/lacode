import { unwatchFile, watchFile } from "node:fs"
import { tool, type Hooks, type PluginOptions } from "@opencode-ai/plugin"
import * as pool from "../lib/pool.ts"
import * as probe from "../lib/probe.ts"
import type { Claim } from "../lib/pool.ts"

// Task routing, limit detection and hang recovery for a shared set of models.
//
// This module is a HOOK FACTORY, not a plugin. opencode loads every export of
// every file under `plugins/` as a plugin and uses the return value as its hooks
// object, so exactly one plugin may exist for the published package: src/index.ts.
// The factories here (agentPoolHooks, contextAutoUpdateHooks, notifyHooks) are
// called BY it and their hook objects merged. plugins/agent-pool.ts is a
// one-line re-export so opencode's own auto-discovery still finds this code
// while developing against the working tree.
//
// The pool's models are not written here. They come from the preset resolution
// chain in ../lib/pool.ts (plugin options > ~/.config/lacode/pool.txt >
// pool.json > presets/free-tier.json), and the config hook rewrites the variant agents
// (explore-N, ...) plus the provider whitelists from that source, so
// changing the pool is a one-file edit instead of twelve agent definitions.
//
// No model in the pool is required to be free. A paid or proprietary model is
// just another slot: cost is the user's decision (see the note at the top of
// ../lib/pool.ts), and the bundled preset is free only because that is a
// sensible default.
//
// A spawn of a pooled base type is rewritten to <base>-<slot>, where the slot is
// chosen by live in-flight load counted per MODEL across every agent type. So
// explore and implement compete for the same capacity instead of each
// protecting its own, and total pressure per model stays balanced. Load is
// shared across processes too: each process publishes only its own claims to
// ~/.local/share/opencode/agent-pool/claims.<id>.json, so no locking is needed.
//
// Two agent types reach the pool differently. explore and implement
// arrive as task tool calls, so they are rewritten here. context is
// spawned by context-autoupdate through the session API and never passes through
// the task hook, so that factory borrows a slot from this module directly.
//
// Limits are handled in three layers, because a usage-limited request does not
// fail -- it hangs, so the caller never regains control and the claim is never
// released. There is no upstream quota API (the server exposes 162 endpoints,
// none for usage; api.opencode.ai answers "Not Found" on every usage path), so a
// limit cannot be predicted before the very first request. Instead:
//
//   1. catalog  -- GET /api/model exposes per-model status (active | deprecated),
//                  so a model opencode has retired is never chosen.
//   2. strikes  -- the event hook sees assistant messages carrying an APIError,
//                  which names providerID/modelID directly and carries
//                  responseHeaders (retry-after) plus responseBody. Each hit
//                  writes a cooldown file that every process reads before
//                  routing. Backoff is exponential; where the provider states
//                  "Resets in 35min" that duration is used instead of guessing.
//   3. watchdog -- a hang is silent: no error event, no log line, no message
//                  delta. So an in-flight claim older than STUCK_MIN_AGE_MS whose
//                  target session has been silent for STUCK_IDLE_MS is presumed
//                  wedged. Silence is only evidence while it PERSISTS, though, and
//                  any message delta resets the clock -- so a claim outliving
//                  MAX_CLAIM_AGE_MS is condemned too, however chatty it was. That
//                  session is aborted, returning control to the caller, freeing
//                  the slot, and cooling the model.

const SERVICE = "agent-pool"
const REAP_INTERVAL_MS = 30_000
const HANG_FALLBACK_MS = 10 * 60 * 1000
/**
 * How often the cooled models are checked by actually using them.
 *
 * Fifteen minutes is the cadence a probe can afford: each one is a real request on
 * a provider that has already refused work, so probing more often would spend the
 * very quota it is waiting on, and less often would leave a model that recovered
 * sitting out for the sake of a status line. It is a floor on the WAIT, not a
 * guarantee — a `pool_recheck` call probes immediately, and every probe is one
 * model at a time.
 */
const PROBE_INTERVAL_MS = 15 * 60 * 1000
/** How often the pool files are polled for a change; 1s is cheap and feels instant. 0 disables. */
const SLOT_WATCH_MS = 1000
/** Editors write a file in more than one step; collapse a burst into one reload. */
const SLOT_WATCH_DEBOUNCE_MS = 250
// The kill is one POST to our own local server. It gets a deadline because the
// reaper is the thing that must never wedge: an unbounded fetch would leave
// s.reaping true and silently disarm the watchdog for the rest of the process.
const ABORT_TIMEOUT_MS = 10_000

/**
 * A cooldown window as a person would say it out loud.
 *
 * A cooldown is reported to the user as the thing they are being asked to wait out,
 * and "21600s" is not that. Sub-minute windows keep seconds (the common case: the
 * 60s re-probe after a transient outage); anything longer rounds UP to the next
 * whole minute, so a window one second past four minutes is never shown as "4m".
 * An understated window is worse than no number at all — it is what makes a user
 * decide the pool is still broken and restart the whole thing by hand.
 */
const formatWindow = (seconds: number): string => (seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`)

/**
 * Brief by design: this lands in a toast and in a tool answer, not in a report.
 * Every line is derived from the outcome itself, so a success is never reported as
 * a shortage and a newly benched model says what it was benched for.
 */
export const reportText = (report: probe.ProbeReport): string => {
  if (report.outcomes.length === 0) return "no models are cooling down, so there was nothing to probe."
  const answered = report.outcomes.filter((outcome) => outcome.ok).length
  const benched = report.outcomes.filter((outcome) => outcome.kind === "benched").length
  const cooling = report.outcomes.length - answered - benched
  return [
    ...report.outcomes.map((outcome) => {
      if (outcome.ok) return `${outcome.model}: answered, cooldown cleared`
      if (outcome.kind === "benched") {
        const window = outcome.leftSeconds > 0 ? ` for ${Math.round(outcome.leftSeconds)}s` : ""
        const strike = outcome.strikes !== undefined ? ` (strike ${outcome.strikes})` : ""
        return `${outcome.model}: ${outcome.reason} — benched${window}${strike}`
      }
      return `${outcome.model}: still limited (${outcome.reason}) — cooldown kept${
        outcome.leftSeconds > 0 ? `, ${formatWindow(outcome.leftSeconds)} left` : ""
      }`
    }),
    `summary: ${answered} answered, ${benched} benched, ${cooling} still cooling`,
  ].join("\n")
}

type AbortReport = {
  slot: number
  model: string
  elapsedMs: number
  kind: "no-answer" | "rate-limit" | "empty response" | "permission" | "provider error"
  released: boolean
  message: string
}

type LogFn = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => Promise<void>

export type AgentPoolOptions = {
  /** Process identity for the claim files; defaults to the pid. Tests inject their own. */
  id?: string
  /** Claim directory. Defaults to ~/.local/share/opencode/agent-pool. */
  dir?: string
  /** Reaper interval; the 30s default is what production runs on. */
  reapMs?: number
  /** How often cooled models are probed by using them; the 15m default, 0 disables. */
  probeMs?: number
  /** Poll interval for the pool files; the 1s default, 0 disables the watcher. */
  watchMs?: number
  /** How long to wait after a pool-file change before reloading; the 250ms default. */
  watchDebounceMs?: number
  /** Explicit slot file. Short-circuits the preset resolution chain. */
  modelsFile?: string
  /** Inline `{ slots: [...] }`, highest priority in the resolution chain. */
  models?: unknown
}

// Typed as a factory returning hooks, NOT as a Plugin: only src/index.ts may
// carry the Plugin type, because only it may be loaded as one.
export const agentPoolHooks = (async ({ client, serverUrl, directory }, options?: PluginOptions): Promise<Hooks> => {
  const opts = (options ?? {}) as AgentPoolOptions
  const s = pool.state(opts)
  // Makes ~/.config/lacode/ exist so a user can drop a pool.json into it. Never
  // throws: an unwritable HOME just means the bundled preset is used.
  pool.ensureUserConfigDir()

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => {})

  const warnOnce = async (message: string) => {
    if (s.warned.has(message)) return
    s.warned.add(message)
    await log("warn", message)
  }

  const refreshProviders = async (force = false) => {
    if (!force && Date.now() - s.connectedAt < pool.PROVIDER_LIST_TTL_MS) return
    s.connectedAt = Date.now()
    try {
      const providerApi = (client as unknown as { provider?: { list?: (options?: { query?: { directory?: string } }) => Promise<{ data?: { connected?: unknown; all?: unknown } }> } }).provider
      if (!providerApi || typeof providerApi.list !== "function") return
      const result = await providerApi.list({ query: { directory } })
      const data = result?.data as { connected?: unknown; all?: unknown } | undefined
      const connected = data?.connected
      const all = data?.all
      if (Array.isArray(connected) && Array.isArray(all)) {
        s.connected = new Set(connected.filter((id): id is string => typeof id === "string"))
        const credentialed = new Set<string>()
        for (const entry of all) {
          if (!entry || typeof entry !== "object") continue
          const rec = entry as Record<string, unknown>
          const id = typeof rec.id === "string" ? rec.id : undefined
          if (!id) continue
          if (typeof rec.key === "string" && rec.key.trim() !== "") {
            credentialed.add(id)
            continue
          }
          const options = rec.options
          if (options && typeof options === "object") {
            const opts = options as Record<string, unknown>
            if (typeof opts.apiKey === "string" && opts.apiKey.trim() !== "") {
              credentialed.add(id)
              continue
            }
            const baseURL = typeof opts.baseURL === "string" ? opts.baseURL.trim() : ""
            if (baseURL !== "") {
              const envArr = Array.isArray(rec.env) ? rec.env : []
              const hasCredEnv = envArr.some((e) => typeof e === "string" && /key|token|secret|password|credential|auth/i.test(e))
              if (!hasCredEnv) {
                credentialed.add(id)
                continue
              }
            }
          }
          const envArr = Array.isArray(rec.env) ? rec.env : []
          for (const e of envArr) {
            if (typeof e === "string" && /key|token|secret|password|credential|auth/i.test(e)) {
              if (typeof (process.env as Record<string, string | undefined>)[e] === "string" && (process.env as Record<string, string | undefined>)[e]!.trim() !== "") {
                credentialed.add(id)
                break
              }
            }
          }
        }
        s.credentialed = credentialed
        s.connectedReady = true
      } else if (Array.isArray(connected)) {
        s.connected = new Set(connected.filter((id): id is string => typeof id === "string"))
        // Do not set connectedReady true if all missing; keep previous credentialed
      }
    } catch {
      // Keep the last successful set. Until the first success, providerReady fails open.
    }
  }

  pool.init(s, (m) => void warnOnce(m))

  // Sweep the shared state directory on its own clock, independent of traffic.
  //
  // The directory's other cleanup (dead claims, lapsed cooldowns) happens only as
  // a side effect of `snapshot()`, which runs when something spawns. So without
  // this, an idle machine -- or one whose process was killed before its next
  // spawn -- carries a dead process's claims file and every lapsed cooldown
  // indefinitely, and those files are read on every routing decision.
  //
  // Defined here, before the reaper below, and run once at startup so the debris
  // of the previous run goes immediately rather than after a day.
  const sweepDirIfDue = () => {
    if (Date.now() - s.lastDirSweep < pool.STATE_SWEEP_INTERVAL_MS) return
    s.lastDirSweep = Date.now()
    const removed = pool.sweepStateDir(s)
    if (removed.length > 0) void log("info", `swept ${removed.length} stale pool file(s): ${removed.join(", ")}`)
  }
  sweepDirIfDue()

  // A successful POST is NOT proof the session died: this endpoint answers 200 and
  // body "true" for a session id that does not exist, and it answers 200 for a
  // 404/500 upstream. So the response is checked via the already-authenticated
  // plugin client, and the reason a kill failed is carried back rather than
  // swallowed -- otherwise a failure is indistinguishable from a success and the
  // zombie outlives its claim. Failure when the response is not ok (return HTTP
  // status) or when result.data === false ("server reported the session was not
  // aborted").
  const abortSession = async (sessionID: string): Promise<{ ok: boolean; why: string }> => {
    try {
      const result = await client.session.abort({
        path: { id: sessionID },
        query: { directory },
        signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
      })
      if (!result.response?.ok) {
        return { ok: false, why: `server answered HTTP ${result.response?.status ?? "?"}` }
      }
      if (result.data === false) {
        return { ok: false, why: "server reported the session was not aborted" }
      }
      return { ok: true, why: "" }
    } catch (error) {
      return { ok: false, why: String(error) }
    }
  }

  // A task child this plugin aborts ends in opencode as a bare "Task cancelled".
  // The cause is recorded here under the claim key so the event hook can rewrite
  // the cancelled task part. Only aborts this plugin initiates are recorded,
  // so a stop the user pressed stays silent.
  const abortReports = new Map<string, AbortReport>()
  const spawns = new Map<string, { base: string; slot: number; model: string; t: number }>()
  const observedErrors = new Map<string, { reason: string; detail: string }>()
  const abortKind = (reason: string): AbortReport["kind"] =>
    pool.isQuotaReason(reason) || pool.isLimitText(reason) ? "rate-limit" : "provider error"
  const abortLabel = (kind: AbortReport["kind"], elapsedMs: number): string => {
    const seconds = Math.max(1, Math.round(elapsedMs / 1000))
    if (kind === "no-answer") return `no answer in ${seconds}s`
    if (kind === "rate-limit") return `rate limited after ${seconds}s`
    if (kind === "empty response") return `empty response after ${seconds}s`
    if (kind === "permission") return `permission denied after ${seconds}s`
    return `provider error after ${seconds}s`
  }
  type CancelledTaskPart = {
    id: string
    sessionID: string
    messageID: string
    callID: string
    type: "tool"
    tool: string
    state: {
      status: "error"
      error: string
      input: Record<string, unknown>
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }
    metadata?: Record<string, unknown>
  }

  // Cancelled spawns never reach tool.execute.after: opencode's task tool throws
  // before the hook runs, so the inline card keeps the bare thrown message. The
  // only lever is to rewrite the persisted tool part once opencode emits it.
  const pendingCancelledParts = new Map<string, CancelledTaskPart>()
  const patchedCancelledParts = new Set<string>()
  const cancelledPrefix = "Task Cancelled by LaCode:"

  const patchCancelledPart = async (part: CancelledTaskPart, key: string, report: AbortReport) => {
    if (patchedCancelledParts.has(key)) return
    patchedCancelledParts.add(key)
    if (patchedCancelledParts.size > 64) {
      const oldest = patchedCancelledParts.values().next().value
      if (oldest !== undefined) patchedCancelledParts.delete(oldest)
    }
    const error = `${cancelledPrefix} ${report.message}`
    const updated = { ...part, state: { ...part.state, error } }
    try {
      // Prefer SDK path: the env-var OPENCODE_SERVER_PASSWORD only exists in the
      // server process, not in the plugin's process, so raw fetch goes unauthenticated.
      const updater = (client as { part?: { update?: (args: Record<string, unknown>) => Promise<{ response?: { ok?: boolean; status?: number } } | undefined> } }).part?.update
      if (typeof updater === "function") {
        const result = await updater({
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          directory,
          part: updated,
          signal: AbortSignal.timeout(5000),
        })
        if (!result?.response?.ok) throw new Error(`server answered HTTP ${result?.response?.status ?? "?"}`)
        abortReports.delete(key)
        return
      }
      const url = new URL(
        `/session/${encodeURIComponent(part.sessionID)}/message/${encodeURIComponent(part.messageID)}/part/${encodeURIComponent(part.id)}`,
        serverUrl,
      )
      if (directory) url.searchParams.set("directory", directory)
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (directory) headers["x-opencode-directory"] = directory
      const password = process.env.OPENCODE_SERVER_PASSWORD
      if (password) {
        const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
      }
      const response = await fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ ...part, state: { ...part.state, error } }),
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim())
      abortReports.delete(key)
    } catch (cause) {
      await log("warn", `could not rewrite cancelled task ${part.callID}: ${cause instanceof Error ? cause.message : String(cause)}`, {
        session: part.sessionID,
        callID: part.callID,
      })
    }
  }

  const noteAbort = async (key: string, report: AbortReport) => {
    abortReports.set(key, report)
    if (abortReports.size > 32) {
      const oldest = abortReports.keys().next().value
      if (oldest !== undefined) abortReports.delete(oldest)
    }
    await log("warn", report.message, {
      slot: report.slot,
      model: report.model,
      elapsedMs: report.elapsedMs,
      failure: report.kind,
      released: report.released,
    })
    const pending = pendingCancelledParts.get(key)
    if (pending) {
      pendingCancelledParts.delete(key)
      await patchCancelledPart(pending, key, report)
    }
  }

  // How many consecutive failed kills to tolerate before giving the slot back.
  // Holding a claim whose session we cannot kill is right for a few sweeps (the
  // abort may just be racing the server), but not forever: the slot must not be
  // lost to a session we can never reach. The give-up is logged loudly.
  const MAX_ABORT_ATTEMPTS = 3

  // A usage limit HANGS rather than errors, so the model that wedged this task is
  // very often already cooling for that very limit. Re-striking it here only
  // relabelled a provider quota window as a "hang" and inflated its strike count.
  // Cooling is only for a model we have actually just seen wedge something.
  const coolForHang = async (claim: Claim, log: LogFn) => {
    const now = Date.now()
    const prior = s.cooling.get(claim.m)
    if (prior && prior.until > now) return
    const strike = pool.recordStrike(s, claim.m, "hang", HANG_FALLBACK_MS)
    if (strike) await log("warn", `cooling ${claim.m} for ${Math.round((strike.until - now) / 1000)}s (hang)`)
  }

  // The claim this process owns that is running on `sessionID`, if any. A claim
  // is bound to the child session opencode creates for it, so the session id is
  // what ties a limit signal back to the slot that took it.
  const claimFor = (sessionID: string | undefined) => {
    if (!sessionID) return undefined
    for (const [key, claim] of s.own) if (claim.g === sessionID) return { key, claim }
    return undefined
  }

  type PooledSession = { agent: string; slot: number; model: string }
  // Identify a pooled child session that has no local claim (e.g. created before
  // a plugin reload or whose session.created binding was missed). Uses the
  // opencode session API to inspect parentage and the user message's agent/model.
  const identifyPooledSession = async (sessionID: string): Promise<PooledSession | undefined> => {
    try {
      const info = await client.session
        .get({ path: { id: sessionID }, query: { directory } })
        .then((r) => r.data as { parentID?: string } | undefined)
        .catch(() => undefined)
      if (!info?.parentID) return undefined // root/user session: leave alone
      const msgs = await client.session
        .messages({ path: { id: sessionID }, query: { directory } })
        .then(
          (r) =>
            r.data as
              | Array<{ info?: { role?: string; agent?: string; model?: { providerID?: string; modelID?: string } } }>
              | undefined,
        )
        .catch(() => undefined)
      if (!Array.isArray(msgs)) return undefined
      const userMsg = msgs.find((m) => m?.info?.role === "user")
      if (!userMsg?.info) return undefined
      const agent = userMsg.info.agent
      if (typeof agent !== "string") return undefined
      const modelInfo = userMsg.info.model
      const userModel = modelInfo?.providerID && modelInfo?.modelID ? `${modelInfo.providerID}/${modelInfo.modelID}` : undefined

      // Determine if this is a pooled variant/base we care about. Once the slot
      // table is known, only a variant the pool actually offers is accepted; a
      // hand-named variant or base counts only while the table is still empty.
      if (s.known.size > 0 && !s.known.has(agent)) return undefined
      if (s.known.size === 0 && pool.manualVariant(agent) === undefined && !(pool.BASES.includes(agent) && userModel)) {
        return undefined
      }

      const slots = s.slots.length > 0 ? s.slots : pool.FALLBACK_SLOTS
      if (!slots || slots.length === 0) return undefined

      let slot: (typeof slots)[number] | undefined
      const variantBase = pool.manualVariant(agent)
      if (variantBase) {
        const idx = Number(agent.slice(agent.lastIndexOf("-") + 1))
        if (!Number.isFinite(idx)) return undefined
        slot = slots.find((sl) => sl.index === idx)
      } else if (pool.BASES.includes(agent) && userModel) {
        slot = slots.find((sl) => sl.model === userModel)
      }
      if (!slot) return undefined
      return { agent, slot: slot.index, model: slot.model }
    } catch {
      return undefined
    }
  }

  // A usage limit HANGS rather than failing: opencode keeps retrying the same
  // refused model, so the claim it is holding never comes back and the reaper
  // would only condemn it after STUCK_MIN_AGE_MS of age -- minutes the caller
  // spends waiting on a provider that has already said no. When the limit signal
  // names the session a claim is running on, abort that session at once: control
  // returns to the caller and the next spawn routes to a slot that answers, in
  // seconds instead of minutes. Scoped to the claim that owns the session so an
  // unrelated session's error never kills someone else's work.
  const failOver = async (
    sessionID: string | undefined,
    model: string,
    reason: string,
    opts?: { stated?: number; cool?: boolean },
  ) => {
    const entry = claimFor(sessionID)
    if (entry) {
      // Owned-claim path: abort the session the limit names and release the claim
      // so the caller can re-route now. A failed abort holds the claim for retry.
      const { key, claim } = entry
      const kill = await abortSession(sessionID)
      if (kill.ok) {
        pool.release(s, key)
        const elapsedMs = Date.now() - claim.t
        const kind = abortKind(reason)
        await noteAbort(key, {
          slot: claim.k,
          model: claim.m,
          elapsedMs,
          kind,
          released: true,
          message: `slot ${claim.k} ${claim.m} — ${abortLabel(kind, elapsedMs)}; claim released`,
        })
        await log(
          "warn",
          `limit (${reason}) on ${model}; aborted in-flight ${claim.v} session ${sessionID} to fail over now`,
          { base: claim.v, model: claim.m, slot: claim.k, session: sessionID, aborted: true, reason },
        )
        return
      }
      await log(
        "warn",
        `limit (${reason}) on ${model}; abort failed (${kill.why}); claim on slot ${claim.k} held for retry`,
        { base: claim.v, model: claim.m, slot: claim.k, session: sessionID, aborted: false, reason },
      )
      return
    }
    if (!entry) {
      // No-claim path
      if (opts?.cool !== false && sessionID) {
        const pooled = await identifyPooledSession(sessionID)
        if (pooled) {
          pool.recordStrike(s, pooled.model, reason, opts?.stated)
          const kill = await abortSession(sessionID)
          await log(
            "warn",
            `limit (${reason}) on ${pooled.model}; aborted pooled ${pooled.agent} session ${sessionID} (slot ${pooled.slot}) to fail over now`,
            { base: pooled.agent, model: pooled.model, slot: pooled.slot, session: sessionID, aborted: kill.ok, reason },
          )
          return
        }
      } else if (opts?.cool === false && sessionID) {
        // If opts?.cool === false (provider-wide cooling already happened), still identify and abort the pooled session, but do not call recordStrike again.
        const pooled = await identifyPooledSession(sessionID)
        if (pooled) {
          const kill = await abortSession(sessionID)
          await log(
            "warn",
            `limit (${reason}) on ${pooled.model}; aborted pooled ${pooled.agent} session ${sessionID} (slot ${pooled.slot}) to fail over now`,
            { base: pooled.agent, model: pooled.model, slot: pooled.slot, session: sessionID, aborted: kill.ok, reason },
          )
          return
        }
      }
      // A limit on a session the pool never bound is not ours to kill: the
      // plugin sees every session in the process, including the user's own and
      // other processes'. A child is bound at session.created, before any
      // request, so a pool-routed session always has a claim. Log the rest so a
      // stall stays visible instead of silent.
      await log("warn", `limit (${reason}) on ${model} for session ${sessionID ?? "?"}, which has no pool claim; nothing aborted`)
      return
    }
  }

  const reapStuck = async () => {
    if (s.reaping) return
    s.reaping = true
    s.lastSweep = Date.now()
    try {
      // Bound the per-session maps even when nothing is spawning: activity is
      // written on every message event and children on every session.created, so
      // an idle-looking server can still be accumulating both. See pool.pruneSessions.
      pool.pruneSessions(s)
      // Housekeeping for the SHARED directory, on its own much slower clock. This
      // is the only cleanup that happens without a spawn, so it is what keeps a
      // dead process's claims file and lapsed cooldowns from outliving an idle
      // night. Runs before the `stuck.length === 0` return below, or a machine
      // with nothing stuck would never sweep at all.
      sweepDirIfDue()
      const stuck = pool.findStuck(s)
      if (stuck.length === 0) return
      const released: string[] = []
      for (const { key, claim, reason } of stuck) {
        // A child that bound late (or whose session.created raced the claim) has no
        // target yet; bind it now so the abort has something to aim at.
        if (!claim.g) pool.backfillChild(s, claim)
        const idle = pool.idleFor(s, claim, Date.now())
        // Infinity means "never bound to a child session", which is not evidence of
        // a hang -- reporting it as silence is what produced "Infinitys of silence".
        const since = Number.isFinite(idle) ? `${Math.round(idle / 1000)}s of silence` : "no child session ever bound"
        const age = Math.round((Date.now() - claim.t) / 1000)

        if (claim.g) {
          const kill = await abortSession(claim.g)
          if (kill.ok) {
            released.push(key)
            s.reaped++
            // Two faults, two words. The ceiling fires on a task that was never
            // silent -- it kept trickling output for half an hour -- so reporting
            // "with 3s of silence" there would state the opposite of the truth, and
            // an operator greps these lines to find out why a task was killed.
            await log(
              "warn",
              reason === "overran"
                ? `overran ${claim.v} on ${claim.m} after ${age}s; aborted session ${claim.g}`
                : `hung ${claim.v} on ${claim.m} after ${age}s with ${since}; aborted session ${claim.g}`,
              { base: claim.v, model: claim.m, slot: claim.k, session: claim.g, aborted: true },
            )
            const elapsedMs = Date.now() - claim.t
            await noteAbort(key, {
              slot: claim.k,
              model: claim.m,
              elapsedMs,
              kind: "no-answer",
              released: true,
              message: `slot ${claim.k} ${claim.m} — ${
                reason === "overran" ? `overran after ${Math.max(1, Math.round(elapsedMs / 1000))}s` : abortLabel("no-answer", elapsedMs)
              }; claim released`,
            })
            await coolForHang(claim, log)
            continue
          }
          // The session is still running. Freeing the claim here is what orphans it:
          // the key is gone, so no later sweep can retry, and the pool hands the slot
          // out while the zombie keeps streaming. Hold the claim and try again.
          claim.n = (claim.n ?? 0) + 1
          if (claim.n < MAX_ABORT_ATTEMPTS) {
            await log(
              "warn",
              `could not abort hung ${claim.v} session ${claim.g} on ${claim.m} (${kill.why}); claim held, retry ${claim.n}/${MAX_ABORT_ATTEMPTS}`,
              { base: claim.v, model: claim.m, slot: claim.k, session: claim.g, aborted: false },
            )
            continue
          }
          released.push(key)
          s.reaped++
          await log(
            "error",
            `GIVING UP on hung ${claim.v} session ${claim.g} on ${claim.m}: ${kill.why} after ${claim.n} attempts. The claim is released but the session is still running and must be killed by hand.`,
            { base: claim.v, model: claim.m, slot: claim.k, session: claim.g, aborted: false },
          )
          continue
        }

        // Never bound: there is no session to abort and no evidence of a hang, so the
        // slot goes back but the model is NOT cooled -- an unbindable claim says
        // nothing about the provider being responsible.
        released.push(key)
        s.reaped++
        await log("warn", `released unbound ${claim.v} claim on ${claim.m} after ${age}s (${since}); model not cooled`, {
          base: claim.v,
          model: claim.m,
          slot: claim.k,
          aborted: false,
        })
      }
      if (released.length > 0) pool.releaseStuck(s, released)
    } catch (error) {
      await log("error", `reaper failed: ${String(error)}`)
    } finally {
      s.reaping = false
    }
  }

  // The reaper must not depend on new work arriving: a task that hangs while the
  // session is otherwise idle would otherwise hold its slot until the TTL. It
  // also runs once at startup so a task left hanging by a previous process is
  // cleaned up rather than waiting a full interval.
  pool.refreshCatalog(s, serverUrl)
  const reapMs = opts.reapMs ?? REAP_INTERVAL_MS
  void reapStuck()
  const timer = setInterval(() => void reapStuck(), reapMs)
  timer.unref?.()
  void log(
    "info",
    `reaper armed: every ${Math.round(reapMs / 1000)}s, aborts a claim older than ${Math.round(pool.STUCK_MIN_AGE_MS / 60000)}m whose target has been silent ${Math.round(pool.STUCK_IDLE_MS / 60000)}m, or any claim past the ${Math.round(pool.MAX_CLAIM_AGE_MS / 60000)}m ceiling however chatty`,
  )

  // ---------------------------------------------------------------------------
  // Cooldown probing (src/lib/probe.ts)
  // ---------------------------------------------------------------------------
  //
  // It lives here rather than in a fourth hook factory because a probe is not
  // self-contained: the event hook above must be able to recognise a probe's
  // failure and refuse to count it as new evidence, the cartographer's idle trigger
  // must be able to skip a probe session, and both read the same `s` this factory
  // already holds. A separate factory would have to publish its probe sessions into
  // that state to be heard at all, which is the same coupling with more indirection.
  //
  // The timer is armed only while something is actually cooling — probeCooling
  // returns immediately when it is not — so the common case costs one timestamp
  // comparison every fifteen minutes and no request at all.
  const EMPTY_REPORT: probe.ProbeReport = { outcomes: [], cleared: [], kept: [], missing: [], changed: false }

  // The `agent-pool: ` prefix belongs to whoever presents this — pool_status and this
  // tool share it — so it is added there and not baked into the summary.
  const reportTitle = (report: probe.ProbeReport) => {
    if (report.outcomes.length === 0) return "nothing cooling to probe"
    const parts = [`probed ${report.outcomes.length} model(s)`, `re-admitted ${report.cleared.length}`]
    if (report.missing.length > 0) parts.push(`benched ${report.missing.length} missing`)
    const authBenched = report.outcomes.filter((outcome) => outcome.reason === pool.AUTH_FAILURE_REASON).length
    if (authBenched > 0) parts.push(`benched ${authBenched} auth-failed`)
    return parts.join(", ")
  }



  /**
   * Surface a change the user would otherwise never learn about.
   *
   * A silent pass is the common case and stays silent — a toast every fifteen
   * minutes saying "nothing happened" is how a useful notification gets ignored. The
   * toast is best-effort: there is no TUI on a server-only run, and a prober that
   * cannot report is still a prober.
   */
  const announce = async (report: probe.ProbeReport) => {
    if (!report.changed) return
    const message =
      report.cleared.length > 0
        ? `Re-admitted ${report.cleared.join(", ")} — they answer again.`
        : report.missing.length > 0
          ? `Benched ${report.missing.join(", ")} — the provider does not serve them.`
          : `${report.kept.length} cooling model(s) re-checked, still limited.`
    await log("info", `pool probe: ${message}`, { cleared: report.cleared, kept: report.kept })
    try {
      await client.tui?.showToast?.({
        body: { title: "pool recheck", message, variant: report.cleared.length > 0 ? "success" : "info", duration: 8000 },
      })
    } catch {
      /* no TUI attached; the log line above is the record */
    }
  }

  const runProbe = async (models?: string[]): Promise<probe.ProbeReport> => {
    let report = EMPTY_REPORT
    try {
      report = await probe.probeCooling(client as probe.ProbeClient, { state: s, directory, models })
    } catch (error) {
      await log("error", `pool probe failed: ${String(error)}`)
      return EMPTY_REPORT
    }
    await announce(report)
    return report
  }

  const probeMs = opts.probeMs ?? PROBE_INTERVAL_MS
  const probeTimer = probeMs > 0 ? setInterval(() => void runProbe(), probeMs) : undefined
  probeTimer?.unref?.()
  void log(
    "info",
    probeMs > 0
      ? `cooldown probe armed: every ${Math.round(probeMs / 60000)}m, checks the models that are cooling by using them (one request each, one at a time); 0 to disable`
      : "cooldown probe disabled (probeMs: 0); use the pool_recheck tool to check on demand",
  )

  // The config object opencode handed us. It is retained because the variant
  // agents' models are written HERE, not read from `s.slots` at spawn time -- so
  // a slot-table reload must re-run this binding against the same object.
  let liveConfig: Parameters<NonNullable<Hooks["config"]>>[0] | undefined

  /**
   * Write the resolved slot table into the variant agents and provider
   * whitelists.
   *
   * Idempotent on purpose: `def.model` is overwritten, a whitelist append is
   * guarded, and `s.known` is replaced rather than merged. That is what makes it
   * safe to run again from the watcher when the pool changes.
   */
  const bind = async (cfg: Parameters<NonNullable<Hooks["config"]>>[0]) => {
    const slots = pool.ensureSlots(s, (m) => void warnOnce(m))
    const agents = cfg.agent as Record<string, { model?: string; [k: string]: unknown }> | undefined
    const providers = cfg.provider as Record<string, { whitelist?: string[]; options?: { apiKey?: unknown } }> | undefined
    const configCreds = new Set<string>()
    for (const [id, entry] of Object.entries(providers ?? {})) {
      const options = (entry as { options?: { apiKey?: unknown } }).options
      if (typeof options?.apiKey === "string" && options.apiKey.trim() !== "") configCreds.add(id)
    }
    s.configCreds = configCreds
    const known = new Set<string>()
    for (const [name, def] of Object.entries(cfg.agent ?? {})) if (def?.model) s.models.set(name, def.model)

    for (const slot of slots) {
      // The variant agents carry no model of their own -- neither in the
      // injected agent set nor in the author's opencode.jsonc. It is written
      // here from the resolved preset, so the preset is the only place a pool
      // model is ever written down. A model already present on a variant is a
      // stale leftover and is reported, not obeyed.
      for (const base of pool.BASES) {
        const name = pool.agentFor(base, slot.index)
        let def = agents?.[name]
        if (!def) {
          // A pool that grows at runtime has a slot with no injected variant yet.
          // Declare it here from the base definition rather than warning: the
          // slot count is open, so a reload may legitimately add slot N > the
          // count present when the plugin started.
          const baseDef = agents?.[base]
          if (!agents || !baseDef) {
            await warnOnce(`variant ${name} is missing from the config; spawns of ${base} that route to slot ${slot.index} would fail`)
            continue
          }
          const created: { model?: string; [k: string]: unknown } = {
            ...baseDef,
            description:
              `Hidden pool slot ${slot.index} for ${base}. Its model is set by the pool at config time. Spawn '${base}' and let the pool route.`,
            hidden: true,
            mode: "primary",
          }
          delete created.model
          agents[name] = created
          def = created
          await log("info", `declared variant ${name} for slot ${slot.index} (table grew after startup)`)
        }
        if (def.model && def.model !== slot.model) {
          await warnOnce(`${name} still hard-codes ${def.model}; the resolved pool preset wins (${slot.model}). Delete the line to keep one source of truth.`)
        }
        def.model = slot.model
        known.add(name)
        s.models.set(name, slot.model)
      }

      // A provider whitelist is an ALLOWLIST: opencode deletes every model a
      // provider offers that the list does not name. So a whitelist the user
      // wrote really is a restriction, and a slot whose model is missing from
      // it silently resolves to no model at all -- append it rather than making
      // the user edit a second file. An ABSENT whitelist already allows
      // everything, and creating one here would delete every model of theirs the
      // pool does not name, so an absent list stays absent.
      // Split on the first slash only: some providers (openrouter) put a vendor
      // segment in the model id itself, e.g. openrouter/nvidia/nemotron-3-ultra:free.
      const slash = slot.model.indexOf("/")
      const provider = slot.model.slice(0, slash)
      const id = slot.model.slice(slash + 1)
      const entry = providers?.[provider]
      if (!pool.providerReady(s, slot.model)) {
        await warnOnce(
          `provider ${provider} is not connected in opencode; slot ${slot.index} (${slot.model}) is excluded from routing until it is authenticated (run \`opencode auth login ${provider}\` or remove the line)`,
        )
      }
      if (!entry) {
        await warnOnce(`provider ${provider} is not configured in opencode.jsonc; slot ${slot.index} (${slot.model}) cannot resolve`)
        continue
      }
      const list = entry.whitelist
      if (list && !list.includes(id)) {
        list.push(id)
        await log("info", `whitelisted ${id} on ${provider} (${s.origin} slot ${slot.index})`)
      }
    }

    s.known = known
    await log(
      "info",
      `${s.origin}: bound ${known.size} variant agent(s) to ${slots.length} slot(s): ${slots.map((sl) => `${sl.index}=${sl.model} w${sl.weight}`).join(", ")}`,
    )
  }

  /**
   * The slot VALIDATION pass: probe every model in the table, cooling or not.
   *
   * A cooling model is re-admitted if it answers. A model the provider does not
   * serve is benched (see probeOne), so the next spawn routes around a slot that
   * would have failed. Shared with the on-demand recheck path, so its failures
   * never throw into the watcher.
   */
  const runValidation = async (models: string[]): Promise<probe.ProbeReport> => {
    let report = EMPTY_REPORT
    try {
      report = await probe.probeModels(client as probe.ProbeClient, { state: s, directory, models })
    } catch (error) {
      await log("error", `pool validation failed: ${String(error)}`)
      return EMPTY_REPORT
    }
    await announce(report)
    return report
  }

  // Watch every file the resolution chain consults. A change reaches
  // reloadSlots(), which is the only way past the read-once cache in
  // ensureSlots(); the variants are re-bound to the new table before the
  // validation pass, because a variant's model lives in the config object.
  const watchMs = opts.watchMs ?? SLOT_WATCH_MS
  const watchDebounceMs = opts.watchDebounceMs ?? SLOT_WATCH_DEBOUNCE_MS
  const sources = watchMs > 0 ? pool.slotSources(opts) : []
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  const reloadFromDisk = async () => {
    const reload = pool.reloadSlots(s, (m) => void warnOnce(m))
    if (!reload.changed) return
    await log(
      "info",
      `pool changed (${reload.origin}): ${reload.slots.map((sl) => `${sl.index}=${sl.model} w${sl.weight}`).join(", ")}`,
    )
    if (liveConfig) await bind(liveConfig)
    await runValidation(reload.slots.map((slot) => slot.model))
  }
  const scheduleReload = () => {
    if (reloadTimer) return
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined
      void reloadFromDisk()
    }, watchDebounceMs)
    reloadTimer.unref?.()
  }
  for (const source of sources) watchFile(source, { interval: watchMs, persistent: false }, scheduleReload)
  void log(
    "info",
    sources.length > 0
      ? `pool config watch armed: ${sources.join(", ")} every ${watchMs}ms; a change reloads the slots and validates every slot`
      : "pool config watch disabled (watchMs: 0)",
  )

  return {
    config: async (cfg) => {
      liveConfig = cfg
      await bind(cfg)
    },

    event: async ({ event }) => {
      try {
        const props = (event as { type?: string; properties?: Record<string, unknown> }).properties ?? {}

        // opencode reports free-tier exhaustion itself, per session: a retry
        // status carrying action.reason "free_tier_limit", the provider, and a
        // `next` reset timestamp. This fires even when no assistant error is
        // attached to a message, and it is provider-wide, so cool every slot on
        // that provider until the stated reset.
        if (event.type === "session.status") {
          const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
          const status = props.status as
            | { type?: string; message?: string; next?: number; action?: { reason?: string; provider?: string } }
            | undefined
          const action = status?.action
          const provider = typeof action?.provider === "string" ? action.provider : undefined
          const reason = action?.reason ?? ""
          // The provider's OWN words. opencode attaches an `action` block only for
          // the two error bodies it knows (FreeUsageLimitError, GoUsageLimitError);
          // any other provider limit arrives as a retry status carrying only a
          // message -- "limit reached", "daily limit reached". Reading the message
          // is what lets a provider with its own vocabulary count, and it is the
          // only signal there is when the provider is not named.
          const message = typeof status?.message === "string" ? status.message : ""
          const auth = pool.isAuthFailureText(reason) || pool.isAuthFailureText(message)
          const limited = reason === "free_tier_limit" || pool.isLimitText(reason) || pool.isLimitText(message) || auth
          if (status?.type === "retry" && limited) {
            // A probe's own 429 is evidence about one request, not about every slot
            // on the provider, and letting it bench the whole provider would turn a
            // health check into a denial of service against the pool running it.
            // The probe settles its own model's cooldown instead (src/lib/probe.ts).
            if (sessionID && pool.isProbe(s, sessionID)) {
              await log("debug", `probe on provider ${provider ?? "?"} was limited (${reason || "rate-limited"}); not cooling the provider`)
              return
            }
            const own = claimFor(sessionID)
            // A transient upstream outage is not a quota: it lifts on its own, so
            // it gets one short, flat window and never counts as a strike -- the
            // same line the assistant-error branch draws below. Without it, a
            // momentary outage reported in a retry status benches a healthy model
            // for the quota window and files it under the wrong reason. A reason
            // that says quota wins: "free_tier_limit" is the provider saying it is
            // out of allowance, not that it is down.
            const outage = pool.isUnavailableText(message) && !pool.isQuotaReason(reason)
            // An outage is filed under its own reason, because that reason is what
            // tells the pool the record is a COOLING record and never a strike (see
            // pool.recordStrike). A reason that says quota still wins -- the
            // provider is out of allowance, not down -- but a reason that says
            // nothing about quota does not get to relabel an outage as something
            // else, because then the outage would land in the strike memory.
            const named = auth ? pool.AUTH_FAILURE_REASON : (outage ? pool.UNAVAILABLE_REASON : reason || pool.limitReason(message) || "rate-limited")
            if (provider) {
              // An outage gets the flat window as well: a provider that is briefly
              // down must not be benched for the quota window because it said so
              // in the wrong words.
              const until = auth
                ? Date.now() + pool.AUTH_FAILURE_COOLDOWN_MS
                : outage
                  ? Date.now() + pool.UNAVAILABLE_COOLDOWN_MS
                  : typeof status.next === "number" && status.next > Date.now()
                    ? status.next
                    : Date.now() + HANG_FALLBACK_MS
              const cooled = pool.coolProvider(s, provider, until, named)
              if (cooled.length > 0) {
                await log("warn", `limit on provider ${provider} (${named}); cooling ${cooled.length} slot(s) until ${new Date(until).toISOString().slice(11, 19)}Z`, {
                  provider,
                  until,
                  models: cooled.map((c) => c.model),
                })
              }
            } else if (own) {
              // No provider named: cool the MODEL the session is running on. That
              // is the one model this refusal is evidence about, and cooling it is
              // what sends the retry to a slot that answers. A reset the provider
              // stated in the message wins over the computed backoff.
              if (auth) {
                const strike = pool.recordStrike(s, own.claim.m, pool.AUTH_FAILURE_REASON, pool.AUTH_FAILURE_COOLDOWN_MS)
                if (strike) {
                  await log("warn", `limit on ${own.claim.m} (${pool.AUTH_FAILURE_REASON}); cooling it for ${Math.round((strike.until - Date.now()) / 1000)}s`, {
                    model: own.claim.m,
                    slot: own.claim.k,
                    session: sessionID,
                  })
                }
              } else if (outage) {
                // The session is still aborted below: a retry status means opencode
                // is LOOPING on a refused model, and only the abort ends the wait.
                // What an outage changes is the WINDOW, not the wait.
                const transient = pool.coolUnavailable(s, own.claim.m)
                if (transient) await log("warn", `cooling ${own.claim.m} for ${Math.round((transient.until - Date.now()) / 1000)}s (${transient.reason})`)
              } else {
                const stated = pool.statedCooldown(message)
                const strike = pool.recordStrike(s, own.claim.m, named, stated)
                if (strike) {
                  await log("warn", `limit on ${own.claim.m} (${named}); cooling it for ${Math.round((strike.until - Date.now()) / 1000)}s`, {
                    model: own.claim.m,
                    slot: own.claim.k,
                    session: sessionID,
                  })
                }
              }
            }
            // The provider is benched, but the task already retrying on it is not:
            // abort it now rather than leave it to burn the whole retry budget.
            if (provider) {
              await failOver(sessionID, provider ?? own?.claim.m ?? "?", named, { stated: undefined, cool: false })
            } else {
              const stated = outage ? undefined : pool.statedCooldown(message)
              await failOver(sessionID, own?.claim.m ?? "?", named, { stated, cool: !own })
            }
          }
          return
        }

        if (event.type === "session.error") {
          const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
          // opencode reports a terminal API error as `session.error` plus an idle
          // status, not as a retry status, so the branch above never sees it.
          const error = props.error as
            | { data?: { statusCode?: number; responseHeaders?: Record<string, string> } }
            | undefined
          const haystack = JSON.stringify(error) ?? ""
          if (sessionID && pool.isProbe(s, sessionID)) {
            await log("debug", `probe session ${sessionID} ended with an error; not cooling anything`)
            return
          }
          const own = claimFor(sessionID)
          const missing = pool.isModelMissingText(haystack)
          const status = typeof error?.data?.statusCode === "number" ? error.data.statusCode : undefined
          const auth = pool.isAuthFailureText(haystack) || status === 401 || status === 403
          const limited = pool.isLimitText(haystack) || status === 429
          const outage = pool.isUnavailableText(haystack)
          if (missing) {
            // A model id the provider does not serve is terminal and will not fix itself.
            // Bench it for the cap like the probe does, and release the claim at once:
            // tool.execute.after never runs when the spawn dies before the tool completes,
            // so waiting for the reaper would leave a dead slot looking FULL.
            const unbound = !own && sessionID
              ? [...s.own.entries()].find(([, claim]) => !claim.g && claim.s === sessionID && haystack.includes(claim.m))
              : undefined
            const target = own ?? (unbound ? { key: unbound[0], claim: unbound[1] } : undefined)
            const model = target?.claim.m
            if (model) {
              const strike = pool.recordStrike(s, model, pool.MODEL_MISSING_REASON, pool.MODEL_MISSING_COOLDOWN_MS)
              if (strike) {
                await log("warn", `bench ${model} (${pool.MODEL_MISSING_REASON}, strike ${strike.strikes}) after a terminal model-not-found error`, {
                  model,
                  slot: target?.claim.k,
                  session: sessionID,
                })
              }
            }
            if (target) {
              pool.release(s, target.key)
              await log("warn", `released ${target.claim.v} claim on ${target.claim.m} after a terminal model-not-found error`, {
                base: target.claim.v,
                model: target.claim.m,
                slot: target.claim.k,
                session: sessionID,
              })
            }
            return
          }
          if (!limited && !outage && !auth) {
            // session.error is terminal (see the comment above the branch), so any claim
            // bound to this session is finished even when the error is not a pool signal.
            // Release it here rather than leaving the slot FULL until the reaper.
            if (own) {
              const detail = haystack.slice(0, 400)
              pool.recordFailure(s, {
                ts: Date.now(),
                source: "observed",
                base: own.claim.v,
                slot: own.claim.k,
                model: own.claim.m,
                session: sessionID,
                reason: "provider error",
                elapsedMs: Date.now() - own.claim.t,
                released: true,
                detail,
              })
              if (!observedErrors.has(own.key)) {
                observedErrors.set(own.key, { reason: "provider error", detail })
                if (observedErrors.size > 32) {
                  const oldest = observedErrors.keys().next().value
                  if (oldest !== undefined) observedErrors.delete(oldest)
                }
              }
              pool.release(s, own.key)
              await log("warn", `released ${own.claim.v} claim on ${own.claim.m} after a terminal session error`, {
                base: own.claim.v,
                model: own.claim.m,
                slot: own.claim.k,
                session: sessionID,
              })
            }
            return
          }
          const named = auth ? pool.AUTH_FAILURE_REASON : (outage ? pool.UNAVAILABLE_REASON : pool.limitReason(haystack) ?? "rate-limited")
          let stated: number | undefined
          if (own) {
            if (auth) {
              stated = pool.AUTH_FAILURE_COOLDOWN_MS
              const strike = pool.recordStrike(s, own.claim.m, pool.AUTH_FAILURE_REASON, stated)
              if (strike) {
                await log("warn", `limit on ${own.claim.m} (${pool.AUTH_FAILURE_REASON}); cooling it for ${Math.round((strike.until - Date.now()) / 1000)}s from a terminal session.error`, {
                  model: own.claim.m,
                  slot: own.claim.k,
                  session: sessionID,
                })
              }
            } else if (outage) {
              const transient = pool.coolUnavailable(s, own.claim.m)
              if (transient) {
                await log("warn", `cooling ${own.claim.m} for ${Math.round((transient.until - Date.now()) / 1000)}s (${transient.reason}) after a terminal error`)
              }
            } else {
              stated = pool.statedCooldown(haystack) ?? pool.retryAfterMs(error?.data?.responseHeaders)
              const strike = pool.recordStrike(s, own.claim.m, named, stated)
              if (strike) {
                await log("warn", `limit on ${own.claim.m} (${named}); cooling it for ${Math.round((strike.until - Date.now()) / 1000)}s from a terminal session.error`, {
                  model: own.claim.m,
                  slot: own.claim.k,
                  session: sessionID,
                })
              }
            }
          }
          await failOver(sessionID, own?.claim.m ?? "?", named, { stated, cool: !own })
          if (own && s.own.has(own.key)) {
            pool.release(s, own.key)
            await log("warn", `released ${own.claim.v} claim on ${own.claim.m} after a terminal session error (abort did not confirm)`, {
              base: own.claim.v,
              model: own.claim.m,
              slot: own.claim.k,
              session: sessionID,
            })
          }
          return
        }

        // Bind the subagent session opencode creates for a task call to the
        // claim that triggered it, oldest unbound claim first.
        if (event.type === "session.created") {
          const info = props.info as { id?: string; parentID?: string } | undefined
          if (info?.id && info.parentID) pool.bindChild(s, info.parentID, info.id)
          return
        }

        // Any message traffic means the task is alive. A hang is silence.
        if (event.type === "message.updated" || event.type === "message.part.updated") {
          const info = props.info as { sessionID?: string } | undefined
          const part = props.part as { sessionID?: string } | undefined
          const sessionID = info?.sessionID ?? part?.sessionID
          if (sessionID) pool.noteActivity(s, sessionID)
        }

        // A cancelled spawn leaves a bare "Task cancelled" on the parent's task
        // part. Rewrite it with the cause the abort recorded, so the expanded
        // card explains why instead of dead-ending. The part can be emitted
        // before the abort report is stored; park it until noteAbort flushes it.
        if (event.type === "message.part.updated") {
          const part = props.part as
            | (Partial<CancelledTaskPart> & { state?: Partial<CancelledTaskPart["state"]> })
            | undefined
          if (
            part?.type === "tool" &&
            part.tool === "task" &&
            part.state?.status === "error" &&
            part.state.error === "Task cancelled" &&
            part.id &&
            part.sessionID &&
            part.messageID &&
            part.callID
          ) {
            const key = pool.claimKey(part.sessionID, part.callID)
            const full = part as CancelledTaskPart
            const report = abortReports.get(key)
            if (report) {
              await patchCancelledPart(full, key, report)
            } else if (observedErrors.has(key)) {
              const spawn = spawns.get(key)
              const seen = observedErrors.get(key)!
              const elapsedMs = spawn ? Date.now() - spawn.t : 0
              const failureReport: AbortReport = {
                slot: spawn?.slot ?? 0,
                model: spawn?.model ?? "?",
                elapsedMs,
                kind: seen.reason as AbortReport["kind"],
                released: true,
                message: `${spawn?.model ?? "?"} — ${seen.reason}${seen.detail ? `: ${seen.detail.slice(0, 200)}` : ""}`,
              }
              await patchCancelledPart(full, key, failureReport)
              observedErrors.delete(key)
              spawns.delete(key)
            } else {
              pendingCancelledParts.set(key, full)
              if (pendingCancelledParts.size > 32) {
                const oldest = pendingCancelledParts.keys().next().value
                if (oldest !== undefined) pendingCancelledParts.delete(oldest)
              }
            }
          }
          return
        }

        if (event.type !== "message.updated") return
        const info = props.info as { role?: string; error?: unknown; providerID?: string; modelID?: string; sessionID?: string } | undefined
        if (!info || info.role !== "assistant" || !info.error) return
        // Shape-agnostic: the error surfaces under different keys depending on
        // whether it came from the AI SDK or the gateway, so scan the whole
        // object rather than assuming data.message.
        const haystack = JSON.stringify(info.error) ?? ""
        const status = typeof (info.error as { data?: { statusCode?: number } }).data?.statusCode === "number"
          ? (info.error as { data: { statusCode: number } }).data.statusCode
          : undefined
        const auth = pool.isAuthFailureText(haystack) || status === 401 || status === 403
        const limited = pool.isLimitText(haystack) || status === 429
        // A gateway 5xx, a queue budget, or a stalled request aborted on timeout
        // is a transient fault: the gateway is saying it cannot serve the request
        // right now, not that the key is out of quota.
        const gateway5xx = status !== undefined && status >= 500 && status <= 599
        const transientGateway = gateway5xx || pool.isTransientGatewayText(haystack)
        const missing = pool.isModelMissingText(haystack)
        if (!limited && !transientGateway && !auth && !missing) {
          const ownMsgUnclassified = claimFor(info.sessionID)
          if (ownMsgUnclassified) {
            pool.recordFailure(s, {
              ts: Date.now(),
              source: "observed",
              base: ownMsgUnclassified.claim.v,
              slot: ownMsgUnclassified.claim.k,
              model: ownMsgUnclassified.claim.m,
              session: info.sessionID,
              reason: "provider error",
              elapsedMs: Date.now() - ownMsgUnclassified.claim.t,
              released: false,
              detail: haystack.slice(0, 400),
            })
            if (!observedErrors.has(ownMsgUnclassified.key)) {
              observedErrors.set(ownMsgUnclassified.key, { reason: "provider error", detail: haystack.slice(0, 400) })
              if (observedErrors.size > 32) {
                const oldest = observedErrors.keys().next().value
                if (oldest !== undefined) observedErrors.delete(oldest)
              }
            }
          }
          return
        }
        const model = `${info.providerID ?? "?"}/${info.modelID ?? "?"}`
        // A probe is a QUESTION about a model, not work on it. Counting its failure
        // would re-cool the model a little further on every check, until the window
        // sat at the six-hour cap and no probe could ever pass — the prober would
        // guarantee the outcome it exists to detect. The probe settles its own
        // model's cooldown instead (src/lib/probe.ts), so this is only about real
        // work failing.
        if (info.sessionID && pool.isProbe(s, info.sessionID)) {
          await log("debug", `probe of ${model} hit a limit (${pool.isLimitText(haystack) ? "limit" : "transient"}); leaving the cooldown to the probe`)
          return
        }
        // A transient upstream outage is not a limit: it lifts on its own, so it
        // gets a short, flat cooldown and is never counted as a strike (which
        // would escalate the cooldown past the outage -- see pool.coolUnavailable).
        // A gateway 5xx, a queue budget, or a timeout is the same kind of fault
        // and takes the same flat path; a real limit still escalates below.
        const ownMsg = claimFor(info.sessionID)
        if (missing) {
          const ownMsgMissing = ownMsg
          const missingModel = ownMsgMissing?.claim.m ?? model
          if (missingModel !== "?/?") {
            const strike = pool.recordStrike(s, missingModel, pool.MODEL_MISSING_REASON, pool.MODEL_MISSING_COOLDOWN_MS)
            if (strike) {
              await log("warn", `bench ${missingModel} (${pool.MODEL_MISSING_REASON}, strike ${strike.strikes}) after a model-not-found error`, {
                model: missingModel,
                slot: ownMsgMissing?.claim.k,
                session: info.sessionID,
              })
            }
          }
          if (ownMsgMissing) {
            pool.release(s, ownMsgMissing.key)
            await log("warn", `released ${ownMsgMissing.claim.v} claim on ${ownMsgMissing.claim.m} after a model-not-found error`, {
              base: ownMsgMissing.claim.v,
              model: ownMsgMissing.claim.m,
              slot: ownMsgMissing.claim.k,
              session: info.sessionID,
            })
          }
          return
        }
        if (pool.isUnavailableText(haystack) || (!limited && !auth && transientGateway)) {
          const transient = pool.coolUnavailable(s, model)
          if (transient) await log("warn", `cooling ${model} for ${Math.round((transient.until - Date.now()) / 1000)}s (${transient.reason})`)
          // The caller already cooled the model, so only the abort/release side
          // of failover applies; a stuck session must not keep retrying it.
          await failOver(info.sessionID, model, transient?.reason ?? pool.UNAVAILABLE_REASON, { cool: false })
          return
        }
        const stated = auth ? pool.AUTH_FAILURE_COOLDOWN_MS : (pool.statedCooldown(haystack) ?? pool.retryAfterMs((info.error as { data?: { responseHeaders?: Record<string, string> } }).data?.responseHeaders))
        const reason = auth ? pool.AUTH_FAILURE_REASON : pool.limitReason(haystack)
        const strike = pool.recordStrike(s, model, reason ?? "rate-limited", stated)
        if (strike) await log("warn", `cooling ${model} for ${Math.round((strike.until - Date.now()) / 1000)}s (${reason ?? "rate-limited"}, strike ${strike.strikes})`)
        // The model is benched; the task already in flight on it is not. Abort it
        // so the caller re-routes now instead of after the ~5-minute hang reaper.
        await failOver(info.sessionID, model, reason ?? "rate-limited", { stated, cool: !ownMsg })
      } catch (error) {
        await log("error", `limit detection failed: ${String(error)}`)
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      let requested = output.args?.subagent_type
      if (typeof requested !== "string") {
        // A task spawn with no subagent_type never reaches the routing below:
        // opencode runs the default subagent, which carries no pool model, so
        // the spawn silently inherits the caller's model. That is the one way a
        // delegated read can cost a primary-model turn without the pool ever
        // seeing it, so it is worth saying even though the spawn cannot be fixed
        // after the fact. Pass the base name ("explore" / "implement") instead.
        await warnOnce(
          'task spawn has no subagent_type, so the pool cannot route it -- it will run on the caller\'s own model. Pass subagent_type "explore" or "implement" to use a slot.',
        )
        return
      }

      // Coerced here, ahead of routing and deliberately OUTSIDE the try below.
      // That catch exists so a routing slip never costs the caller a spawn; a
      // coercion is not a slip, and swallowing it into "spawn unchanged" would
      // leave the hand-named slot in place instead of routing through pickSlot.
      // A hand-named pool slot variant (e.g. a variant of a pooled base) is
      // rewritten to its base so routing proceeds through pickSlot and the pool
      // owns slot choice. The variant's NAME is deliberately absent from the
      // log line, for the same reason the routing log omits it.
      const manual = pool.manualVariant(requested)
      if (manual) {
        await log("warn", `rewrote a hand-named pool slot to its base; the pool owns slot choice`, {
          base: manual,
        })
        requested = manual
        output.args.subagent_type = manual
      }

      try {
        await reapStuck()
        await refreshProviders()
        pool.refreshCatalog(s, serverUrl)
        const snap = pool.snapshot(s)

        if (pool.BASES.includes(requested)) {
          const slot = pool.pickSlot(s, snap)
          const variant = pool.agentFor(requested, slot.index)
          if (s.known.size > 0 && !s.known.has(variant)) {
            await warnOnce(`variant ${variant} missing from config; spawn left unchanged`)
            return
          }
          // The variant's NAME is deliberately absent from this line.
          //
          // This log is read by the very agent it routes. Printing "routed explore
          // -> explore-2" hands the model a valid-looking agent name in the exact
          // place it is deciding what to spawn, and a model that sees one copies
          // it straight back: `implement-4` 23 times, `implement-2` 20,
          // `explore-2` 12 -- one occurrence per routed spawn.
          // The slot index and the model say everything an operator needs and give
          // the model nothing to echo.
          await log("info", `routed ${requested} to slot ${slot.index} on ${slot.model}`, {
            slot: slot.index,
            weight: slot.weight,
            model: slot.model,
            ceiling: pool.slotCeiling(slot),
            load: (snap.counts.get(slot.index) ?? 0) + 1,
          })
          output.args.subagent_type = variant
          // Invariant: a claim is held only for a rout that completes.
          const routeKey = pool.claimKey(input.sessionID, input.callID)
          pool.acquire(s, requested, slot, input.sessionID, routeKey)
          spawns.set(routeKey, { base: requested, slot: slot.index, model: slot.model, t: Date.now() })
          return
        }

        // A spawn the pool does NOT own (basic, expert -- anything with its own
        // hard-coded model) falls through here with nothing logged, because the
        // pool neither routed it nor claimed a slot. So when that pinned model
        // is cooling, the spawn is going to fail and the log says nothing about
        // why: the escalation agent simply "cancelled". Naming the model and the
        // reason is the difference between "expert is broken" and "expert's
        // provider is benched", and it is the only signal available -- a pinned
        // agent gets no cooldown-driven failover, so the bench is not survivable.
        const pinned = s.models.get(requested)
        const bench = pinned ? snap.cooling.get(pinned) : undefined
        if (pinned && bench) {
          await warnOnce(
            `${requested} runs ${pinned}, which is cooling (${bench.reason}, strike ${bench.strikes}) -- it cannot fail over, because only ${pool.BASES.join("/")} are pooled. Drop the model line from ${requested} to route it through the pool, or wait out the cooldown.`,
          )
        }
      } catch (error) {
        await log("error", `routing failed, spawn unchanged: ${String(error)}`)
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return
      const key = pool.claimKey(input.sessionID, input.callID)
      const spawn = spawns.get(key)
      pool.release(s, key)
      const text = typeof output.output === "string" ? output.output : ""
      const failed = abortReports.has(key) || /task\s+cancel+ed/i.test(text)
      spawns.delete(key)
      const report = abortReports.get(key)
      if (!report) return
      abortReports.delete(key)
      pool.recordFailure(s, {
        ts: Date.now(),
        source: "pool",
        base: undefined,
        slot: report.slot,
        model: report.model,
        session: input.sessionID,
        reason: report.kind,
        elapsedMs: report.elapsedMs,
        released: report.released,
        detail: report.message,
      })
      const detail = [
        `Task Cancelled by LaCode: ${report.message}`,
        `slot ${report.slot}; model ${report.model}; elapsed ${report.elapsedMs}ms; failure ${report.kind}; claim ${report.released ? "released" : "held"}`,
      ].join("\n")
      // Replace opencode's dead end rather than appending to it, so a plain
      // "Task cancelled" is not reachable for an abort this plugin caused. This
      // only covers a spawn that completed before the abort landed; cancelled
      // spawns are handled by the event hook.
      output.output = /task\s+cancel+ed/i.test(text) ? detail : text ? `${text}\n\n${detail}` : detail
    },

    tool: {
      pool_recheck: tool({
        description:
          "Probe the models the pool has benched and re-admit the ones that answer. Each probe is a real request on that exact model, so it settles what a cooldown can only guess: if the model replies, its cooldown is cleared and it is back in the pool; if it is still limited, the existing cooldown stands; if the provider does not serve it at all, it is benched so routing stops choosing it. Pass `models` to validate those even when they are not cooling. Call it after editing the pool, after resetting a quota in the provider's own console, when the pool feels short of capacity, or to check now instead of waiting for the next automatic pass.",
        args: {
          models: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Model ids to validate, as provider/model-id. Omit to probe only the models that are cooling."),
        },
        async execute(args) {
          await refreshProviders(true)
          const models = args?.models
          const report = models && models.length > 0 ? await runValidation(models) : await runProbe()
          return { title: `agent-pool: ${reportTitle(report)}`, output: reportText(report) }
        },
      }),

      pool_status: tool({
        description:
          "Show live pool load across every opencode process, per free model and per agent type, each slot's load against its ceiling, the slot marked <- next that the next spawn would take, and which models are cooling after a rate limit or a stuck task; COOLING/UNAVAILABLE = not routable. Check it before launching many parallel subagents.",
        args: {},
        async execute() {
          await refreshProviders(true)
          pool.refreshCatalog(s, serverUrl)
          const slots = pool.ensureSlots(s, (m) => void warnOnce(m))
          const snap = pool.snapshot(s)
          const pass = pool.poolPass(s, snap)
          const now = Date.now()
          // Load is per SLOT, not per model: the same model may occupy two lines
          // with independent budgets, and grouping by model would merge them.
          const bySlot = new Map<number, { total: number; bases: Map<string, number> }>()
          const add = (k: number, base: string) => {
            const entry = bySlot.get(k) ?? { total: 0, bases: new Map() }
            entry.total++
            entry.bases.set(base, (entry.bases.get(base) ?? 0) + 1)
            bySlot.set(k, entry)
          }
          for (const claim of snap.own.values()) add(claim.k, claim.v)
          for (const sibling of snap.siblings) for (const claim of sibling.claims) add(claim.k, claim.v)

          // Which slot the next pooled spawn would actually take, so a surprising routing
          // decision can be read off the status instead of guessed at from load alone.
          const next = pool.pickSlot(s, snap)
          const line = (slot: pool.Slot) => {
            const entry = bySlot.get(slot.index)
            const users = entry && entry.bases.size > 0 ? [...entry.bases].map(([b, n]) => `${b}x${n}`).join(" ") : "idle"
            const strike = snap.cooling.get(slot.model)
            const status = s.catalog.get(slot.model)
            const notes = [
              strike ? `UNAVAILABLE (COOLING ${Math.ceil((strike.until - now) / 1000)}s, ${strike.reason}, strike ${strike.strikes})` : "",
              !pool.providerReady(s, slot.model)
                ? `UNAVAILABLE (provider-unconfigured: ${pool.providerOf(slot.model)}; run \`opencode auth login ${pool.providerOf(slot.model)}\`)`
                : "",
              status && status !== "active" && status !== "unknown" ? `catalog:${status}` : "",
            ].filter(Boolean)
            const marker = slot.index === next.index ? " <- next" : ""
            // load/ceiling: the ceiling is the slot's weight. A FULL slot is only
            // used again once no other slot is both available and under its weight.
            const load = entry?.total ?? 0
            const atCeiling = !pool.underCeiling(slot, snap.counts)
            return `  slot ${slot.index} w${slot.weight}  ${slot.model}  load=${load}/${pool.slotCeiling(slot)}${atCeiling ? " FULL" : ""}${marker}  [${users}${notes.length ? "; " + notes.join("; ") : ""}]`
          }

          const total = [...snap.counts.values()].reduce((sum, n) => sum + n, 0)
          const coolingNow = [...snap.cooling.entries()].filter(([, st]) => st.until > now)
          // Effective capacity per shared quota group. A bucket with one slot is
          // just that model and is not repeated here.
          const buckets = new Map<string, { seats: number; slots: number; cooling: boolean }>()
          for (const slot of slots) {
            const name = pool.slotBucket(slot)
            const entry = buckets.get(name) ?? { seats: 0, slots: 0, cooling: false }
            entry.seats += slot.weight
            entry.slots++
            if (snap.cooling.has(slot.model)) entry.cooling = true
            buckets.set(name, entry)
          }
          const sharedBuckets = [...buckets].filter(([, entry]) => entry.slots > 1)
          // Judged by the reaper's own rule, not a restatement of it: the status
          // and the sweep must describe the same rule, or a claim the status
          // calls healthy is one the reaper is about to condemn.
          const verdicts = [...snap.own.values()].map((claim) => pool.condemnReason(s, claim, now))
          const hung = verdicts.filter((verdict) => verdict === "hung").length
          const overran = verdicts.filter((verdict) => verdict === "overran").length

          return {
            title: `agent-pool: ${total} task(s) in flight, ${coolingNow.length} model(s) cooling`,
            output: [
              `shared pool over ${slots.length} slot(s) from ${s.origin}; state ${pass}; bases: ${pool.BASES.join(", ")}\none ordered pass in slot order: each slot fills to its weight, then overflow goes to the least-loaded slot. Capacity is the sum of the weights; repeat a model on another line to give it more (FULL = at weight).`,
              ...(sharedBuckets.length
                ? [`buckets: ${sharedBuckets.map(([name, entry]) => `${name} ${entry.seats} seat(s)${entry.cooling ? " COOLING" : ""}`).join("; ")}`]
                : []),
              ...slots.map(line),
              "",
              "by process:",
              `  ${s.id} (this process): ${snap.own.size} claim(s)`,
              ...snap.siblings.map((sibling) => `  ${sibling.id}: ${sibling.claims.length} claim(s)`),
              "",
              `${total} claim(s) in flight across ${snap.siblings.length + 1} process(es).`,
              `hung past ${Math.round(pool.STUCK_MIN_AGE_MS / 60000)}min with ${Math.round(pool.STUCK_IDLE_MS / 60000)}min silence: ${hung} (auto-aborted); reaped total: ${s.reaped}.`,
              `overran past ${Math.round(pool.MAX_CLAIM_AGE_MS / 60000)}min: ${overran} (auto-aborted).`,
              `watchdog alive: last sweep ${s.lastSweep ? `${Math.max(0, Math.round((now - s.lastSweep) / 1000))}s ago` : "never"} (every ${Math.round(reapMs / 1000)}s).`,
              // When the cooled models were last USED rather than inferred, because
              // "still cooling" and "nobody has actually asked it lately" are
              // different situations and this is the line that tells them apart.
              probeMs > 0
                ? `cooldown probe: last ${
                    s.lastProbe
                      ? `${Math.max(0, Math.round((now - s.lastProbe) / 1000))}s ago`
                      : coolingNow.length > 0
                        ? "never in this process (cooldowns came from disk)"
                        : "never (nothing has been cooling)"
                  }, every ${Math.round(probeMs / 60000)}m; call the pool_recheck tool (or run /pool-recheck) to ask now.`
                : "cooldown probe: off (probeMs: 0); call the pool_recheck tool (or run /pool-recheck) to ask now.",
              watchMs > 0
                ? `pool config watch: ${sources.join(", ")} every ${watchMs}ms; a change reloads the slot table and validates every slot.`
                : "pool config watch: off (watchMs: 0).",
              coolingNow.length === 0
                ? "no models cooling down."
                : `unavailable/cooling: ${coolingNow.map(([m, st]) => `${m} for ${Math.ceil((st.until - now) / 1000)}s`).join(", ")}`,
              (() => {
                const recent = pool.readFailures(s, 5)
                if (recent.length === 0) {
                  return "recent failures: none recorded"
                }
                const all = pool.readFailures(s, 1000)
                const total = all.length
                const fmtAge = (ts: number) => {
                  const diff = Math.max(0, Date.now() - ts)
                  const sAge = Math.floor(diff / 1000)
                  if (sAge < 60) return `${sAge}s`
                  const mAge = Math.floor(sAge / 60)
                  if (mAge < 60) return `${mAge}m`
                  const hAge = Math.floor(mAge / 60)
                  if (hAge < 24) return `${hAge}h`
                  const dAge = Math.floor(hAge / 24)
                  return `${dAge}d`
                }
                const lines = [`recent failures: ${total} recorded in ${s.dir}/failures.jsonl`]
                const ordered = [...recent].reverse()
                for (const rec of ordered) {
                  const age = fmtAge(rec.ts)
                  const slot = rec.slot === undefined || rec.slot === null ? "-" : rec.slot
                  const model = rec.model
                  const reason = rec.reason
                  const source = rec.source
                  const suffix = source === "observed" ? " (unclassified)" : ""
                  lines.push(`  ${age} ago  slot ${slot} ${model}  ${reason}  [${source}]${suffix}`)
                }
                return lines.join("\n")
              })(),
            ].join("\n"),
          }
        },
      }),
    },

    dispose: async () => {
      clearInterval(timer)
      if (probeTimer) clearInterval(probeTimer)
      if (reloadTimer) clearTimeout(reloadTimer)
      for (const source of sources) unwatchFile(source, scheduleReload)
      s.own.clear()
      // Drop the per-session bookkeeping with the claims: nothing can be running
      // once the hooks are gone, and these are the two maps that would otherwise
      // be the last to be released. See pool.pruneSessions.
      s.activity.clear()
      s.children.clear()
      // Publish the empty set so this process's claims stop counting as load for
      // every sibling the moment it exits. Clearing memory alone left the claims
      // in `claims.<id>.json`, so a dead process's "locks" outlived it until the
      // TTL -- the pool reported slots as busy that nobody was using.
      pool.publish(s)
    },
  }
})