// Notification-id recording and close-by-correlation-key primitives shared by
// the notification adapter layer.
//
// Only the desktop that raised a popup can close it: the id the daemon handed
// out is the handle. The raiser records ids under a correlation key, and the
// closer reads them back, closes each over the session bus and spends the file.
//
// This module is pure: it imports nothing from `src/tunnel` or `src/plugins`.

import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { notificationIdFile, notificationStateDir } from "../notify.ts"
import { exec } from "./exec.ts"
import { sessionBusEnv } from "./probe.ts"

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
export const recordNotificationId = (correlationKey: string, id: string): boolean => {
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
  const viaGdbus = exec(
    "gdbus",
    [
      "call",
      "--session",
      "--dest", "org.freedesktop.Notifications",
      "--object-path", "/org/freedesktop/Notifications",
      "--method", "org.freedesktop.Notifications.CloseNotification",
      id,
    ],
    { timeout: CLOSE_TIMEOUT_MS, env },
  )
  if (viaGdbus.ok) return true
  const viaDbusSend = exec(
    "dbus-send",
    [
      "--session",
      "--dest=org.freedesktop.Notifications",
      "--type=method_call",
      "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications.CloseNotification",
      `uint32:${id}`,
    ],
    { timeout: CLOSE_TIMEOUT_MS, env },
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
