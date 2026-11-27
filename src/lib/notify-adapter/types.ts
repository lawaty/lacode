export type Urgency = "low" | "normal" | "critical"

export type Icon =
  | "utilities-terminal"
  | "dialog-information"
  | "dialog-error"
  | "dialog-warning"
  | "system-run"
  | "emblem-default"

export type Sound = "none" | "done" | "question" | "permission" | "error"

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

/**
 * The desktop channel a local send goes through, or `"none"` when this platform
 * has none.
 *
 * `"none"` is a real, reachable state rather than a bug: it is what a headless
 * box reports, and `sendLocal` turns it into a non-throwing failure with an
 * explanation, exactly as it already did for a missing `notify-send`.
 */
export type LocalChannel = "notify-send" | "osascript" | "terminal-notifier" | "powershell-toast" | "none"

export interface AdapterCapabilities {
  readonly actions: boolean
  readonly inlineReply: boolean
  readonly closeByKey: boolean
  readonly closeById: boolean
  readonly persistence: boolean
  readonly grouping: boolean
  readonly dndAware: boolean
  readonly activation: boolean
  readonly integratedSound: boolean
}

export interface AdapterContext {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exec?: ExecSeam
}

export type ExecOptions = {
  timeout?: number
  env?: NodeJS.ProcessEnv
  extraFd?: number
}

export type ExecResult = {
  ok: boolean
  stdout: string
  stderr: string
  detail?: string
}

export type ExecSeam = (command: string, args: string[], options?: ExecOptions) => ExecResult

export type CloseTarget = { kind: "key"; key: string }

export interface AdapterResult {
  ok: boolean
  detail?: string
  channel: LocalChannel
  action?: string
  notificationId?: string
  soundHandled?: boolean
}

export interface DesktopAdapter {
  readonly id: LocalChannel
  capabilities(): AdapterCapabilities
  probe(ctx: AdapterContext): { available: boolean; reason?: string }
  notify(request: NotifyRequest, ctx: AdapterContext): AdapterResult
  close(target: CloseTarget, ctx: AdapterContext): boolean
}
