// provider-status: the live degradation signal from status.opencode.ai.
//
// Run with: node --test tests/provider-status-test.mjs

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  STATUS_CACHE_TTL_MS,
  fetchProviderStatus,
  statusDegradedProviders,
} from "../scripts/provider-status.mjs"

const component = (service, status, extra = {}) => ({ service, status, reason: "none", ...extra })

const payload = (components) => ({ status: "operational", components, incidents: [], history: [] })

test("all-operational payload degrades nothing", () => {
  const { services, providers } = statusDegradedProviders(
    payload([component("inference", "operational"), component("go", "operational"), component("free", "operational")]),
  )
  assert.deepEqual(services, [])
  assert.deepEqual(providers, [])
})

test("a degraded free tier benches the opencode free models", () => {
  const { services, providers } = statusDegradedProviders(
    payload([
      component("inference", "operational"),
      component("go", "operational"),
      component("free", "degraded", { reason: "elevated errors", since: 1794352000000 }),
    ]),
  )
  assert.deepEqual(providers, ["opencode"])
  assert.equal(services[0].service, "free")
  assert.equal(services[0].status, "degraded")
  assert.ok(services[0].since, "the degradation start must be carried for logging")
})

test("a down go component benches opencode-go, inference benches both", () => {
  const go = statusDegradedProviders(payload([component("go", "down")]))
  assert.deepEqual(go.providers, ["opencode-go"])

  const inference = statusDegradedProviders(payload([component("inference", "degraded")]))
  assert.deepEqual(inference.providers, ["opencode-go", "opencode"])
})

test("non-routing components and unknown shapes degrade nothing", () => {
  assert.deepEqual(statusDegradedProviders(payload([component("console", "down")])).providers, [])
  assert.deepEqual(statusDegradedProviders(payload([component("logs", "maintenance")])).providers, [])
  assert.deepEqual(statusDegradedProviders(null).providers, [])
  assert.deepEqual(statusDegradedProviders({}).providers, [])
  assert.deepEqual(statusDegradedProviders({ components: "nope" }).providers, [])
})

test("a live fetch is cached and reused while fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-status-"))
  const cachePath = join(dir, "provider-status.json")
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, json: async () => payload([component("free", "degraded")]) }
  }
  const first = await fetchProviderStatus({ fetchImpl, cachePath, now: 1_000_000 })
  assert.equal(first.ok, true)
  assert.deepEqual(first.providers, ["opencode"])
  assert.equal(first.cached, false)

  const failing = async () => {
    throw new Error("network down")
  }
  const second = await fetchProviderStatus({ fetchImpl: failing, cachePath, now: 1_000_000 + STATUS_CACHE_TTL_MS - 1 })
  assert.equal(second.ok, true, "a fresh cache must cover a failed fetch")
  assert.equal(second.cached, true)
  assert.deepEqual(second.providers, ["opencode"])
  assert.equal(calls, 1, "the cache must prevent a second network call")
  rmSync(dir, { recursive: true, force: true })
})

test("a stale cache is not trusted and a failed fetch reports unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-status-"))
  const cachePath = join(dir, "provider-status.json")
  const fetchImpl = async () => {
    throw new Error("network down")
  }
  const result = await fetchProviderStatus({ fetchImpl, cachePath, now: 1_000_000 })
  assert.equal(result.ok, false)
  assert.deepEqual(result.providers, [])
  assert.match(result.reason, /network down/)

  writeFileSync(cachePath, JSON.stringify({ checkedAt: 0, ok: true, providers: ["opencode-go"] }))
  const stale = await fetchProviderStatus({ fetchImpl, cachePath, now: STATUS_CACHE_TTL_MS + 1 })
  assert.equal(stale.ok, false, "a stale cache must not pose as a live signal")
  assert.deepEqual(stale.providers, [])
  rmSync(dir, { recursive: true, force: true })
})

test("a non-200 status API response is treated as no signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-status-"))
  const cachePath = join(dir, "provider-status.json")
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) })
  const result = await fetchProviderStatus({ fetchImpl, cachePath, now: 1_000_000 })
  assert.equal(result.ok, false)
  assert.deepEqual(result.providers, [])
  rmSync(dir, { recursive: true, force: true })
})

test("statusGateSignal only gates on a hard down of a gating service", async () => {
  const { statusGateSignal } = await import("../scripts/provider-status.mjs")
  const down = statusGateSignal(
    payload([
      component("go", "down", { reason: "outage" }),
      component("free", "degraded", { reason: "latency" }),
      component("payg", "down", { reason: "paid blip" }),
    ]),
  )
  assert.deepEqual(down.down, ["go"], "only the gating hard-down gates a scan")
  assert.deepEqual(down.degraded, ["go", "free"], "degraded stays annotation-only")

  const degradedOnly = statusGateSignal(payload([component("free", "degraded", { reason: "latency" })]))
  assert.deepEqual(degradedOnly.down, [])
  assert.deepEqual(degradedOnly.degraded, ["free"])

  const clean = statusGateSignal(payload([component("go", "operational"), component("free", "operational")]))
  assert.deepEqual(clean.down, [])
  assert.deepEqual(clean.degraded, [])
})
