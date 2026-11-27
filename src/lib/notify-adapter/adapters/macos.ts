// macOS desktop adapters.
//
// This moves the macOS osascript and terminal-notifier branches out of
// src/tunnel/index.ts. It is a move: the behavior is byte-for-byte identical to
// the previous macOS branches of sendLocal. sendLocal now dispatches through
// selectAdapter.
//
// This module is pure: it imports nothing from src/tunnel or src/plugins.

import { exec, have } from "../exec.ts"
import { normalizeUrgency, safeMessage, safeTitle } from "../text.ts"
import type { AdapterContext, AdapterResult, CloseTarget, DesktopAdapter, NotifyRequest } from "../types.ts"

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
export const DARWIN_SCRIPT = [
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
export const DARWIN_ARGV_MARKER = "lacode"

const DARWIN_CAPABILITIES = {
  actions: false,
  inlineReply: false,
  closeByKey: false,
  closeById: false,
  persistence: false,
  grouping: false,
  dndAware: false,
  activation: false,
  integratedSound: false,
} as const

function notifyDarwin(
  channel: "osascript" | "terminal-notifier",
  request: NotifyRequest,
  ctx: AdapterContext,
): AdapterResult {
  try {
    const execFn = ctx.exec ?? exec
    const title = safeTitle(request.title)
    const body = safeMessage(request.message)
    const args =
      channel === "osascript"
        ? ["-e", DARWIN_SCRIPT, DARWIN_ARGV_MARKER, title, body]
        : ["-title", title, "-message", body, "-appName", "LaCode", "-priority", normalizeUrgency(request.urgency)]
    const result = execFn(channel, args, { timeout: 5000 })
    return {
      ok: result.ok,
      detail: result.ok ? undefined : result.stderr || result.detail,
      channel,
    }
  } catch (error) {
    return { ok: false, detail: String(error), channel }
  }
}

export const osascriptAdapter: DesktopAdapter = {
  id: "osascript",
  capabilities() {
    return DARWIN_CAPABILITIES
  },
  probe(ctx: AdapterContext) {
    return { available: have("osascript", ctx.exec, ctx.platform) }
  },
  close(_target: CloseTarget, _ctx: AdapterContext): boolean {
    return false
  },
  notify(request: NotifyRequest, ctx: AdapterContext): AdapterResult {
    return notifyDarwin("osascript", request, ctx)
  },
}

export const terminalNotifierAdapter: DesktopAdapter = {
  id: "terminal-notifier",
  capabilities() {
    return DARWIN_CAPABILITIES
  },
  probe(ctx: AdapterContext) {
    return { available: have("terminal-notifier", ctx.exec, ctx.platform) }
  },
  close(_target: CloseTarget, _ctx: AdapterContext): boolean {
    return false
  },
  notify(request: NotifyRequest, ctx: AdapterContext): AdapterResult {
    return notifyDarwin("terminal-notifier", request, ctx)
  },
}
