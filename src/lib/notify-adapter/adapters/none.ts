// Terminal "none" desktop adapter.
//
// This is the fallback adapter: it is always available, can do nothing, and
// reports the same platform-specific "no channel" detail the tunnel used to
// hardcode. It is a real adapter so selection can always return something.

import type { AdapterContext, AdapterResult, CloseTarget, DesktopAdapter, NotifyRequest } from "../types.ts"

/** Why there is no channel, said in the words of the platform that has none. */
export const NO_CHANNEL: Record<string, string> = {
  linux: "notify-send is not installed",
  darwin: "neither osascript nor terminal-notifier is installed",
}

export const noneAdapter: DesktopAdapter = {
  id: "none",
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
  probe(_ctx: AdapterContext) {
    return { available: true }
  },
  notify(request: NotifyRequest, ctx: AdapterContext): AdapterResult {
    const platform = ctx.platform ?? process.platform
    void request
    return {
      ok: false,
      detail: NO_CHANNEL[platform] ?? `no local notification channel on ${platform}`,
      channel: "none",
    }
  },
  close(_target: CloseTarget, _ctx: AdapterContext): boolean {
    return false
  },
}
