import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { PACKAGE_ROOT } from "./package-root.ts"
import { readInstalledVersion } from "./selfupdate.ts"

export const TIMER_MIGRATION_ENV = "LACODE_NO_TIMER_MIGRATION"
export const TIMER_MIGRATION_STATE_VERSION = 1

export interface TimerMigrationState {
  version?: number
  timersVersion?: string
  installedAt?: string
}

export type TimerMigrationResult =
  | { action: "disabled" }
  | { action: "skipped"; reason: "not-linux" | "no-systemd" | "no-version" }
  | { action: "up-to-date"; version: string }
  | { action: "installed"; version: string }
  | { action: "failed"; version: string; error: string }

export type TimerLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void

export interface TimerMigrationOptions {
  packageRoot?: string
  version?: string
  home?: string
  statePath?: string
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  now?: () => Date
  log?: TimerLog
  run?: (file: string, args: string[], options?: { stdio?: "ignore" | "inherit" }) => Promise<void>
}

const defaultRun = (
  file: string,
  args: string[],
  options?: { stdio?: "ignore" | "inherit" },
): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { stdio: options?.stdio ?? "ignore" }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })

function resolveNodeBinary(execPath = process.execPath): string {
  if (/^node(\.exe)?$/i.test(basename(execPath))) return execPath
  if (existsSync("/usr/bin/node")) return "/usr/bin/node"
  return "node"
}

export function timerMigrationStatePath(home = homedir()): string {
  return join(home, ".local", "share", "opencode", "lacode", "migrations.json")
}

export function timerMigrationUnitPath(home = homedir()): string {
  return join(home, ".config", "systemd", "user", "lacode-refresh-pool.timer")
}

function readState(path: string): TimerMigrationState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TimerMigrationState
  } catch {
    return {}
  }
}

function writeState(path: string, state: TimerMigrationState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state) + "\n")
  renameSync(tmp, path)
}

export async function runTimerMigration(options: TimerMigrationOptions = {}): Promise<TimerMigrationResult> {
  const env = options.env ?? process.env
  if (env[TIMER_MIGRATION_ENV] === "1" || env.NODE_TEST_CONTEXT !== undefined) return { action: "disabled" }

  const platform = options.platform ?? process.platform
  if (platform !== "linux") return { action: "skipped", reason: "not-linux" }

  const packageRoot = options.packageRoot ?? PACKAGE_ROOT
  const version = options.version ?? readInstalledVersion(packageRoot)
  if (!version) return { action: "skipped", reason: "no-version" }

  const home = options.home ?? homedir()
  const statePath = options.statePath ?? timerMigrationStatePath(home)
  const state = readState(statePath)
  if (state.timersVersion === version && existsSync(timerMigrationUnitPath(home))) {
    return { action: "up-to-date", version }
  }

  const run = options.run ?? defaultRun
  try {
    await run("systemctl", ["--user", "show-environment"], { stdio: "ignore" })
  } catch {
    return { action: "skipped", reason: "no-systemd" }
  }

  const script = join(packageRoot, "scripts", "refresh-pool.mjs")
  if (!existsSync(script)) return { action: "failed", version, error: `timer script not found: ${script}` }

  try {
    await run(resolveNodeBinary(), [script, "--install-timer", "--stable"], { stdio: "ignore" })
  } catch (error) {
    return { action: "failed", version, error: String((error as Error)?.message ?? error) }
  }

  try {
    writeState(statePath, {
      version: TIMER_MIGRATION_STATE_VERSION,
      timersVersion: version,
      installedAt: (options.now?.() ?? new Date()).toISOString(),
    })
  } catch (error) {
    options.log?.("warn", `timer migration state not written: ${String((error as Error)?.message ?? error)}`)
  }

  return { action: "installed", version }
}
