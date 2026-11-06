// refresh-pool: build a rewritten pool.txt from scorer output.
//
// The scorer measures; this module decides. It never writes on a fail-closed
// condition and never partially writes. These tests pin the pure buildPool()
// contract with fixtures and no filesystem/network side effects.
//
// Run with: node --test tests/refresh-pool-test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildPool, renderTimerUnits } from "../scripts/refresh-pool.mjs"

const NOW = new Date("2026-11-06T12:00:00.000Z")

function makeScores(overrides = {}) {
  return {
    generatedAt: "2026-11-06T03:41:14.089Z",
    providers: [
      {
        provider: "opencode-go",
        error: null,
        rows: [
          // out of score order on purpose
          { model: "opencode-go/beam-free", ok: true, score: 96.0, reason: "answered" },
          { model: "opencode-go/crouton-alpha-free", ok: true, score: 88.7, reason: "answered" },
          { model: "opencode-go/iceman-contributor-free", ok: true, score: 88.6, reason: "answered" },
          { model: "opencode-go/broken-free", ok: false, score: 40, reason: "timeout" },
          { model: "opencode-go/unscored-free", ok: true, score: null, reason: "answered" },
        ],
      },
      {
        provider: "opencode",
        error: null,
        rows: [
          { model: "opencode/crouton-alpha-free", ok: true, score: 94.5, reason: "answered" },
          { model: "opencode/pulse-alpha-free", ok: true, score: 90.9, reason: "answered" },
          { model: "opencode/big-pickle", ok: true, score: 59.0, reason: "answered" },
          { model: "opencode/deepseek-v4.1-flash-free", ok: true, score: 59.0, reason: "answered" },
          { model: "opencode/not-ok-free", ok: false, score: 99.9, reason: "http 429" },
        ],
      },
      {
        provider: "openrouter",
        error: null,
        rows: [
          { model: "openrouter/cohere/north-mini-code:free", ok: true, score: 90.6, reason: "answered" },
          { model: "openrouter/small-context:free", ok: true, score: 99, context: 100000, reason: "answered" },
        ],
      },
      {
        provider: "console-openrouter",
        error: null,
        rows: [
          { model: "console-openrouter/cohere/north-mini-code:free", ok: true, score: 89.0, reason: "answered" },
        ],
      },
    ],
    ...overrides,
  }
}

const CURRENT_POOL = `# LaCode pool — one model per line:  <provider>/<model-id>  [weight]
#
# weight is optional (default 1).

cerebras/gpt-oss-120b                            2
groq/openai/gpt-oss-120b                         2
  mistral/codestral-latest                         2  # keep my indent/comment
openrouter/cohere/north-mini-code:free           2
console-openrouter/cohere/north-mini-code:free   2
opencode/deepseek-v4.1-flash-free                2  b:opencode
opencode/big-pickle                              2  b:opencode
`

test("buildPool ranks opencode-go first, then the best others, and applies the floors", () => {
  const { text, slots, chosen, warnings } = buildPool({ scores: makeScores(), currentPoolText: CURRENT_POOL, now: NOW })

  assert.deepEqual(chosen.opencodeGo, ["opencode-go/beam-free", "opencode-go/crouton-alpha-free", "opencode-go/iceman-contributor-free"])
  assert.deepEqual(chosen.others, ["opencode/crouton-alpha-free", "opencode/pulse-alpha-free", "openrouter/cohere/north-mini-code:free", "console-openrouter/cohere/north-mini-code:free"])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /only 7 scorable model\(s\) available, wanted 10/)

  assert.equal(slots.length, 7)
  assert.deepEqual(slots, [
    "opencode-go/beam-free  4",
    "opencode-go/crouton-alpha-free  4",
    "opencode-go/iceman-contributor-free  4",
    "opencode/crouton-alpha-free  2  b:opencode",
    "opencode/pulse-alpha-free  2  b:opencode",
    "openrouter/cohere/north-mini-code:free  2",
    "console-openrouter/cohere/north-mini-code:free  2",
  ])

  assert.ok(!text.includes("cerebras/gpt-oss-120b"))
  assert.ok(!text.includes("groq/openai/gpt-oss-120b"))
  assert.ok(!text.includes("mistral/codestral-latest"))
  assert.ok(!text.includes("openrouter/small-context:free"))
  assert.ok(!text.includes("opencode/big-pickle"))
  assert.ok(!text.includes("opencode/deepseek-v4.1-flash-free"))

  // header preserved (original comment survived)
  assert.ok(text.includes("# LaCode pool — one model per line"))
  assert.ok(text.includes("# weight is optional (default 1)."))

  // one generated refresh comment
  const refreshLines = text.split("\n").filter((l) => /^#\s*Refreshed\b/.test(l))
  assert.equal(refreshLines.length, 1)
  assert.match(refreshLines[0], /Refreshed 2026-11-06T12:00:00\.000Z/)
  assert.match(refreshLines[0], /scores generated 2026-11-06T03:41:14\.089Z/)
  assert.match(refreshLines[0], /opencode-go first \(weight 4\)/)
})

test("consecutive runs do not duplicate the refresh comment", () => {
  const first = buildPool({ scores: makeScores(), currentPoolText: CURRENT_POOL, now: NOW })
  const second = buildPool({
    scores: makeScores(),
    currentPoolText: first.text,
    now: new Date("2026-11-07T12:00:00.000Z"),
  })
  const refreshLines = second.text.split("\n").filter((l) => /^#\s*Refreshed\b/.test(l))
  assert.equal(refreshLines.length, 1)
  assert.match(refreshLines[0], /2026-11-07T12:00:00\.000Z/)
  assert.deepEqual(second.slots, first.slots)
})

test("builds from the other providers when opencode-go has no usable rows", () => {
  let scores = makeScores()
  scores.providers = scores.providers.map((p) =>
    p.provider === "opencode-go"
      ? { ...p, rows: p.rows.map((r) => ({ ...r, ok: false, score: null })) }
      : p,
  )
  const { chosen, slots } = buildPool({ scores, currentPoolText: CURRENT_POOL, now: NOW })
  assert.deepEqual(chosen.opencodeGo, [])
  assert.deepEqual(chosen.others, ["opencode/crouton-alpha-free", "opencode/pulse-alpha-free", "openrouter/cohere/north-mini-code:free", "console-openrouter/cohere/north-mini-code:free"])
  assert.deepEqual(slots, ["opencode/crouton-alpha-free  2  b:opencode", "opencode/pulse-alpha-free  2  b:opencode", "openrouter/cohere/north-mini-code:free  2", "console-openrouter/cohere/north-mini-code:free  2"])
})

test("builds without opencode when it has no usable rows", () => {
  let scores = makeScores()
  scores.providers = scores.providers.map((p) =>
    p.provider === "opencode"
      ? { ...p, rows: p.rows.map((r) => ({ ...r, ok: false })) }
      : p,
  )
  const { chosen, slots } = buildPool({ scores, currentPoolText: CURRENT_POOL, now: NOW })
  assert.deepEqual(chosen.opencodeGo, ["opencode-go/beam-free", "opencode-go/crouton-alpha-free", "opencode-go/iceman-contributor-free"])
  assert.deepEqual(chosen.others, ["openrouter/cohere/north-mini-code:free", "console-openrouter/cohere/north-mini-code:free"])
  assert.equal(slots.length, 5)
})

test("fail-closed when no row clears the score floor", () => {
  let scores = makeScores()
  scores.providers = scores.providers.map((p) => ({
    ...p,
    rows: p.rows.map((r) => ({ ...r, ok: true, score: 10 })),
  }))
  assert.throws(() => buildPool({ scores, currentPoolText: CURRENT_POOL, now: NOW }), /no scorable model/i)
})

test("fail-closed on missing/invalid scores shape", () => {
  assert.throws(() => buildPool({ scores: null, currentPoolText: CURRENT_POOL, now: NOW }), /missing or invalid/)
  assert.throws(() => buildPool({ scores: { nope: true }, currentPoolText: CURRENT_POOL, now: NOW }), /missing or invalid/)
  assert.throws(() => buildPool({ scores: "bad", currentPoolText: "", now: NOW }), /missing or invalid/)
})

test("empty current pool keeps header semantics and still builds blocks", () => {
  const { text, slots } = buildPool({ scores: makeScores(), currentPoolText: "# header only\n\n", now: NOW })
  assert.ok(text.includes("# header only"))
  assert.equal(slots.length, 7)
  assert.equal(slots[0], "opencode-go/beam-free  4")
  assert.equal(slots[slots.length - 1], "console-openrouter/cohere/north-mini-code:free  2")
})

test("renderTimerUnits returns user systemd service and daily timer", () => {
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
  assert.match(units.service, /ExecStart=\/usr\/bin\/node \/repo\/scripts\/refresh-pool\.mjs/)
  assert.match(units.service, /Environment=PATH=\/home\/tester\/\.opencode\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin/)
  assert.match(units.service, /Nice=10/)

  assert.match(units.timer, /Description=Daily LaCode model pool refresh/)
  assert.match(units.timer, /OnCalendar=\*-\*-\* 01:00:00/)
  assert.ok(!units.timer.includes("RandomizedDelaySec"))
  assert.match(units.timer, /Persistent=true/)
  assert.match(units.timer, /Unit=lacode-refresh-pool\.service/)
  assert.match(units.timer, /WantedBy=timers\.target/)
})

test("--install-timer --stable copies the script and points ExecStart at it", () => {
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
  const service = readFileSync(join(home, ".config", "systemd", "user", "lacode-refresh-pool.service"), "utf8")
  assert.ok(service.includes(`ExecStart=${process.execPath} ${stable}`), service)
  const timer = readFileSync(join(home, ".config", "systemd", "user", "lacode-refresh-pool.timer"), "utf8")
  assert.match(timer, /OnCalendar=\*-\*-\* 01:00:00/)
  rmSync(home, { recursive: true, force: true })
})
