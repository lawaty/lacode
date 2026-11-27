// notify-send (freedesktop) desktop adapter.
//
// This is the Linux notify-send implementation extracted out of
// src/tunnel/index.ts. It is a move/extraction: the behavior is byte-for-byte
// identical to the previous notify-send branch of sendLocal. sendLocal now
// dispatches through selectAdapter.
//
// This module is pure: it imports nothing from src/tunnel or src/plugins.

import { closeSync, mkdirSync, openSync } from "node:fs"
import { notificationIdFile, notificationStateDir } from "../../notify.ts"
import { exec, have } from "../exec.ts"
import { closeCorrelationKey, recordNotificationId } from "../ids.ts"
import { supportsNotifyAction, supportsNotifyIdFd } from "../probe.ts"
import {
  normalizeIcon,
  normalizeUrgency,
  presentCorrelationKey,
  safeMessage,
  safeRequestId,
  safeTitle,
} from "../text.ts"
import type {
  AdapterContext,
  AdapterResult,
  CloseTarget,
  DesktopAdapter,
  NotifyRequest,
} from "../types.ts"

/**
 * The freedesktop "never expire" timeout. A notification is not dismissed by a
 * timer: it stays on the desktop until the user closes it.
 */
export const NEVER_EXPIRE_FLAG = "--expire-time=0"

/**
 * The app name the popup is raised under.
 */
export const APP_NAME_FLAG = "--app-name=LaCode"

/**
 * The buttons an actionable notification offers.
 */
export const NOTIFICATION_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["once", "Allow once"],
  ["always", "Always allow"],
  ["reject", "Deny"],
]

/**
 * How long an actionable notification waits for the user.
 */
export const ACTION_WAIT_MS = 10 * 60_000

/**
 * Split what notify-send printed into the notification id and the action.
 */
export const splitNotifyOutput = (stdout: string): { id: string; action: string } => {
  const newline = stdout.indexOf("\n")
  if (newline === -1) return { id: stdout.trim(), action: "" }
  return { id: stdout.slice(0, newline).trim(), action: stdout.slice(newline + 1).trim() }
}

export const freedesktopAdapter: DesktopAdapter = {
  id: "notify-send",
  capabilities() {
    return {
      actions: true,
      inlineReply: false,
      closeByKey: true,
      closeById: false,
      persistence: true,
      grouping: false,
      dndAware: false,
      activation: false,
      integratedSound: false,
    }
  },
  probe(ctx: AdapterContext) {
    return { available: have("notify-send", ctx.exec, ctx.platform) }
  },
  close(target: CloseTarget, _ctx: AdapterContext): boolean {
    return target.kind === "key" ? closeCorrelationKey(target.key) : false
  },
  notify(request: NotifyRequest, ctx: AdapterContext): AdapterResult {
    try {
      const execFn = ctx.exec ?? exec
      const platform = ctx.platform ?? process.platform
      void platform
      const title = safeTitle(request.title)
      const body = safeMessage(request.message)
      const requestID = safeRequestId(request.requestID)
      const actionable = requestID !== undefined
      const canAction = actionable && supportsNotifyAction(execFn)
      const actionArgs = canAction
        ? NOTIFICATION_ACTIONS.map(([name, label]) => `--action=${name}=${label}`)
        : []
      const correlationKey = presentCorrelationKey(request.correlationKey)
      const trackable = correlationKey !== undefined

      let idFd: number | undefined
      let useIdFd = false
      if (trackable && correlationKey !== undefined && supportsNotifyIdFd(execFn)) {
        try {
          mkdirSync(notificationStateDir(), { recursive: true })
          idFd = openSync(notificationIdFile(correlationKey), "a")
          useIdFd = true
        } catch {
          idFd = undefined
          useIdFd = false
        }
      }

      const args = [
        title,
        body,
        APP_NAME_FLAG,
        "--urgency=" + normalizeUrgency(request.urgency),
        "--icon=" + normalizeIcon(request.icon),
        NEVER_EXPIRE_FLAG,
        ...(trackable ? [useIdFd ? "--id-fd=3" : "--print-id"] : []),
        ...actionArgs,
      ]

      const timeout = canAction ? ACTION_WAIT_MS : 5000

      try {
        const result = execFn("notify-send", args, { timeout, extraFd: idFd })
        const printed =
          trackable && !useIdFd
            ? splitNotifyOutput(result.stdout)
            : { id: "", action: result.stdout.trim() }
        const action = canAction ? printed.action : ""
        if (!useIdFd && correlationKey !== undefined && printed.id) {
          recordNotificationId(correlationKey, printed.id)
        }
        return {
          ok: result.ok,
          detail: result.ok ? undefined : result.stderr || result.detail,
          channel: "notify-send",
          ...(action ? { action } : {}),
        }
      } finally {
        if (idFd !== undefined) {
          try {
            closeSync(idFd)
          } catch {
            // A close failure after notify-send has exited is not actionable.
          }
        }
      }
    } catch (error) {
      return { ok: false, detail: String(error), channel: "notify-send" }
    }
  },
}
