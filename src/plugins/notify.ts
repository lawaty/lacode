import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import * as path from "node:path"
import type { Hooks } from "@opencode-ai/plugin"
import {
  NOTIFY_CLOSE_ENV,
  NOTIFY_OUTCOMES,
  NOTIFY_SESSION_ENV,
  PERMISSION_REPLIES,
  REQUEST_ID_ENV,
  Notifier,
  claimCompletion,
  claimNotification,
  errorDetail,
  helperArgv,
  isUnrecognizedError,
  markCompletion,
  permissionHeadline,
  questionHeadline,
  releaseCompletion,
  releaseNotificationClaim,
  shouldNotify,
  type Outcome,
  type PermissionReply,
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
// Sound rides along with the notification (US-15), on the same wire field the
// outcome already implies: four bundled WAVs, one per outcome, named after it --
// done, question, permission, error. So the sound says WHICH kind of thing
// happened even when the popup is out of sight, and nothing has to be translated
// per outcome here: the name goes out as the outcome.
//
// A popup the user is already looking past fades on its own. Once they answer a
// permission, answer a question, or type into that session's chat, the popup has
// said everything it is going to say -- the answer is on their screen already --
// so it closes itself instead of waiting for the X button. It never closes
// sooner than five seconds after it was raised, so it is always readable, and a
// popup nobody touched still waits for them (see --expire-time=0 in the helper).
//
// The close is the HELPER's job, never this file's: the popup lives on the
// desktop, and only the desktop knows the notification id. The helper already
// knows how to reach the desktop from wherever the plugin runs -- locally, or
// over the ssh tunnel -- so it is asked to close and it closes there. One code
// path, two topologies.
//
// ONE POPUP PER SESSION PER KIND: duplicate popups have two independent causes,
// both real:
//
//   * opencode raises ONE `permission.asked` per pattern it wants, and they
//     arrive together -- four file reads inside 300ms. A popup per request is
//     four identical popups, and clicking one of them answered one request
//     while the other three were answered by a 404 or not at all. So the
//     requests of a session are tracked as a SET: the first one raises the
//     popup, the ones that join it are covered by that popup, and the click
//     answers every one of them. The popup waits a moment for the batch to
//     form, so it can say how many requests it covers.
//
//   * opencode publishes its events through a shared store, so EVERY opencode
//     process on the machine sees the same event and would raise the same
//     popup. The cooldown is per PROCESS, so it never caught that. The claim
//     is the one-winner file that says "this process is the one raising it";
//     a process that loses it stays quiet. Our own claim never changes our
//     own behaviour, so one process does exactly what it did before.
//
// This module is a HOOK FACTORY, not a plugin -- see the note at the top of
// ./agent-pool.ts. It must export the factory and nothing else.

const SERVICE = "notify"
const COOLDOWN_MS = 5_000
// Bounds on the SPAWN, deliberately not on which notifications are decided.
//
// Question, permission and error outcomes bypass the notification cooldown on
// purpose -- three tests pin it, and the reason is right: a session blocked on a
// prompt the user was never told about is the exact silent stall this plugin
// exists to prevent. What that permits is an unbounded number of helper
// PROCESSES: each delivery spawns `bin/oc-notify` -> `bin/oc` -> an ssh attempt,
// so a failure storm can start one per event. A fire-and-forget helper is
// detached and unref'd, so nothing reaps it.
//
// So the bound goes here, on the transport, where it cannot suppress a decision
// the plugin already made. A delivery dropped by the cap is still logged, and the
// user's next notification arrives normally.
const MAX_INFLIGHT_HELPERS = 4
// An ssh hop to a machine that has gone away can sit there indefinitely. This is
// generous enough for a slow but working tunnel, and short enough that a dead
// one is not held for the life of the server.
const HELPER_TIMEOUT_MS = 30_000
// An actionable notification waits for the user, not for a timeout: the
// transport's own wait is ten minutes, so this must outlive it and the
// inner wait ends first, cleanly.
const ACTION_TIMEOUT_MS = 10 * 60_000 + 30_000
// Hard cap on the per-session bookkeeping (`active` / `titles` / `live`).
// `session.deleted` is the intended cleanup, but a long-running server must not
// depend on EVERY session being deleted to stay bounded -- an abandoned session
// may never emit it. Once past the cap the oldest session is forgotten; by then
// its idle events have long since fired, so forgetting it can only suppress a
// stale notification.
const MAX_TRACKED_SESSIONS = 500
// How long a popup must have been up before it may fade. The user is working in
// the chat, so the popup has said what it says -- but it still has to have been
// readable, so the floor is on the popup's OWN life, never on the moment the
// user answered.
const MIN_VISIBLE_MS = 5_000
// How long the plugin waits for a session's permission requests to pile up
// before it raises the popup.
//
// opencode raises ONE `permission.asked` per pattern it wants, and a single
// turn can raise four of them inside 300ms. A popup per request is four
// identical popups, and clicking one of them answered one request while the
// other three were answered by a 404 or not at all.
//
// So the first request of a session waits a moment for its siblings to arrive.
// The wait is short enough that a single prompt still feels immediate, and long
// enough that a burst is one popup: the popup then says how many requests it
// covers, and the click answers every one of them.
//
// The delay applies to the PERMISSION outcome only. Every other outcome is
// already a single event, and delaying it would delay a finished task for no
// reason.
const PERMISSION_SETTLE_MS = 250
// The placeholder a permission request without an id is tracked under.
//
// The request id is what a reply is addressed to, so a request that carries
// none cannot be answered -- but it is still an OUTSTANDING request: the user
// is being asked something, and the popup must still say so. It is tracked
// under this placeholder so the size of the set stays the number of asks, and
// it is skipped when the click answers the session's requests.
const UNANSWERABLE_REQUEST = ""

// The user's explicit off switch for notification sound. Deliberately NOT
// exported: this file may export the factory and nothing else (opencode calls
// every export of a plugins/ file as a plugin -- see the header), and the value
// the switch has is observable anyway, through what the deliver seam receives.
const SOUND_ENV = "LACODE_SOUND"
// The only spellings that mean "off". Anything else -- including an empty
// value, a typo, or a future flag someone assumes means on -- is NOT read as
// truthy: the user who never asked for silence must not get it from a misspelt
// variable.
const SOUND_OFF_VALUES = ["0", "false", "off", "no"]

// Where the notification helper lives, in order:
//   1. OC_NOTIFY_HELPER -- an explicit override, so a user can point at their own
//   2. ~/bin/lacode -- what a hand-made install of the CLI puts on PATH
//   3. dist/lacode.js -- the BUILT cli, which is all an npm install ships. The
//      shipped package carries compiled dist/, not TypeScript sources, so pointing at
//      the package's bin/lacode there would hand a broken helper to every
//      consumer: found, spawned, and dead on arrival with node refusing to strip
//      types under node_modules. The built CLI is the same program with the
//      types already gone -- but a different ENTRY: it takes a `notify`
//      subcommand, so its argv is built differently (see helperArgv below).
//   4. the package's own bin/lacode -- the author's checkout
//   5. ~/bin/oc-notify -- the bash helper, kept only as a last-resort fallback:
//      it execs bin/oc, whose OC_NOTIFY_ONLY path drops the sound name and has
//      no permission action-button plumbing
//   6. the package's own bin/oc-notify -- the author's checkout
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
    path.join(PACKAGE_ROOT, "dist", "lacode.js"),
    path.join(PACKAGE_ROOT, "bin", "lacode"),
    path.join(home, "bin", "oc-notify"),
    path.join(PACKAGE_ROOT, "bin", "oc-notify"),
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
 * Omit it and nothing changes: the default spawns `bin/oc-notify` -- detached
 * and unref'd, unless the notification waits for a click. This parameter is
 * additive and last, so every existing call site keeps its current behaviour.
 *
 * The fourth argument is the sound name -- an outcome, or "none" when the user
 * has switched sound off. It is appended last and typed as `string` so a sender
 * written before sounds existed still satisfies the type; an unknown name is the
 * receiver's to normalize, not this file's.
 *
 * The fifth argument is the permission request id, present only when the
 * notification is actionable. The returned `action` is the raw string the
 * transport read off the helper's stdout. It is untrusted: the plugin validates
 * it against PERMISSION_REPLIES before using it.
 *
 * The sixth argument is the session id -- the correlation key that says WHICH
 * popup this is. It is opaque: never shown to the user, never used to build a
 * command argument, and it travels to the helper in the environment. It is
 * optional and additive, so a sender written before it existed still satisfies
 * the type.
 */
export type Delivery = (
  title: string,
  message: string,
  urgency: string,
  sound: string,
  requestID?: string,
  sessionID?: string,
) => Promise<{ ok: boolean; detail?: string; action?: string }>

export type NotifyDeps = {
  deliver?: Delivery
  /**
   * Asks the desktop to close one session's popup. Omit it and the helper is
   * spawned with the session id in its environment; supply it and the
   * dismissal is observable without a desktop, a helper or a D-Bus session.
   */
  close?: (sessionID: string) => void
  maxInflightHelpers?: number
  helperTimeoutMs?: number
}

/**
 * One live popup: when it was raised, whether the user has shown they are
 * working in that session's chat, and the dismissal waiting to fire.
 */
type LivePopup = { raisedAt: number; interacted: boolean; timer?: NodeJS.Timeout }

/**
 * The plugin options this factory reads, narrowed from the loose value opencode
 * hands it -- the same cast agent-pool.ts and selfupdate.ts make. One field, and
 * it is opt-out: an absent option means the full behaviour.
 */
export type NotifyOptions = {
  /** Notification sounds. Absent (or anything but `false`) plays them. */
  sound?: boolean
}

// A factory returning hooks, not a Plugin -- see the note in ./agent-pool.ts.
export const notifyHooks = (async ({ client, directory }, options?: unknown, deps: NotifyDeps = {}): Promise<Hooks> => {
  // Overridable so a test can drive both bounds without waiting 30 seconds or
  // starting four real helpers. The defaults are what ship.
  const maxInflight = deps.maxInflightHelpers ?? MAX_INFLIGHT_HELPERS
  const helperTimeoutMs = deps.helperTimeoutMs ?? HELPER_TIMEOUT_MS
  // Sound on or off, decided ONCE and here, so the rest of the file works from a
  // plain boolean and never re-reads the environment: there is exactly one place
  // where "is sound on" is answered.
  //
  // Opt-OUT only, mirroring `selfUpdate: false` / LACODE_NO_SELFUPDATE (US-27).
  // Audio is audible in a shared room, and a feature that is off by default is a
  // feature nobody ever finds -- so the default is the full behaviour and the
  // toggle exists to turn it off.
  //
  // The environment beats the option, so a shell can mute a machine whose config
  // says otherwise; it is read first, trimmed and lowercased, and compared against
  // the four off-spellings and nothing else.
  const opts = (options ?? {}) as NotifyOptions
  const soundEnv = (process.env[SOUND_ENV] ?? "").trim().toLowerCase()
  const soundOn = !SOUND_OFF_VALUES.includes(soundEnv) && opts.sound !== false

  const notifier = new Notifier(COOLDOWN_MS)
  const instanceId = randomUUID()
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
  // Sessions with an unanswered PERMISSION request outstanding, and the ids of
  // those requests. Tracked separately from `pending` rather than sharing the
  // set, because the two have independent lifecycles: a question can be
  // answered while a permission is still open, and one set would drop the
  // other's block and let a parked session announce itself as finished.
  //
  // A MAP, not a set of session ids: one session can have SEVERAL requests
  // outstanding at once, and the set of ids is what makes the batch visible.
  // The first request of a session raises the popup, the ones that join it are
  // covered by that popup, and the click answers all of them.
  const permissions = new Map<string, Set<string>>()
  // The popup a session's first permission request is waiting to raise. One per
  // session: a session with a request outstanding already has a popup coming,
  // so a second one is never scheduled.
  const pendingPermissionPopups = new Map<string, NodeJS.Timeout>()
  // The live popup per session: when it was raised, whether the user has shown
  // they are working in that session's chat, and the dismissal waiting to
  // fire. Per-session like `active` and `titles`, and bounded the same way.
  const live = new Map<string, LivePopup>()
  let warnedHelper = false
  // Helpers currently running. Bounded by MAX_INFLIGHT_HELPERS; see that constant
  // for why the bound is on the spawn and not on the notification decision.
  let inflight = 0

  // The per-session stores that grow with every session seen; they are capped
  // so a long-running server cannot let them grow without bound. See MAX_TRACKED_SESSIONS.
  const rememberActive = (sessionID: string) => {
    active.add(sessionID)
    while (active.size > MAX_TRACKED_SESSIONS) active.delete(active.values().next().value as string)
  }
  const rememberTitle = (id: string, title: string | undefined) => {
    titles.set(id, title)
    while (titles.size > MAX_TRACKED_SESSIONS) titles.delete(titles.keys().next().value as string)
  }
  // The live popup is written through here too, never straight into the map,
  // so the bound AND the timer bookkeeping cannot be forgotten at a call site.
  const rememberLive = (sessionID: string, popup: LivePopup) => {
    // A dismissal still pending was armed against the PREVIOUS popup's
    // raisedAt, so it goes with the popup it belonged to: a stale timer would
    // hide the new one before it had its own five seconds.
    const previous = live.get(sessionID)
    if (previous?.timer) clearTimeout(previous.timer)
    live.set(sessionID, popup)
    while (live.size > MAX_TRACKED_SESSIONS) {
      const oldest = live.keys().next().value as string
      const forgotten = live.get(oldest)
      // Same for a forgotten session: its timer goes with it.
      if (forgotten?.timer) clearTimeout(forgotten.timer)
      live.delete(oldest)
    }
  }
  // A deleted session takes its popup with it, and its pending dismissal with
  // it too: a timer that fires for a session that is gone closes nothing.
  const forgetLive = (sessionID: string) => {
    const popup = live.get(sessionID)
    if (popup?.timer) clearTimeout(popup.timer)
    live.delete(sessionID)
  }
  // The outstanding permission requests of a session, written through here so
  // the bound cannot be forgotten at a call site -- exactly like `active`,
  // `titles` and `live`.
  const rememberPermissions = (sessionID: string, requests: Set<string>) => {
    permissions.set(sessionID, requests)
    while (permissions.size > MAX_TRACKED_SESSIONS) {
      const oldest = permissions.keys().next().value as string
      permissions.delete(oldest)
    }
  }
  // Drop ONE answered request from a session's outstanding set, and the
  // session itself when nothing is outstanding any more.
  //
  // The map entry goes when the set empties: `shouldNotify` asks whether the
  // session has something outstanding with `.has`, so a session left in the
  // map with an empty set would look parked for ever -- and a parked session's
  // completion is swallowed.
  const forgetPermission = (sessionID: string, requestID: string) => {
    const outstanding = permissions.get(sessionID)
    if (!outstanding) return
    outstanding.delete(requestID)
    if (outstanding.size === 0) permissions.delete(sessionID)
  }
  // The popup a session's permission batch is waiting to raise is cancelled
  // with the session: a popup about a session that is gone is a popup about
  // nothing.
  const forgetPermissionPopup = (sessionID: string) => {
    const timer = pendingPermissionPopups.get(sessionID)
    if (timer) clearTimeout(timer)
    pendingPermissionPopups.delete(sessionID)
  }

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => {})

  // Answer ONE permission request from a notification click.
  //
  // The action is the raw string the helper printed, so it is validated
  // against the server's vocabulary before it is forwarded. Every outcome is
  // logged and none is thrown: a failed reply must never escape the event
  // handler.
  const replyPermission = async (sessionID: string, requestID: string, response: PermissionReply) => {
    // A thrown error carries the status under `.cause` (the SDK's wrapper) or,
    // for a caller that threw the response itself, under `.response`/`.status`.
    const errorStatus = (error: unknown): number | undefined => {
      const candidate = error as { status?: unknown; response?: { status?: unknown }; cause?: { status?: unknown } } | null | undefined
      const status = candidate?.response?.status ?? candidate?.cause?.status ?? candidate?.status
      return typeof status === "number" ? status : undefined
    }
    const reply = await client
      .postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID: requestID },
        body: { response },
      })
      .then((result) => ({ result }))
      .catch((error: unknown) => ({ error }))
    const status = "result" in reply ? reply.result.response?.status : errorStatus(reply.error)
    if (status === 404) {
      // Already answered elsewhere -- most often in the terminal. Not a failure.
      void log("debug", "permission already answered", { sessionID, requestID })
      // It IS answered, though, so it is not outstanding any more.
      forgetPermission(sessionID, requestID)
      return
    }
    if ("error" in reply) {
      void log("warn", `permission reply failed: ${errorDetail(reply.error) ?? String(reply.error)}`, {
        sessionID,
        requestID,
      })
      return
    }
    if (reply.result.error) {
      void log("warn", `permission reply failed: ${errorDetail(reply.result.error) ?? String(reply.result.error)}`, {
        sessionID,
        requestID,
      })
      return
    }
    // The request is answered, so it is not outstanding any more. The runtime
    // says so as well, with `permission.replied`, but a set that waits for
    // that event keeps a session looking parked when the event never comes --
    // and a parked session's completion is swallowed.
    forgetPermission(sessionID, requestID)
    void log("info", "permission answered from the notification", { sessionID, requestID, response })
  }

  // Answer the permissions of a session from a notification click.
  //
  // EVERY outstanding request of the session is answered, not only the one the
  // popup carries: the popup covers the whole batch -- that is why it says how
  // many requests it covers -- so the click answers the batch. `once` allows
  // each of them once, `always` allows each pattern permanently, `reject`
  // denies each. The values are the server's own; the plugin invents none.
  //
  // A request already answered in the terminal comes back as a 404, which is a
  // debug line and not a failure.
  const answerPermission = async (sessionID: string, requestIDs: string[], action: string) => {
    const response = PERMISSION_REPLIES.find((candidate) => candidate === action) as PermissionReply | undefined
    if (!response) {
      void log("warn", `notification action ignored: ${JSON.stringify(action)} is not a permission reply`, {
        sessionID,
        requestIDs,
      })
      return
    }
    for (const requestID of requestIDs) {
      await replyPermission(sessionID, requestID, response)
    }
  }

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
  const deliverViaHelper = (title: string, message: string, urgency: string, sound: string, requestID?: string, sessionID?: string) =>
    new Promise<{ ok: boolean; detail?: string; action?: string }>((resolve) => {
      // The cap, before anything is spawned. Settled exactly once on every path
      // below, so the count can never drift upward and wedge the transport shut.
      if (inflight >= maxInflight) {
        void log("warn", `notification dropped: ${inflight} helpers already in flight`, { title })
        resolve({ ok: false, detail: `too many notification helpers in flight (${inflight})` })
        return
      }
      const helper = findHelper()
      if (!helper) {
        if (!warnedHelper) {
          warnedHelper = true
          void log("warn", "no oc-notify helper found; run 'bin/oc-sync' to install one")
        }
        resolve({ ok: false, detail: "no oc-notify helper found" })
        return
      }
      // Without a request id the notification is fire-and-forget: detached and
      // unref'd, so it can never hold the server open. stdio pipes (not ignore)
      // because the helper's own diagnostics are the only way a remote tunnel
      // failure is ever visible -- oc-notify prints to stderr and exits 0, so its
      // output is the entire signal.
      //
      // With a request id it is actionable: the transport waits for the user to
      // click, so the child stays attached, its stdout is read for the chosen
      // button, and it must not be unref'd -- the plugin is waiting on it.
      //
      // Sound last, matching the payload's own field order (TITLE, MESSAGE,
      // URGENCY, ICON, SOUND) -- helperArgv puts it in the same slot for both
      // helper CLIs, so there is no per-transport decision left to make here.
      //
      // The correlation key travels in the ENVIRONMENT, never in the argv: the
      // helper's argv is a published contract (five fields, two CLIs) and the
      // session id is plugin bookkeeping that must not cost it one. It is
      // ABSENT, not empty, when there is no session -- an empty value would be
      // a different thing, and the helper must be able to tell "no session"
      // from a session whose id is the empty string, which does not exist.
      const childEnv = { ...process.env, ...(sessionID ? { [NOTIFY_SESSION_ENV]: sessionID } : {}) }
      const actionable = Boolean(requestID)
      const timeoutMs = actionable ? ACTION_TIMEOUT_MS : helperTimeoutMs
      const child = actionable
        ? spawn(helper, helperArgv(helper, title, message, urgency, "utilities-terminal", sound), {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
            env: { ...childEnv, [REQUEST_ID_ENV]: requestID },
          })
        : spawn(helper, helperArgv(helper, title, message, urgency, "utilities-terminal", sound), {
            stdio: ["ignore", "ignore", "pipe"],
            detached: true,
            env: childEnv,
          })
      inflight++
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: { ok: boolean; detail?: string; action?: string }) => {
        if (settled) return
        settled = true
        inflight--
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      // A hop to a machine that is gone must not hold its slot forever. Killed,
      // not merely abandoned: the helper is its own process, so leaving it
      // running is what the timeout exists to prevent. An actionable helper gets
      // the longer bound, because it is waiting on a human decision.
      timer = setTimeout(() => {
        try { child.kill("SIGKILL") } catch {}
        void log("warn", `notification helper timed out after ${timeoutMs}ms`, { title })
        finish({ ok: false, detail: `helper timed out after ${timeoutMs}ms` })
      }, timeoutMs)
      timer.unref?.()
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < 400) stdout += String(chunk)
      })
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 400) stderr += String(chunk)
      })
      child.on("error", (error) => {
        void log("warn", `notification helper failed: ${String(error)}`, { title })
        finish({ ok: false, detail: String(error) })
      })
      child.on("exit", (code) => {
        const noise = stderr.trim()
        // Two independent signals, because each has failed on its own: the helper's
        // exit code, and any text it wrote to stderr.
        //
        // The exit code is primary -- oc-notify propagates send_notify's status, and
        // the hop's real failure (ssh's "Permission denied (publickey,password)") is
        // a bare non-zero exit from ssh, which the tunnel's LogLevel=ERROR hides.
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
        // An empty stdout means the user dismissed the popup without choosing.
        const action = actionable ? stdout.trim() : ""
        finish({ ok, detail: noise || undefined, ...(action ? { action } : {}) })
      })
      if (!actionable) child.unref()
    })

  // The injected sender, when given, replaces the spawn above entirely. The
  // factory still does all the evaluating around it (suppression, cooldown,
  // ok/failed bookkeeping), so an injected sender observes exactly the
  // notifications a real desktop would have received -- nothing more, nothing less.
  const deliver: Delivery = deps.deliver ?? deliverViaHelper

  // The dismissal goes through the HELPER, never through D-Bus from here: the
  // popup lives on the desktop -- locally, or on the desktop at the far end of
  // the ssh tunnel -- and only the desktop knows the notification id. The helper
  // already knows how to reach the desktop from wherever this plugin runs, so
  // it is asked to close and it closes there.
  //
  // Fire-and-forget: detached and unref'd, so a dismissal can never hold the
  // server open. It is NOT counted against the in-flight helper cap -- it is not
  // a notification, and dropping one would leave a popup on screen for good.
  //
  // The correlation key travels in the ENVIRONMENT. It is opaque: never shown,
  // never used to build an argument.
  //
  // The argv below carries no information: the helper answers the close
  // request from the environment and sends nothing. It is still a well-formed
  // notification argv -- the `lacode` CLI refuses an empty title outright, and
  // a close that never reaches the helper closes nothing -- so the title is a
  // placeholder and the rest is empty.
  const closeViaHelper = (sessionID: string) => {
    try {
      const helper = findHelper()
      if (!helper) {
        if (!warnedHelper) {
          warnedHelper = true
          void log("warn", "no oc-notify helper found; run 'bin/oc-sync' to install one")
        }
        return
      }
      const child = spawn(helper, helperArgv(helper, "opencode", "", "normal", "utilities-terminal", "none"), {
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
        env: { ...process.env, [NOTIFY_CLOSE_ENV]: sessionID },
      })
      child.on("error", (error) => {
        void log("warn", `notification close failed: ${String(error)}`, { sessionID })
      })
      child.on("exit", (code) => {
        // A close that fails is not an error the user needs to see: the popup
        // stays, and nothing else changes.
        if (code !== 0) void log("warn", `notification not closed: helper exit ${code}`, { sessionID })
      })
      child.unref()
    } catch (error) {
      void log("warn", `notification close failed: ${String(error)}`, { sessionID })
    }
  }

  // The injected closer, when given, replaces the spawn above entirely -- the
  // same seam shape as `deliver`, so a test can watch a dismissal happen
  // without a desktop, a helper or a D-Bus session.
  const close: (sessionID: string) => void = deps.close ?? closeViaHelper

  // Fade one session's popup. The plugin only asks; the helper closes, locally
  // or over the hop.
  const dismiss = (sessionID: string) => {
    const popup = live.get(sessionID)
    if (!popup) return
    if (popup.timer) {
      clearTimeout(popup.timer)
      popup.timer = undefined
    }
    // The popup's five seconds are spent, so the clock restarts here. The
    // `interacted` flag belongs to the popup it was set on: a new popup starts
    // un-interacted and only fades if the user interacts while it is live.
    popup.raisedAt = Date.now()
    const failed = (error: unknown) => void log("warn", `notification dismiss failed: ${String(error)}`, { sessionID })
    try {
      // The closer is typed as void, but an injected one may be async -- and a
      // rejected promise must never escape as an unhandled rejection, which
      // would take the server down with it.
      const outcome = close(sessionID) as unknown as Promise<void> | undefined
      if (outcome && typeof outcome.catch === "function") void outcome.catch(failed)
    } catch (error) {
      failed(error)
    }
  }

  // Arm the dismissal for a session's popup.
  //
  // The five-second rule: the popup hides at max(now, raisedAt + MIN_VISIBLE_MS)
  // -- five seconds after it was shown, or immediately if that moment has
  // already passed. `raisedAt` is the LATEST notification's time for that
  // session, so no popup is ever hidden before five seconds of its own life.
  //
  // Nothing happens for a session with no popup, and nothing happens for one
  // whose dismissal is already armed: a second signal must not push the popup
  // earlier.
  const scheduleDismiss = (sessionID: string) => {
    const popup = live.get(sessionID)
    if (!popup) return
    if (popup.timer) return
    const delay = Math.max(0, popup.raisedAt + MIN_VISIBLE_MS - Date.now())
    const timer = setTimeout(() => dismiss(sessionID), delay)
    // Unref'd, like every other timer in this file: a popup's lifetime is
    // never a reason to hold the server open.
    timer.unref?.()
    popup.timer = timer
  }

  // The user is working in this session's chat directly: they answered a
  // permission, they answered or dropped a question, or they typed. The popup
  // has said everything it is going to say -- they are looking at the answer --
  // so it may fade.
  //
  // The session merely going busy is NOT one of those signals: the runtime
  // raises `busy` when the session starts executing, so a retry or an
  // automatic continuation would close a popup the user never read.
  const noteInteraction = (sessionID: string) => {
    const popup = live.get(sessionID)
    if (!popup) return
    popup.interacted = true
    scheduleDismiss(sessionID)
  }

  // The claim's release, one timer per (session, kind).
  //
  // The window is the same five seconds the cooldown uses, so the claim is
  // never held longer than the thing it mirrors. The timer is unref'd, like
  // every other timer in this file: a claim's lifetime is never a reason to
  // hold the server open.
  //
  // ONE timer per claim, not one per notification: the claim is a single file,
  // and a second timer would delete a claim this process has since taken
  // again.
  const claimReleases = new Map<string, NodeJS.Timeout>()
  const scheduleClaimRelease = (sessionID: string, kind: string) => {
    const key = `${kind}:${sessionID}`
    if (claimReleases.has(key)) return
    const timer = setTimeout(() => {
      claimReleases.delete(key)
      releaseNotificationClaim(sessionID, kind)
    }, COOLDOWN_MS)
    timer.unref?.()
    claimReleases.set(key, timer)
  }

  // Raise the popup for a session's permission requests, once the batch has had
  // a moment to form.
  //
  // The request id that travels on the notification is the FIRST request's: it
  // is what makes the popup actionable, and the click answers every
  // outstanding request of that session -- not only that one.
  //
  // If the session's outstanding set is empty by the time the wait is over,
  // nothing is raised at all: the user answered in the terminal, and a popup
  // about a request that is no longer open is noise.
  const raisePermissionPopup = (sessionID: string, requestID: string | undefined, headline: string) => {
    // Any earlier wait for this session is cancelled first. It was waiting for
    // a batch that is gone, and letting it fire as well would raise the popup
    // twice for the same session.
    forgetPermissionPopup(sessionID)
    const timer = setTimeout(() => {
      // A wait that was superseded never raises anything.
      if (pendingPermissionPopups.get(sessionID) !== timer) return
      pendingPermissionPopups.delete(sessionID)
      const outstanding = permissions.get(sessionID)
      if (!outstanding || outstanding.size === 0) return
      // One request says WHAT is being asked for. Several say HOW MANY there
      // are: the popup covers the batch, and naming one of several asks would
      // misdescribe the others.
      const detail = outstanding.size > 1 ? `${outstanding.size} requests` : headline
      void announce(sessionID, "permission", detail || undefined, requestID)
    }, PERMISSION_SETTLE_MS)
    // Unref'd, like every other timer in this file: a popup's lifetime is
    // never a reason to hold the server open.
    timer.unref?.()
    pendingPermissionPopups.set(sessionID, timer)
  }

  const announce = async (sessionID: string, outcome: Outcome, detail?: string, requestID?: string) => {
    try {
      const info = await fetchInfo(sessionID)
      if (!info) {
        void log("debug", "session info unavailable; not notifying", { sessionID })
        return
      }
      // session.get is authoritative, but an idle event can arrive before the
      // title update lands; fall back to the last title this process saw rather
      // than announcing "session".
      const titled = { ...info, title: info.title ?? titles.get(sessionID), directory: info.directory ?? directory }
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
        requestID,
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
      // Cross-process dedupe. Two mechanisms, chosen by outcome:
      //
      //   * done: a per-session completion marker held until the session goes
      //     busy again (a new turn) or is deleted. It is a marker, not a lock:
      //     any existing file suppresses, whatever pid it names and however old
      //     it is, so a repeat done and the done that follows an error in the
      //     same turn both stay quiet.
      //   * error: keeps the original 5 s cross-process claim (every distinct
      //     error announces; the claim's same-pid "ours" exemption is why two
      //     errors in one process both notify), and overwrites the completion
      //     marker so a following done stays quiet.
      //   * question / permission: the original 5 s claim, because a blocked
      //     session must announce promptly.
      //
      // opencode publishes its events through a shared store, so EVERY
      // opencode process on this machine that has this plugin loaded sees the
      // same event and would raise the same popup: two processes, one event,
      // the identical popup twice, seconds apart. The cooldown above cannot
      // catch that -- it is per process.
      //
      // The claim/marker is taken AFTER the cooldown and BEFORE the popup is
      // recorded and delivered: a process that lost it must not record a popup
      // it never raised, and must not deliver one.
      //
      // Our own claim never changes our own behaviour for question/permission,
      // so a single process does exactly what it did before for those. The done
      // marker is different: it deliberately suppresses a same-process repeat.
      if (outcome === "done") {
        if (!claimCompletion(sessionID, "done")) {
          void log("debug", "suppressed: completion already announced", { sessionID })
          return
        }
      } else if (!claimNotification(sessionID, kind, instanceId)) {
        void log("debug", "suppressed: another process is raising this", { sessionID, kind })
        return
      } else if (outcome === "error") {
        // An error always announces, but it marks the turn so the done that follows
        // it in the same turn stays quiet.
        markCompletion(sessionID, "error")
      }
      const message = isRemote ? `${decision.message} (remote)` : decision.message
      // The outcome IS the sound name: four outcomes, four bundled WAVs, one each,
      // so there is nothing to translate. The membership test is the guard for a
      // future fifth outcome -- silence until it has a WAV, rather than a name the
      // receiver would have to reject. With the toggle off the sound is "none",
      // which is the whitelist's own word for play nothing.
      const sound = soundOn && NOTIFY_OUTCOMES.includes(outcome) ? outcome : "none"
      // The popup this notification raises is live from here on. Recorded
      // BEFORE the delivery, because the delivery is what puts it on the
      // screen, and the record is what lets a later interaction in the TUI
      // fade it.
      //
      // `interacted` belongs to the popup it was set on: a new popup starts
      // un-interacted and only fades if the user interacts while it is live.
      const popup: LivePopup = { raisedAt: Date.now(), interacted: false }
      rememberLive(sessionID, popup)
      // A session the user is working in directly does not need its popups to
      // wait for the X button. This one still gets its own five seconds, so the
      // dismissal is armed against THIS notification's raisedAt -- which is why
      // the previous one was dropped when the record was replaced.
      if (popup.interacted) scheduleDismiss(sessionID)
      // The initial value is for the compiler only: a delivery that throws
      // never reaches the lines below it.
      let sent: { ok: boolean; detail?: string; action?: string } = { ok: false }
      try {
        sent = await deliver(decision.title, message, decision.urgency, sound, requestID, sessionID)
      } catch (error) {
        if (outcome === "done" || outcome === "error") releaseCompletion(sessionID)
        throw error
      } finally {
        if (outcome !== "done") scheduleClaimRelease(sessionID, kind)
      }
      if ((outcome === "done" || outcome === "error") && !sent.ok) releaseCompletion(sessionID)
      // An actionable notification only returns once the user clicks or the wait
      // ends, so an action means the click answered the permission. With no action
      // the popup was raised and dismissed without a choice, which is still a
      // delivery.
      if (sent.action && requestID) {
        // The click answers EVERY outstanding request of this session, not only
        // the one the popup carries: the popup covers the whole batch -- that
        // is why it says how many requests it covers -- so the batch is what
        // the user answered. A request without an id cannot be addressed, and
        // is left out.
        const outstanding = permissions.get(sessionID)
        const ids = outstanding ? [...outstanding].filter((id) => id !== UNANSWERABLE_REQUEST) : []
        await answerPermission(sessionID, ids.length > 0 ? ids : [requestID], sent.action)
      }
      // Claiming "notified" on a failed delivery is how this bug survived: the log
      // said notified five times while nothing reached the desktop. Only say it when
      // the helper confirmed, and say what failed when it did not.
      const answered = Boolean(sent.action)
      void log(answered || sent.ok ? "info" : "error", answered ? "permission answered from the notification" : sent.ok ? "notified" : "notification failed", {
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
          if (status.type === "busy" && sessionID) {
            rememberActive(sessionID)
            releaseCompletion(sessionID)
            // NOT an interaction. The runtime raises `busy` whenever the
            // session STARTS EXECUTING -- a retry, a resumption, an automatic
            // continuation -- so it says the machine is working, not that
            // the user is in the chat. Reading it as "the user typed" let a
            // machine-driven retry close a popup nobody had read; the
            // signal that means the user is there is their own message
            // (below).
          }
          return
        }

        // The user typed in this session's chat.
        //
        // The runtime publishes every message with its role, so a USER
        // message is the signal that the user is in that chat -- and the
        // only one that says so. `session.status: busy` is not: it says the
        // session started executing, which a retry or an automatic
        // continuation does without the user.
        if (event.type === "message.updated") {
          const info = event.properties.info
          if (info?.role === "user" && info.sessionID) noteInteraction(info.sessionID)
          return
        }

        if (event.type === "session.updated") {
          // A title arrives here, and the notification is named after it, so
          // capture the latest. Not the marker of "work happened" -- see above.
          const info = event.properties.info as SessionInfo | undefined
          if (info?.id) rememberTitle(info.id, info.title)
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
          rememberActive(sessionID)
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
          if (sessionID) {
            pending.delete(sessionID)
            // The question was answered (or dropped) in the TUI: the user is
            // looking at the answer, so the popup may fade.
            noteInteraction(sessionID)
          }
          return
        }

        // The permission gap. Everything above was about a session handing control back
        // or asking a question; this is the other silent stall -- opencode blocks
        // on a permission decision and says nothing, which is why a directory
        // prompt is not treated as a hung agent.
        //
        // The event is `permission.asked`, read off the wire deliberately: the
        // pinned SDK types offer `permission.updated` with `type`/`pattern`
        // (neither appears in the binary), while this runtime emits
        // `permission.asked` with `permission`/`patterns`, and the
        // `permission.ask` HOOK is never triggered, so a handler on it would be
        // dead code that reads as live coverage.
        //
        // A bus event, not that hook, so the payload is only read: the hook's
        // `output.status` IS the decision, and deciding a prompt in a handler
        // is not answering the one the user was asked for. The answer is the
        // user's: the request id rides on the notification, a click is
        // forwarded to the server's own reply route, the plugin never picks
        // one, and a dismissed popup answers nothing.
        //
        // opencode raises ONE request per pattern it wants, and they arrive
        // together -- four file reads inside 300ms. So the requests of a
        // session are tracked as a SET, and only the first one raises a popup:
        // the popup that is up (or on its way) covers the ones that join it,
        // and the click answers every one of them.
        if (event.type === "permission.asked") {
          const properties = event.properties as PermissionRequest
          const sessionID = properties?.sessionID
          if (!sessionID) return
          // The request id is what a reply is addressed to, so it is carried on
          // the notification rather than shown to the user.
          const requestID = typeof properties?.id === "string" && properties.id ? properties.id : undefined
          const outstanding = permissions.get(sessionID) ?? new Set<string>()
          // The first request of this session: nothing was outstanding before.
          const first = outstanding.size === 0
          // A request without an id cannot be replied to, but it is still an
          // outstanding request, so it is tracked under the placeholder.
          outstanding.add(requestID ?? UNANSWERABLE_REQUEST)
          rememberPermissions(sessionID, outstanding)
          // A permission request is also proof of work, so it must not be
          // suppressed by the never-went-busy rule -- and if it was never seen
          // busy, treat it as busy.
          rememberActive(sessionID)
          // The popup that is already up -- or already on its way -- covers
          // this request. The user is told once, and the click answers them
          // all.
          if (!first) return
          // The first request waits a moment for its siblings, so the popup
          // can say how many requests it covers.
          raisePermissionPopup(sessionID, requestID, permissionHeadline(properties))
          return
        }

        // The prompt was answered or dismissed. This deliberately does NOT
        // notify: the user asked to be told they are being asked, not what they
        // or opencode decided afterwards. It only clears the block, so the idle
        // event that follows is allowed to report real work as finished again.
        if (event.type === "permission.replied") {
          const sessionID = (event.properties as { sessionID?: string })?.sessionID
          if (sessionID) {
            // The request id is read off the wire with a narrow cast, like
            // question.asked -- and the FIELD NAME follows the runtime, not
            // the typing. The runtime publishes `requestID` (the package's
            // own v2 types say so), while the pinned v1 SDK typing still
            // calls that field `permissionID`. The stale typing is why the
            // cast is here; the runtime is why the name is `requestID`.
            const requestID = (event.properties as { requestID?: string })?.requestID
            // Only THAT request is answered. The others of the batch are still
            // outstanding, so the session stays parked until they are answered
            // too. An event without an id cannot say which one it was, so the
            // whole batch is cleared -- that is the old behaviour, and it is
            // the safe direction: a session that looks parked swallows its own
            // completion.
            if (requestID) forgetPermission(sessionID, requestID)
            else permissions.delete(sessionID)
            // The prompt was answered in the TUI, so the popup is no longer
            // needed and may fade.
            noteInteraction(sessionID)
          }
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
            // Its popup goes with it, and so does the dismissal waiting to
            // close it: the session is gone, so there is nothing to fade.
            forgetLive(sessionID)
            // And so does the permission popup still waiting to be raised: a
            // popup about a session that no longer exists is a popup about
            // nothing.
            forgetPermissionPopup(sessionID)
            releaseCompletion(sessionID)
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