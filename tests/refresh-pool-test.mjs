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
import { buildPool, renderTimerUnits, scheduleRetry } from "../scripts/refresh-pool.mjs"

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

test("--install-timer --stable copies all three modules and points ExecStart at the stable script", () => {
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
