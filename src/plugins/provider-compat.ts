// Provider compatibility hook factory.
//
// This module returns NO working hooks. Like ./selfupdate.ts it does its work
// once, at load: it swaps `globalThis.fetch` for a wrapper that normalizes the
// chunk fields whose type varies between OpenAI-compatible providers (see
// ../lib/provider-compat.ts for the fault and the rewrite). opencode resolves
// its transport lazily, so the swap takes effect for every request that starts
// after this factory has run -- which is all of them, because plugins load
// before the first session.
//
// WHY A FACTORY AT ALL. opencode calls every export of every auto-loaded plugin
// file, and a stray second plugin export poisons the shared hook registry, so
// this stays a plain function returning an (almost empty) hooks object and
// src/index.ts is the only `Plugin`. The one hook it returns is `dispose`,
// which restores the fetch it replaced; without it a process that reloads the
// plugin would leave a dead wrapper behind.
//
// DEGRADE, NEVER BLOCK. A host with no writable fetch, a frozen global, a
// response whose body cannot be re-framed -- each one is logged and the
// original behaviour stands. A compatibility layer that can fail a request is
// worse than the incompatibility it repairs.

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { installProviderCompat } from "../lib/provider-compat.ts"

const SERVICE = "provider-compat"

export const providerCompatHooks = async (input: Pick<PluginInput, "client">): Promise<Hooks> => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    input.client.app.log({ body: { service: SERVICE, level, message } }).catch(() => {})

  let restore: () => void = () => {}

  try {
    restore = installProviderCompat()
    await log("debug", "normalizing object-shaped reasoning in provider streams")
  } catch (error) {
    await log("warn", `provider compat unavailable: ${String(error)}`)
  }

  return {
    dispose: async () => {
      try {
        restore()
      } catch {
        // An undo that fails is not worth a second error line.
      }
    },
  }
}
