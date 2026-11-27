// Desktop capability probes shared by the notification adapter layer.
//
// The --id-fd probe and the session-bus fallback are facts about the desktop
// this process is running on, not about any one transport. They live here so
// both the tunnel and a future adapter can ask the same question once.
//
// This module is pure: it imports nothing from `src/tunnel` or `src/plugins`.

import { exec } from "./exec.ts"
import type { ExecSeam } from "./types.ts"

let notifyIdFdSupport: boolean | undefined
let notifyActionSupport: boolean | undefined

/**
 * Whether the local `notify-send` can report its notification id on a caller-
 * supplied fd (`--id-fd`). Probed once: the answer does not change for the
 * life of the process, and the probe is cheap (a help text, 2s ceiling).
 *
 * Older notify-send builds lack `--id-fd`; those take the fallback path that
 * records the id after the process exits, which is the best they can do.
 *
 * `execFn` is a seam for tests; the default is the real `exec`. The memoized
 * answer is shared by every caller, so a test that changes the fake must call
 * `resetNotifyIdFdSupport()` first.
 */
export const supportsNotifyIdFd = (execFn: ExecSeam = exec): boolean => {
  if (notifyIdFdSupport !== undefined) return notifyIdFdSupport
  const help = execFn("notify-send", ["--help"], { timeout: 2000 })
  notifyIdFdSupport = (help.stdout + help.stderr).includes("--id-fd")
  return notifyIdFdSupport
}

/** @internal test seam — reset the memoized --id-fd probe. */
export const resetNotifyIdFdSupport = (): void => {
  notifyIdFdSupport = undefined
}

/**
 * Whether the local `notify-send` supports action buttons (`--action`).
 * Probed once (2000ms) by checking `notify-send --help` for `--action`.
 */
export const supportsNotifyAction = (execFn: ExecSeam = exec): boolean => {
  if (notifyActionSupport !== undefined) return notifyActionSupport
  const help = execFn("notify-send", ["--help"], { timeout: 2000 })
  notifyActionSupport = (help.stdout + help.stderr).includes("--action")
  return notifyActionSupport
}

/** @internal test seam — reset the memoized --action probe. */
export const resetNotifyActionSupport = (): void => {
  notifyActionSupport = undefined
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
export const sessionBusEnv = (): NodeJS.ProcessEnv => {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return {}
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  return uid === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` }
}
