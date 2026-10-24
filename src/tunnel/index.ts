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

import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { NOTIFY_CLOSE_ENV, NOTIFY_SESSION_ENV, notificationIdFile, notificationStateDir, safeCorrelationKey } from "../lib/notify.ts"
import { PACKAGE_ROOT } from "../lib/package-root.ts"

// The notification state directory and the safe-key rule live in lib/notify.ts
// now: the plugin needs them too, and `src/plugins/*` may import `src/lib/*`
// only. They are re-exported here because this module's published surface has
// always carried them, and `dist/tunnel.js` is a published entry point.
export { notificationIdFile, notificationStateDir, safeCorrelationKey }

export type Urgency = "low" | "normal" | "critical"

export type Icon =
  | "utilities-terminal"
  | "dialog-information"
  | "dialog-error"
  | "dialog-warning"
  | "system-run"
  | "emblem-default"

/** The icon whitelist. Everything else collapses to the default. */
export const ICONS: readonly Icon[] = [
  "utilities-terminal",
  "dialog-information",
  "dialog-error",
  "dialog-warning",
  "system-run",
  "emblem-default",
] as const

export type Sound = "none" | "done" | "question" | "permission" | "error"

/**
 * The sound whitelist. The sender passes a name, the receiver maps it to a
 * bundled WAV asset; this is data, never a path or a command.
 */
export const SOUNDS: readonly Sound[] = [
  "none",
  "done",
  "question",
  "permission",
  "error",
] as const

export type NotifyRequest = {
  title: string
  message?: string
  urgency?: string
  icon?: string
  sound?: string
  /**
   * The opaque id of the request this notification answers. It is never passed
   * to a command and never shown: it only decides whether the notification
   * carries buttons.
   */
  requestID?: string
  /**
   * The opaque key of the session this popup belongs to. It is never shown to
   * the user and never used to build a command argument: it only says which
   * session a popup belongs to, so that a later request can find the popup
   * again and close it.
   */
  correlationKey?: string
}

export type Result = { ok: boolean; detail?: string; transport: "local" | "remote" | "none"; action?: string }

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

export function normalizeUrgency(raw: string | undefined): Urgency {
  return raw === "low" || raw === "critical" || raw === "normal" ? raw : "normal"
}

export function normalizeIcon(raw: string | undefined): Icon {
  return ICONS.includes(raw as Icon) ? (raw as Icon) : "utilities-terminal"
}

export function normalizeSound(raw: string | undefined): Sound {
  return SOUNDS.includes(raw as Sound) ? (raw as Sound) : "none"
}

// Strip control characters and cap the length: both values are user-visible text
// that lands on a desktop, and a session title is not trusted input.
//
// The \u0000-\u001f range includes \n, and the following collapse turns every
// run of whitespace into one space. That is what makes `encodePayload` below
// unambiguous: no field it writes can contain the newline it joins on.
const safeText = (raw: string, fallback: string, max: number) => {
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  if (!clean) return fallback
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export const safeTitle = (raw: string | undefined) => safeText(raw ?? "", "LaCode", 120)
export const safeMessage = (raw: string | undefined) => safeText(raw ?? "", "", 400)

/**
 * The request id, sanitized.
 *
 * Opaque and never handed to a command: it decides only whether the
 * notification carries buttons. It is stripped of control characters and
 * capped like every other field, so it can never contain the newline the
 * payload is delimited with -- an id that could smuggle a delimiter would
 * split the payload and let a sender forge a field.
 *
 * An absent or empty id yields undefined, which is what "no request id" means:
 * a notification without one is not actionable.
 */
export const safeRequestId = (raw: string | undefined): string | undefined => {
  const clean = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!clean) return undefined
  return clean.length > 128 ? clean.slice(0, 128) : clean
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
 * The correlation key, sanitized for the wire.
 *
 * Opaque like the request id: it says which session a popup belongs to, it is
 * never shown to the user and it never builds a command argument. It is
 * stripped of control characters exactly like the free-text fields, so it can
 * never contain the newline the payload is delimited with -- a key that could
 * smuggle a delimiter would split the payload and let a sender forge a field.
 *
 * The `close:` marker is part of this field and survives the sanitizing
 * unchanged, so a close request is still recognizable on the other end.
 */
const wireCorrelationKey = (raw: string | undefined): string => safeText(raw ?? "", "", 200)

/**
 * The correlation key of a request, or undefined when it carries none.
 *
 * An absent key and an empty one mean the same thing: the notification is not
 * tracked, no id is captured, and nothing is written to disk.
 */
const presentCorrelationKey = (raw: string | undefined): string | undefined => {
  const clean = wireCorrelationKey(raw)
  return clean ? clean : undefined
}

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

// The extra environment a command needs, on top of the inherited one. Absent
// means "inherit unchanged", which is what every other call wants.
const run = (command: string, args: string[], timeout: number, extraEnv?: NodeJS.ProcessEnv) => {
  try {
    const result = spawnSync(command, args, {
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    })
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: (result.stderr ?? "").trim(),
      // spawnSync reports a timeout as a null status and an ETIMEDOUT error; both
      // are "did not arrive", not "crashed", and neither may throw.
      detail: result.error ? String((result.error as NodeJS.ErrnoException).code ?? result.error.message) : undefined,
    }
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", detail: String(error) }
  }
}

const have = (command: string) => {
  try {
    return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0
  } catch {
    return false
  }
}

/**
 * The desktop channel a local send goes through, or `"none"` when this platform
 * has none.
 *
 * `"none"` is a real, reachable state rather than a bug: it is what a headless
 * box reports, and `sendLocal` turns it into a non-throwing failure with an
 * explanation, exactly as it already did for a missing `notify-send`.
 */
export type LocalChannel = "notify-send" | "osascript" | "terminal-notifier" | "none"

/** The binary each channel names. One entry, so the channel IS the command. */
const CHANNEL_BINARY: Record<Exclude<LocalChannel, "none">, string> = {
  "notify-send": "notify-send",
  osascript: "osascript",
  "terminal-notifier": "terminal-notifier",
}

/** The sound player binary. One entry, so the channel IS the command. */
const SOUND_BINARY = {
  afplay: "afplay",
  paplay: "paplay",
  aplay: "aplay",
  "pw-play": "pw-play",
}

/** Which sound player to use here. */
export function soundChannel(platform: string = process.platform): keyof typeof SOUND_BINARY | "none" {
  if (platform === "darwin") {
    if (have(SOUND_BINARY.afplay)) return "afplay"
  } else {
    for (const cmd of [SOUND_BINARY.paplay, SOUND_BINARY.aplay, SOUND_BINARY["pw-play"]]) {
      if (have(cmd)) return cmd
    }
  }
  return "none"
}

/**
 * The AppleScript a macOS send runs.
 *
 * The title and the body are NOT written into this text. They arrive as `argv`
 * and reach `display notification` as AppleScript *values*, so a body carrying
 * quotes, `;`, `$(…)`, backticks or a newline is data and never source. Building
 * the script by concatenation -- the obvious way, and the way every
 * `osascript -e 'display notification "…" with title "…"'` snippet on the
 * internet is written -- turns a session title into arbitrary AppleScript
 * execution on the developer's own machine, which is exactly the class of bug
 * this file already refuses to have on the SSH side.
 */
const DARWIN_SCRIPT = [
  "on run argv",
  "  display notification (item 3 of argv) with title (item 2 of argv)",
  "end run",
].join("\n")

/**
 * The constant first `argv` entry, and the reason the text starts at `item 2`.
 *
 * osascript reads its own options from the same argument list the script reads,
 * so option parsing ends at the first argument that is not an option. Handing it
 * the notification text first would make the user's own title the argument that
 * ends parsing: a title beginning `-e` would be swallowed as an option and the
 * body consumed as its value. A fixed marker first means no notification text can
 * ever be that argument.
 */
const DARWIN_ARGV_MARKER = "lacode"

/**
 * Which channel a local send would use here.
 *
 * Platform first, installed binaries second, never a guess: macOS gets the
 * `osascript` that ships with the OS, falling back to `terminal-notifier` when
 * the machine has been stripped of it, and every other platform keeps the
 * `notify-send` path it has always had -- including the ones where notify-send
 * comes from a non-libnotify package. macOS is *added*, not substituted, so
 * nothing that worked before can stop working.
 *
 * This is the single source of truth for the channel: `sendLocal` runs it and
 * `describe` reports it, which is what stops `lacode doctor` from claiming a
 * `notify-send` that does not exist on a Mac.
 */
export function localChannel(platform: string = process.platform): LocalChannel {
  if (platform === "darwin") {
    if (have(CHANNEL_BINARY.osascript)) return "osascript"
    if (have(CHANNEL_BINARY["terminal-notifier"])) return "terminal-notifier"
    return "none"
  }
  return have(CHANNEL_BINARY["notify-send"]) ? "notify-send" : "none"
}

/** Why there is no channel, said in the words of the platform that has none. */
const NO_CHANNEL: Record<string, string> = {
  linux: "notify-send is not installed",
  darwin: "neither osascript nor terminal-notifier is installed",
}

/**
 * The freedesktop "never expire" timeout. A notification is not dismissed by a
 * timer: it stays on the desktop until the user closes it. Without it the
 * daemon's own timeout takes the popup away, which is the difference between a
 * notice the user can still act on and one they missed.
 */
const NEVER_EXPIRE_FLAG = "--expire-time=0"

/**
 * The app name the popup is raised under.
 *
 * On KDE Plasma the popup's header IS the notification's app name, and
 * notify-send reports its own name when none is given, so the app name is set
 * explicitly to make the header say "LaCode".
 *
 * The macOS branch does not need it: terminal-notifier takes `-appName`, and
 * it already says LaCode.
 */
const APP_NAME_FLAG = "--app-name=LaCode"

/**
 * The buttons an actionable notification offers. The names are opencode's own
 * permission-reply values, so a clicked button is already a valid answer; the
 * labels are what the user reads.
 */
export const NOTIFICATION_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["once", "Allow once"],
  ["always", "Always allow"],
  ["reject", "Deny"],
]

/**
 * How long an actionable notification waits for the user. `--action` implies
 * `--wait`, so the notifier blocks; a prompt nobody answers must still end.
 */
const ACTION_WAIT_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// The notification id: how a popup is found again so it can be closed
// ---------------------------------------------------------------------------

/**
 * A notification id is a decimal integer and nothing else.
 *
 * The ids come out of a file on disk, so a malformed line must never reach a
 * command argument: it is ignored instead, and the rest of the file still
 * closes.
 */
export const isNotificationId = (id: string): boolean => /^\d+$/.test(id)

/**
 * Append one notification id to its correlation key's file.
 *
 * One id per line, because a session can have more than one popup up. The file
 * is appended to by the raiser and read then deleted by the closer.
 *
 * Only a decimal integer is recorded: anything else in the daemon's output is
 * not an id, and a line that is not an id must never become a command argument
 * later.
 */
const recordNotificationId = (correlationKey: string, id: string): boolean => {
  if (!isNotificationId(id)) return false
  try {
    mkdirSync(notificationStateDir(), { recursive: true })
    appendFileSync(notificationIdFile(correlationKey), `${id}\n`, "utf8")
    return true
  } catch {
    // A popup that cannot be tracked cannot be closed later. The popup itself
    // is up, and that is the part the user sees.
    return false
  }
}

/**
 * The session bus to talk to the notification daemon over.
 *
 * The daemon is on the SESSION bus, and the address is usually already in the
 * environment. It is not always: an ssh forced command -- which is exactly how
 * the desktop end of the hop runs -- inherits no session bus, and the common
 * systemd layout has one at a predictable path. Without this a close would
 * work from a terminal and fail from the hop, which is the harder half.
 */
const sessionBusEnv = (): NodeJS.ProcessEnv => {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return {}
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  return uid === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` }
}

/**
 * How long a close may take. It is a message to a local daemon, not a
 * network call, so it is either instant or the daemon is not there.
 */
const CLOSE_TIMEOUT_MS = 5_000

/**
 * Close one popup by its notification id, over the session bus.
 *
 * Two tools, because neither is everywhere: `gdbus` first and `dbus-send` as
 * the fallback. The id is a validated decimal integer, so it can only ever be
 * a number in a command argument.
 *
 * A close that fails returns false and never throws: the popup stays, and
 * nothing else changes. That is not an error the user needs to hear about.
 */
export function closeNotification(id: string): boolean {
  if (!isNotificationId(id)) return false
  const env = sessionBusEnv()
  const viaGdbus = run(
    "gdbus",
    [
      "call",
      "--session",
      "--dest", "org.freedesktop.Notifications",
      "--object-path", "/org/freedesktop/Notifications",
      "--method", "org.freedesktop.Notifications.CloseNotification",
      id,
    ],
    CLOSE_TIMEOUT_MS,
    env,
  )
  if (viaGdbus.ok) return true
  const viaDbusSend = run(
    "dbus-send",
    [
      "--session",
      "--dest=org.freedesktop.Notifications",
      "--type=method_call",
      "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications.CloseNotification",
      `uint32:${id}`,
    ],
    CLOSE_TIMEOUT_MS,
    env,
  )
  return viaDbusSend.ok
}

/**
 * Close every popup of one correlation key, and forget them.
 *
 * The ids are read from the key's file and the file is deleted: the ids are
 * consumed by the close. A file that does not exist means nothing was raised
 * under that key, which is not a failure -- there is nothing to take down.
 */
export function closeCorrelationKey(correlationKey: string): boolean {
  const file = notificationIdFile(correlationKey)
  let content = ""
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return true
  }
  let closed = true
  for (const line of content.split("\n")) {
    const id = line.trim()
    // A line that is not a decimal integer is not an id: it is ignored, and
    // the rest of the file still closes.
    if (!isNotificationId(id)) continue
    if (!closeNotification(id)) closed = false
  }
  try {
    unlinkSync(file)
  } catch {
    // The popups are down; a file that will not delete is a leftover, not
    // something the user has to hear about.
  }
  return closed
}

/**
 * Split what notify-send printed into the notification id and the action.
 *
 * `--print-id` prints the id on the FIRST line and the clicked action's name
 * after it -- the name only when the popup was actionable and the user
 * clicked. The id is the daemon's handle on the popup and the action is the
 * user's answer; mixing them up would answer a permission with a number.
 */
const splitNotifyOutput = (stdout: string): { id: string; action: string } => {
  const newline = stdout.indexOf("\n")
  if (newline === -1) return { id: stdout.trim(), action: "" }
  return { id: stdout.slice(0, newline).trim(), action: stdout.slice(newline + 1).trim() }
}

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
export function sendLocal(request: NotifyRequest, platform: string = process.platform): Result {
  // A close request is not a notification. The popup lives on the desktop and
  // only the desktop can take it down, so this is where the far end of the hop
  // lands: a payload that names a session to close closes that session's
  // popups and raises nothing at all.
  const closing = closeRequestTarget(request.correlationKey)
  if (closing !== undefined) {
    const closed = closeCorrelationKey(closing)
    return { ok: closed, detail: closed ? undefined : "a popup could not be closed", transport: "local" }
  }
  // Play an alert sound, if available.
  //
  // This is spawned here because `sendLocal` is the only function that
  // runs on the user's actual desktop in both topologies (local or
  // through the SSH tunnel), so the sound is audible. The plugin's own
  // spawn runs on a headless host where it would be silent.
  //
  // Audio success is independent of notification success: this is called
  // in the `channel === "none"` branch too, because on a desktop with no
  // notification daemon, the sound is the only alert the user gets.
  // Therefore, a sound failure must never change the `Result` of `sendLocal`.
  //
  // The player is detached + unref'd so it can outlive the parent process,
  // which may exit immediately after `sendLocal` returns (e.g. `lacode receive`).
  //
  // Assets are whitelisted via `normalizeSound`, so the path is never built
  // from sender-supplied text, preventing arbitrary file access.
  const sound = normalizeSound(request.sound)
  const playSound = () => {
    if (sound === "none") return
    const channel = soundChannel(platform)
    if (channel === "none") return
    const path = join(PACKAGE_ROOT, "sounds", `${sound}.wav`)
    if (!existsSync(path)) return
    const child = spawn(channel, [path], { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  }

  const channel = localChannel(platform)
  if (channel === "none") {
    playSound()
    return { ok: false, detail: NO_CHANNEL[platform] ?? `no local notification channel on ${platform}`, transport: "local" }
  }
  const title = safeTitle(request.title)
  const body = safeMessage(request.message)
  // A notification is actionable only when it carries a request id, and only on
  // the channel that can offer buttons: macOS has no `--action`, so its branches
  // keep exactly the behaviour they have today.
  const requestID = safeRequestId(request.requestID)
  const actionable = channel === "notify-send" && requestID !== undefined
  const actionArgs = actionable ? NOTIFICATION_ACTIONS.map(([name, label]) => `--action=${name}=${label}`) : []
  // The correlation key, when there is one, is what makes the popup closable:
  // notify-send is asked for the id the daemon gave it, and that id is
  // recorded next to the key, so a later close request can find the popup
  // again. No key means no id is captured and nothing is written -- exactly
  // the behaviour a notification has always had.
  const correlationKey = presentCorrelationKey(request.correlationKey)
  const trackable = channel === "notify-send" && correlationKey !== undefined
  const args =
    channel === "osascript"
      ? ["-e", DARWIN_SCRIPT, DARWIN_ARGV_MARKER, title, body]
      : channel === "terminal-notifier"
        ? ["-title", title, "-message", body, "-appName", "LaCode", "-priority", normalizeUrgency(request.urgency)]
        : // Never auto-dismissed: the notification waits for the user to close it.
          [title, body, APP_NAME_FLAG, `--urgency=${normalizeUrgency(request.urgency)}`, `--icon=${normalizeIcon(request.icon)}`, NEVER_EXPIRE_FLAG, ...(trackable ? ["--print-id"] : []), ...actionArgs]
  // `--action` implies `--wait`: the notifier blocks until the user clicks, so
  // the fire-and-forget timeout would kill the prompt before it could be
  // answered. An actionable send waits for the answer instead.
  const result = run(CHANNEL_BINARY[channel], args, actionable ? ACTION_WAIT_MS : 5000)
  playSound()
  // notify-send prints the NAME of the clicked button on stdout. Empty stdout
  // means the user dismissed the popup without choosing: no action at all.
  //
  // With `--print-id` the stdout carries the notification id FIRST and the
  // action after it, so the two are split apart: the id is the daemon's handle
  // on the popup, the action is the user's answer, and they must never be
  // confused with each other.
  const printed = trackable ? splitNotifyOutput(result.stdout) : { id: "", action: result.stdout.trim() }
  const action = actionable ? printed.action : ""
  // The id is recorded, never printed: the helper's stdout carries the action
  // name and nothing else, and that contract is published.
  if (correlationKey !== undefined && printed.id) recordNotificationId(correlationKey, printed.id)
  return {
    ok: result.ok,
    detail: result.ok ? undefined : result.stderr || result.detail,
    transport: "local",
    ...(action ? { action } : {}),
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
    const result = run("ssh", args, timeoutMs)
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
  const result = run("ssh", [...SSH_OPTS, "-o", `ConnectTimeout=${Math.max(1, Math.round(timeoutMs / 1000))}`, host, "--", ...argv], timeoutMs)
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
  return {
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
}