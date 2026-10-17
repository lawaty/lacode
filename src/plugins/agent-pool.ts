import { tool, type Hooks, type PluginOptions } from "@opencode-ai/plugin"
import * as pool from "../lib/pool.ts"
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
// chain in ../lib/pool.ts (plugin options > ~/.config/lacode/pool.json >
// presets/free-tier.json), and the config hook rewrites the variant agents
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
// The kill is one POST to our own local server. It gets a deadline because the
// reaper is the thing that must never wedge: an unbounded fetch would leave
// s.reaping true and silently disarm the watchdog for the rest of the process.
const ABORT_TIMEOUT_MS = 10_000

type LogFn = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => Promise<void>

export type AgentPoolOptions = {
  /** Process identity for the claim files; defaults to the pid. Tests inject their own. */
  id?: string
  /** Claim directory. Defaults to ~/.local/share/opencode/agent-pool. */
  dir?: string
  /** Reaper interval; the 30s default is what production runs on. */
  reapMs?: number
  /** Explicit slot file. Short-circuits the preset resolution chain. */
  modelsFile?: string
  /** Inline `{ slots: [...] }`, highest priority in the resolution chain. */
  models?: unknown
}

// Typed as a factory returning hooks, NOT as a Plugin: only src/index.ts may
// carry the Plugin type, because only it may be loaded as one.
export const agentPoolHooks = (async ({ client, serverUrl }, options?: PluginOptions): Promise<Hooks> => {
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
  // 404/500 upstream. So the response is checked, and the reason a kill failed is
  // carried back rather than swallowed -- otherwise a failure is indistinguishable
  // from a success and the zombie outlives its claim.
  const abortSession = async (sessionID: string): Promise<{ ok: boolean; why: string }> => {
    if (!serverUrl) return { ok: false, why: "no serverUrl: this process has no HTTP server to abort through" }
    try {
      const res = await fetch(new URL(`/session/${sessionID}/abort`, serverUrl).toString(), {
        method: "POST",
        signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
      })
      if (!res.ok) return { ok: false, why: `gateway answered HTTP ${res.status}` }
      const body = (await res.text()).trim()
      if (body === "false") return { ok: false, why: "server reported the session was not aborted" }
      return { ok: true, why: "" }
    } catch (error) {
      return { ok: false, why: String(error) }
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

  // A usage limit HANGS rather than failing: opencode keeps retrying the same
  // refused model, so the claim it is holding never comes back and the reaper
  // would only condemn it after STUCK_MIN_AGE_MS of age -- minutes the caller
  // spends waiting on a provider that has already said no. When the limit signal
  // names the session a claim is running on, abort that session at once: control
  // returns to the caller and the next spawn routes to a slot that answers, in
  // seconds instead of minutes. Scoped to the claim that owns the session so an
  // unrelated session's error never kills someone else's work.
  const failOver = async (sessionID: string | undefined, model: string, reason: string) => {
    if (!sessionID) return
    const entry = [...s.own.entries()].find(([, claim]) => claim.g === sessionID)
    if (!entry) return
    const [key, claim] = entry
    const kill = await abortSession(sessionID)
    pool.release(s, key)
    await log(
      "warn",
      kill.ok
        ? `limit (${reason}) on ${model}; aborted in-flight ${claim.v} session ${sessionID} to fail over now`
        : `limit (${reason}) on ${model}; released in-flight ${claim.v} claim after a failed abort (${kill.why})`,
      { base: claim.v, model: claim.m, slot: claim.k, session: sessionID, aborted: kill.ok, reason },
    )
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

  return {
    config: async (cfg) => {
      const slots = pool.ensureSlots(s, (m) => void warnOnce(m))
      const agents = cfg.agent as Record<string, { model?: string; [k: string]: unknown }> | undefined
      const providers = cfg.provider as Record<string, { whitelist?: string[] }> | undefined
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
          const def = agents?.[name]
          if (!def) {
            await warnOnce(`variant ${name} is missing from the config; spawns of ${base} that route to slot ${slot.index} would fail`)
            continue
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
          const reason = status?.action?.reason ?? ""
          // opencode reports a provider-wide limit itself, per session: a retry
          // status carrying the provider and a `next` reset timestamp. This fires
          // even when no assistant error is attached to a message, and it is
          // provider-wide, so cool every slot on that provider until the stated
          // reset. "free_tier_limit" is opencode's own reason; a limit-shaped
          // reason from any other provider is the same statement, so both count.
          if (status?.type === "retry" && status.action?.provider && (reason === "free_tier_limit" || pool.isLimitText(reason))) {
            const provider = status.action.provider
            const until = typeof status.next === "number" && status.next > Date.now() ? status.next : Date.now() + HANG_FALLBACK_MS
            const cooled = pool.coolProvider(s, provider, until, reason || "rate-limited")
            if (cooled.length > 0) {
              await log("warn", `limit on provider ${provider} (${reason || "rate-limited"}); cooling ${cooled.length} slot(s) until ${new Date(until).toISOString().slice(11, 19)}Z`, {
                provider,
                until,
                models: cooled.map((c) => c.model),
              })
            }
            // The provider is benched, but the task already retrying on it is not:
            // abort it now rather than leave it to burn the whole retry budget.
            await failOver(sessionID, provider, reason || "rate-limited")
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
        const limited = pool.isLimitText(haystack) || status === 429
        // A gateway 5xx, a queue budget, or a stalled request aborted on timeout
        // is a transient fault: the gateway is saying it cannot serve the request
        // right now, not that the key is out of quota.
        const gateway5xx = status !== undefined && status >= 500 && status <= 599
        const transientGateway = gateway5xx || pool.isTransientGatewayText(haystack)
        if (!limited && !transientGateway) return
        const model = `${info.providerID ?? "?"}/${info.modelID ?? "?"}`
        // A transient upstream outage is not a limit: it lifts on its own, so it
        // gets a short, flat cooldown and is never counted as a strike (which
        // would escalate the cooldown past the outage -- see pool.coolUnavailable).
        // A gateway 5xx, a queue budget, or a timeout is the same kind of fault
        // and takes the same flat path; a real limit still escalates below.
        if (pool.isUnavailableText(haystack) || (!limited && transientGateway)) {
          const transient = pool.coolUnavailable(s, model)
          if (transient) await log("warn", `cooling ${model} for ${Math.round((transient.until - Date.now()) / 1000)}s (${transient.reason})`)
          return
        }
        const stated = pool.statedCooldown(haystack) ?? pool.retryAfterMs((info.error as { data?: { responseHeaders?: Record<string, string> } }).data?.responseHeaders)
        const reason = haystack.match(/rate[\s_-]?limit|usage limit|too many requests|quota|freelimiterror|overloaded/i)?.[0]
          ?.toLowerCase()
          .replace(/[\s_]/g, "-")
        const strike = pool.recordStrike(s, model, reason ?? "rate-limited", stated)
        if (strike) await log("warn", `cooling ${model} for ${Math.round((strike.until - Date.now()) / 1000)}s (${reason ?? "rate-limited"}, strike ${strike.strikes})`)
        // The model is benched; the task already in flight on it is not. Abort it
        // so the caller re-routes now instead of after the ~5-minute hang reaper.
        await failOver(info.sessionID, model, reason ?? "rate-limited")
      } catch (error) {
        await log("error", `limit detection failed: ${String(error)}`)
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      const requested = output.args?.subagent_type
      if (typeof requested !== "string") return

      // Refused here, ahead of routing and deliberately OUTSIDE the try below.
      // That catch exists so a routing slip never costs the caller a spawn; a
      // refusal is not a slip, and swallowing it into "spawn unchanged" would let
      // the very spawn this forbids go through -- with a claim on a slot the pool
      // never chose, above the ceiling that slot was meant to enforce.
      const manual = pool.manualVariant(requested)
      if (manual) {
        await log("warn", `refused manual spawn of slot variant ${requested}; spawn "${manual}" instead`, {
          variant: requested,
          base: manual,
        })
        throw new Error(
          `${requested} is a pool slot variant and cannot be spawned by name. Naming it lets the caller pick the provider: ` +
            `it skips the round-robin rotation and the slot's ceiling, so one provider takes every concurrent claim. ` +
            `Spawn "${manual}" and let the pool choose the slot.`,
        )
      }

      try {
        await reapStuck()
        pool.refreshCatalog(s, serverUrl)
        const snap = pool.snapshot(s)

        if (pool.BASES.includes(requested)) {
          const slot = pool.pickSlot(s, snap)
          const variant = pool.agentFor(requested, slot.index)
          if (s.known.size > 0 && !s.known.has(variant)) {
            await warnOnce(`variant ${variant} missing from config; spawn left unchanged`)
            return
          }
          pool.acquire(s, requested, slot, input.sessionID, pool.claimKey(input.sessionID, input.callID))
          output.args.subagent_type = variant
          await log("info", `routed ${requested} -> ${variant}`, {
            slot: slot.index,
            weight: slot.weight,
            model: slot.model,
            ceiling: pool.slotCeiling(slot),
            load: (snap.counts.get(slot.model) ?? 0) + 1,
          })
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

    "tool.execute.after": async (input) => {
      if (input.tool !== "task") return
      pool.release(s, pool.claimKey(input.sessionID, input.callID))
    },

    tool: {
      pool_status: tool({
        description:
          "Show live pool load across every opencode process, per free model and per agent type, each slot's load against its ceiling, the slot marked <- next that the next spawn would take, and which models are cooling after a rate limit or a stuck task. Check it before launching many parallel subagents.",
        args: {},
        async execute() {
          pool.refreshCatalog(s, serverUrl)
          const slots = pool.ensureSlots(s, (m) => void warnOnce(m))
          const snap = pool.snapshot(s)
          const now = Date.now()
          const byModel = new Map<string, { total: number; bases: Map<string, number> }>()
          const add = (model: string, base: string) => {
            const entry = byModel.get(model) ?? { total: 0, bases: new Map() }
            entry.total++
            entry.bases.set(base, (entry.bases.get(base) ?? 0) + 1)
            byModel.set(model, entry)
          }
          for (const claim of snap.own.values()) add(claim.m, claim.v)
          for (const sibling of snap.siblings) for (const claim of sibling.claims) add(claim.m, claim.v)

          // Which slot the next pooled spawn would actually take, so a surprising routing
          // decision can be read off the status instead of guessed at from load alone.
          // advance:false -- looking must not consume the rotation's next turn.
          const next = pool.pickSlot(s, snap, { advance: false })
          const line = (slot: pool.Slot) => {
            const entry = byModel.get(slot.model)
            const users = entry && entry.bases.size > 0 ? [...entry.bases].map(([b, n]) => `${b}x${n}`).join(" ") : "idle"
            const strike = snap.cooling.get(slot.model)
            const status = s.catalog.get(slot.model)
            const notes = [
              strike ? `COOLING ${Math.ceil((strike.until - now) / 1000)}s (${strike.reason}, strike ${strike.strikes})` : "",
              status && status !== "active" && status !== "unknown" ? `catalog:${status}` : "",
            ].filter(Boolean)
            const marker = slot.index === next.index ? " <- next" : ""
            // claims/ceiling: the ceiling is reached at the denominator (twice the
            // slot's weight), and a slot at its ceiling is only used again once every
            // other slot is also there.
            const load = entry?.total ?? 0
            const atCeiling = !pool.underCeiling(slot, snap.counts)
            return `  slot ${slot.index} w${slot.weight}  ${slot.model}  load=${load}/${pool.slotCeiling(slot)}${atCeiling ? " FULL" : ""}${marker}  [${users}${notes.length ? "; " + notes.join("; ") : ""}]`
          }

          const total = [...snap.counts.values()].reduce((sum, n) => sum + n, 0)
          const coolingNow = [...snap.cooling.entries()].filter(([, st]) => st.until > now)
          // Judged by the reaper's own rule, not a restatement of it: the status
          // and the sweep must describe the same rule, or a claim the status
          // calls healthy is one the reaper is about to condemn.
          const verdicts = [...snap.own.values()].map((claim) => pool.condemnReason(s, claim, now))
          const hung = verdicts.filter((verdict) => verdict === "hung").length
          const overran = verdicts.filter((verdict) => verdict === "overran").length

          return {
            title: `agent-pool: ${total} task(s) in flight, ${coolingNow.length} model(s) cooling`,
            output: [
              `shared pool over ${slots.length} model(s) from ${s.origin}; bases: ${pool.BASES.join(", ")}\nround robin in slot order, each slot taking as many turns as its weight says, so no slot is starved while another drains (FULL = at ceiling, used only when every slot is)`,
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
              coolingNow.length === 0
                ? "no models cooling down."
                : `cooling: ${coolingNow.map(([m, st]) => `${m} for ${Math.ceil((st.until - now) / 1000)}s`).join(", ")}`,
            ].join("\n"),
          }
        },
      }),
    },

    dispose: async () => {
      clearInterval(timer)
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