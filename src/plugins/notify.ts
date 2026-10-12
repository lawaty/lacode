import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"
import type { Hooks } from "@opencode-ai/plugin"
import {
  Notifier,
  errorDetail,
  helperArgv,
  isUnrecognizedError,
  permissionHeadline,
  questionHeadline,
  shouldNotify,
  type Outcome,
  type PermissionRequest,
  type SessionInfo,
} from "../lib/notify.ts"
import { PACKAGE_ROOT } from "../lib/pool.ts"

// Desktop notification when a session needs you: a finished turn, or a question
// it cannot proceed without.
//
// Two design points that are load-bearing rather than cosmetic:
//
//   * Subagents are suppressed. A root session that dispatched ten
//     explore children would otherwise raise ten "ready" notifications.
//     The whole value of this plugin is one notification per thing you asked
//     for, and a subagent going idle is not a thing you asked for.
//   * The cartographer is suppressed too. context-autoupdate creates it through
//     the session API with no parentID, so it is indistinguishable from a root
//     session by structure alone; it is identified by its title prefix.
//
// The notification is delivered by bin/oc-notify, the same tunnel path `oc` uses,
// rather than by talking to a notification daemon from here. One implementation of
// the return trip, already tested against both hosts; a second one written in
// TypeScript would be a second thing to get wrong.
//
// Two outcomes are worth someone's attention, and the wording is about what they
// must do rather than what opencode did:
//
//   done      the agent finished a turn and handed control back
//   question  the agent is blocked on an answer and cannot continue
//
// A third joins them (US-25): a permission prompt. It is the same class of
// silent stall as a question -- opencode blocks and waits -- but it was
// invisible here, so a directory-access prompt looked like a hung agent. It
// notifies on the ASK and never on the reply: the user needs to know they are
// being asked, and telling them what they then decided only adds noise.
//
// All of them are suppressed for subagents and the cartographer. A
// session.started notification was removed: it interrupts to say nothing, and
// it fires before there is any result to name.
//
// This module is a HOOK FACTORY, not a plugin -- see the note at the top of
// ./agent-pool.ts. It must export the factory and nothing else.

const SERVICE = "notify"
const COOLDOWN_MS = 5_000

// Where the notification helper lives, in order:
//   1. OC_NOTIFY_HELPER -- an explicit override, so a user can point at their own
//   2. ~/bin/lacode or ~/bin/oc-notify -- what a hand-made install puts on PATH
//   3. the package's own bin/ -- the author's checkout, where bin/oc-notify exists
//   4. dist/lacode.js -- the BUILT cli, which is all an npm install ships. The
//      shipped package no longer carries the TypeScript sources, so pointing at
//      the package's bin/lacode there would hand a broken helper to every
//      consumer: found, spawned, and dead on arrival with node refusing to strip
//      types under node_modules. The built CLI is the same program with the
//      types already gone -- but a different ENTRY: it takes a `notify`
//      subcommand, so its argv is built differently (see helperArgv below).
// Candidates are anchored on PACKAGE_ROOT rather than on this module's own
// directory, because bundling moves this file from src/plugins/ to dist/ and a
// relative hop would resolve outside the package.
// Nothing here throws: a missing helper warns once and notifications are lost,
// which is strictly better than taking the server down with them.
const findHelper = (): string | undefined => {
  const home = process.env.HOME ?? ""
  const candidates = [
    process.env.OC_NOTIFY_HELPER,
    path.join(home, "bin", "lacode"),
    path.join(home, "bin", "oc-notify"),
    path.join(PACKAGE_ROOT, "bin", "oc-notify"),
    path.join(PACKAGE_ROOT, "dist", "lacode.js"),
    path.join(PACKAGE_ROOT, "bin", "lacode"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

/**
 * The one seam in this file.
 *
 * `deliver` is what actually reaches the desktop; everything above it is policy.
 * A test injects a recording sender here to observe that a notification WOULD be
 * sent, without a desktop daemon, an SSH hop, or a child process per assertion
 * (US-11/US-12). It is also how a caller can substitute a different transport.
 *
 * Omit it and nothing changes: the default spawns `bin/oc-notify` detached and
 * unref'd, exactly as before. This parameter is additive and last, so every
 * existing call site keeps its current behaviour.
 */
export type Delivery = (title: string, message: string, urgency: string) => Promise<{ ok: boolean; detail?: string }>

export type NotifyDeps = { deliver?: Delivery }

// A factory returning hooks, not a Plugin -- see the note in ./agent-pool.ts.
export const notifyHooks = (async ({ client, directory }, _options?: unknown, deps: NotifyDeps = {}): Promise<Hooks> => {
  const notifier = new Notifier(COOLDOWN_MS)
  // Sessions this process has actually seen do work in. Distinguishes "finished
  // after a turn" from "an idle event for a session that was merely opened".
  const active = new Set<string>()
  // Latest known title per session. session.get is the authority and is always
  // consulted before notifying; this exists so an idle event racing the title
  // update still names the session rather than falling back to "session".
  const titles = new Map<string, string | undefined>()
  // Sessions with an unanswered question outstanding. A question parks the turn:
  // the user has been asked and the task cannot continue, which is a different
  // (and more urgent) reason to look than "finished". Tracked so the idle event
  // that follows a question does not also claim the task finished.
  const pending = new Set<string>()
  // Sessions with an unanswered PERMISSION request outstanding. Tracked
  // separately from `pending` rather than sharing the set, because the two have
  // independent lifecycles: a question can be answered while a permission is
  // still open, and one set would drop the other's block and let a parked
  // session announce itself as finished.
  const permissions = new Set<string>()
  let warnedHelper = false

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => {})

  const fetchInfo = async (sessionID: string) => {
    const info = await client.session
      .get({ path: { id: sessionID }, query: { directory } })
      .then((result) => result.data as SessionInfo | undefined)
      .catch(() => undefined)
    return info
  }

// A notification that fails to arrive is worse than one that never fired: the
  // user believes the agent finished and stops watching. So delivery is verified,
  // not assumed -- the helper's exit status and stderr are captured and logged, and
  // "notified" is only claimed when the helper actually succeeded.
  const deliverViaHelper = (title: string, message: string, urgency: string) =>
    new Promise<{ ok: boolean; detail?: string }>((resolve) => {
      const helper = findHelper()
      if (!helper) {
        if (!warnedHelper) {
          warnedHelper = true
          void log("warn", "no oc-notify helper found; run 'bin/oc-sync' to install one")
        }
        resolve({ ok: false, detail: "no oc-notify helper found" })
        return
      }
      // Detached and unref'd: a notification must never hold the server open.
      // stdio pipes (not ignore) because the helper's own diagnostics are the only
      // way a remote tunnel failure is ever visible -- oc-notify prints to stderr
      // and exits 0, so its output is the entire signal.
      const child = spawn(helper, helperArgv(helper, title, message, urgency, "utilities-terminal"), {
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      })
      let stderr = ""
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 400) stderr += String(chunk)
      })
      child.on("error", (error) => {
        void log("warn", `notification helper failed: ${String(error)}`, { title })
        resolve({ ok: false, detail: String(error) })
      })
      child.on("exit", (code) => {
        const noise = stderr.trim()
        // Two independent signals, because each has failed on its own: the helper's
        // exit code, and any text it wrote to stderr.
        //
        // The exit code is primary -- oc-notify propagates send_notify's status, and
        // the hop's real failure (ssh's "Permission denied (publickey,password)")
        // is a bare non-zero exit from ssh, which the tunnel's LogLevel=ERROR hides.
        // Matching on stderr text alone missed exactly that case and logged a
        // failed delivery as sent. Stderr is still treated as a failure, because a
        // successful send is silent and there is nothing benign for it to print.
        const ok = code === 0 && noise === ""
        if (!ok) {
          void log("warn", `notification not delivered: ${noise || `helper exit ${code}`}`, {
            title,
            message,
          })
        }
        resolve({ ok, detail: noise || undefined })
      })
      child.unref()
    })

  // The injected sender, when given, replaces the spawn above entirely. The
  // factory still does all the evaluating around it (suppression, cooldown,
  // ok/failed bookkeeping), so an injected sender observes exactly the
  // notifications a real desktop would have received -- nothing more, nothing less.
  const deliver: Delivery = deps.deliver ?? deliverViaHelper

  const announce = async (sessionID: string, outcome: Outcome, detail?: string) => {
    try {
      const info = await fetchInfo(sessionID)
      if (!info) {
        void log("debug", "session info unavailable; not notifying", { sessionID })
        return
      }
      // session.get is authoritative, but an idle event can arrive before the
      // title update lands; fall back to the last title this process saw rather
      // than announcing "session".
      const titled = info.title ? info : { ...info, title: titles.get(sessionID) }
      // isRemote mirrors what bin/oc decides for itself, so the message says the
      // useful thing: a remote session needs the tunnel, a local one does not.
      const isRemote = Boolean(process.env.SSH_CLIENT || process.env.SSH_TTY)
      const decision = shouldNotify({
        info: titled,
        outcome,
        detail,
        sawMessage: active.has(sessionID),
        // Either kind of block suppresses the idle event's "finished": a session
        // parked on a permission prompt has not finished, it is waiting.
        awaitingResponse: pending.has(sessionID) || permissions.has(sessionID),
      })
      if (!decision.notify) {
        void log("debug", `suppressed: ${decision.reason}`, { sessionID })
        return
      }
      // The cooldown absorbs a burst of identical notices. Three outcomes are
      // exempt, for the same reason: they report a session that is BLOCKED, and a
      // blocked session that is not announced is a silent stall.
      //   error      the failure is new; the cooldown may still be holding from the
      //              "busy" transition moments earlier
      //   question   a second question within the window is a second thing to answer,
      //              not a repeat of the first -- gating it strands the user on a
      //              prompt they were never told about
      //   permission likewise: a permission prompt the user never saw is the exact
      //              silent stall this plugin exists to prevent
      // All three record the timestamp so a follow-up is judged against what the
      // user has actually already seen.
      //
      // Keyed per outcome so a genuine later completion still notifies: a question
      // and the "finished" that follows it are different moments.
      const kind = decision.urgency === "critical" ? "error" : outcome === "done" ? "done" : outcome
      const key = `${kind}:${sessionID}`
      const blocking = kind !== "done"
      const now = Date.now()
      if (blocking) {
        notifier.record(key, now)
      } else if (!notifier.allow(key, now)) {
        void log("debug", "suppressed: cooldown", { sessionID })
        return
      }
      const message = isRemote ? `${decision.message} (remote)` : decision.message
      const sent = await deliver(decision.title, message, decision.urgency)
      // Claiming "notified" on a failed delivery is how this bug survived: the log
      // said notified five times while nothing reached the desktop. Only say it when
      // the helper confirmed, and say what failed when it did not.
      void log(sent.ok ? "info" : "error", sent.ok ? "notified" : "notification failed", {
        sessionID,
        outcome,
        title: decision.title,
        ...(sent.detail ? { detail: sent.detail } : {}),
      })
    } catch (error) {
      void log("error", `notify failed: ${String(error)}`)
    }
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.status") {
          // busy is the reliable "work is happening" signal. session.updated also
          // fires on a title change or a token-count refresh, which would mark a
          // session as active without any work having been done.
          const { sessionID, status } = event.properties
          if (status.type === "busy" && sessionID) active.add(sessionID)
          return
        }

        if (event.type === "session.updated") {
          // A title arrives here, and the notification is named after it, so
          // capture the latest. Not the marker of "work happened" -- see above.
          const info = event.properties.info as SessionInfo | undefined
          if (info?.id) titles.set(info.id, info.title)
          return
        }

        // question.asked is not in the pinned SDK's event types -- the runtime emits it
        // (verified against a live server) but types.gen.d.ts predates it. Reading
        // it off the event object is deliberate: the alternative is a plugin that
        // cannot see the most important thing an agent can do to you.
        if (event.type === "question.asked") {
          const properties = event.properties as {
            sessionID?: string
            questions?: Array<{ question?: string }>
          }
          const sessionID = properties?.sessionID
          if (!sessionID) return
          pending.add(sessionID)
          // A question is also proof of work, so it must not be suppressed by the
          // never-went-busy rule -- and if it was never seen busy, treat it as busy.
          active.add(sessionID)
          const headline = questionHeadline(properties.questions)
          void announce(sessionID, "question", headline || undefined)
          return
        }

        // The question was answered OR dismissed -- `rejected` is what the runtime
        // emits when it is dropped rather than answered, and it is the path that
        // would otherwise leave `pending` set forever, silently suppressing every
        // later "Task finished" for that session.
        //
        // Both are read off the wire rather than from the pinned types, for the same
        // reason as question.asked: the SDK types here predate these events.
        if (event.type === "question.replied" || event.type === "question.rejected") {
          const sessionID = (event.properties as { sessionID?: string })?.sessionID
          if (sessionID) pending.delete(sessionID)
          return
        }

        // The permission gap. Everything above was about a session handing control back
        // or asking a question; this is the other silent stall -- opencode blocks
        // on a permission decision and says nothing, which is why a directory
        // prompt used to look like a hung agent.
        //
        // The event is `permission.asked`, read off the wire deliberately, for
        // the same reason as question.asked: the pinned SDK types describe a
        // different thing. They offer `permission.updated` carrying a
        // `Permission` with `type`/`pattern`; this runtime emits
        // `permission.asked` carrying `permission`/`patterns`. `type` and
        // `pattern` appear nowhere in the binary, and the `permission.ask` HOOK
        // the SDK also declares is never triggered -- wiring a handler to it
        // would be dead code that reads as live coverage. See the field-by-field
        // derivation on PermissionRequest.
        //
        // This is a bus event, not that hook, which is also the security property:
        // there is no `output.status` here to perturb, so observing a prompt
        // cannot approve or deny it. The payload is only read.
        if (event.type === "permission.asked") {
          const properties = event.properties as PermissionRequest
          const sessionID = properties?.sessionID
          if (!sessionID) return
          permissions.add(sessionID)
          // A permission request is also proof of work, so it must not be
          // suppressed by the never-went-busy rule -- and if it was never seen
          // busy, treat it as busy.
          active.add(sessionID)
          void announce(sessionID, "permission", permissionHeadline(properties) || undefined)
          return
        }

        // The prompt was answered or dismissed. This deliberately does NOT
        // notify: the user asked to be told they are being asked, not what they
        // or opencode decided afterwards. It only clears the block, so the idle
        // event that follows is allowed to report real work as finished again.
        if (event.type === "permission.replied") {
          const sessionID = (event.properties as { sessionID?: string })?.sessionID
          if (sessionID) permissions.delete(sessionID)
          return
        }

        if (event.type === "session.error") {
          const sessionID = event.properties.sessionID
          // An error unblocks the session: whatever question was parked is no
          // longer what the user must act on.
          if (sessionID) {
            pending.delete(sessionID)
            permissions.delete(sessionID)
            // Only an unrecognized failure interrupts. Rate limits and quota
            // errors are the pool's to handle -- it cools the model and the
            // request retries -- and an abort is the user's own action, so
            // notifying for either would report something already handled.
            // The error field is not in the pinned SDK's event types, so it is
            // read off the wire with a narrow cast, like question.asked.
            const error = (event.properties as { error?: unknown }).error
            if (isUnrecognizedError(error)) {
              void announce(sessionID, "error", errorDetail(error))
            } else {
              void log("debug", "suppressed: recognized error", { sessionID })
            }
          }
          return
        }

        // Neither `active` nor `titles` may grow for the life of a long-running
        // server, and a deleted session must stop contributing to either.
        if (event.type === "session.deleted") {
          const sessionID = (event.properties as { info?: { id?: string } })?.info?.id
          if (sessionID) {
            active.delete(sessionID)
            titles.delete(sessionID)
            pending.delete(sessionID)
            permissions.delete(sessionID)
          }
          return
        }

        if (event.type !== "session.idle") return

        const sessionID = event.properties.sessionID
        if (sessionID) void announce(sessionID, "done")
      } catch (error) {
        void log("error", `handler failed: ${String(error)}`)
      }
    },
  }
})