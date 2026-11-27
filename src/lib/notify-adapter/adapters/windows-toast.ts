// Windows 10/11 toast adapter via PowerShell 5.1.
//
// Raises a Windows toast through the Windows.UI.Notifications runtime, invoked
// from `powershell.exe` (not `pwsh`). The title and body never reach argv:
// they are written to a temporary `toast.xml` and only the XML path is handed
// to PowerShell. The toast is non-actionable, cannot be closed from this side,
// and self-expires after its duration; permission replies stay in the TUI.
//
// This module is pure: it imports nothing from src/tunnel or src/plugins.

import { exec, have } from "../exec.ts"
import { normalizeUrgency, safeMessage, safeTitle } from "../text.ts"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AdapterContext,
  AdapterResult,
  CloseTarget,
  DesktopAdapter,
  NotifyRequest,
} from "../types.ts"

/**
 * The PowerShell 5.1 App User Model ID the toast is raised under.
 *
 * It is the WindowsPowerShell v1.0 AUMID: the launcher itself, not lacode, so
 * no lacode registration appears in the registry and no installer is required.
 */
const AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"

/**
 * The PowerShell script template. `{xmlPath}` and `{AUMID}` are filled in at
 * send time; nothing else is interpolated, so title and body can never reach
 * argv. Placeholders are substituted with split/join so backslashes in the
 * path or the AUMID survive untouched.
 */
const SCRIPT_TEMPLATE = [
  "$ErrorActionPreference = 'Stop';",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;",
  "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;",
  "$xml.LoadXml([IO.File]::ReadAllText('{xmlPath}'));",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml);",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{AUMID}').Show($toast)",
].join("\n")

/** Escape XML text so user-controlled title/body cannot break the markup. */
const xmlEscape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")

export const windowsToastAdapter: DesktopAdapter = {
  id: "powershell-toast",
  capabilities() {
    return {
      actions: false,
      inlineReply: false,
      closeByKey: false,
      closeById: false,
      persistence: false,
      grouping: false,
      dndAware: false,
      activation: false,
      integratedSound: false,
    }
  },
  probe(ctx: AdapterContext) {
    return { available: have("powershell.exe", ctx.exec, ctx.platform) }
  },
  close(_target: CloseTarget, _ctx: AdapterContext): boolean {
    return false
  },
  notify(request: NotifyRequest, ctx: AdapterContext): AdapterResult {
    let dir: string | undefined
    try {
      const execFn = ctx.exec ?? exec
      const title = safeTitle(request.title)
      const body = safeMessage(request.message)
      const duration = normalizeUrgency(request.urgency) === "critical" ? "long" : "short"
      const xml = `<toast duration="${duration}"><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`

      dir = mkdtempSync(join(tmpdir(), "lacode-toast-"))
      const xmlPath = join(dir, "toast.xml")
      writeFileSync(xmlPath, xml, "utf8")

      // PowerShell single-quoted strings escape ' as ''.
      const safePath = xmlPath.replace(/'/g, "''")
      const script = SCRIPT_TEMPLATE.split("{xmlPath}").join(safePath).split("{AUMID}").join(AUMID)

      const result = execFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeout: 5000,
        ...(ctx.env ? { env: ctx.env } : {}),
      })
      return {
        ok: result.ok,
        detail: result.ok ? undefined : result.stderr || result.detail,
        channel: "powershell-toast",
      }
    } catch (error) {
      return { ok: false, detail: String(error), channel: "powershell-toast" }
    } finally {
      if (dir !== undefined) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // Best-effort cleanup: the temp dir must not outlive the send.
        }
      }
    }
  },
}
