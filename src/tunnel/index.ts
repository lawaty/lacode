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

import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

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

export type NotifyRequest = {
  title: string
  message?: string
  urgency?: string
  icon?: string
}

export type Result = { ok: boolean; detail?: string; transport: "local" | "remote" | "none" }

export type TunnelConfig = {
  /** The desktop user the reverse forward authenticates as. */
  user: string
  /** Port the reverse forward is listening on, local side. */
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

/** The delimiter `encodePayload` joins fields with. Also what the receiver splits on. */
export const FIELD_SEPARATOR = "\n"

/**
 * One argument, four newline-delimited fields: `title\nmessage\nurgency\nicon`.
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
 * character (including \n) from both free-text fields, and the icon and urgency
 * are whitelisted values. No field can contain the delimiter, so the split is
 * lossless for a body containing spaces, quotes or glob characters.
 */
export const encodePayload = (request: NotifyRequest): string =>
  [
    safeTitle(request.title),
    safeMessage(request.message),
    normalizeUrgency(request.urgency),
    normalizeIcon(request.icon),
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

const run = (command: string, args: string[], timeout: number) => {
  try {
    const result = spawnSync(command, args, { timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
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
 * Deliver straight to the local desktop session. Never throws, never blocks
 * longer than the notifier timeout.
 *
 * `platform` is a parameter rather than a bare `process.platform` read so the
 * channel a machine WOULD pick is observable from a test on any machine -- the
 * same reason `notifyHooks` takes a `deliver` seam.
 */
export function sendLocal(request: NotifyRequest, platform: string = process.platform): Result {
  const channel = localChannel(platform)
  if (channel === "none") {
    return { ok: false, detail: NO_CHANNEL[platform] ?? `no local notification channel on ${platform}`, transport: "local" }
  }
  const title = safeTitle(request.title)
  const body = safeMessage(request.message)
  const args =
    channel === "osascript"
      ? ["-e", DARWIN_SCRIPT, DARWIN_ARGV_MARKER, title, body]
      : channel === "terminal-notifier"
        ? ["-title", title, "-message", body, "-appName", "LaCode", "-priority", normalizeUrgency(request.urgency)]
        : // Byte-identical to the notify-send call this package has always made.
          [title, body, `--urgency=${normalizeUrgency(request.urgency)}`, `--icon=${normalizeIcon(request.icon)}`]
  const result = run(CHANNEL_BINARY[channel], args, 5000)
  return { ok: result.ok, detail: result.ok ? undefined : result.stderr || result.detail, transport: "local" }
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
  const args = [
    ...SSH_OPTS,
    "-o", `ConnectTimeout=${Math.max(1, Math.round(tunnel.connectTimeoutMs / 1000))}`,
    "-i", tunnel.key,
    "-p", String(tunnel.port),
    `${tunnel.user}@localhost`,
    "--",
    encodePayload(request),
  ]
  const result = run("ssh", args, tunnel.connectTimeoutMs + 2000)
  return { ok: result.ok, detail: result.ok ? undefined : result.stderr || result.detail, transport: "remote" }
}

/**
 * Send one notification, picking the transport by where we are running.
 *
 * Never throws (US-14). The caller decides what a failure means; the CLI's
 * fire-and-forget path treats every result as exit 0.
 */
export function notify(request: NotifyRequest, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Result {
  try {
    return isRemote(env) ? sendRemote(request, resolveTunnel(env)) : sendLocal(request, platform)
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
 * `channel` is the field that has to be true: `lacode doctor` used to report
 * only whether `notify-send` was installed, which on a Mac is a fact about a
 * binary that has nothing to do with whether a notification appears, and
 * therefore answered the wrong question while looking like an answer.
 */
export function describe(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform) {
  const tunnel = resolveTunnel(env)
  return {
    running: isRemote(env) ? "remote (over ssh)" : "local",
    user: tunnel.user || "(unset)",
    port: tunnel.port,
    key: tunnel.key,
    channel: localChannel(platform),
    // Still exactly what it always meant -- is the notify-send binary present --
    // rather than a second opinion about which channel runs.
    notifySend: have("notify-send"),
  }
}