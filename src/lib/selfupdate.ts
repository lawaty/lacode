// LaCode self-update: keep an installed plugin current, with no external tool.
//
// WHY THIS EXISTS: opencode's plugin cache is WRITE-ONCE. It resolves
// `@lawaty/lacode` to an exact version once, freezes it into
// `packages/@lawaty/lacode@latest/package.json`, and never re-resolves -- not on
// restart, not with `opencode plugin -g -f`, not with a range pin, not with a
// tagged config spec. All four were verified against opencode 1.18.34. So a
// published release reaches a client only when something installs it into that
// cache again, and nothing in opencode ever does. This module is that something:
// on startup it compares its own version to npm's `latest` and, when behind,
// re-runs the host's own opencode installer in the background. The new version
// loads on the NEXT start -- opencode never hot-reloads plugins.
//
// NO EXTERNAL TOOL IS ASSUMED. The one thing every client is guaranteed to have
// is the opencode binary itself, because this code runs inside it. npm and bun
// are NOT assumed: the author's own remote host has neither, and the installer
// path here is the same one that worked there with no npm at all.
//
// The module is intentionally pure and injectable (`fetch`, `spawn`, clock and
// paths are all parameters) so the suite can exercise every branch offline.

import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { PACKAGE_NAME } from "./package-root.ts"

export const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
/** Re-check the registry at most this often per machine. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
export const FETCH_TIMEOUT_MS = 4000
export const INSTALL_TIMEOUT_MS = 120_000
/** A lock older than this is presumed abandoned and may be broken. */
export const LOCK_STALE_MS = 10 * 60 * 1000
/** Set on the installer subprocess so the nested run cannot self-update again. */
export const CHILD_ENV = "LACODE_SELFUPDATE_CHILD"
/** The user's explicit off switch for the automatic check. */
export const OPT_OUT_ENV = "LACODE_NO_SELFUPDATE"

/**
 * True when this code is running inside node's test runner (`node --test` sets
 * NODE_TEST_CONTEXT). Several suites boot the real plugin — including the
 * installed-package fixture — and an unguarded check would reach the npm
 * registry and write to the developer's real state dir, breaking the rule that
 * the suite is offline and hermetic. Detection is by env var because the runner
 * sets it; a missing var simply means "not a test", which is the safe default.
 */
export const inTestRunner = (env: Record<string, string | undefined> = process.env): boolean =>
  typeof env.NODE_TEST_CONTEXT === "string" && env.NODE_TEST_CONTEXT.length > 0

export const STATE_DIR = join(homedir(), ".local", "share", "opencode", "lacode")
export const STATE_PATH = join(STATE_DIR, "selfupdate.json")
export const LOCK_PATH = join(STATE_DIR, "selfupdate.lock")

/**
 * Numeric semver compare, ignoring any pre-release/build suffix. Returns -1, 0
 * or 1. Enough for `x.y.z`; it deliberately does not implement full semver
 * ordering, because the two inputs are always this package's own releases.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.split("-")[0].split("+")[0].split(".").map((n) => Number.parseInt(n, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/**
 * The version of the package rooted at `packageRoot`, if it is really ours.
 *
 * `read` is injectable so a caller can describe a package root that is not on
 * this filesystem — `lacode version` reports on a copy the caller names, and a
 * test must not have to build one to assert a version string.
 */
export function readInstalledVersion(
  packageRoot: string,
  read: (path: string) => string | undefined = (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  },
): string | undefined {
  try {
    const raw = read(join(packageRoot, "package.json"))
    if (raw === undefined) return undefined
    const manifest = JSON.parse(raw) as {
      name?: string
      version?: string
    }
    if (manifest.name !== PACKAGE_NAME) return undefined
    return typeof manifest.version === "string" ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * The opencode cache dir (`<...>/lacode@latest`) iff `packageRoot` sits inside
 * one. A plain checkout returns undefined, so a dev tree never self-updates; the
 * extra `package.json` check guards against a random path that merely ends in
 * `node_modules/@lawaty/lacode`.
 */
export function resolveCacheRoot(
  packageRoot: string,
  exists: (p: string) => boolean = (p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  },
): string | undefined {
  const tail = join("node_modules", "@lawaty", "lacode")
  if (!packageRoot.endsWith(tail)) return undefined
  const cacheRoot = resolve(packageRoot, "..", "..", "..")
  if (!exists(join(cacheRoot, "package.json"))) return undefined
  return cacheRoot
}

/**
 * The opencode binary to drive the install. When this code runs inside opencode
 * (a compiled single-file executable) `process.execPath` IS that binary, which
 * makes this exact rather than a search; otherwise fall back to PATH and the
 * conventional install location.
 */
export function resolveOpencodeBin(
  execPath: string = process.execPath,
  env: { PATH?: string } = process.env,
  exists: (p: string) => boolean = (p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  },
): string | undefined {
  if (execPath && /(^|[\\/])opencode(\.exe)?$/.test(execPath)) return execPath
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue
    const candidate = join(dir, "opencode")
    if (exists(candidate)) return candidate
  }
  const fallback = join(homedir(), ".opencode", "bin", "opencode")
  return exists(fallback) ? fallback : undefined
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/** The published `latest` version, or undefined when offline/unreachable. */
export async function fetchLatest(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(REGISTRY_LATEST, { signal: controller.signal })
    if (!response.ok) return undefined
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === "string" ? body.version : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export type UpdateState = {
  checkedAt?: number
  latest?: string
  updatedTo?: string
}

export function readState(path = STATE_PATH): UpdateState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UpdateState
  } catch {
    return {}
  }
}

export function writeState(state: UpdateState, path = STATE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state))
  } catch {
    // losing the throttle marker only costs an extra check next time
  }
}

export const isDue = (state: UpdateState, now: number, interval = CHECK_INTERVAL_MS): boolean =>
  typeof state.checkedAt !== "number" || now - state.checkedAt >= interval

/** Signal-0 existence probe: true if `pid` is running. EPERM means alive but not ours. */
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * A cross-process lock so two opencode processes starting together cannot both
 * rewrite the same cache dir. Created with `wx` (exclusive).
 *
 * A lock is only broken when its holder is PROVABLY gone: the recorded pid is
 * no longer running, or the file is older than LOCK_STALE_MS. That distinction
 * matters because the release runs in a `finally`, and any process that exits
 * mid-install -- a one-shot `opencode debug` command, a test, a closed session --
 * never reaches it. Without a liveness check that orphaned file blocks every
 * later start for the whole grace window, silently, and an updater nobody can
 * tell is stuck is worse than one that is merely late. So a dead holder is
 * reclaimed immediately, and the acquisition is retried so the update is not
 * pushed back by another full cycle.
 */
export function acquireLock(path = LOCK_PATH, now = Date.now()): (() => void) | undefined {
  const claim = (): (() => void) => {
    const fd = openSync(path, "wx")
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return () => {
      try {
        unlinkSync(path)
      } catch {
        // already gone
      }
    }
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    return claim()
  } catch {
    let orphaned = false
    try {
      const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
      orphaned = !Number.isFinite(pid) || pid <= 0 || !isProcessAlive(pid)
    } catch {
      orphaned = true // unreadable or vanished: treat as abandoned
    }
    if (!orphaned) {
      try {
        orphaned = now - statSync(path).mtimeMs > LOCK_STALE_MS
      } catch {
        orphaned = true
      }
    }
    if (!orphaned) return undefined
    try {
      unlinkSync(path)
    } catch {
      return undefined
    }
    try {
      return claim()
    } catch {
      // another process won the reclaimed lock; let it do the work
      return undefined
    }
  }
}

export type CheckResult = {
  installed: string | undefined
  latest: string | undefined
  newer: boolean
  cacheRoot: string | undefined
  bin: string | undefined
}

/** Compare the installed version to npm's latest. Pure of side effects. */
export async function checkForUpdate(opts: {
  packageRoot: string
  fetchImpl?: FetchLike
  execPath?: string
  env?: { PATH?: string }
  exists?: (p: string) => boolean
}): Promise<CheckResult> {
  const installed = readInstalledVersion(opts.packageRoot)
  const latest = await fetchLatest(opts.fetchImpl)
  return {
    installed,
    latest,
    newer: Boolean(installed && latest && compareSemver(latest, installed) > 0),
    cacheRoot: resolveCacheRoot(opts.packageRoot, opts.exists),
    bin: resolveOpencodeBin(opts.execPath, opts.env, opts.exists),
  }
}

/**
 * Re-install the cache dir at `latest` using the opencode binary. The running
 * process keeps its loaded code (Linux survives removing/renaming files in use),
 * so the new version is picked up on the next start. The old dir is renamed
 * aside rather than deleted, and only removed once the fresh install verifies.
 */
export async function refreshCache(opts: {
  cacheRoot: string
  bin: string
  latest: string
  spawnImpl?: typeof spawn
  timeoutMs?: number
}): Promise<{ ok: boolean; detail: string }> {
  const { cacheRoot, bin, latest } = opts
  const spawnImpl = opts.spawnImpl ?? spawn
  const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS
  const fresh = join(cacheRoot, "node_modules", "@lawaty", "lacode")
  const aside = `${cacheRoot}.stale-${Date.now()}`

  try {
    rmSync(aside, { recursive: true, force: true })
    renameSync(cacheRoot, aside)
  } catch (error) {
    return { ok: false, detail: `could not set the old cache aside: ${String(error)}` }
  }

  const exited = await new Promise<boolean>((settle) => {
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(value)
    }
    const child = spawnImpl(bin, ["plugin", PACKAGE_NAME, "-g"], {
      env: { ...process.env, [CHILD_ENV]: "1" },
      stdio: "ignore",
    })
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      finish(false)
    }, timeoutMs)
    child.on("error", () => finish(false))
    child.on("exit", (code: number | null) => finish(code === 0))
  })

  const installed = readInstalledVersion(fresh)
  const ok = exited && installed === latest
  if (ok) {
    try {
      rmSync(aside, { recursive: true, force: true })
    } catch {
      // a leftover backup costs disk, not correctness
    }
  } else {
    try {
      renameSync(aside, cacheRoot)
    } catch {
      // the failed install may have recreated cacheRoot; leave both
    }
  }
  return {
    ok,
    detail: ok ? `installed ${installed}` : `installer exited ${exited ? "0" : "non-zero"}, cache now ${installed ?? "missing"}`,
  }
}

export type MaybeOptions = {
  packageRoot: string
  enabled?: boolean
  now?: () => number
  intervalMs?: number
  statePath?: string
  lockPath?: string
  fetchImpl?: FetchLike
  spawnImpl?: typeof spawn
  execPath?: string
  exists?: (p: string) => boolean
  env?: Record<string, string | undefined>
  log?: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void
}

export type MaybeResult = { action: "skipped" | "current" | "updated" | "failed" | "disabled"; detail?: string }

/**
 * The throttled startup entry point. Checks at most once per interval, guarded
 * by a cross-process lock, and never throws into the caller: every failure is a
 * return value. `enabled: false` and the opt-out env stand it down entirely.
 */
export async function maybeSelfUpdate(opts: MaybeOptions): Promise<MaybeResult> {
  const env = opts.env ?? process.env
  if (opts.enabled === false || env[CHILD_ENV] === "1" || env[OPT_OUT_ENV] === "1" || inTestRunner(env)) {
    return { action: "disabled" }
  }
  const now = (opts.now ?? Date.now)()
  const statePath = opts.statePath ?? STATE_PATH
  const state = readState(statePath)
  if (!isDue(state, now, opts.intervalMs ?? CHECK_INTERVAL_MS)) return { action: "skipped", detail: "checked recently" }

  const release = acquireLock(opts.lockPath, now)
  if (!release) return { action: "skipped", detail: "another process is updating" }

  try {
    const check = await checkForUpdate(opts)
    if (!check.installed) return { action: "skipped", detail: "no installed version" }
    if (!check.latest) {
      writeState({ ...state, checkedAt: now }, statePath)
      return { action: "skipped", detail: "registry unreachable" }
    }
    if (!check.newer) {
      writeState({ ...state, checkedAt: now, latest: check.latest }, statePath)
      return { action: "current", detail: `${check.installed} is current` }
    }
    if (!check.cacheRoot) {
      writeState({ ...state, checkedAt: now, latest: check.latest }, statePath)
      return { action: "skipped", detail: "not an opencode cache install" }
    }
    if (!check.bin) {
      writeState({ ...state, checkedAt: now, latest: check.latest }, statePath)
      opts.log?.("warn", `LaCode ${check.latest} is available but no opencode binary was found to install it`)
      return { action: "failed", detail: "no opencode binary" }
    }
    const result = await refreshCache({ cacheRoot: check.cacheRoot, bin: check.bin, latest: check.latest, spawnImpl: opts.spawnImpl })
    if (result.ok) {
      writeState({ ...state, checkedAt: now, latest: check.latest, updatedTo: check.latest }, statePath)
      opts.log?.("info", `LaCode updated ${check.installed} -> ${check.latest}; restart opencode to apply`)
      return { action: "updated", detail: `${check.installed} -> ${check.latest}` }
    }
    writeState({ ...state, checkedAt: now, latest: check.latest }, statePath)
    opts.log?.("warn", `LaCode update to ${check.latest} failed: ${result.detail}`)
    return { action: "failed", detail: result.detail }
  } finally {
    release()
  }
}
