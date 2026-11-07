#!/usr/bin/env node
// Daily-refreshable pool builder.
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
//   3. at most one opencode model as a last resort, weight 2, with b:opencode
//
// Total = n + min(10 - n, #others), where n = #1.
//
// This file ships as source and must run with plain `node` (ESM, no TS).

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir, userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HOME = homedir()
export const DEFAULT_SCORES_PATH = join(HOME, ".config", "lacode", "model-scores.json")
export const DEFAULT_POOL_PATH = join(HOME, ".config", "lacode", "pool.txt")
export const SYSTEMD_USER_DIR = (home = HOME) => join(home, ".config", "systemd", "user")
export const STABLE_LIB_DIR = (home = HOME) => join(home, ".local", "lib", "lacode")
export const STABLE_SCRIPT = (home = HOME) => join(STABLE_LIB_DIR(home), "refresh-pool.mjs")
export const STABLE_SCORER = (home = HOME) => join(STABLE_LIB_DIR(home), "score-models.mjs")
export const STABLE_SELECTION = (home = HOME) => join(STABLE_LIB_DIR(home), "pool-selection.mjs")
export const REFRESH_SERVICE_NAME = "lacode-refresh-pool.service"
export const REFRESH_TIMER_NAME = "lacode-refresh-pool.timer"

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

function runScorer(max) {
  const here = dirname(fileURLToPath(import.meta.url))
  const scorer = resolve(here, "score-models.mjs")
  if (!existsSync(scorer)) throw new Error(`scorer not found: ${scorer}`)
  const args = [scorer, "--max", String(max)]
  execFileSync(process.execPath, args, { stdio: "inherit" })
}

export function scheduleRetry(retry, options = {}) {
  const at = Date.parse(retry?.after ?? "")
  if (!Number.isFinite(at)) return { scheduled: false, reason: "no reset time" }
  const now = options.now ?? Date.now
  const nowMs = now()
  const seconds = Math.ceil((at - nowMs) / 1000)
  if (!Number.isFinite(seconds) || seconds <= 0) return { scheduled: false, reason: "reset is not in the future" }
  if (seconds > 24 * 60 * 60) return { scheduled: false, reason: "reset is more than a day away" }
  const exec = options.exec ?? execFileSync
  const scriptPath = options.scriptPath ?? fileURLToPath(import.meta.url)
  const nodePath = options.nodePath ?? process.execPath
  const home = options.home ?? HOME
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
      ],
      { stdio: "ignore" },
    )
    return { scheduled: true, seconds, after: retry.after }
  } catch (error) {
    return { scheduled: false, reason: String(error?.message ?? error) }
  }
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
ExecStart=${nodePath} ${scriptPath}
Environment=PATH=${home}/.opencode/bin:/usr/local/bin:/usr/bin:/bin
Nice=10
`
  const timer = `[Unit]
Description=Daily LaCode model pool refresh

[Timer]
OnCalendar=*-*-* 01:00:00
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
  return true
}

function usage() {
  console.log(`Usage: node scripts/refresh-pool.mjs [options]

  --from-scores     skip scoring, use the existing ~/.config/lacode/model-scores.json
  --no-retry        do not schedule a transient retry after a rate-limited run
  --install-timer   install and enable a user systemd oneshot service + daily timer
                    (add --stable to copy the script to ~/.local/lib/lacode and
                    point ExecStart there, so plugin-cache updates do not break it)
  --print           print the proposed pool.txt and make no changes (alias: --dry-run)
  --dry-run         same as --print
  --max N           models per provider passed to the scorer (default: 50)
  --scores PATH     scores file (default: ${DEFAULT_SCORES_PATH})
  --pool PATH       pool file to read/compare/write (default: ${DEFAULT_POOL_PATH})
  -h, --help        this message`)
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
  const value = (flag, fallback) => {
    const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`))
    if (!hit) return fallback
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : argv[argv.indexOf(hit) + 1]
  }
  const max = Math.max(1, Number(value("--max", "50")) || 50)
  const scoresPath = value("--scores", DEFAULT_SCORES_PATH)
  const poolPath = value("--pool", DEFAULT_POOL_PATH)

  if (!fromScores) {
    try {
      runScorer(max)
    } catch (error) {
      console.error(`scorer failed; pool.txt not written: ${String(error?.message ?? error)}`)
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

  const currentPoolText = readTextFile(poolPath)
  let built
  try {
    built = buildPool({ scores, currentPoolText, now: new Date() })
  } catch (error) {
    console.error(`refresh refused (fail closed): ${String(error?.message ?? error)}`)
    process.exitCode = 1
    return
  }

  const oldSlotCount = splitHeaderAndSlots(currentPoolText).slots.filter(isSlotLine).length
  const newSlotCount = built.slots.filter(isSlotLine).length
  const dropped = scores.providers.flatMap((entry) => (Array.isArray(entry?.excluded) ? entry.excluded : []))
  const summary = [
    `selected [${built.chosen.selected.join(", ")}]`,
    ...(dropped.length ? [`dropped ${dropped.length} model(s) below the context/score floor`] : []),
    ...(built.warnings.length ? [`warnings [${built.warnings.join("; ")}]`] : []),
  ].join(" | ")

  if (!printOnly && !noRetry) {
    const scheduled = scheduleRetry(scores.retry)
    if (scheduled.scheduled) {
      console.log(`scheduled retry in ${scheduled.seconds}s for ${scores.retry.models.length} model(s) at ${scheduled.after}`)
    } else if (scores.retry) {
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
