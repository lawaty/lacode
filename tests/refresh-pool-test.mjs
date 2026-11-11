// refresh-pool: the writer consumes the scorer's selection and schedules retries.
//
// Run with: node --test tests/refresh-pool-test.mjs

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { applyScanBench, buildPool, computeScanBench, degradedRetryDelay, poolSlotCount, renderTimerUnits, scheduleRetry, scheduleRetrySoon, shouldKeepPool } from "../scripts/refresh-pool.mjs"

const NOW = new Date("2026-11-06T12:00:00.000Z")
const GENERATED = "2026-11-06T03:41:14.089Z"

const CURRENT_POOL = `# LaCode pool — one model per line:  <provider>/<model-id>  [weight]
#
# weight is optional (default 1).

cerebras/gpt-oss-120b                            2
opencode/deepseek-v4.1-flash-free                2  b:opencode
`

const SELECTION = [
  { model: "opencode-go/beam-free", weight: 4, context: 1048576 },
  { model: "opencode-go/crouton-alpha-free", weight: 4, context: 1048576 },
  { model: "opencode-go/iceman-contributor-free", weight: 4, context: 262144 },
  { model: "openrouter/cohere/north-mini-code:free", weight: 2, context: 256000 },
  { model: "console-openrouter/cohere/north-mini-code:free", weight: 2, context: 256000 },
  { model: "opencode/crouton-alpha-free", weight: 2, bucket: "opencode", context: 1048576 },
]

const makeScores = (overrides = {}) => ({
  generatedAt: GENERATED,
  providers: [],
  selection: SELECTION,
  warnings: ["only 6 scorable model(s) available, wanted 10"],
  ...overrides,
})

test("buildPool writes the scorer selection in order", () => {
  const { text, slots, chosen, warnings } = buildPool({
    scores: makeScores(),
    currentPoolText: CURRENT_POOL,
    now: NOW,
  })

  assert.deepEqual(chosen.selected, SELECTION.map((entry) => entry.model))
  assert.deepEqual(warnings, ["only 6 scorable model(s) available, wanted 10"])
  assert.deepEqual(slots, [
    "opencode-go/beam-free  4  c:1048576",
    "opencode-go/crouton-alpha-free  4  c:1048576",
    "opencode-go/iceman-contributor-free  4  c:262144",
    "openrouter/cohere/north-mini-code:free  2  c:256000",
    "console-openrouter/cohere/north-mini-code:free  2  c:256000",
    "opencode/crouton-alpha-free  2  c:1048576  b:opencode",
  ])

  assert.ok(text.includes("# LaCode pool — one model per line"))
  assert.ok(!text.includes("cerebras/gpt-oss-120b"))
  assert.ok(!text.includes("opencode/deepseek-v4.1-flash-free"))

  const refreshLines = text.split("\n").filter((line) => /^#\s*Refreshed\b/.test(line))
  assert.equal(refreshLines.length, 1)
  assert.match(refreshLines[0], /Refreshed 2026-11-06T12:00:00\.000Z/)
  assert.match(refreshLines[0], /scores generated 2026-11-06T03:41:14\.089Z/)
})

test("consecutive runs do not duplicate the refresh comment", () => {
  const first = buildPool({ scores: makeScores(), currentPoolText: CURRENT_POOL, now: NOW })
  const second = buildPool({
    scores: makeScores(),
    currentPoolText: first.text,
    now: new Date("2026-11-07T12:00:00.000Z"),
  })

  assert.deepEqual(second.slots, first.slots)
  const refreshLines = second.text.split("\n").filter((line) => /^#\s*Refreshed\b/.test(line))
  assert.equal(refreshLines.length, 1)
  assert.match(refreshLines[0], /2026-11-07T12:00:00\.000Z/)
})

test("fail-closed on missing or invalid scores shape", () => {
  for (const scores of [null, { nope: true }, "bad", { providers: [] }]) {
    assert.throws(
      () => buildPool({ scores, currentPoolText: CURRENT_POOL, now: NOW }),
      /missing or invalid/,
    )
  }
})

test("fail-closed when the selection is empty or entirely invalid", () => {
  for (const selection of [[], [{ model: "no-provider", weight: 0 }]]) {
    assert.throws(
      () => buildPool({ scores: makeScores({ selection }), currentPoolText: CURRENT_POOL, now: NOW }),
      /no selected models/,
    )
  }
})

test("empty current pool keeps header semantics", () => {
  const { text, slots } = buildPool({
    scores: makeScores(),
    currentPoolText: "# header only\n\n",
    now: NOW,
  })
  assert.ok(text.includes("# header only"))
  assert.equal(slots.length, 6)
  assert.equal(slots[0], "opencode-go/beam-free  4  c:1048576")
})

test("a selection entry with context null produces no c: token", () => {
  const { slots } = buildPool({
    scores: makeScores({ selection: [{ model: "openrouter/no-context:free", weight: 2, context: null }] }),
    currentPoolText: CURRENT_POOL,
    now: NOW,
  })
  assert.equal(slots[0], "openrouter/no-context:free  2")
})

test("scheduleRetry runs systemd-run at the reset", () => {
  const calls = []
  const exec = (file, args) => calls.push([file, ...args])
  const result = scheduleRetry(
    { after: "2026-11-06T13:00:00.000Z", models: ["openrouter/limited:free"] },
    {
      now: () => Date.parse("2026-11-06T12:00:00.000Z"),
      exec,
      scriptPath: "/repo/scripts/refresh-pool.mjs",
      nodePath: "/usr/bin/node",
      home: "/home/tester",
    },
  )

  assert.deepEqual(result, { scheduled: true, seconds: 3600, after: "2026-11-06T13:00:00.000Z" })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "systemd-run")
  assert.ok(calls[0].some((arg) => arg.startsWith("--unit=lacode-refresh-pool-retry-")))
  assert.ok(calls[0].includes("--on-active=3600"))
  assert.ok(calls[0].includes("--setenv=HOME=/home/tester"))
  assert.ok(calls[0].includes("--setenv=PATH=/home/tester/.opencode/bin:/usr/local/bin:/usr/bin:/bin"))
  assert.ok(calls[0].includes("/usr/bin/node"))
  assert.ok(calls[0].includes("/repo/scripts/refresh-pool.mjs"))
})

test("scheduleRetry skips a past reset, a too-far reset, or no reset", () => {
  const exec = () => {
    throw new Error("must not run")
  }
  const now = () => Date.parse("2026-11-06T12:00:00.000Z")
  assert.deepEqual(
    scheduleRetry({ after: "2026-11-06T11:00:00.000Z", models: [] }, { now, exec }),
    { scheduled: false, reason: "reset is not in the future" },
  )
  assert.deepEqual(
    scheduleRetry({ after: "2026-11-07T14:00:00.000Z", models: [] }, { now, exec }),
    { scheduled: false, reason: "reset is more than a day away" },
  )
  assert.deepEqual(scheduleRetry(undefined, { now, exec }), {
    scheduled: false,
    reason: "no reset time",
  })
})

test("scheduleRetry reports an exec failure", () => {
  const result = scheduleRetry(
    { after: "2026-11-06T13:00:00.000Z", models: [] },
    {
      now: () => Date.parse("2026-11-06T12:00:00.000Z"),
      exec: () => {
        throw new Error("unit already exists")
      },
    },
  )
  assert.deepEqual(result, { scheduled: false, reason: "unit already exists" })
})

test("renderTimerUnits returns user systemd service and a 6-hourly timer", () => {
  const units = renderTimerUnits({
    nodePath: "/usr/bin/node",
    scriptPath: "/repo/scripts/refresh-pool.mjs",
    home: "/home/tester",
  })

  assert.equal(units.servicePath, "/home/tester/.config/systemd/user/lacode-refresh-pool.service")
  assert.equal(units.timerPath, "/home/tester/.config/systemd/user/lacode-refresh-pool.timer")

  assert.match(units.service, /Description=Refresh the LaCode model pool from free-model scores/)
  assert.match(units.service, /After=network-online\.target/)
  assert.match(units.service, /Wants=network-online\.target/)
  assert.match(units.service, /Type=oneshot/)
  assert.match(units.service, /TimeoutStartSec=infinity/)
  assert.match(units.service, /ExecStart=\/usr\/bin\/node \/repo\/scripts\/refresh-pool\.mjs/)
  assert.match(units.service, /Environment=PATH=\/home\/tester\/\.opencode\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin/)
  assert.match(units.service, /Nice=10/)

  assert.match(units.timer, /Description=LaCode model pool refresh every 6 hours/)
  assert.match(units.timer, /OnCalendar=\*-\*-\* 00\/6:00:00/)
  assert.match(units.timer, /OnStartupSec=5min/)
  assert.ok(!units.timer.includes("RandomizedDelaySec"))
  assert.match(units.timer, /Persistent=true/)
  assert.match(units.timer, /Unit=lacode-refresh-pool\.service/)
  assert.match(units.timer, /WantedBy=timers\.target/)
})

test("--install-timer --stable copies all four modules and points ExecStart at the stable script", () => {
  const home = mkdtempSync(join(tmpdir(), "refresh-pool-install-"))
  const stubDir = join(home, "stub-bin")
  mkdirSync(stubDir, { recursive: true })
  for (const name of ["systemctl", "loginctl"]) {
    writeFileSync(join(stubDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  }
  const script = fileURLToPath(new URL("../scripts/refresh-pool.mjs", import.meta.url))
  const result = spawnSync(process.execPath, [script, "--install-timer", "--stable"], {
    env: { ...process.env, HOME: home, PATH: `${stubDir}:${process.env.PATH}` },
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)

  const stable = join(home, ".local", "lib", "lacode", "refresh-pool.mjs")
  assert.ok(existsSync(stable), "stable copy must exist")
  assert.ok(existsSync(join(home, ".local", "lib", "lacode", "score-models.mjs")), "stable scorer must exist")
  assert.ok(existsSync(join(home, ".local", "lib", "lacode", "pool-selection.mjs")), "stable selection module must exist")
  assert.ok(existsSync(join(home, ".local", "lib", "lacode", "provider-status.mjs")), "stable status module must exist")

  const service = readFileSync(join(home, ".config", "systemd", "user", "lacode-refresh-pool.service"), "utf8")
  assert.ok(service.includes(`ExecStart=${process.execPath} ${stable}`), service)
  const timer = readFileSync(join(home, ".config", "systemd", "user", "lacode-refresh-pool.timer"), "utf8")
  assert.match(timer, /OnCalendar=\*-\*-\* 00\/6:00:00/)

  rmSync(home, { recursive: true, force: true })
})

test("a second refresh skips while one holds the lock, and a dead PID's lock is reclaimed", () => {
  const home = mkdtempSync(join(tmpdir(), "refresh-pool-lock-"))
  const conf = join(home, ".config", "lacode")
  mkdirSync(conf, { recursive: true })
  const scores = join(conf, "model-scores.json")
  const pool = join(conf, "pool.txt")
  const lock = join(conf, "refresh.lock")
  writeFileSync(scores, JSON.stringify(makeScores()))
  writeFileSync(pool, CURRENT_POOL)
  mkdirSync(lock)
  writeFileSync(join(lock, "pid"), String(process.pid)) // alive: the test runner

  const script = fileURLToPath(new URL("../scripts/refresh-pool.mjs", import.meta.url))
  const run = () =>
    spawnSync(process.execPath, [script, "--from-scores", "--scores", scores, "--pool", pool], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    })

  const blocked = run()
  assert.equal(blocked.status, 0, blocked.stderr)
  assert.match(blocked.stdout, /already running; skipping/)
  assert.equal(readFileSync(pool, "utf8"), CURRENT_POOL, "a skipped run must not touch the pool")

  // A lock left by a killed run must not block forever: the PID is dead.
  writeFileSync(join(lock, "pid"), "2147483647")
  const reclaimed = run()
  assert.equal(reclaimed.status, 0, reclaimed.stderr)
  assert.ok(readFileSync(pool, "utf8").includes("opencode-go/beam-free"), "the reclaimed run must write the pool")
  assert.equal(existsSync(lock), false, "a completed run must release the lock")

  rmSync(home, { recursive: true, force: true })
})

const TEN_SLOT_POOL = `# LaCode pool
opencode-go/a  4  c:1048576
opencode-go/b  4  c:1048576
opencode-go/c  4  c:262144
google/small  2  c:131072
groq/a  2  c:131072
groq/b  2  c:131072
mistral/a  2  c:262144
console-openrouter/a  2  c:131072
openrouter/a  2  c:131072
opencode/zen  2  b:opencode  c:1048576
`

const TWO_SLOT_SELECTION = [
  { model: "google/gemini-3-flash-preview", weight: 1, context: 1048576 },
  { model: "opencode/inkling-2-small-free", weight: 2, bucket: "opencode", context: 1048576 },
]

test("poolSlotCount ignores comments and blanks", () => {
  assert.equal(poolSlotCount(TEN_SLOT_POOL), 10)
  assert.equal(poolSlotCount("# only comments\n\n"), 0)
  assert.equal(poolSlotCount(""), 0)
})

test("shouldKeepPool refuses a degenerate selection against a healthy pool", () => {
  const kept = shouldKeepPool({
    currentPoolText: TEN_SLOT_POOL,
    newSlots: ["google/gemini-3-flash-preview  1  c:1048576", "opencode/inkling-2-small-free  2  b:opencode  c:1048576"],
  })
  assert.equal(kept.keep, true)
  assert.equal(kept.prev, 10)
  assert.equal(kept.threshold, 5)
  assert.match(kept.reason, /breaks the pool structure|refusing to shrink the pool/)
})

test("shouldKeepPool refuses a beheaded or docked pool even at full count", () => {
  const headless = TEN_SLOT_POOL.split("\n").filter((line) => !line.startsWith("opencode-go/"))
  assert.equal(
    shouldKeepPool({ currentPoolText: TEN_SLOT_POOL, newSlots: [...headless.slice(0, 7), "opencode/zen  2  b:opencode"] }).keep,
    true,
  )
  const tailless = TEN_SLOT_POOL.split("\n").filter((line) => !line.includes("b:opencode"))
  assert.equal(
    shouldKeepPool({ currentPoolText: TEN_SLOT_POOL, newSlots: [...tailless.slice(0, 7), "groq/a  2"] }).keep,
    true,
    "dropping the zen tail must keep the previous pool",
  )
})

test("shouldKeepPool passes a healthy selection and a first-ever run", () => {
  const full = TEN_SLOT_POOL.split("\n").filter((line) => line && !line.startsWith("#"))
  assert.equal(shouldKeepPool({ currentPoolText: TEN_SLOT_POOL, newSlots: full }).keep, false)
  const minimal = [full[0], full[1], full[3], full[4], full[9]]
  assert.equal(minimal.length, 5)
  assert.equal(shouldKeepPool({ currentPoolText: TEN_SLOT_POOL, newSlots: minimal }).keep, false)
  assert.equal(shouldKeepPool({ currentPoolText: "", newSlots: full.slice(0, 2) }).keep, false)
  assert.equal(shouldKeepPool({ currentPoolText: "# header only\n", newSlots: full.slice(0, 1) }).keep, false)
})

test("computeScanBench benches transient failures and clears answered members", () => {
  const now = 1_000_000
  const providers = [
    {
      provider: "opencode-go",
      rows: [
        { model: "opencode-go/a", ok: false, reason: "timeout after 12000ms", kind: "timeout", retryAfter: now + 300_000 },
        { model: "opencode-go/b", ok: true, score: 90 },
      ],
    },
    { provider: "groq", rows: [{ model: "groq/a", ok: false, reason: "not served: 404", kind: "not-served" }] },
  ]
  const { bench, clear } = computeScanBench({ selectionModels: ["opencode-go/a", "opencode-go/b", "groq/a", "unscanned/x"], providers, now })
  assert.deepEqual(
    bench,
    [{ model: "opencode-go/a", until: now + 300_000, kind: "timeout" }],
    "only the transiently failed member is benched, at its stated reset",
  )
  assert.deepEqual(clear, ["opencode-go/b"], "an answered member has its stale bench cleared")
})

test("computeScanBench falls back to a 45-minute window without a stated reset", () => {
  const now = 1_000_000
  const providers = [{ provider: "mistral", rows: [{ model: "mistral/a", ok: false, reason: "socket hang up", kind: "network" }] }]
  const { bench } = computeScanBench({ selectionModels: ["mistral/a"], providers, now })
  assert.equal(bench[0].until, now + 45 * 60 * 1000)
})

test("applyScanBench writes atomic limit files and clears answered ones", () => {
  const home = mkdtempSync(join(tmpdir(), "refresh-pool-bench-"))
  const dir = join(home, ".local", "share", "opencode", "agent-pool")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "limit.opencode-go__b.json"), JSON.stringify({ model: "opencode-go/b", until: 1, reason: "x", strikes: 1, last: 0 }))
  const applied = applyScanBench({
    dir,
    bench: [{ model: "opencode-go/a", until: 2_000_000, kind: "timeout" }],
    clear: ["opencode-go/b", "never/existed"],
  })
  assert.deepEqual(applied.benched, ["opencode-go/a"])
  const record = JSON.parse(readFileSync(join(dir, "limit.opencode-go__a.json"), "utf8"))
  assert.equal(record.reason, "scan-kept")
  assert.equal(record.until, 2_000_000)
  assert.ok(!existsSync(join(dir, "limit.opencode-go__b.json")), "an answered member's bench must be removed")
  rmSync(home, { recursive: true, force: true })
})

test("scheduleRetrySoon runs a canary recheck", () => {
  const calls = []
  const exec = (file, args) => calls.push([file, ...args])
  const result = scheduleRetrySoon(300, {
    now: () => 1_000_000,
    exec,
    scriptPath: "/repo/scripts/refresh-pool.mjs",
    nodePath: "/usr/bin/node",
    home: "/home/tester",
  })
  assert.deepEqual(result, { scheduled: true, seconds: 300 })
  assert.ok(calls[0].includes("--canary"), "degraded retries must run the cheap canary first")
  assert.ok(calls[0].includes("/repo/scripts/refresh-pool.mjs"))
})

test("shouldKeepPool allows recovery from a previously clobbered pool", () => {
  const thin = "opencode-go/a  4  c:1048576\nopencode/b  2  b:opencode  c:1048576\n"
  const full = TEN_SLOT_POOL.split("\n").filter((line) => line && !line.startsWith("#"))
  assert.equal(shouldKeepPool({ currentPoolText: thin, newSlots: [...full.slice(0, 7), full[9]] }).keep, false)
})

test("degradedRetryDelay rechecks within 5 minutes while degraded", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z")
  assert.equal(
    degradedRetryDelay({ after: "2026-11-10T18:00:00.000Z", models: [] }, now),
    300,
    "a reset hours out must not stop the 5-minute rechecks",
  )
  assert.equal(
    degradedRetryDelay({ after: "2026-11-10T12:02:00.000Z", models: [] }, now),
    120,
    "an earlier provider reset is honoured",
  )
  assert.equal(degradedRetryDelay({ after: "2026-11-10T11:00:00.000Z", models: [] }, now), 300)
  assert.equal(degradedRetryDelay(undefined, now), 300)
})

test("scheduleRetrySoon schedules a recheck on the degraded cadence", () => {
  const calls = []
  const exec = (file, args) => calls.push([file, ...args])
  const result = scheduleRetrySoon(300, {
    now: () => 1_000_000,
    exec,
    scriptPath: "/repo/scripts/refresh-pool.mjs",
    nodePath: "/usr/bin/node",
    home: "/home/tester",
  })
  assert.deepEqual(result, { scheduled: true, seconds: 300 })
  assert.ok(calls[0].includes("--on-active=300"))
})

test("a degenerate scan never replaces a healthy pool file", () => {
  const home = mkdtempSync(join(tmpdir(), "refresh-pool-guard-"))
  const conf = join(home, ".config", "lacode")
  mkdirSync(conf, { recursive: true })
  writeFileSync(
    join(conf, "model-scores.json"),
    JSON.stringify({ generatedAt: GENERATED, providers: [], selection: TWO_SLOT_SELECTION, warnings: [] }),
  )
  writeFileSync(join(conf, "pool.txt"), TEN_SLOT_POOL)

  const script = fileURLToPath(new URL("../scripts/refresh-pool.mjs", import.meta.url))
  const run = () =>
    spawnSync(process.execPath, [script, "--from-scores", "--no-retry", "--scores", join(conf, "model-scores.json"), "--pool", join(conf, "pool.txt")], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    })

  const result = run()
  assert.equal(readFileSync(join(conf, "pool.txt"), "utf8"), TEN_SLOT_POOL, "the healthy pool must survive a degenerate scan")
  assert.ok(
    (result.status === 1 && /fail closed|breaks the pool structure|refusing to shrink/.test(result.stderr)) ||
      (result.status === 0 && /status degraded/.test(result.stdout)),
    `either the write guard or the status early-out must keep the pool (status=${result.status} out=${result.stdout} err=${result.stderr})`,
  )

  rmSync(home, { recursive: true, force: true })
})
