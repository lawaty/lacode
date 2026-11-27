// Adapter registry and selection.
//
// This layer decides which desktop adapter should handle a local notification.
// It is pure selection logic: it does not send notifications itself and it
// does not know about the tunnel. Adapters own probing and delivery.
//
// Phase 2 selection order:
//   darwin: osascript, terminal-notifier, none
//   win32:  powershell-toast, freedesktop, none  (Windows toast first, then the
//           notify-send fallback when it is installed, then none)
//   other:  freedesktop, none

import { freedesktopAdapter } from "./adapters/freedesktop.ts"
import { osascriptAdapter, terminalNotifierAdapter } from "./adapters/macos.ts"
import { noneAdapter } from "./adapters/none.ts"
import { windowsToastAdapter } from "./adapters/windows-toast.ts"
import type { AdapterContext, DesktopAdapter } from "./types.ts"

export { noneAdapter } from "./adapters/none.ts"

export function adapterChain(platform: NodeJS.Platform, _env: NodeJS.ProcessEnv): DesktopAdapter[] {
  if (platform === "darwin") return [osascriptAdapter, terminalNotifierAdapter, noneAdapter]
  if (platform === "win32") return [windowsToastAdapter, freedesktopAdapter, noneAdapter]
  return [freedesktopAdapter, noneAdapter]
}

export function selectAdapter(ctx: AdapterContext): { adapter: DesktopAdapter; reason?: string } {
  const platform = ctx.platform ?? process.platform
  const env = ctx.env ?? process.env
  const chain = adapterChain(platform, env)
  const override = env.LACODE_NOTIFY_ADAPTER

  if (override) {
    const found = chain.find((adapter) => adapter.id === override)
    if (found) return { adapter: found }
    process.stderr.write(`lacode: unknown LACODE_NOTIFY_ADAPTER=${override}; falling back to auto selection\n`)
    const fallback = autoSelect(chain, ctx)
    return { ...fallback, reason: fallback.reason ?? `unknown adapter override: ${override}` }
  }

  return autoSelect(chain, ctx)
}

function autoSelect(chain: DesktopAdapter[], ctx: AdapterContext): { adapter: DesktopAdapter; reason?: string } {
  for (const adapter of chain) {
    const probe = adapter.probe(ctx)
    if (probe.available) return { adapter }
  }
  return { adapter: noneAdapter }
}
