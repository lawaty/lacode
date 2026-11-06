#!/usr/bin/env node
// Daily-refreshable pool builder.
//
// Reads the scorer's output (~/.config/lacode/model-scores.json) and proposes a
// rewritten ~/.config/lacode/pool.txt. It never partially writes and never
// writes on a fail-closed condition.
//
// Layout (exact, per spec):
//   1. every free opencode-go model with ok:true and a numeric score, one slot
//      each, sorted by score descending, weight 4
//   2. every slot from the current pool whose provider is NOT present in the
//      score file, preserved exactly (raw line text, weight/bucket/notify, order)
//   3. exactly one free opencode model — the best ok:true numeric score —
//      weight 2, with b:opencode
//
// Total = #opencode-go free + #preserved unscored + 1.
//
// This file ships as source and must run with plain `node` (ESM, no TS).

import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HOME = homedir()
export const DEFAULT_SCORES_PATH = join(HOME, ".config", "lacode", "model-scores.json")
export const DEFAULT_POOL_PATH = join(HOME, ".config", "lacode", "pool.txt")
export const SYSTEMD_USER_DIR = (home = HOME) => join(home, ".config", "systemd", "user")
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

const isFree = (modelId) => {
  const id = String(modelId || "")
  return id.endsWith(":free") || id.endsWith("-free")
}

const numericScore = (row) => typeof row?.score === "number" && Number.isFinite(row.score)

const okFreeRows = (providerEntry) => {
  const rows = Array.isArray(providerEntry?.rows) ? providerEntry.rows : []
  return rows.filter((row) => row?.ok === true && numericScore(row) && isFree(row.model))
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
  return `# Refreshed ${when} from model-scores.json${gen}: opencode-go free models first, best opencode last.`
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
 * @returns {{ text: string, slots: string[], warnings: string[], chosen: { opencodeGo: string[], opencode: string, preserved: string[] } }}
 */
export function buildPool(input) {
  const warnings = []
  const scores = input?.scores
  if (!scores || typeof scores !== "object" || !Array.isArray(scores.providers)) {
    throw new Error("score file is missing or invalid (expected { providers: [...] })")
  }

  const providerEntries = scores.providers
  const scoredProviders = new Set(
    providerEntries.map((p) => String(p?.provider ?? "").trim()).filter(Boolean),
  )

  const goEntry = providerEntries.find((p) => p?.provider === "opencode-go")
  const goRows = okFreeRows(goEntry).sort((a, b) => b.score - a.score)
  if (goRows.length === 0) {
    throw new Error("no free opencode-go model with ok:true and a numeric score is available; refusing to write pool.txt")
  }

  const opEntry = providerEntries.find((p) => p?.provider === "opencode")
  const opRows = okFreeRows(opEntry).sort((a, b) => b.score - a.score)
  if (opRows.length === 0) {
    throw new Error("no free opencode model with ok:true and a numeric score is available; refusing to write pool.txt")
  }
  const bestOp = opRows[0].model

  const { header, slots: currentSlots } = splitHeaderAndSlots(input?.currentPoolText ?? "")
  const preserved = currentSlots.filter((line) => {
    if (!isSlotLine(line)) return false
    return !scoredProviders.has(providerOf(line))
  })

  const block1 = goRows.map((row) => formatGeneratedLine(row.model, 4))
  const block3 = [formatGeneratedLine(bestOp, 2, "opencode")]
  const outSlots = [...block1, ...preserved, ...block3]

  const comment = refreshComment(input?.now ?? new Date(), scores.generatedAt)
  const outHeader = withRefreshComment(header, comment)

  const text = [...outHeader, "", ...outSlots, ""].join("\n")
  return {
    text,
    slots: outSlots,
    warnings,
    chosen: {
      opencodeGo: goRows.map((r) => r.model),
      opencode: bestOp,
      preserved: preserved.map((l) => String(l).split("#")[0].trim().split(/\s+/)[0]),
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
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true
Unit=${REFRESH_SERVICE_NAME}

[Install]
WantedBy=timers.target
`
  return { service, timer, servicePath, timerPath }
}

function installTimerUnits() {
  const units = renderTimerUnits({
    nodePath: process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
    home: HOME,
  })
  mkdirSync(dirname(units.servicePath), { recursive: true })
  writeFileSync(units.servicePath, units.service, "utf8")
  writeFileSync(units.timerPath, units.timer, "utf8")
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" })
    execFileSync("systemctl", ["--user", "enable", "--now", REFRESH_TIMER_NAME], { stdio: "inherit" })
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
  console.log(`installed ${units.servicePath}`)
  console.log(`installed ${units.timerPath}`)
  console.log(`enabled ${REFRESH_TIMER_NAME}`)
  return true
}

function usage() {
  console.log(`Usage: node scripts/refresh-pool.mjs [options]

  --from-scores     skip scoring, use the existing ~/.config/lacode/model-scores.json
  --install-timer   install and enable a user systemd oneshot service + daily timer
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
    installTimerUnits()
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
  const summary = [
    `opencode-go [${built.chosen.opencodeGo.join(", ")}]`,
    `preserved-unscored [${built.chosen.preserved.join(", ")}]`,
    `opencode-last [${built.chosen.opencode}]`,
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
