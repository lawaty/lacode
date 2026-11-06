import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { PACKAGE_ROOT } from "../lib/package-root.ts"
import { readInstalledVersion } from "../lib/selfupdate.ts"
import { runTimerMigration } from "../lib/timer-migration.ts"

export interface TimerMigrationPluginOptions {
  enabled?: boolean
}

/** Fire-and-forget: once per package version, install/refresh the pool timer. */
export function timerMigrationHooks(input: PluginInput, options?: TimerMigrationPluginOptions): Hooks {
  if (options?.enabled === false) return {}
  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    void input.client.app.log({ body: { service: "lacode", level, message, extra } }).catch(() => {})
  }
  void runTimerMigration({
    packageRoot: PACKAGE_ROOT,
    version: readInstalledVersion(PACKAGE_ROOT),
    log,
  })
    .then((result) => {
      if (result.action === "installed") log("info", `timer migration installed for ${result.version}`)
      else if (result.action === "failed") log("warn", `timer migration failed: ${result.error}`)
      else log("debug", `timer migration: ${result.action}`)
    })
    .catch((error) => log("error", `timer migration threw: ${String(error)}`))
  return {}
}
