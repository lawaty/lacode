// Self-update hook factory (US-27). Runs the version check ONCE when the plugin
// loads and returns no hooks of its own -- it has nothing to do on config, event
// or dispose. Isolated like every other factory: a failure here costs only the
// update check, never the process.
//
// The check is fire-and-forget. A plugin that blocked startup on a registry
// round-trip would make every opencode launch depend on npm being reachable,
// which is exactly the kind of coupling this codebase avoids.

import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { PACKAGE_ROOT } from "../lib/pool.ts"
import { maybeSelfUpdate } from "../lib/selfupdate.ts"

type SelfUpdateOptions = {
  enabled?: boolean
  selfUpdate?: boolean
}

export async function selfUpdateHooks(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const opts = (options ?? {}) as SelfUpdateOptions
  if (opts.enabled === false || opts.selfUpdate === false) return {}

  const log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    input.client.app.log({ body: { service: "lacode", level, message, extra } }).catch(() => {})

  void maybeSelfUpdate({ packageRoot: PACKAGE_ROOT, enabled: opts.enabled, log }).catch(() => {})

  return {}
}
