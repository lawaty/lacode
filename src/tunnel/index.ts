// Portable notification transport.
//
// This is the GENERIC part of the author's `bin/oc` tunnel, extracted so it is
// not welded to one person's SSH topology, one systemd unit per host, or one
// per-host marker file. Those stay in `bin/oc*` and keep working exactly as
// before; nothing in the published package depends on them.
//
// What is portable is the shape:
//   * a notification is either local (notify straight to the desktop session) or
//     remote (hand it to the desktop over an SSH reverse forward),
//   * the hop passes ONE self-delimiting argument, never a shell string: ssh
//     concatenates everything after the host into a single command string and a
//     forced command is started with NO positional parameters, so separate
//     arguments cannot survive the hop and one delimited blob can,
//   * the only value interpolated into a notify-send call is the icon, and that
//     is checked against a whitelist,
//   * the LOCAL channel is chosen by process.platform and by what is installed,
//     never by guessing, and the text is handed to it as arguments rather than
//     spliced into a command (US-26),
//   * everything degrades. An unreachable remote, a missing key, a missing
//     notifier: all of them return a result, none of them throw, and the
//     fire-and-forget path exits 0 regardless (US-14). A notification that
//     cannot be delivered must never be able to fail the thing that tried to
//     deliver it -- an agent must not go down because a laptop went to sleep.
//
// Nothing here knows how the tunnel is established. Configure it with the
// environment (OC_LOCAL_USER, OC_TUNNEL_PORT, OC_NOTIFY_KEY) or by passing a
// TunnelConfig; there is no discovery, no system probing, and no writes.

import { homedir } from "node:os"
import { join } from "node:path"
import { NOTIFY_CLOSE_ENV, NOTIFY_SESSION_ENV } from "../lib/notify.ts"
import { exec, have } from "../lib/notify-adapter/exec.ts"
import { closeCorrelationKey } from "../lib/notify-adapter/ids.ts"
import { ACTION_WAIT_MS, NOTIFICATION_ACTIONS } from "../lib/notify-adapter/adapters/freedesktop.ts"
import { selectAdapter } from "../lib/notify-adapter/registry.ts"
import { describeNotify } from "../lib/notify-adapter/doctor.ts"
import { playSound } from "../lib/notify-adapter/sound.ts"
import {
  normalizeIcon,
  normalizeSound,
  normalizeUrgency,
  presentCorrelationKey,
  safeMessage,
  safeRequestId,
  safeTitle,
  wireCorrelationKey,
} from "../lib/notify-adapter/text.ts"
import type { LocalChannel, NotifyRequest, Result } from "../lib/notify-adapter/types.ts"

// The notification state directory and the safe-key rule live in lib/notify.ts
// now: the plugin needs them too, and `src/plugins/*` may import `src/lib/*`
// only. They are re-exported here because this module's published surface has
// always carried them, and `dist/tunnel.js` is a published entry point.
export { notificationIdFile, notificationStateDir, safeCorrelationKey } from "../lib/notify.ts"
// The shared execution/probe/sound primitives moved into the adapter layer.
// They are re-exported so every existing import from `dist/tunnel.js` keeps
// working -- that published surface may not change.
export { resetNotifyIdFdSupport, supportsNotifyIdFd } from "../lib/notify-adapter/probe.ts"
export { soundChannel } from "../lib/notify-adapter/sound.ts"
export { isNotificationId, closeNotification, closeCorrelationKey } from "../lib/notify-adapter/ids.ts"
export type { Urgency, Icon, Sound, NotifyRequest, Result, LocalChannel } from "../lib/notify-adapter/types.ts"
// The shared text/normalization/whitelist helpers moved into the adapter layer.
// They are re-exported so every existing import from `dist/tunnel.js` keeps
// working -- that published surface may not change. `safeText`,
// `wireCorrelationKey` and `presentCorrelationKey` were never exported and stay
// private to the transport's internals.
export { ICONS, SOUNDS, normalizeUrgency, normalizeIcon, normalizeSound, safeTitle, safeMessage, safeRequestId } from "../lib/notify-adapter/text.ts"

export type TunnelConfig = {
  /** The desktop user the direct ssh hop authenticates as. */
  user: string
  /** The desktop host a direct ssh reaches. Empty selects the legacy reverse-forward port path. */
  host: string
  /** Port the legacy reverse forward is listening on, local side. Unused when `host` is set. */
  port: number
  /** Dedicated key. Never a personal key: this one is restricted to notifying. */
  key: string
  /** Hard ceiling on the hop. A silent remote must not hold the caller. */
  connectTimeoutMs: number
}

/**
 * Every value has a default so a caller that knows nothing still gets something
 * that works locally. Reading them from the environment (rather than probing
 * `id -un`, or a per-host marker file) is what keeps this portable: on a remote
 * account `id -un` is frequently root, which is never the desktop user.
 */
export function resolveTunnel(env: NodeJS.ProcessEnv = process.env): TunnelConfig {
  const port = Number(env.OC_TUNNEL_PORT)
  return {
    user: env.OC_LOCAL_USER ?? "",
    host: env.OC_LOCAL_HOST ?? "",
    port: Number.isFinite(port) && port > 0 ? port : 10022,
    key: env.OC_NOTIFY_KEY ?? join(homedir(), ".ssh", "lacode_notify"),
    connectTimeoutMs: Number(env.OC_CONNECT_TIMEOUT_MS) || 5000,
  }
}

/** True when this process is running on the other end of an SSH connection. */
export function isRemote(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CLIENT || env.SSH_TTY)
}

/**
 * The marker that turns a correlation key into a CLOSE request.
 *
 * It travels as a prefix of the payload's seventh field, so the far end can
 * tell "raise a popup for this session" from "take the popups of this session
 * down" without a second field and without changing the field count.
 */
export const CLOSE_REQUEST_PREFIX = "close:"

/**
 * Whether a correlation key is a close request rather than a session.
 *
 * One rule, shared: the sender marks a close request in the payload's seventh
 * field and the receiver reads that same field with this same test. Both ends
 * have to agree on it, so it lives in one place.
 */
export const isCloseRequest = (correlationKey: string | undefined): boolean =>
  typeof correlationKey === "string" && correlationKey.startsWith(CLOSE_REQUEST_PREFIX)

/**
 * The session a close request names, or undefined when the field is not a
 * close request.
 */
export const closeRequestTarget = (correlationKey: string | undefined): string | undefined => {
  if (!isCloseRequest(correlationKey)) return undefined
  const target = correlationKey?.slice(CLOSE_REQUEST_PREFIX.length).trim() ?? ""
  return target ? target : undefined
}

/** The delimiter `encodePayload` joins fields with. Also what the receiver splits on. */
export const FIELD_SEPARATOR = "\n"

/**
 * One argument, seven newline-delimited fields:
 * `title\nmessage\nurgency\nicon\nsound\nrequestID\ncorrelationKey`.
 *
 * The single-argument shape is not a style choice, it is what the transport
 * actually provides. ssh concatenates everything after the host into ONE command
 * string and hands it to the forced command in $SSH_ORIGINAL_COMMAND with zero
 * positional parameters -- verified against OpenSSH 10.5: `ssh host -- a b c d`
 * yields `ARGC=0`. A four-argument sender therefore arrived as the single string
 * `"a b c d"`, which the receiving end could only read as one field, so every
 * field fell back to its default and the popup was blank.
 *
 * Newline is the delimiter because `safeText` above strips every control
 * character (including \n) from both free-text fields, the icon, urgency
 * and sound are whitelisted values, and `safeRequestId` strips them from the
 * request id. No field can contain the delimiter, so the split is lossless for
 * a body containing spaces, quotes or glob characters.
 *
 * The seventh field is the correlation key and it is EMPTY when there is none,
 * so the field count never changes: a six-field payload from an older sender
 * still parses, and a seven-field payload still reaches an older receiver,
 * which ignores the field it does not know.
 */
/**
 * The inverse of `encodePayload`: the newline-delimited payload a forced command
 * reads from $SSH_ORIGINAL_COMMAND. Fields are sanitized again here, at the trust
 * boundary, rather than assumed from the sender.
 */
export function parsePayload(raw: string): NotifyRequest {
  const [title, message, urgency, icon, sound, requestID, correlationKey] = raw.split(FIELD_SEPARATOR)
  const key = wireCorrelationKey(correlationKey)
  return {
    title: safeTitle(title),
    message: safeMessage(message),
    urgency: normalizeUrgency(urgency),
    icon: normalizeIcon(icon),
    sound: normalizeSound(sound),
    requestID: safeRequestId(requestID),
    // The seventh field, empty when there is none. A close request keeps its
    // marker here, so the receiver can still tell it apart from a session.
    ...(key ? { correlationKey: key } : {}),
  }
}

export const encodePayload = (request: NotifyRequest): string =>
  [
    safeTitle(request.title),
    safeMessage(request.message),
    normalizeUrgency(request.urgency),
    normalizeIcon(request.icon),
    normalizeSound(request.sound),
    // The sixth field, empty when there is no request id: an absent id and an
    // empty one mean the same thing, and the field count never changes.
    safeRequestId(request.requestID) ?? "",
    // The seventh field, the correlation key, empty when there is none. The
    // `close:` marker of a close request is part of the key and travels with
    // it, so the far end closes instead of raising.
    wireCorrelationKey(request.correlationKey),
  ].join(FIELD_SEPARATOR)

/**
 * Options shared by every ssh call. `ClearAllForwardings=yes` matters: without
 * it, a `RemoteForward` in ~/.ssh/config competes for the tunnel port and a
 * half-claimed listener silently starves the one session that needed it.
 */
const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "ClearAllForwardings=yes",
  "-o", "LogLevel=ERROR",
  "-o", "StrictHostKeyChecking=accept-new",
]

/**
 * The direct transport's multiplexing options. `ControlMaster=auto` makes the
 * first send the master and later ones cheap channels on it, and `ControlPersist`
 * keeps that master warm between notifications -- one long-lived ssh connection
 * instead of one per popup, with no reverse forward, no listening port and no
 * systemd unit to keep alive. `%C` is ssh's own hash of user/host/port, so two
 * desktops never share a socket.
 */
const CONTROL_OPTS = [
  "-o", "ControlMaster=auto",
  "-o", "ControlPersist=300",
  "-o", `ControlPath=${join(homedir(), ".ssh", "lacode-cm-%C")}`,
]

/**
 * Which channel a local send would use here.
 *
 * Platform first, installed binaries second, never a guess, delegated to the
 * adapter registry. This stays as the single source of truth for callers like
 * `describe`, and `LACODE_NOTIFY_ADAPTER` now affects it intentionally.
 */
export const localChannel = (platform: string = process.platform): LocalChannel =>
  selectAdapter({ platform: platform as NodeJS.Platform }).adapter.id

// Preserve the published surface even though tunnel no longer uses these
// freedesktop constants directly.
export { NOTIFICATION_ACTIONS } from "../lib/notify-adapter/adapters/freedesktop.ts"

/**
 * Deliver straight to the local desktop session. Never throws, never blocks
 * longer than the notifier timeout.
 *
 * Sound playback is fire-and-forget: it is detached and unref'd to outlive
 * the parent process, and failures (missing player, missing asset) are
 * silent and never affect the Result of the notification itself.
 *
 * `platform` is a parameter rather than a bare `process.platform` read so the
 * channel a machine WOULD pick is observable from a test on any machine -- the
 * same reason `notifyHooks` takes a `deliver` seam.
 */
export function sendLocal(request: NotifyRequest, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Result {
  // A close request is not a notification. The popup lives on the desktop and
  // only the desktop can take it down, so this is where the far end of the hop
  // lands: a payload that names a session to close closes that session's
  // popups and raises nothing at all. This stays in tunnel for parity: use the
  // correlation-key close path, not adapter.close, in this unit.
  const closing = closeRequestTarget(request.correlationKey)
  if (closing !== undefined) {
    const closed = closeCorrelationKey(closing)
    return { ok: closed, detail: closed ? undefined : "a popup could not be closed", transport: "local" }
  }
  const ctx = { platform: platform as NodeJS.Platform, env }
  const { adapter } = selectAdapter(ctx)
  // Sound stays before the notifier and plays even when the adapter is none.
  playSound(normalizeSound(request.sound), platform)
  const result = adapter.notify(request, ctx)
  return {
    ok: result.ok,
    detail: result.detail,
    transport: "local",
    ...(result.action ? { action: result.action } : {}),
  }
}

/**
 * Hand the notification to the desktop over the reverse forward.
 *
 * Exactly ONE argument crosses the hop, the newline-delimited payload from
 * `encodePayload` -- not four quoted ARGV entries. The receiving end is an
 * authorized_keys forced command restricted to exactly this, and that transport
 * receives the command as a single string in $SSH_ORIGINAL_COMMAND with no
 * positional parameters, so a per-field argument list arrives flattened and
 * unreadable. A missing user, a missing key, an unreachable port: all return,
 * none block for longer than connectTimeoutMs.
 */
export function sendRemote(request: NotifyRequest, tunnel: TunnelConfig): Result {
  if (!tunnel.user) return { ok: false, detail: "OC_LOCAL_USER is unset; the desktop user for the tunnel is unknown", transport: "remote" }
  const connect = ["-o", `ConnectTimeout=${Math.max(1, Math.round(tunnel.connectTimeoutMs / 1000))}`]
  // Only an actionable request can come back with an answer, and the far end
  // waits for the user to click -- so the hop's own deadline has to outlast
  // that wait, or the answer is cut off before it can arrive. A notification
  // that asks nothing keeps the short, fire-and-forget deadline it has always
  // had: a sleeping laptop must never hold an agent open.
  const actionable = safeRequestId(request.requestID) !== undefined
  const timeoutMs = actionable
    ? Math.max(tunnel.connectTimeoutMs + 2000, ACTION_WAIT_MS + 2000)
    : tunnel.connectTimeoutMs + 2000
  const deliver = (args: string[]): Result => {
    const result = exec("ssh", args, { timeout: timeoutMs })
    // The forced command prints the NAME of the clicked button on its stdout,
    // and ssh carries that back: it is the whole answer to an actionable
    // request. Empty stdout means the user dismissed the popup without
    // choosing.
    const action = actionable ? result.stdout.trim() : ""
    return {
      ok: result.ok,
      detail: result.ok ? undefined : result.stderr || result.detail,
      transport: "remote",
      ...(action ? { action } : {}),
    }
  }
  // Direct ssh (default when OC_LOCAL_HOST is set): the caller owns the transport
  // and ControlPersist keeps one connection warm. There is no reverse forward, no
  // listening port and no systemd unit -- nothing to sync and nothing to manage.
  if (tunnel.host) {
    return deliver([
      ...SSH_OPTS,
      ...CONTROL_OPTS,
      ...connect,
      "-i",
      tunnel.key,
      `${tunnel.user}@${tunnel.host}`,
      "--",
      encodePayload(request),
    ])
  }
  // Legacy reverse-forward fallback, kept until every host sets OC_LOCAL_HOST.
  return deliver([
    ...SSH_OPTS,
    ...connect,
    "-i",
    tunnel.key,
    "-p",
    String(tunnel.port),
    `${tunnel.user}@localhost`,
    "--",
    encodePayload(request),
  ])
}

/**
 * Send one notification, picking the transport by where we are running.
 *
 * Never throws (US-14). The caller decides what a failure means; the CLI's
 * fire-and-forget path treats every result as exit 0.
 */
export function notify(request: NotifyRequest, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Result {
  try {
    // A close request is not a notification: the plugin asks the helper to
    // take a popup down, and nothing is raised. The helper is the one that
    // talks to the desktop in both topologies, so this is the only place that
    // knows which end can actually close a popup.
    const closeKey = (env[NOTIFY_CLOSE_ENV] ?? "").trim()
    if (closeKey) {
      if (!isRemote(env)) {
        const closed = closeCorrelationKey(closeKey)
        return { ok: closed, detail: closed ? undefined : "a popup could not be closed", transport: "local" }
      }
      // The desktop owns the popup, so the request hops there: the payload's
      // seventh field names the session to close, and nothing is sent.
      return sendRemote({ ...request, correlationKey: `${CLOSE_REQUEST_PREFIX}${closeKey}` }, resolveTunnel(env))
    }
    // The correlation key rides in the environment, not in the argv: the
    // helper's argv is a published contract and the key is opaque. It says
    // which session the popup belongs to, so that a later request can find the
    // popup again and close it.
    const sessionKey = presentCorrelationKey(env[NOTIFY_SESSION_ENV])
    const tracked = sessionKey ? { ...request, correlationKey: request.correlationKey ?? sessionKey } : request
    const result = isRemote(env) ? sendRemote(tracked, resolveTunnel(env)) : sendLocal(tracked, platform)
    // The chosen action travels with the result: a clicked button is already a
    // valid answer, so it must not be dropped on the way back to the caller.
    return result.action ? { ...result, action: result.action } : result
  } catch (error) {
    return { ok: false, detail: String(error), transport: "none" }
  }
}

/**
 * Run a command on another host over SSH. This is the portable core of what
 * `bin/oc-sync` does per host, without the deploy logic, the systemd units, the
 * per-host marker file or the tunnel provisioning.
 *
 * Returns a result rather than throwing, and is bounded by `timeoutMs`, so a
 * wedged remote cannot wedge the caller.
 */
export function forward(
  host: string,
  argv: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Result & { stdout: string } {
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? (Number(env.OC_SSH_TIMEOUT_MS) || 30_000)
  const result = exec("ssh", [...SSH_OPTS, "-o", `ConnectTimeout=${Math.max(1, Math.round(timeoutMs / 1000))}`, host, "--", ...argv], { timeout: timeoutMs })
  return {
    ok: result.ok,
    detail: result.ok ? undefined : result.stderr || result.detail,
    transport: "remote",
    stdout: result.stdout,
  }
}

/**
 * Print what the current environment resolves to. Diagnostics, never a gate.
 *
 * `channel` is the field that has to be true: `lacode doctor` reports
 * only whether `notify-send` was installed, which on a Mac is a fact about a
 * binary that has nothing to do with whether a notification appears, and
 * therefore answers the wrong question while looking like an answer.
 */
export function describe(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform) {
  const tunnel = resolveTunnel(env)
  const base = {
    running: isRemote(env) ? "remote (over ssh)" : "local",
    user: tunnel.user || "(unset)",
    host: tunnel.host || "(unset)",
    port: tunnel.port,
    key: tunnel.key,
    channel: localChannel(platform),
    // Still exactly what it always meant -- is the notify-send binary present --
    // rather than a second opinion about which channel runs.
    notifySend: have("notify-send"),
  }
  const notify = describeNotify({ platform: platform as NodeJS.Platform, env: process.env })
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(notify)) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      // Keep the existing key; choose a non-colliding name for the new one.
      let name = `${key}2`
      while (Object.prototype.hasOwnProperty.call(merged, name)) name = `${name}2`
      merged[name] = value
    } else {
      merged[key] = value
    }
  }
  return merged as any
}