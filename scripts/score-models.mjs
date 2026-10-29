#!/usr/bin/env node
// LaCode free-model scorer — MEASURE, DO NOT FABRICATE.
//
// The pool is for mechanical work: reading files, grepping, mechanical edits,
// cartography. What matters for that is not "the smartest model" but a model that
// is (a) free, (b) awake, (c) fast, and (d) has enough context and output room.
// This script measures those four things and ranks the candidates.
//
//   npm run score                       all configured free providers
//   npm run score -- --providers opencode,openrouter
//   npm run score -- --max 6            probe at most 6 models per provider
//   npm run score -- --no-write         print only, touch nothing
//
// WHAT IT MEASURES
//   context      limit.context from `opencode models --verbose`
//   output       limit.output  (the token ceiling for one reply)
//   speed        wall-clock ms for one tiny completion, one request per model
//   reliability  did the model actually answer? A 429/401/404 is recorded as the
//                named failure it is, never as a slow success.
//
// WHAT IT DOES NOT DO
//   * It never invents a latency or a score. A model it could not reach is shown
//     as unreachable with the reason and is NOT ranked.
//   * It never writes pool.txt. It prints a SUGGESTED table for you to paste; the
//     pool stays yours to decide.
//   * It never probes a paid model. Only cost 0/0 models from the provider's
//     catalog are candidates.
//
// OUTPUT
//   a per-provider ranked table, an overall ranking, a suggested pool.txt block,
//   and (unless --no-write) the raw rows in ~/.config/lacode/model-scores.json so
//   a later run can compare.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const AUTH = join(homedir(), ".local", "share", "opencode", "auth.json")
const OUT = join(homedir(), ".config", "lacode", "model-scores.json")
const DEFAULT_PROVIDERS = ["opencode", "opencode-go", "openrouter", "console-openrouter"]

// ── scoring weights ─────────────────────────────────────────────────────────
// Mechanical work prizes speed and availability over raw capability. Context is
// scored on a log curve so 256k vs 1M is a difference, not a cliff.
const W = { speed: 0.35, context: 0.3, output: 0.15, reliability: 0.2 }
const MAX_CONTEXT = 1_000_000
const FAST_MS = 300 // at or below this, speed scores 1.0
const SLOW_MS = 8_000 // at or above this, speed scores 0
const PROMPT = "Reply with the single word: ok"
const MAX_TOKENS = 8

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const value = (flag, fallback) => {
  const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`))
  if (!hit) return fallback
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : argv[argv.indexOf(hit) + 1]
}

if (has("--help") || has("-h")) {
  console.log(`Usage: npm run score -- [options]

  --providers a,b   providers to scan (default: ${DEFAULT_PROVIDERS.join(",")})
  --max N           probe at most N free models per provider (default: 12)
  --timeout MS      per-request deadline in ms (default: 20000)
  --delay MS        pause between requests in ms (default: 300)
  --no-write        do not write ~/.config/lacode/model-scores.json
  -h, --help        this message

Only cost 0/0 models are candidates. Credentials come from
~/.local/share/opencode/auth.json; a provider with no entry falls back to the
"opencode" key (which is how the console-openrouter connection authenticates).`)
  process.exit(0)
}

const providers = String(value("--providers", DEFAULT_PROVIDERS.join(","))).split(",").map((s) => s.trim()).filter(Boolean)
const maxPerProvider = Math.max(1, Number(value("--max", "12")) || 12)
const timeoutMs = Math.max(1_000, Number(value("--timeout", "20000")) || 20_000)
const delayMs = Math.max(0, Number(value("--delay", "300")) || 300)
const writeResults = !has("--no-write")

// ── discovery ───────────────────────────────────────────────────────────────
/** Parse `opencode models --verbose <provider>`: alternating id line + JSON block. */
function parseVerbose(text) {
  const rows = []
  let id = null
  let buf = []
  const flush = () => {
    if (!id || buf.length === 0) return false
    try {
      const parsed = JSON.parse(buf.join("\n"))
      rows.push({ id, model: parsed })
      id = null
      buf = []
      return true
    } catch {
      return false
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const isId = /^\S/.test(line) && !/^[{}]/.test(line)
    if (isId) {
      if (id) flush()
      if (line.startsWith("provider/") || line.includes("/")) {
        id = line.trim()
        buf = []
      }
      continue
    }
    if (id) {
      buf.push(line)
      const trimmed = line.trim()
      if (trimmed === "}" || trimmed === "},") flush()
    }
  }
  flush()
  return rows
}

function freeModels(provider) {
  let text
  try {
    text = execFileSync("opencode", ["models", "--verbose", provider], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch (error) {
    return { provider, error: `opencode models failed: ${String(error?.message ?? error)}`, models: [] }
  }
  const rows = parseVerbose(text)
  const models = rows
    .filter(({ model }) => model?.api?.url && model?.api?.id)
    .filter(({ model }) => (model.cost?.input ?? 1) === 0 && (model.cost?.output ?? 1) === 0)
    .filter(({ model }) => !model.status || model.status === "active")
    .map(({ id, model }) => ({
      model: id,
      url: model.api.url,
      apiId: model.api.id,
      context: model.limit?.context ?? null,
      output: model.limit?.output ?? null,
      name: model.name ?? id,
    }))
  return { provider, error: null, models }
}

// ── credentials ─────────────────────────────────────────────────────────────
function loadAuth() {
  if (!existsSync(AUTH)) return {}
  try {
    return JSON.parse(readFileSync(AUTH, "utf8"))
  } catch {
    return {}
  }
}
const auth = loadAuth()
const keyFor = (provider) => auth[provider]?.key ?? auth.opencode?.key ?? null
// The Zen gateways reject a request that does not name a session; the value does
// not need to be a real opencode session, it only has to be present.
const runSession = `score-${Date.now().toString(36)}`
const sessionHeader = (provider) =>
  provider === "opencode" || provider === "opencode-go" ? { "x-opencode-session": runSession } : {}

// ── probing ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One real request. Returns {ok, ms, reason}. A failure is named, never rounded
 * into a success, and `ms` is only reported for a request that actually ran.
 */
async function probe(candidate, provider) {
  const key = keyFor(provider)
  if (!key) return { ok: false, ms: null, reason: "no credential in auth.json" }

  const url = `${String(candidate.url).replace(/\/+$/, "")}/chat/completions`
  const started = performance.now()
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...sessionHeader(provider),
        ...(provider === "openrouter" ? { "HTTP-Referer": "https://opencode.ai", "X-Title": "LaCode score" } : {}),
      },
      body: JSON.stringify({
        model: candidate.apiId,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: MAX_TOKENS,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const ms = Math.round(performance.now() - started)
    const body = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {}

    if (!response.ok) {
      const detail = parsed?.error?.message ?? body.slice(0, 160)
      const kind =
        response.status === 429
          ? "rate-limited"
          : response.status === 401 || response.status === 403
            ? "credential"
            : response.status === 404
              ? "not served"
              : `http ${response.status}`
      return { ok: false, ms, reason: `${kind}: ${detail}` }
    }
    // A 200 can still carry an error object (OpenRouter does this).
    if (parsed?.error) return { ok: false, ms, reason: `${parsed.error.message ?? "error"} `.trim() }
    if (!Array.isArray(parsed?.choices) || parsed.choices.length === 0) {
      return { ok: false, ms, reason: "no choices in response" }
    }
    return { ok: true, ms, reason: "answered" }
  } catch (error) {
    const ms = Math.round(performance.now() - started)
    const name = error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error)
    return { ok: false, ms, reason: name }
  }
}

// ── scoring ─────────────────────────────────────────────────────────────────
const clamp01 = (n) => Math.max(0, Math.min(1, n))
const logScore = (n, max) => (n && n > 0 ? clamp01(Math.log2(1 + n) / Math.log2(1 + max)) : 0)
const speedScore = (ms) => (ms == null ? 0 : clamp01((SLOW_MS - ms) / (SLOW_MS - FAST_MS)))

function score(row) {
  if (!row.ok) return null
  const parts = {
    speed: speedScore(row.ms),
    context: logScore(row.context, MAX_CONTEXT),
    output: logScore(row.output, 262_144),
    reliability: 1,
  }
  const value = 100 * (Object.entries(W).reduce((sum, [k, w]) => sum + w * parts[k], 0) / Object.values(W).reduce((a, b) => a + b, 0))
  return { value: Math.round(value * 10) / 10, parts }
}

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

async function main() {
  const scanned = providers.map(freeModels)
  const results = []

  for (const entry of scanned) {
    if (entry.error) {
      console.log(`\n${entry.provider}: ${entry.error}`)
      results.push({ provider: entry.provider, error: entry.error, rows: [] })
      continue
    }
    const candidates = entry.models.slice(0, maxPerProvider)
    console.log(`\n${entry.provider}: probing ${candidates.length} free model(s)${entry.models.length > candidates.length ? ` of ${entry.models.length}` : ""}`)
    if (candidates.length === 0) {
      results.push({ provider: entry.provider, error: null, rows: [] })
      continue
    }
    const rows = []
    for (const candidate of candidates) {
      const outcome = await probe(candidate, entry.provider)
      const row = { provider: entry.provider, ...candidate, ...outcome, score: null }
      row.score = score(row)
      rows.push(row)
      const verdict = outcome.ok ? `${outcome.ms}ms` : outcome.reason.slice(0, 60)
      console.log(`  ${pad(candidate.model.replace(`${entry.provider}/`, ""), 52)} ${padL(verdict, 16)}`)
      await sleep(delayMs)
    }
    results.push({ provider: entry.provider, error: null, rows })
  }

  // Per-provider ranked tables.
  for (const entry of results) {
    if (entry.error || entry.rows.length === 0) continue
    console.log(`\n${entry.provider} — ranked`)
    console.log(`  ${pad("#", 3)}${pad("model", 52)}${padL("ctx", 9)}${padL("out", 9)}${padL("ms", 7)}${padL("score", 7)}`)
    const ranked = [...entry.rows].filter((r) => r.score).sort((a, b) => b.score.value - a.score.value)
    ranked.forEach((r, i) => {
      console.log(`  ${pad(i + 1, 3)}${pad(r.model.replace(`${entry.provider}/`, ""), 52)}${padL(r.context ?? "?", 9)}${padL(r.output ?? "?", 9)}${padL(r.ms ?? "?", 7)}${padL(r.score.value, 7)}`)
    })
    const failed = entry.rows.filter((r) => !r.ok)
    if (failed.length) {
      console.log(`  unreachable (not ranked):`)
      for (const r of failed) console.log(`    ${pad(r.model.replace(`${entry.provider}/`, ""), 52)} ${r.reason.slice(0, 90)}`)
    }
  }

  // Overall ranking across providers.
  const all = results.flatMap((e) => e.rows).filter((r) => r.score)
  all.sort((a, b) => b.score.value - a.score.value)
  if (all.length) {
    console.log(`\noverall — best free models right now`)
    all.slice(0, 12).forEach((r, i) => {
      console.log(`  ${pad(i + 1, 3)}${pad(r.model, 58)}${padL(`${r.ms}ms`, 8)}${padL(r.score.value, 7)}`)
    })
  }

  // A SUGGESTED pool: the best model from each provider, weights 4/3/2/1 by rank.
  // Printed, never written — pool.txt stays the user's decision.
  const bestPerProvider = []
  for (const entry of results) {
    const top = entry.rows.filter((r) => r.score).sort((a, b) => b.score.value - a.score.value)[0]
    if (top) bestPerProvider.push(top)
  }
  bestPerProvider.sort((a, b) => b.score.value - a.score.value)
  if (bestPerProvider.length) {
    console.log(`\nsuggested pool.txt (paste if it matches your judgement — nothing was changed)`)
    console.log(`# scored ${new Date().toISOString()} — one best free model per provider`)
    bestPerProvider.forEach((r, i) => {
      const weight = Math.max(1, 4 - i)
      console.log(`${pad(r.model, 60)}${weight}`)
    })
  }

  if (writeResults) {
    try {
      mkdirSync(dirname(OUT), { recursive: true })
      const payload = {
        generatedAt: new Date().toISOString(),
        weights: W,
        providers: results.map((e) => ({
          provider: e.provider,
          error: e.error,
          rows: e.rows.map((r) => ({
            model: r.model,
            context: r.context,
            output: r.output,
            ok: r.ok,
            ms: r.ms,
            reason: r.reason,
            score: r.score?.value ?? null,
          })),
        })),
      }
      writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n")
      console.log(`\nwrote ${OUT}`)
    } catch (error) {
      console.error(`\ncould not write ${OUT}: ${String(error?.message ?? error)}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error))
  process.exitCode = 1
})
