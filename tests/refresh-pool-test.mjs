// refresh-pool: build a rewritten pool.txt from scorer output.
//
// The scorer measures; this module decides. It never writes on a fail-closed
// condition and never partially writes. These tests pin the pure buildPool()
// contract with fixtures and no filesystem/network side effects.
//
// Run with: node --test tests/refresh-pool-test.mjs

import test from "node:test"
import assert from "node:assert/strict"

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
          { model: "opencode-go/paid-model", ok: true, score: 99, reason: "answered" },
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

test("buildPool orders blocks, preserves unscored, normalizes generated", () => {
  const { text, slots, chosen } = buildPool({ scores: makeScores(), currentPoolText: CURRENT_POOL, now: NOW })

  assert.equal(chosen.opencode, "opencode/crouton-alpha-free")
  assert.deepEqual(chosen.opencodeGo, [
    "opencode-go/beam-free",
    "opencode-go/crouton-alpha-free",
    "opencode-go/iceman-contributor-free",
  ])
  assert.deepEqual(chosen.preserved, [
    "cerebras/gpt-oss-120b",
    "groq/openai/gpt-oss-120b",
    "mistral/codestral-latest",
  ])

  // Exact order: 3 go (desc) + 3 preserved raw + 1 best opencode
  assert.equal(slots.length, 7)
  assert.equal(slots[0], "opencode-go/beam-free  4")
  assert.equal(slots[1], "opencode-go/crouton-alpha-free  4")
  assert.equal(slots[2], "opencode-go/iceman-contributor-free  4")
  // middle block preserves original raw line text, in order
  assert.equal(slots[3], "cerebras/gpt-oss-120b                            2")
  assert.equal(slots[4], "groq/openai/gpt-oss-120b                         2")
  assert.equal(slots[5], "  mistral/codestral-latest                         2  # keep my indent/comment")
  assert.equal(slots[6], "opencode/crouton-alpha-free  2  b:opencode")

  // scored openrouter/console/opencode slots dropped
  assert.ok(!text.includes("openrouter/cohere/north-mini-code:free"))
  assert.ok(!text.includes("console-openrouter/cohere/north-mini-code:free"))
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
  // preserved middle block still preserved from the already-refreshed text
  assert.ok(second.text.includes("  mistral/codestral-latest                         2  # keep my indent/comment"))
})

test("fail-closed when opencode-go has no usable rows", () => {
  const scores = makeScores()
  scores.providers[0].rows = [
    { model: "opencode-go/beam-free", ok: false, score: 96, reason: "timeout" },
    { model: "opencode-go/paid-model", ok: true, score: 99, reason: "answered" }, // not free
    { model: "opencode-go/no-score-free", ok: true, score: null, reason: "answered" },
  ]
  assert.throws(
    () => buildPool({ scores, currentPoolText: CURRENT_POOL, now: NOW }),
    /opencode-go.*refusing to write/i,
  )
})

test("fail-closed when opencode has no usable rows", () => {
  const scores = makeScores()
  scores.providers[1].rows = [{ model: "opencode/crouton-alpha-free", ok: false, score: 94.5 }]
  assert.throws(
    () => buildPool({ scores, currentPoolText: CURRENT_POOL, now: NOW }),
    /opencode.*refusing to write/i,
  )
})

test("fail-closed on missing/invalid scores shape", () => {
  assert.throws(() => buildPool({ scores: null, currentPoolText: CURRENT_POOL, now: NOW }), /missing or invalid/)
  assert.throws(() => buildPool({ scores: { nope: true }, currentPoolText: CURRENT_POOL, now: NOW }), /missing or invalid/)
  assert.throws(() => buildPool({ scores: "bad", currentPoolText: "", now: NOW }), /missing or invalid/)
})

test("empty current pool keeps header semantics and still builds blocks", () => {
  const { text, slots } = buildPool({ scores: makeScores(), currentPoolText: "# header only\n\n", now: NOW })
  assert.ok(text.includes("# header only"))
  assert.equal(slots.length, 4) // 3 go + 0 preserved + 1 opencode
  assert.equal(slots[slots.length - 1], "opencode/crouton-alpha-free  2  b:opencode")
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
  assert.match(units.timer, /OnCalendar=daily/)
  assert.match(units.timer, /RandomizedDelaySec=2h/)
  assert.match(units.timer, /Persistent=true/)
  assert.match(units.timer, /Unit=lacode-refresh-pool\.service/)
  assert.match(units.timer, /WantedBy=timers\.target/)
})
