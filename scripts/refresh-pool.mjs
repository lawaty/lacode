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
//   2. the best (10 - n) models from every other provider, sorted by score
//      descending, weight 2; opencode models get b:opencode
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
export const REFRESH_SERVICE_NAME = "lacode-refresh-pool.service"
export const REFRESH_TIMER_NAME = "lacode-refresh-pool.timer"

const isSlotLine = (line) => {
  const stripped = String(line).split("#")[0].trim()
  return stripped.length > 0 && stripped.includes("/")
}

const providerOf = (modelOrLine) => {
  const stripped = String(modelOrLine).split("#")[0].trim()
  const token = stripped.split(/\s+/)[0] || ""
  const slash = token.indexOf("/")
  return slash < 0 ? token : token.slice(0, slash)
}

const numericScore = (row) => typeof row?.score === "number" && Number.isFinite(row.score)

// Fallbacks for score files written before the floors were recorded there.
const MIN_CONTEXT = 200_000
const MIN_SCORE = 60
const POOL_SIZE = 10

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
  return `# Refreshed ${when} from model-scores.json${gen}: opencode-go first (weight 4), then the best others (weight 2).`
}

function withRefreshComment(headerLines, comment) {
  const kept = headerLines.filter((line) => !/^#\s*Refreshed\b/.test(String(line)))
  return [...kept, comment]
}

function formatGeneratedLine(model, weight, bucket) {
  const parts = [String(model), String(weight)]
  if (bucket) parts.push(`b:${bucket}`)
  return parts.join("  ")
}

/**
 * Pure builder. Throws on every fail-closed condition; never touches the filesystem.
 *
 * @param {{ scores: any, currentPoolText: string, now?: Date|string }} input
 * @returns {{ text: string, slots: string[], warnings: string[], chosen: { opencodeGo: string[], others: string[] } }}
 */
export function buildPool(input) {
  const warnings = []
  const scores = input?.scores
  if (!scores || typeof scores !== "object" || !Array.isArray(scores.providers)) {
    throw new Error("score file is missing or invalid (expected { providers: [...] })")
  }

  const minScore = Number(scores.minScore) || MIN_SCORE
  const minContext = Number(scores.minContext) || MIN_CONTEXT
  const rankable = (row) =>
    row?.ok === true &&
    numericScore(row) &&
    row.score >= minScore &&
    (row.context == null || row.context >= minContext)
  const byScore = (a, b) => b.score - a.score || String(a.model).localeCompare(String(b.model))

  const rows = scores.providers.flatMap((entry) => (Array.isArray(entry?.rows) ? entry.rows : []))
  const goRows = rows.filter((row) => providerOf(row.model) === "opencode-go" && rankable(row)).sort(byScore)
  const others = rows.filter((row) => providerOf(row.model) !== "opencode-go" && rankable(row)).sort(byScore)
  const otherRows = others.slice(0, Math.max(0, POOL_SIZE - goRows.length))

  if (goRows.length + otherRows.length === 0) {
    throw new Error("no scorable model at or above the minimum score is available; refusing to write pool.txt")
  }
  if (goRows.length + otherRows.length < POOL_SIZE) {
    warnings.push(`only ${goRows.length + otherRows.length} scorable model(s) available, wanted ${POOL_SIZE}`)
  }

  const { header } = splitHeaderAndSlots(input?.currentPoolText ?? "")
  const outSlots = [
    ...goRows.map((row) => formatGeneratedLine(row.model, 4)),
    ...otherRows.map((row) =>
      formatGeneratedLine(row.model, 2, providerOf(row.model) === "opencode" ? "opencode" : undefined),
    ),
  ]

  const comment = refreshComment(input?.now ?? new Date(), scores.generatedAt)
  const outHeader = withRefreshComment(header, comment)

  const text = [...outHeader, "", ...outSlots, ""].join("\n")
  return {
    text,
    slots: outSlots,
    warnings,
    chosen: {
      opencodeGo: goRows.map((r) => r.model),
      others: otherRows.map((r) => r.model),
    },
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
  if (stable) console.log(`copied ${live} to ${scriptPath}`)
  console.log(`installed ${units.servicePath}`)
  console.log(`installed ${units.timerPath}`)
  console.log(`enabled ${REFRESH_TIMER_NAME}`)
  return true
}

function usage() {
  console.log(`Usage: node scripts/refresh-pool.mjs [options]

  --from-scores     skip scoring, use the existing ~/.config/lacode/model-scores.json
  --install-timer   install and enable a user systemd oneshot service + daily timer
                    (add --stable to copy the script to ~/.local/lib/lacode and
                    point ExecStart there, so plugin-cache updates do not break it)
  --print           print the proposed pool.txt and make no changes (alias: --dry-run)
  --dry-run         same as --print
  --max N           models per provider passed to the scorer (default: 20)
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
  const value = (flag, fallback) => {
    const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`))
    if (!hit) return fallback
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : argv[argv.indexOf(hit) + 1]
  }
  const max = Math.max(1, Number(value("--max", "20")) || 20)
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
    `opencode-go [${built.chosen.opencodeGo.join(", ")}]`,
    `others [${built.chosen.others.join(", ")}]`,
    ...(dropped.length ? [`dropped [${dropped.map((x) => x.model).join(", ")}]`] : []),
    ...(built.warnings.length ? [`warnings [${built.warnings.join("; ")}]`] : []),
  ].join(" | ")

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
