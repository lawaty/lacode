#!/usr/bin/env node
// Refreshable pool builder; the installed systemd timer runs it every 6 hours.
//
// Reads the scorer's output (~/.config/lacode/model-scores.json) and proposes a
// rewritten ~/.config/lacode/pool.txt. It never partially writes and never
// writes on a fail-closed condition.
//
// Layout (exact, per spec):
//   1. every opencode-go model with ok:true, a numeric score at or above the
//      score floor and a context at or above the context floor, sorted by score
//      descending, weight 4
//   2. the best (10 - n) models from every provider other than opencode,
//      sorted by score descending, weight 2
//   3. exactly one opencode model as the reserved last slot, weight 2, with
//      b:opencode, when a rankable opencode model exists
//
// Total = n + (others up to 10 - n - zen) + zen, where n = #1.
//
// This file ships as source and must run with plain `node` (ESM, no TS).

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir, tmpdir, userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fetchProviderStatus, statusDeprioritizedProviders } from "./provider-status.mjs"
import { POOL_SIZE, isTransientFailure, parsePoolSlots, poolStructureValid } from "./pool-selection.mjs"

const HOME = homedir()
export const DEFAULT_SCORES_PATH = join(HOME, ".config", "lacode", "model-scores.json")
export const DEFAULT_POOL_PATH = join(HOME, ".config", "lacode", "pool.txt")
export const SYSTEMD_USER_DIR = (home = HOME) => join(home, ".config", "systemd", "user")
export const STABLE_LIB_DIR = (home = HOME) => join(home, ".local", "lib", "lacode")
export const STABLE_SCRIPT = (home = HOME) => join(STABLE_LIB_DIR(home), "refresh-pool.mjs")
export const STABLE_SCORER = (home = HOME) => join(STABLE_LIB_DIR(home), "score-models.mjs")
export const STABLE_SELECTION = (home = HOME) => join(STABLE_LIB_DIR(home), "pool-selection.mjs")
export const STABLE_STATUS = (home = HOME) => join(STABLE_LIB_DIR(home), "provider-status.mjs")
export const REFRESH_SERVICE_NAME = "lacode-refresh-pool.service"
export const REFRESH_TIMER_NAME = "lacode-refresh-pool.timer"

/**
 * A refresh must never replace a working pool with a degenerate one. When the
 * new selection falls below the keep threshold, the previous pool.txt is left
 * untouched, the failure is logged loudly, and a fast retry is scheduled.
 * The threshold is half the previous pool (rounded down), with a floor of
 * MIN_POOL_SLOTS so a thin-but-real pool is still protected.
 */
export const MIN_POOL_SLOTS = 4
/** While degraded, recheck on this cadence instead of waiting out a long reset. */
export const DEGRADED_RETRY_S = 5 * 60

const REFRESH_LOCK_DIR = join(HOME, ".config", "lacode", "refresh.lock")
const REFRESH_LOCK_STALE_MS = 60 * 60 * 1000

/**
 * One refresh at a time. The 6-hourly service and a transient retry timer can
 * otherwise overlap and race on model-scores.json. A killed run leaves the lock
 * behind, so a live PID keeps it only for an hour; a dead PID or a stale lock is
 * reclaimed by the next run.
 */
function acquireRefreshLock() {
  const take = () => {
    mkdirSync(REFRESH_LOCK_DIR)
    writeFileSync(join(REFRESH_LOCK_DIR, "pid"), String(process.pid))
    return true
  }
  try {
    return take()
  } catch {}
  try {
    const stat = statSync(REFRESH_LOCK_DIR)
    let pid = 0
    try {
      pid = Number(readFileSync(join(REFRESH_LOCK_DIR, "pid"), "utf8"))
    } catch {}
    let alive = false
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch {}
    }
    if (alive && Date.now() - stat.mtimeMs < REFRESH_LOCK_STALE_MS) return false
    rmSync(REFRESH_LOCK_DIR, { recursive: true, force: true })
    return take()
  } catch {
    return false
  }
}

function releaseRefreshLock() {
  try {
    rmSync(REFRESH_LOCK_DIR, { recursive: true, force: true })
  } catch {}
}

const isSlotLine = (line) => {
  const stripped = String(line).split("#")[0].trim()
  return stripped.length > 0 && stripped.includes("/")
}

function splitHeaderAndSlots(text) {
  const lines = String(text ?? "").split(/\r?\n/)
  // Drop a single trailing empty element produced by a final newline so we can
  // reason about the file's logical lines; we re-add a final newline on output.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  let first = -1
  for (let i = 0; i < lines.length; i++) {
    if (isSlotLine(lines[i])) { first = i; break }
  }
  if (first === -1) return { header: lines, slots: [] }
  return { header: lines.slice(0, first), slots: lines.slice(first) }
}

function refreshComment(now, scoresGeneratedAt) {
  const when = now instanceof Date ? now.toISOString() : String(now)
  const gen = scoresGeneratedAt ? ` (scores generated ${scoresGeneratedAt})` : ""
  return `# Refreshed ${when} from model-scores.json${gen}: opencode-go first (weight 4), small-context providers (weight 2), large-context providers (weight 1), opencode last (max 1).`
}

function withRefreshComment(headerLines, comment) {
  const kept = headerLines.filter((line) => !/^#\s*Refreshed\b/.test(String(line)))
  return [...kept, comment]
}

function formatGeneratedLine(model, weight, bucket, context) {
  const parts = [String(model), String(weight)]
  if (context != null && Number.isFinite(Number(context))) parts.push(`c:${Math.round(Number(context))}`)
  if (bucket) parts.push(`b:${bucket}`)
  return parts.join("  ")
}

/**
 * Pure builder. Throws on every fail-closed condition; never touches the filesystem.
 *
 * @param {{ scores: any, currentPoolText: string, now?: Date|string }} input
 * @returns {{ text: string, slots: string[], warnings: string[], chosen: { selected: string[] } }}
 */
export function buildPool(input) {
  const scores = input?.scores
  if (!scores || typeof scores !== "object" || !Array.isArray(scores.providers) || !Array.isArray(scores.selection)) {
    throw new Error("score file is missing or invalid (expected { providers: [...], selection: [...] })")
  }
  const selection = scores.selection.filter(
    (entry) =>
      entry &&
      typeof entry.model === "string" &&
      entry.model.includes("/") &&
      typeof entry.weight === "number" &&
      Number.isFinite(entry.weight) &&
      entry.weight > 0,
  )
  if (selection.length === 0) {
    throw new Error("score file has no selected models; refusing to write pool.txt")
  }
  const warnings = Array.isArray(scores.warnings) ? scores.warnings : []
  const { header } = splitHeaderAndSlots(input?.currentPoolText ?? "")
  const outSlots = selection.map((entry) => formatGeneratedLine(entry.model, entry.weight, entry.bucket, entry.context))
  const comment = refreshComment(input?.now ?? new Date(), scores.generatedAt)
  const outHeader = withRefreshComment(header, comment)
  const text = [...outHeader, "", ...outSlots, ""].join("\n")
  return {
    text,
    slots: outSlots,
    warnings,
    chosen: { selected: selection.map((entry) => entry.model) },
  }
}

function readJsonFile(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`)
  const raw = readFileSync(path, "utf8")
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${String(error?.message ?? error)}`)
  }
}

function readTextFile(path) {
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8")
}

function atomicWriteSimple(path, text) {
  const dir = dirname(path)
  const tmp = join(dir, `.pool.txt.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmp, text, "utf8")
  renameSync(tmp, path)
}

function writeFileAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, "utf8")
  renameSync(tmp, path)
}

function runScorer(max, extraArgs = []) {
  const here = dirname(fileURLToPath(import.meta.url))
  const scorer = resolve(here, "score-models.mjs")
  if (!existsSync(scorer)) throw new Error(`scorer not found: ${scorer}`)
  const args = [scorer, "--max", String(max), ...extraArgs]
  execFileSync(process.execPath, args, { stdio: "inherit" })
}

/**
 * Cheap health check: probe exactly the current pool members (no catalogue
 * sweep). Every member answers → the pool stands as-is: no full scan, no
 * retry, back to the 6-hour cadence. Anything else → false, and the caller
 * runs a full scan to verify. Returns true when the pool stands.
 */
function runCanary({ currentPoolText, scorerArgs, max }) {
  const members = parsePoolSlots(currentPoolText).map((slot) => slot.model)
  if (members.length === 0) return false
  const tmp = join(tmpdir(), `lacode-canary-${process.pid}.json`)
  try {
    runScorer(Math.max(max, members.length), [...scorerArgs, "--probe-models", members.join(","), "--out", tmp])
    const payload = JSON.parse(readFileSync(tmp, "utf8"))
    const answered = new Set()
    for (const entry of payload?.providers ?? []) {
      for (const row of entry?.rows ?? []) {
        if (row?.model && row?.ok === true) answered.add(row.model)
      }
    }
    const missing = members.filter((model) => !answered.has(model))
    if (missing.length === 0) {
      console.log(`canary healthy: all ${members.length} pool member(s) answered; pool stands, no full scan`)
      return true
    }
    console.log(`canary: ${missing.length} member(s) not answering (${missing.join(", ")}); running a full scan`)
    return false
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {}
  }
}

/**
 * Count the usable model slots in a pool.txt text (comments and blanks ignored).
 */
export function poolSlotCount(text) {
  return splitHeaderAndSlots(text).slots.filter(isSlotLine).length
}

/**
 * Bench-in-place file layout. Must match src/lib/pool.ts: the runtime treats
 * these files as flat cooling records (never strikes) and re-admits a model
 * the moment a probe watches it answer.
 */
export const SCAN_BENCH_REASON = "scan-kept"
export const SCAN_BENCH_WINDOW_MS = 45 * 60 * 1000
export const scanBenchDir = (home = HOME) => join(home, ".local", "share", "opencode", "agent-pool")
export const scanBenchFile = (model) => `limit.${String(model).replace(/[^a-zA-Z0-9._-]/g, "__")}.json`

/**
 * Pure bench plan for the current pool members. A member whose current row
 * failed transiently is benched until its stated reset (else 45 minutes); a
 * member that answered has any stale bench cleared; an unscanned member is
 * left alone for lack of evidence. Only pool members are ever touched.
 */
export function computeScanBench({ selectionModels, providers, now = Date.now() }) {
  const currentByModel = new Map()
  for (const entry of Array.isArray(providers) ? providers : []) {
    for (const row of Array.isArray(entry?.rows) ? entry.rows : []) {
      if (row?.model && !currentByModel.has(row.model)) currentByModel.set(row.model, row)
    }
  }
  const bench = []
  const clear = []
  for (const model of selectionModels ?? []) {
    const row = currentByModel.get(model)
    if (!row) continue
    if (row.ok !== false) {
      clear.push(model)
      continue
    }
    if (!isTransientFailure(row)) continue
    const at = Number(row.retryAfter)
    bench.push({
      model,
      until: Number.isFinite(at) && at > now ? at : now + SCAN_BENCH_WINDOW_MS,
      kind: String(row.kind ?? "unknown"),
    })
  }
  return { bench, clear }
}

/** Apply a bench plan with atomic writes; every failure is best-effort. */
export function applyScanBench({ dir, bench, clear }) {
  const applied = { benched: [], cleared: [] }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  for (const { model, until } of bench ?? []) {
    try {
      const record = { model, until, strikes: 1, reason: SCAN_BENCH_REASON, last: Date.now() }
      const tmp = join(dir, `${scanBenchFile(model)}.tmp-${process.pid}`)
      writeFileSync(tmp, JSON.stringify(record))
      renameSync(tmp, join(dir, scanBenchFile(model)))
      applied.benched.push(model)
    } catch {}
  }
  for (const model of clear ?? []) {
    try {
      rmSync(join(dir, scanBenchFile(model)), { force: true })
      applied.cleared.push(model)
    } catch {}
  }
  return applied
}

/**
 * Pure fail-closed guard. A refresh must never break the pool's structure or
 * replace a working pool with a degenerate selection: the new pool must keep
 * the opencode-go head and the opencode tail the current pool has, and hold at
 * least half of POOL_SIZE. The baseline is the contract size, never the
 * current file — a previously shrunk pool can always grow back, but no write
 * may shrink or behead it. There is no previous pool on a first-ever run, so
 * there is nothing to protect and the guard passes. `--force-write` is the
 * human override for a genuinely changed catalogue.
 */
export function shouldKeepPool({ currentPoolText, newSlots }) {
  const prev = poolSlotCount(currentPoolText ?? "")
  if (prev <= 0) return { keep: false, prev, threshold: 0, reason: "no previous pool to protect" }
  const slots = Array.isArray(newSlots) ? newSlots : []
  const threshold = Math.max(MIN_POOL_SLOTS, Math.floor(POOL_SIZE / 2))
  const currentCheck = poolStructureValid(currentPoolText)
  const newCheck = poolStructureValid(slots)
  if (currentCheck.valid && !newCheck.valid) {
    return {
      keep: true,
      prev,
      threshold,
      reason: `new selection breaks the pool structure (${newCheck.problems.join("; ")}); keeping the previous pool`,
    }
  }
  if (slots.filter(isSlotLine).length >= threshold) return { keep: false, prev, threshold, reason: "" }
  return {
    keep: true,
    prev,
    threshold,
    reason: `new selection has ${slots.filter(isSlotLine).length} usable slot(s), below the keep threshold of ${threshold} (contract pool size ${POOL_SIZE}); refusing to shrink the pool`,
  }
}

/**
 * How long until the next look while degraded. A provider reset in the future
 * is honoured, but the wait never exceeds the degraded cadence: a reset hours
 * out must not stop the 5-minute rechecks, and a reset that already passed
 * means recheck on the cadence. No retry information at all also means the
 * cadence.
 */
export function degradedRetryDelay(retry, now = Date.now()) {
  const at = Date.parse(retry?.after ?? "")
  if (!Number.isFinite(at)) return DEGRADED_RETRY_S
  const wait = Math.ceil((at - now) / 1000)
  if (wait <= 0) return DEGRADED_RETRY_S
  return Math.min(wait, DEGRADED_RETRY_S)
}

export function scheduleRetryIn(seconds, options = {}) {
  if (!Number.isFinite(seconds) || seconds <= 0) return { scheduled: false, reason: "delay is not in the future" }
  if (seconds > 24 * 60 * 60) return { scheduled: false, reason: "delay is more than a day away" }
  const exec = options.exec ?? execFileSync
  const scriptPath = options.scriptPath ?? fileURLToPath(import.meta.url)
  const nodePath = options.nodePath ?? process.execPath
  const home = options.home ?? HOME
  const extraArgs = Array.isArray(options.args) ? options.args : []
  const nowMs = (options.now ?? Date.now)()
  const path = `${home}/.opencode/bin:/usr/local/bin:/usr/bin:/bin`
  const unit = `lacode-refresh-pool-retry-${Math.floor(nowMs / 1000).toString(36)}`
  try {
    exec(
      "systemd-run",
      [
        "--user",
        "--collect",
        `--unit=${unit}`,
        `--on-active=${seconds}`,
        `--setenv=HOME=${home}`,
        `--setenv=PATH=${path}`,
        nodePath,
        scriptPath,
        ...extraArgs,
      ],
      { stdio: "ignore" },
    )
    return { scheduled: true, seconds }
  } catch (error) {
    return { scheduled: false, reason: String(error?.message ?? error) }
  }
}

export function scheduleRetry(retry, options = {}) {
  const at = Date.parse(retry?.after ?? "")
  if (!Number.isFinite(at)) return { scheduled: false, reason: "no reset time" }
  const nowMs = (options.now ?? Date.now)()
  const seconds = Math.ceil((at - nowMs) / 1000)
  if (!Number.isFinite(seconds) || seconds <= 0) return { scheduled: false, reason: "reset is not in the future" }
  if (seconds > 24 * 60 * 60) return { scheduled: false, reason: "reset is more than a day away" }
  const scheduled = scheduleRetryIn(seconds, options)
  if (scheduled.scheduled) return { ...scheduled, after: retry.after }
  return scheduled
}

/** Schedule a recheck on the degraded cadence (default 5 minutes). Retries run
 * a cheap canary first and only fall back to a full scan when a pool member
 * stops answering. */
export function scheduleRetrySoon(seconds = DEGRADED_RETRY_S, options = {}) {
  return scheduleRetryIn(seconds, { ...options, args: [...(options.args ?? []), "--canary"] })
}

export function renderTimerUnits(input = {}) {
  const nodePath = input.nodePath || process.execPath
  const scriptPath = input.scriptPath || fileURLToPath(import.meta.url)
  const home = input.home || HOME
  const servicePath = join(SYSTEMD_USER_DIR(home), REFRESH_SERVICE_NAME)
  const timerPath = join(SYSTEMD_USER_DIR(home), REFRESH_TIMER_NAME)
  const service = `[Unit]
Description=Refresh the LaCode model pool from free-model scores
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
TimeoutStartSec=infinity
ExecStart=${nodePath} ${scriptPath}
Environment=PATH=${home}/.opencode/bin:/usr/local/bin:/usr/bin:/bin
Nice=10
`
  const timer = `[Unit]
Description=LaCode model pool refresh every 6 hours

[Timer]
OnCalendar=*-*-* 00/6:00:00
# A reboot kills a run mid-scan. Persistent=true does NOT retry that, because
# systemd records the trigger when the service starts, not when it succeeds, so
# the 6-hour slot is already spent even though the run never finished. A startup
# trigger gives the next boot a fresh run even if the previous one was killed.
OnStartupSec=5min
Persistent=true
Unit=${REFRESH_SERVICE_NAME}

[Install]
WantedBy=timers.target
`
  return { service, timer, servicePath, timerPath }
}

function installTimerUnits(stable = false) {
  const live = fileURLToPath(import.meta.url)
  const scriptPath = stable ? STABLE_SCRIPT(HOME) : live
  const units = renderTimerUnits({ nodePath: process.execPath, scriptPath, home: HOME })
  try {
    if (stable) {
      mkdirSync(STABLE_LIB_DIR(HOME), { recursive: true })
      copyFileSync(live, scriptPath)
      copyFileSync(resolve(dirname(live), "score-models.mjs"), STABLE_SCORER(HOME))
      copyFileSync(resolve(dirname(live), "pool-selection.mjs"), STABLE_SELECTION(HOME))
      copyFileSync(resolve(dirname(live), "provider-status.mjs"), STABLE_STATUS(HOME))
    }
    mkdirSync(dirname(units.servicePath), { recursive: true })
    writeFileAtomic(units.servicePath, units.service)
    writeFileAtomic(units.timerPath, units.timer)
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" })
    execFileSync("systemctl", ["--user", "enable", "--now", REFRESH_TIMER_NAME], { stdio: "inherit" })
    try {
      execFileSync("loginctl", ["enable-linger", userInfo().username], { stdio: "ignore" })
    } catch {}
  } catch (error) {
    console.error(`failed to install systemd user timer: ${String(error?.message ?? error)}`)
    console.error(`unit files written:`)
    console.error(`  ${units.servicePath}`)
    console.error(`  ${units.timerPath}`)
    console.error(`manual commands:`)
    console.error(`  systemctl --user daemon-reload`)
    console.error(`  systemctl --user enable --now ${REFRESH_TIMER_NAME}`)
    process.exitCode = 1
    return false
  }
  if (stable) console.log(`copied ${live}, score-models.mjs and pool-selection.mjs to ${STABLE_LIB_DIR(HOME)}`)
  console.log(`installed ${units.servicePath}`)
  console.log(`installed ${units.timerPath}`)
  console.log(`enabled ${REFRESH_TIMER_NAME}`)
  console.log(`refresh now: systemctl --user start ${REFRESH_SERVICE_NAME}`)
  return true
}

function usage() {
  console.log(`Usage: node scripts/refresh-pool.mjs [options]

  --from-scores     skip scoring, use the existing ~/.config/lacode/model-scores.json
  --no-retry        do not schedule a transient retry after a rate-limited run
  --install-timer   install and enable a user systemd oneshot service + 6-hourly
                    timer (add --stable to copy the script to ~/.local/lib/lacode
                    and point ExecStart there, so plugin-cache updates do not break
                    it). Refresh on demand with:
                    systemctl --user start lacode-refresh-pool.service
  --print           print the proposed pool.txt and make no changes (alias: --dry-run)
  --dry-run         same as --print
  --canary          probe only the current pool members; run a full scan only
                    when one stops answering (used by degraded rechecks)
  --max N           models per provider passed to the scorer (default: 50)
  --scores PATH     scores file (default: ${DEFAULT_SCORES_PATH})
  --pool PATH       pool file to read/compare/write (default: ${DEFAULT_POOL_PATH})
  --force-write   write the new selection even when the fail-closed guard would
                    keep the previous pool (human override for a changed catalogue)
  -h, --help        this message

Degradation behaviour: before scanning, the refresh reads
https://status.opencode.ai/api/status. The page is a hint, never a verdict:
sick providers are only probed last, and nothing is ever skipped or benched
because of it. A canary (--canary, used by every degraded recheck) probes only
the current pool members and runs a full scan solely when one stops answering.
After a scan, a selection that breaks the pool structure or falls below half
the contract pool size (minimum ${MIN_POOL_SLOTS} slots) is never written; the
previous pool is kept, transiently failed members are still benched in place,
and a 5-minute canary recheck is scheduled. A retry is always rechecked
within 5 minutes while anything failed, even when the stated reset is hours out.`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) { usage(); return }
    if (argv.includes("--install-timer")) {
      installTimerUnits(argv.includes("--stable"))
      return
    }
  const fromScores = argv.includes("--from-scores")
  const printOnly = argv.includes("--print") || argv.includes("--dry-run")
  const noRetry = argv.includes("--no-retry")
  const forceWrite = argv.includes("--force-write")
  const value = (flag, fallback) => {
    const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`))
    if (!hit) return fallback
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : argv[argv.indexOf(hit) + 1]
  }
  const max = Math.max(1, Number(value("--max", "50")) || 50)
  const scoresPath = value("--scores", DEFAULT_SCORES_PATH)
  const poolPath = value("--pool", DEFAULT_POOL_PATH)

  if (!printOnly) {
    if (!acquireRefreshLock()) {
      console.log("another LaCode pool refresh is already running; skipping this run")
      return
    }
    process.once("exit", releaseRefreshLock)
  }

  const currentPoolText = readTextFile(poolPath)
  const canary = argv.includes("--canary")

  // Live status is a hint, never a verdict. Gating services that report down
  // or degraded only reorder probes (sick providers last) so they cannot eat
  // the scan budget. Nothing is ever skipped or benched because of the page —
  // only real probe evidence benches a model, and the write guard below
  // protects the pool if the scan comes back degenerate.
  let deprioritized = []
  if (!printOnly && !fromScores) {
    try {
      deprioritized = statusDeprioritizedProviders(await fetchProviderStatus())
    } catch (error) {
      console.log(`live status unreadable (${String(error?.message ?? error)}); scanning in default order`)
    }
    if (deprioritized.length > 0) {
      console.log(`status hint: probing ${deprioritized.join(", ")} last`)
    }
  }
  const scorerArgs = [`--current-pool`, poolPath]
  if (deprioritized.length > 0) scorerArgs.push(`--deprioritize-providers`, deprioritized.join(","))

  const runFullScan = () => runScorer(max, scorerArgs)

  if (!fromScores) {
    try {
      if (canary) {
        runCanary({ poolPath, currentPoolText, scorerArgs, max })
      } else {
        runFullScan()
      }
    } catch (error) {
      console.error(`scorer failed; pool.txt not written: ${String(error?.message ?? error)}`)
      if (!printOnly && !noRetry) {
        const scheduled = scheduleRetrySoon()
        console.log(
          scheduled.scheduled
            ? `scheduled degraded recheck in ${scheduled.seconds}s`
            : `degraded recheck not scheduled: ${scheduled.reason}`,
        )
      }
      process.exitCode = 1
      return
    }
  }

  let scores
  try {
    scores = readJsonFile(scoresPath)
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exitCode = 1
    return
  }

  let built
  try {
    built = buildPool({ scores, currentPoolText, now: new Date() })
  } catch (error) {
    console.error(`refresh refused (fail closed): ${String(error?.message ?? error)}`)
    if (!printOnly && !noRetry) {
      const scheduled = scheduleRetrySoon()
      console.log(
        scheduled.scheduled
          ? `scheduled degraded recheck in ${scheduled.seconds}s`
          : `degraded recheck not scheduled: ${scheduled.reason}`,
      )
    }
    process.exitCode = 1
    return
  }

  const oldSlotCount = poolSlotCount(currentPoolText)
  const newSlotCount = built.slots.filter(isSlotLine).length

  // Bench-in-place: a pool member this run failed transiently keeps its slot
  // and gets a flat cooling record the runtime already honours; a member that
  // answered has any stale bench cleared. Unscanned members are left alone.
  // Runs on the write path and the refusal path alike — a kept pool still
  // learns what the scan found.
  if (!printOnly) {
    const plan = computeScanBench({ selectionModels: built.chosen.selected, providers: scores.providers })
    const applied = applyScanBench({ dir: scanBenchDir(), bench: plan.bench, clear: plan.clear })
    if (applied.benched.length > 0) {
      const detail = plan.bench.map((entry) => `${entry.model} (${entry.kind})`).join(", ")
      console.log(`scan benched in place: ${detail}`)
    }
    if (applied.cleared.length > 0) console.log(`scan cleared stale benches: ${applied.cleared.join(", ")}`)
  }
  const dropped = scores.providers.flatMap((entry) => (Array.isArray(entry?.excluded) ? entry.excluded : []))
  const summary = [
    `selected [${built.chosen.selected.join(", ")}]`,
    ...(dropped.length ? [`dropped ${dropped.length} model(s) below the context/score floor`] : []),
    ...(built.warnings.length ? [`warnings [${built.warnings.join("; ")}]`] : []),
  ].join(" | ")

  // Fail closed on a degenerate selection: keep the previous pool, say so
  // loudly, and recheck in 5 minutes instead of waiting out a long reset.
  // --force-write is the human override for a genuinely changed catalogue.
  if (!printOnly && !forceWrite) {
    const kept = shouldKeepPool({ currentPoolText, newSlots: built.slots })
    if (kept.keep) {
      console.error(`refresh refused (fail closed): ${kept.reason}`)
      if (!noRetry) {
        const scheduled = scheduleRetrySoon()
        console.log(
          scheduled.scheduled
            ? `scheduled degraded recheck in ${scheduled.seconds}s`
            : `degraded recheck not scheduled: ${scheduled.reason}`,
        )
      }
      process.exitCode = 1
      return
    }
  }

  if (!printOnly && !noRetry && scores.retry) {
    const scheduled = scheduleRetrySoon(degradedRetryDelay(scores.retry))
    if (scheduled.scheduled) {
      console.log(`scheduled retry in ${scheduled.seconds}s for ${scores.retry.models.length} model(s) (reset ${scores.retry.after})`)
    } else {
      console.log(`retry not scheduled: ${scheduled.reason}`)
    }
  }

  if (printOnly) {
    process.stdout.write(built.text)
    console.error(`--print: proposed ${oldSlotCount} -> ${newSlotCount} slots; no changes written. ${summary}`)
    return
  }

  if (existsSync(poolPath)) {
    try {
      const existing = readFileSync(poolPath, "utf8")
      if (existing === built.text) {
        console.log(`unchanged: ${poolPath} (${newSlotCount} slots). ${summary}`)
        return
      }
    } catch {}
  }

  try {
    atomicWriteSimple(poolPath, built.text)
  } catch (error) {
    console.error(`failed to write ${poolPath}: ${String(error?.message ?? error)}`)
    process.exitCode = 1
    return
  }
  console.log(`wrote ${poolPath}: ${oldSlotCount} -> ${newSlotCount} slots. ${summary}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(String(error?.stack ?? error?.message ?? error))
    process.exitCode = 1
  })
}
