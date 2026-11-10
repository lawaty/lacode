// Epic L -- pool refresh reliability.
//
//   US-39  the 6-hour refresh completes, retries what can recover, and never
//          lets a partial scan shrink the pool
//
// The story exists because a daily scan was killed by a reboot mid-run and
// `Persistent=true` did not retry it: systemd records the trigger when the
// service starts, not when it succeeds. These tests pin the replacement:
// a 6-hour calendar plus a startup catch-up, a bounded scan that keeps the
// previous rows it did not reach, a transient retry, and a lock so a retry
// cannot race the scheduled run.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { SYNTHETIC_RETRY_MS, selectPool } from "../../scripts/pool-selection.mjs"
import { renderTimerUnits } from "../../scripts/refresh-pool.mjs"

const NOW = Date.parse("2026-11-10T20:00:00.000Z")

const provider = (name, rows, extra = {}) => ({ provider: name, error: null, rows, ...extra })
const ok = (model, score, context) => ({ model, ok: true, score, context })
const fail = (model, reason, extra = {}) => ({ model, ok: false, score: null, context: 200000, reason, ...extra })

/** A full field: enough other providers that a pool without a reserve fills all 10. */
const makeProviders = () => [
  provider("opencode-go", [
    ok("opencode-go/a", 96, 1048576),
    ok("opencode-go/b", 95, 1048576),
    ok("opencode-go/c", 94, 262144),
  ]),
  provider("opencode", [ok("opencode/zen", 93, 1048576), ok("opencode/zen-2", 92, 1048576)]),
  provider("google", [ok("google/small", 92, 131072), ok("google/large", 91, 1048576)]),
  provider("groq", [ok("groq/a", 90, 131072), ok("groq/b", 89, 131072)]),
  provider("mistral", [ok("mistral/a", 88, 262144)]),
  provider("console-openrouter", [ok("console-openrouter/a", 87, 131072), ok("console-openrouter/b", 86, 1048576)]),
  provider("openrouter", [ok("openrouter/a", 85, 131072), ok("openrouter/b", 84, 1048576)]),
]

test("[US-39] the installed timer runs every 6 hours and has a startup catch-up", () => {
  const units = renderTimerUnits({
    nodePath: "/usr/bin/node",
    scriptPath: "/repo/scripts/refresh-pool.mjs",
    home: "/home/tester",
  })
  assert.match(units.timer, /OnCalendar=\*-\*-\* 00\/6:00:00/, units.timer)
  assert.match(units.timer, /OnStartupSec=5min/, units.timer)
  assert.match(units.timer, /Persistent=true/, units.timer)
  assert.match(units.service, /TimeoutStartSec=infinity/, units.service)
})

test("[US-39] a partial scan keeps previous rows for unscanned and truncated providers", () => {
  const previous = makeProviders()

  // A targeted scan of only opencode-go: every other provider is unscanned.
  const onlyGo = [previous[0]]
  const unscanned = selectPool({ providers: onlyGo, previousProviders: previous, now: NOW })
  assert.ok(
    unscanned.selection.some((row) => row.model === "google/small"),
    `an unscanned provider must keep its previous rows, got ${unscanned.selection.map((r) => r.model).join(", ")}`,
  )

  // The budget stopped google mid-provider: it has no rows, but it is not gone.
  const truncated = makeProviders().map((entry) =>
    entry.provider === "google" ? { ...entry, truncated: true, rows: [] } : entry,
  )
  const kept = selectPool({ providers: truncated, previousProviders: previous, now: NOW })
  assert.ok(
    kept.selection.some((row) => row.model.startsWith("google/")),
    `a truncated provider must keep its previous rows, got ${kept.selection.map((r) => r.model).join(", ")}`,
  )
})

test("[US-39] a transient failure keeps the last measured score and schedules a 45-minute retry", () => {
  const previous = makeProviders()
  const current = makeProviders().map((entry) => ({
    ...entry,
    rows: entry.rows.map((row) => (row.model === "opencode-go/a" ? fail(row.model, "timeout after 45000ms") : row)),
  }))
  const { selection, retry } = selectPool({ providers: current, previousProviders: previous, now: NOW })
  assert.ok(
    selection.some((row) => row.model === "opencode-go/a"),
    "the last measured score must keep a model through a transient failure",
  )
  assert.ok(retry, "a transient failure must schedule a retry")
  assert.equal(retry.after, new Date(NOW + SYNTHETIC_RETRY_MS).toISOString())
})

test("[US-39] a permanent failure is not retried and does not fall back", () => {
  const previous = makeProviders()
  const current = makeProviders().map((entry) => ({
    ...entry,
    rows: entry.rows.map((row) => (row.model === "opencode-go/a" ? fail(row.model, "not served: 404") : row)),
  }))
  const { selection, retry } = selectPool({ providers: current, previousProviders: previous, now: NOW })
  assert.ok(!selection.some((row) => row.model === "opencode-go/a"), "a permanent 404 must not fall back")
  assert.equal(retry, undefined, "a permanent failure must not schedule a retry")
})

test("[US-39] a full field still reserves exactly one zen slot at the end", () => {
  const { selection } = selectPool({ providers: makeProviders(), now: NOW })
  const zen = selection.filter((row) => row.model.startsWith("opencode/"))
  assert.equal(zen.length, 1, `exactly one zen slot, got ${JSON.stringify(zen)}`)
  assert.equal(zen[0].bucket, "opencode")
  assert.equal(zen[0].weight, 2)
  assert.equal(selection[selection.length - 1].model, zen[0].model, "zen must be the last slot")
})

test("[US-39] overlapping refreshes serialize, and a dead PID's lock is reclaimed", () => {
  const home = mkdtempSync(join(tmpdir(), "lacode-story-lock-"))
  const conf = join(home, ".config", "lacode")
  mkdirSync(conf, { recursive: true })
  const scores = join(conf, "model-scores.json")
  const pool = join(conf, "pool.txt")
  const lock = join(conf, "refresh.lock")
  writeFileSync(
    scores,
    JSON.stringify({
      generatedAt: new Date(NOW).toISOString(),
      providers: [],
      selection: [{ model: "unit/model", weight: 1 }],
      warnings: [],
    }),
  )
  writeFileSync(pool, "# pool\n")
  mkdirSync(lock)
  writeFileSync(join(lock, "pid"), String(process.pid)) // alive: this test runner

  const script = fileURLToPath(new URL("../../scripts/refresh-pool.mjs", import.meta.url))
  const run = () =>
    spawnSync(process.execPath, [script, "--from-scores", "--scores", scores, "--pool", pool], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    })

  const blocked = run()
  assert.equal(blocked.status, 0, blocked.stderr)
  assert.match(blocked.stdout, /already running; skipping/)
  assert.equal(readFileSync(pool, "utf8"), "# pool\n", "a skipped run must not touch the pool")

  writeFileSync(join(lock, "pid"), "2147483647") // dead: no such process
  const reclaimed = run()
  assert.equal(reclaimed.status, 0, reclaimed.stderr)
  assert.match(readFileSync(pool, "utf8"), /unit\/model/, "the reclaimed run must write the pool")

  rmSync(home, { recursive: true, force: true })
})
