// Doctor diagnostics for the desktop notification adapter.
//
// Pure reporting: resolves which adapter would be selected, probes every
// adapter in the chain (without delivering anything), and reports the
// capabilities, sound channel and state directory. Never throws.

import { adapterChain, selectAdapter } from "./registry.ts"
import { soundChannel } from "./sound.ts"
import { notificationStateDir } from "../notify.ts"
import type { AdapterContext } from "./types.ts"

export function describeNotify(ctx: AdapterContext = {}): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const platform = (ctx.platform ?? process.platform) as NodeJS.Platform
    const env = ctx.env ?? process.env

    const { adapter, reason } = selectAdapter({ platform, env })
    const chain = adapterChain(platform, env)

    result.adapter = adapter.id

    const probeParts: string[] = []
    for (const a of chain) {
      let available = false
      try {
        const probe = a.probe({ platform, env })
        available = Boolean(probe && probe.available)
      } catch {
        available = false
      }
      probeParts.push(`${a.id}=${available ? "available" : "unavailable"}`)
    }
    result.adapterChain = probeParts.join(",")

    const caps = adapter.capabilities()
    const enabled = Object.keys(caps).filter((key) => Boolean((caps as Record<string, unknown>)[key]))
    result.capabilities = enabled.length > 0 ? enabled.join(",") : "none"

    result.sound = soundChannel(platform as string)

    result.stateDir = notificationStateDir()

    if (reason !== undefined && reason !== "") {
      result.adapterNote = reason
    }
  } catch {
    // Never throw out of diagnostics.
  }
  return result
}
