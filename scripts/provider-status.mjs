#!/usr/bin/env node
// Live degradation signal for opencode-served providers.
//
// status.opencode.ai publishes a machine-readable summary at /api/status:
//
//   { status, components: [{ service, status, reason, since, ... }], ... }
//
// Only opencode's own serving path is covered there: `go` (opencode-go models),
// `free` (free-tier models), `inference` (shared inference) and `payg` (paid
// models). Third-party providers (groq, cerebras, minimax, ...) are NOT covered
// and keep the probe-based failure classification in the scorer.
//
// Mapping to pool provider names:
//   go degraded        -> opencode-go
//   free degraded      -> opencode (the free-tier models live there)
//   inference degraded -> opencode-go + opencode (shared serving path)
//   payg degraded      -> opencode (paid models; rarely in the pool)
//
// Anything that is not literally "operational" counts as degraded. A fetch
// failure never blocks a refresh: the caller falls back to a fresh cache entry
// when one exists, and to `{ ok: false }` (proceed as before) otherwise.
//
// This file ships as source and must run with plain `node` (ESM, no deps).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const STATUS_API_URL = "https://status.opencode.ai/api/status"
export const STATUS_TIMEOUT_MS = 10_000
export const STATUS_CACHE_TTL_MS = 5 * 60 * 1000

export const statusCachePath = (home = homedir()) => join(home, ".config", "lacode", "provider-status.json")

/** Status components that carry model traffic. console/logs are irrelevant to routing. */
const ROUTING_SERVICES = ["inference", "go", "free", "payg"]

const SERVICE_PROVIDERS = {
  inference: ["opencode-go", "opencode"],
  go: ["opencode-go"],
  free: ["opencode"],
  payg: ["opencode"],
}

/**
 * Pure mapping from a status payload to the degraded pool providers.
 *
 * @param {any} payload parsed /api/status JSON (or anything else)
 * @returns {{ services: { service: string, status: string, reason: string, since: string|null }[], providers: string[] }}
 */
export function statusDegradedProviders(payload) {
  const components = Array.isArray(payload?.components) ? payload.components : []
  const services = []
  for (const component of components) {
    const service = typeof component?.service === "string" ? component.service : ""
    if (!ROUTING_SERVICES.includes(service)) continue
    if (String(component?.status ?? "").toLowerCase() === "operational") continue
    services.push({
      service,
      status: String(component?.status ?? "unknown"),
      reason: typeof component?.reason === "string" && component.reason ? component.reason : "no reason given",
      since: typeof component?.since === "number" ? new Date(component.since).toISOString() : null,
    })
  }
  const providers = [...new Set(services.flatMap((entry) => SERVICE_PROVIDERS[entry.service] ?? []))]
  return { services, providers }
}

function readCache(cachePath, now) {
  try {
    if (!existsSync(cachePath)) return null
    const cached = JSON.parse(readFileSync(cachePath, "utf8"))
    if (!cached || typeof cached.checkedAt !== "number") return null
    if (now - cached.checkedAt > STATUS_CACHE_TTL_MS) return null
    return cached
  } catch {
    return null
  }
}

function writeCache(cachePath, record) {
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(record, null, 2) + "\n", "utf8")
  } catch {}
}

/**
 * Fetch the live status, falling back to a fresh cache entry on failure.
 * Never throws: network trouble means `{ ok: false }`, and the caller proceeds
 * with the normal scan (the pool-write guard still protects the pool).
 *
 * @param {{ fetchImpl?: typeof fetch, cachePath?: string, now?: number, timeoutMs?: number }} options
 */
export async function fetchProviderStatus(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const cachePath = options.cachePath ?? statusCachePath()
  const now = typeof options.now === "number" ? options.now : Date.now()
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS

  try {
    if (typeof fetchImpl !== "function") throw new Error("no fetch implementation")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(STATUS_API_URL, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response || response.ok !== true) throw new Error(`status API responded HTTP ${response?.status ?? "unknown"}`)
    const payload = await response.json()
    const { services, providers } = statusDegradedProviders(payload)
    const record = {
      checkedAt: now,
      ok: true,
      cached: false,
      overall: typeof payload?.status === "string" ? payload.status : "unknown",
      stale: payload?.stale === true,
      services,
      providers,
    }
    writeCache(cachePath, record)
    return record
  } catch (error) {
    const cached = readCache(cachePath, now)
    if (cached) return { ...cached, cached: true }
    return {
      checkedAt: now,
      ok: false,
      cached: false,
      overall: "unknown",
      stale: false,
      services: [],
      providers: [],
      reason: String(error?.message ?? error),
    }
  }
}

const isMain = process.argv[1] && String(process.argv[1]).endsWith("provider-status.mjs")
if (isMain) {
  const json = process.argv.includes("--json")
  fetchProviderStatus().then((status) => {
    if (json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    if (!status.ok) {
      console.log(`opencode status unreachable (${status.reason}); proceeding without a live signal`)
      return
    }
    if (status.providers.length === 0) {
      console.log(`opencode status ${status.overall}${status.cached ? " (cached)" : ""}: no routing component degraded`)
      return
    }
    const detail = status.services.map((entry) => `${entry.service}=${entry.status}`).join(", ")
    console.log(`opencode status degraded: ${detail} -> bench ${status.providers.join(", ")}${status.cached ? " (cached)" : ""}`)
  })
}
