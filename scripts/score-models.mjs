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
//   context      limit.context from `opencode models --verbose`; a known limit
//                below --min-context is excluded from ranking, not scored low
//   output       limit.output  (the token ceiling for one reply)
//   speed        wall-clock ms for one tiny completion, one request per model
//   reliability  did the model actually answer? A 429/401/404 is recorded as the
//                named failure it is, never as a slow success.
//
// WHAT IT DOES NOT DO
//   * It never invents a latency or a score. A model it could not reach is shown
//     as unreachable with the reason and is NOT ranked.
//   * It never ranks a model whose known context is below --min-context, or whose
//     measured score is below --min-score: those are listed as excluded instead.
//   * It never writes pool.txt. It prints a SUGGESTED table for you to paste; the
//     pool stays yours to decide.
//   * opencode and opencode-go stay free-only. Every other provider is probed
//     even when its catalogue lists a price, because provider credits cover it;
//     --free-only restores the cost-0 rule everywhere. Non-chat/media/safety/
//     meta-router models are always skipped.
//
// OUTPUT
//   a per-provider ranked table, an overall ranking, a suggested pool.txt block,
//   and (unless --no-write) the raw rows in ~/.config/lacode/model-scores.json so
//   a later run can compare.

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  MIN_CONTEXT,
  MIN_SCORE,
  classifyFailure,
  isTransientFailure,
  isTransientKind,
  providerRank,
  retryAfterMs,
  selectPool,
} from "./pool-selection.mjs"

const AUTH = join(homedir(), ".local", "share", "opencode", "auth.json")
const OUT = join(homedir(), ".config", "lacode", "model-scores.json")
// No default provider list: `opencode models --verbose` with no argument returns
// every provider opencode knows about, and that is what we scan by default.
const SESSION_PROVIDERS = new Set(["opencode", "opencode-go"])
const FREE_ONLY_PROVIDERS = new Set(["opencode", "opencode-go"])

// ── scoring weights ─────────────────────────────────────────────────────────
// Mechanical work prizes speed and availability over raw capability. Context is
// scored on a log curve so 256k vs 1M is a difference, not a cliff.
const W = { speed: 0.35, context: 0.3, output: 0.15, reliability: 0.2 }
const MAX_CONTEXT = 1_000_000
const FAST_MS = 300 // at or below this, speed scores 1.0
const SLOW_MS = 8_000 // at or above this, speed scores 0
const PROMPT = "Reply with the single word: ok"
const MAX_TOKENS = 8
const PROBE_ATTEMPTS = 2 // one retry for a timeout or a dropped connection
/**
 * Retry the same probe only when the next attempt has a chance. A known
 * exhausted balance or a permanent 401/403/404 will not recover in 300ms; the
 * selector schedules those with retryAfter instead. A bare gateway 402 is
 * retried once, because that is often a transient edge, not a real balance.
 */
const retryableProbe = (outcome) => {
  if (!outcome || outcome.ok) return false
  const kind = outcome.kind ?? classifyFailure({ status: outcome.status, reason: outcome.reason })
  if (kind === "credit") {
    return !/insufficient credits|out of credits|payment required|billing|purchase/i.test(String(outcome.reason ?? ""))
  }
  return isTransientKind(kind)
}

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

  --providers a,b   restrict the scan to these providers (default: all configured)
  --max N           probe at most N candidate models per provider (default: 50)
  --min-context N   exclude models whose context limit is below N (default: ${MIN_CONTEXT})
  --min-score N     do not rank models scoring below N (default: ${MIN_SCORE})
  --free-only        only probe catalogue cost 0/0 models on every provider
  --timeout MS      per-request deadline in ms (default: 45000)
  --delay MS        pause between requests in ms (default: 300)
  --budget-min N    stop starting new probes after N minutes and write what was
                    measured; providers not scanned keep their previous rows
                    (default: 30)
  --no-write        do not write ~/.config/lacode/model-scores.json
  -h, --help        this message

opencode and opencode-go stay free-only; every other provider is probed even
when its catalogue lists a price, because provider credits cover it. Use
--free-only to apply the cost-0 rule everywhere. Non-chat/media generators,
safety classifiers, and OpenRouter meta-routers are always skipped.
Credentials come from ~/.local/share/opencode/auth.json; a provider with no
entry falls back to the "opencode" key (which is how the console-openrouter
connection authenticates).
opencode/opencode-go models are probed through a temporary local opencode serve --pure session, while the other providers are probed directly.
Providers with no direct HTTP endpoint (or an unexpanded \${...} URL) are probed through the same local opencode session as opencode/opencode-go.`)
    process.exit(0)
  }

const providerArg = value("--providers", null)
const providers = providerArg ? String(providerArg).split(",").map((s) => s.trim()).filter(Boolean) : null
const maxPerProvider = Math.max(1, Number(value("--max", "50")) || 50)
const minContext = Math.max(0, Number(value("--min-context", String(MIN_CONTEXT))) || MIN_CONTEXT)
const minScore = Math.max(0, Number(value("--min-score", String(MIN_SCORE))) || MIN_SCORE)
const timeoutMs = Math.max(1_000, Number(value("--timeout", "45000")) || 45_000)
const delayMs = Math.max(0, Number(value("--delay", "300")) || 300)
const budgetMin = Math.max(1, Number(value("--budget-min", "30")) || 30)
const budgetMs = budgetMin * 60_000
const writeResults = !has("--no-write")
const freeOnlyFlag = has("--free-only")

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

/** True for concrete text-in/text-out chat models, not media generators, classifiers, or OpenRouter meta-routers. */
function isChatModel(model) {
  const input = model?.capabilities?.input
  const output = model?.capabilities?.output
  if (input?.text === false) return false
  if (output?.text === false) return false
  if (output?.audio || output?.image || output?.video || output?.pdf) return false
  const apiId = String(model?.api?.id ?? "").toLowerCase()
  if (apiId.startsWith("openrouter/")) return false
  if (/content[-_]safety|moderation|classifier/.test(apiId)) return false
  return true
}

function buildProviderEntry(provider, rows) {
  const freeOnly = freeOnlyFlag || FREE_ONLY_PROVIDERS.has(provider)
  const isFree = (model) => (model?.cost?.input ?? 1) === 0 && (model?.cost?.output ?? 1) === 0
  const models = rows
    .filter(({ model }) => model?.api?.id)
    .filter(({ model }) => !freeOnly || isFree(model))
    .filter(({ model }) => !model.status || model.status === "active")
    .filter(({ model }) => isChatModel(model))
    .map(({ id, model }) => ({
      model: id,
      url: model.api.url,
      apiId: model.api.id,
      context: model.limit?.context ?? null,
      output: model.limit?.output ?? null,
      name: model.name ?? id,
      // Ordering only: a zero-cost model is probed before a paid one, so a scan
      // budget is spent on the models the pool is most likely to keep. It never
      // excludes a paid model.
      free: isFree(model),
    }))
  const excluded = models
    .filter((m) => m.context != null && m.context < minContext)
    .map((m) => ({
      model: m.model,
      context: m.context,
      output: m.output,
      reason: `context ${m.context} < minimum ${minContext}`,
    }))
  return {
    provider,
    error: null,
    models: models
      .filter((m) => m.context == null || m.context >= minContext)
      .sort((a, b) => Number(b.free) - Number(a.free)),
    excluded,
  }
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
    return { provider, error: `opencode models failed: ${String(error?.message ?? error)}`, models: [], excluded: [] }
  }
  return buildProviderEntry(provider, parseVerbose(text))
}

function freeModelsAll() {
  let text
  try {
    text = execFileSync("opencode", ["models", "--verbose"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch (error) {
    return [{ provider: "all", error: `opencode models failed: ${String(error?.message ?? error)}`, models: [], excluded: [] }]
  }
  const groups = new Map()
  for (const row of parseVerbose(text)) {
    const provider = String(row.model?.providerID ?? row.id.split("/")[0] ?? "")
    if (!provider) continue
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider).push(row)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, rows]) => buildProviderEntry(provider, rows))
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

function failureText(error) {
  if (!error) return "error"
  if (typeof error === "string") return error
  if (error?.data?.message) return error.data.message
  if (error?.message) return error.message
  if (error?.name) return error.name
  try {
    return JSON.stringify(error).slice(0, 240)
  } catch {
    return "error"
  }
}

let sessionServerPromise = null
let sessionServerProc = null

function startSessionServer() {
  if (sessionServerPromise) return sessionServerPromise
  sessionServerPromise = new Promise((resolve, reject) => {
    let resolved = false
    let output = ""
    let proc
    try {
      proc = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0", "--pure"], {
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      sessionServerPromise = null
      sessionServerProc = null
      reject(error)
      return
    }
    sessionServerProc = proc

    const timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      try {
        proc.kill()
      } catch {}
      sessionServerPromise = null
      sessionServerProc = null
      reject(new Error("opencode serve timeout"))
    }, 15000)

    const onData = (chunk) => {
      if (resolved) return
      output += chunk.toString()
      const match = output.match(/opencode server listening on (https?:\/\/\S+)/)
      if (match) {
        resolved = true
        clearTimeout(timer)
        const url = match[1].replace(/\/+$/, "")
        resolve({ url, proc })
      }
    }
    proc.stdout.on("data", onData)
    proc.stderr.on("data", onData)

    proc.on("error", (error) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      sessionServerPromise = null
      sessionServerProc = null
      reject(error)
    })

    proc.on("exit", () => {
      if (sessionServerProc === proc) {
        sessionServerProc = null
        sessionServerPromise = null
      }
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      reject(new Error("opencode serve exited before ready"))
    })
  })
  return sessionServerPromise
}

function stopSessionServer() {
  if (sessionServerProc) {
    try {
      sessionServerProc.kill()
    } catch {}
    sessionServerProc = null
  }
  sessionServerPromise = null
}
process.on("exit", stopSessionServer)

/**
 * One real request. Returns {ok, ms, reason}. A failure is named, never rounded
 * into a success, and `ms` is only reported for a request that actually ran.
 */
async function probeDirect(candidate, provider) {
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
      const kind = classifyFailure({ status: response.status, reason: detail })
      const retryAfter =
        kind === "rate-limited" || kind === "credit" ? retryAfterMs(body, response.headers.get("retry-after")) : undefined
      return { ok: false, ms, reason: `${kind}: ${detail}`, status: response.status, kind, retryAfter }
    }
    // A 200 can still carry an error object (OpenRouter does this).
    if (parsed?.error) {
      const reason = `${parsed.error.message ?? "error"} `.trim()
      const kind = classifyFailure({ status: response.status, reason })
      return { ok: false, ms, reason, status: response.status, kind, retryAfter: retryAfterMs(reason) }
    }
    if (!Array.isArray(parsed?.choices) || parsed.choices.length === 0) {
      return { ok: false, ms, reason: "no choices in response", status: response.status, kind: "unknown" }
    }
    return { ok: true, ms, reason: "answered", status: response.status, kind: null }
  } catch (error) {
    const ms = Math.round(performance.now() - started)
    const name = error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error)
    return { ok: false, ms, reason: name, kind: classifyFailure({ reason: name }) }
  }
}

async function probeViaSession(candidate, provider) {
  const started = performance.now()
  let promptStarted = null
  const directory = encodeURIComponent(process.cwd())
  let id = null
  let server = null
  try {
    server = await startSessionServer()
    const createRes = await fetch(`${server.url}/session?directory=${directory}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `score probe ${candidate.model}` }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const createText = await createRes.text()
    let createdJson = null
    try {
      createdJson = JSON.parse(createText)
    } catch {}
    if (!createRes.ok) {
      const detail = createdJson?.error?.message ?? createdJson?.message ?? createText.slice(0, 160)
      const ms = Math.round(performance.now() - started)
      const kind = classifyFailure({ status: createRes.status, reason: detail })
      return {
        ok: false,
        ms,
        reason: `session create http ${createRes.status}: ${detail}`,
        status: createRes.status,
        kind,
        retryAfter: retryAfterMs(detail),
      }
    }
    id = createdJson?.id ?? createdJson?.data?.id ?? null
    if (!id) {
      const ms = Math.round(performance.now() - started)
      return { ok: false, ms, reason: `no session id: ${createText.slice(0, 160)}`, status: createRes.status, kind: "unknown" }
    }
    promptStarted = performance.now()
    const msgRes = await fetch(`${server.url}/session/${id}/message?directory=${directory}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: provider, modelID: candidate.apiId },
        system: "You are a connection health check. Reply with the single word: ok",
        parts: [{ type: "text", text: "ok" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const msgText = await msgRes.text()
    let parsed = null
    try {
      parsed = JSON.parse(msgText)
    } catch {}
    const ms = Math.round(performance.now() - (promptStarted ?? started))
    if (!msgRes.ok) {
      const detail = parsed?.error?.message ?? parsed?.message ?? msgText.slice(0, 160)
      const kind = classifyFailure({ status: msgRes.status, reason: detail })
      return {
        ok: false,
        ms,
        reason: `http ${msgRes.status}: ${detail}`,
        status: msgRes.status,
        kind,
        retryAfter: retryAfterMs(detail),
      }
    }
    const failure = parsed?.error ?? parsed?.info?.error
    if (failure) {
      const reason = failureText(failure).slice(0, 240)
      const kind = classifyFailure({ status: msgRes.status, reason })
      return { ok: false, ms, reason, status: msgRes.status, kind, retryAfter: retryAfterMs(reason) }
    }
    if (!parsed?.info) {
      return { ok: false, ms, reason: "no response", status: msgRes.status, kind: "unknown" }
    }
    return { ok: true, ms, reason: "answered", status: msgRes.status, kind: null }
  } catch (error) {
    const ms = Math.round(performance.now() - (promptStarted ?? started))
    if (error?.name === "TimeoutError") {
      return { ok: false, ms, reason: `timeout after ${timeoutMs}ms`, kind: "timeout" }
    }
    const reason = failureText(error).slice(0, 240)
    return { ok: false, ms, reason, kind: classifyFailure({ reason }), retryAfter: retryAfterMs(reason) }
  } finally {
    if (id && server) {
      try {
        await fetch(`${server.url}/session/${id}?directory=${directory}`, { method: "DELETE" })
      } catch {}
    }
  }
}

function usesSession(provider, candidate) {
  if (SESSION_PROVIDERS.has(provider)) return true
  const url = String(candidate.url ?? "")
  return url.length === 0 || url.includes("${")
}

async function probe(candidate, provider) {
  if (usesSession(provider, candidate)) return probeViaSession(candidate, provider)
  const outcome = await probeDirect(candidate, provider)
  if (outcome.ok) return outcome
  // A provider whose direct URL is misconfigured can still be reachable
  // through opencode's own provider resolution. A real 401/404 is worth the
  // second path; a permanent agreement/credit refusal is not retried here.
  if (
    outcome.kind === "credential" ||
    outcome.kind === "not-served" ||
    /invalid request path|could not route/i.test(String(outcome.reason ?? ""))
  ) {
    return probeViaSession(candidate, provider)
  }
  return outcome
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
  const scanned = providers ? providers.map((provider) => freeModels(provider)) : freeModelsAll()
  // Core providers first, then the free-only middle tier, then the slow paid
  // catalogues. Ordering only; every provider is still probed if time allows.
  scanned.sort(
    (a, b) => providerRank(a.provider) - providerRank(b.provider) || String(a.provider).localeCompare(String(b.provider)),
  )
  const results = []
  const deadline = Date.now() + budgetMs
  const skippedProviders = []
  let budgetHit = false

  for (const entry of scanned) {
    if (Date.now() >= deadline) {
      budgetHit = true
      skippedProviders.push(entry.provider)
      console.log(`\n${entry.provider}: skipped (scan budget of ${budgetMin}m reached)`)
      continue
    }
    if (entry.error) {
      console.log(`\n${entry.provider}: ${entry.error}`)
      results.push({ provider: entry.provider, error: entry.error, rows: [], excluded: [] })
      continue
    }
    const candidates = entry.models.slice(0, maxPerProvider)
    const excludedNote = entry.excluded.length ? `, ${entry.excluded.length} excluded (context < ${minContext})` : ""
    console.log(`\n${entry.provider}: probing ${candidates.length} candidate model(s)${entry.models.length > candidates.length ? ` of ${entry.models.length}` : ""}${excludedNote}`)
    if (entry.excluded.length) {
      console.log(`  excluded — context below ${minContext}:`)
      for (const x of entry.excluded) console.log(`    ${pad(x.model.replace(`${entry.provider}/`, ""), 52)} ${padL(x.context, 9)}`)
    }
    if (candidates.length === 0) {
      results.push({ provider: entry.provider, error: null, rows: [], excluded: entry.excluded })
      continue
    }
    const rows = []
    for (const candidate of candidates) {
      if (Date.now() >= deadline) {
        budgetHit = true
        entry.truncated = true
        console.log(`  scan budget reached; stopped ${entry.provider} after ${rows.length}/${candidates.length}`)
        break
      }
      let outcome = await probe(candidate, entry.provider)
      for (let attempt = 1; attempt < PROBE_ATTEMPTS && !outcome.ok && retryableProbe(outcome); attempt++) {
        console.log(`  retrying ${candidate.model.replace(`${entry.provider}/`, "")} after ${String(outcome.reason).slice(0, 60)}`)
        await sleep(delayMs)
        outcome = await probe(candidate, entry.provider)
      }
      const row = { provider: entry.provider, ...candidate, ...outcome, score: null }
      row.score = score(row)
      if (row.score && row.score.value < minScore) {
        entry.excluded.push({
          model: row.model,
          context: row.context,
          output: row.output,
          score: row.score.value,
          reason: `score ${row.score.value} < minimum ${minScore}`,
        })
      }
      rows.push(row)
      const verdict = outcome.ok ? `${outcome.ms}ms` : outcome.reason.slice(0, 60)
      console.log(`  ${pad(candidate.model.replace(`${entry.provider}/`, ""), 52)} ${padL(verdict, 16)}`)
      await sleep(delayMs)
    }
    results.push({ provider: entry.provider, error: null, rows, excluded: entry.excluded, truncated: !!entry.truncated })
  }
  if (budgetHit) {
    console.log(
      `\nscan budget of ${budgetMin}m reached; ${skippedProviders.length} provider(s) skipped and any truncated provider keeps its previous rows.`,
    )
  }
  stopSessionServer()

  // Per-provider ranked tables.
  for (const entry of results) {
    if (entry.error || entry.rows.length === 0) continue
    console.log(`\n${entry.provider} — ranked`)
    console.log(`  ${pad("#", 3)}${pad("model", 52)}${padL("ctx", 9)}${padL("out", 9)}${padL("ms", 7)}${padL("score", 7)}`)
    const ranked = [...entry.rows].filter((r) => r.score && r.score.value >= minScore).sort((a, b) => b.score.value - a.score.value)
    ranked.forEach((r, i) => {
      console.log(`  ${pad(i + 1, 3)}${pad(r.model.replace(`${entry.provider}/`, ""), 52)}${padL(r.context ?? "?", 9)}${padL(r.output ?? "?", 9)}${padL(r.ms ?? "?", 7)}${padL(r.score.value, 7)}`)
    })
    const failed = entry.rows.filter((r) => !r.ok)
    if (failed.length) {
      console.log(`  unreachable (not ranked):`)
      for (const r of failed) console.log(`    ${pad(r.model.replace(`${entry.provider}/`, ""), 52)} ${r.reason.slice(0, 90)}`)
    }
  }

  // Models dropped for a too-small context or a too-low score are reported, never ranked.
  const excluded = results.flatMap((e) => e.excluded ?? [])
  if (excluded.length) {
    console.log(`\nexcluded — below the context or score floor (not ranked)`)
    for (const x of excluded) console.log(`  ${pad(x.model, 58)}${padL(x.context ?? "?", 9)}  ${x.reason}`)
  }

  // Overall ranking across providers.
  const all = results.flatMap((e) => e.rows).filter((r) => r.score && r.score.value >= minScore)
  all.sort((a, b) => b.score.value - a.score.value)
  if (all.length) {
    console.log(`\noverall — best candidate models right now`)
    all.slice(0, 12).forEach((r, i) => {
      console.log(`  ${pad(i + 1, 3)}${pad(r.model, 58)}${padL(`${r.ms}ms`, 8)}${padL(r.score.value, 7)}`)
    })
  }

  // Previous scores let a transient outage keep the pool it had.
  const previousScores = (() => {
    try {
      return JSON.parse(readFileSync(OUT, "utf8"))
    } catch {
      return null
    }
  })()
  const { selection, warnings, retry } = selectPool({
    providers: results.map((entry) => ({
      provider: entry.provider,
      error: entry.error,
      truncated: entry.truncated,
      rows: entry.rows.map((row) => ({ ...row, score: row.score?.value ?? null })),
      excluded: entry.excluded,
    })),
    previousProviders: previousScores?.providers,
    minContext,
    minScore,
  })
  if (budgetHit) {
    warnings.push(`scan budget of ${budgetMin}m reached; providers not fully scanned keep their previous scores`)
  }

  if (selection.length) {
    console.log(`\nsuggested pool.txt (paste if it matches your judgement — nothing was changed)`)
    console.log(`# scored ${new Date().toISOString()} — opencode-go first (weight 4), small-context providers (weight 2), large-context providers (weight 1), opencode last (max 1)`)
    for (const entry of selection) {
      const bucket = entry.bucket ? `  b:${entry.bucket}` : ""
      console.log(`${pad(entry.model, 60)}${entry.weight}${bucket}`)
    }
  }
  if (retry) console.log(`\nlimited: ${retry.models.length} model(s); retry after ${retry.after}`)

  if (writeResults) {
    try {
      mkdirSync(dirname(OUT), { recursive: true })
      // A provider the budget skipped has no current rows. Carry its previous
      // entry forward verbatim so the next run still sees it and selectPool can
      // keep its rankable models.
      const scannedNames = new Set(results.map((e) => e.provider))
      const carried = (previousScores?.providers ?? []).filter((p) => !scannedNames.has(String(p?.provider ?? "")))
      const previousByModel = new Map()
      for (const provider of previousScores?.providers ?? []) {
        for (const row of provider?.rows ?? []) {
          if (row?.model) previousByModel.set(row.model, row)
        }
      }
      const payload = {
        generatedAt: new Date().toISOString(),
        weights: W,
        minContext,
        minScore,
        selection,
        warnings,
        retry,
        providers: [
          ...results.map((e) => ({
            provider: e.provider,
            error: e.error,
            truncated: !!e.truncated,
            excluded: e.excluded ?? [],
            rows: e.rows.flatMap((r) => {
              const current = {
                model: r.model,
                context: r.context,
                output: r.output,
                ok: r.ok,
                ms: r.ms,
                reason: r.reason,
                status: r.status ?? null,
                kind: r.kind ?? null,
                score: r.score?.value ?? null,
                retryAfter: r.retryAfter ?? null,
              }
              // A transient failure must not erase the last measured ranking:
              // the next run needs it to keep a previously-good model while a
              // gateway is down. Keep both rows; the selector prefers the
              // rankable one and still schedules the failed one for retry.
              if (r.ok === false && isTransientFailure(r)) {
                const prior = previousByModel.get(r.model)
                if (prior?.ok === true && typeof prior.score === "number") return [current, prior]
              }
              return [current]
            }),
          })),
          ...carried,
        ],
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
