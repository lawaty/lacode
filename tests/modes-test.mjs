import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"

const DIR = mkdtempSync(join(tmpdir(), "lacode-modes-"))
const CONFIG = join(DIR, "opencode", "opencode.jsonc")
const LACODE = "file:///home/lawaty/Projects/lacode/dist/index.js"
process.env.XDG_CONFIG_HOME = DIR

const writeConfig = (text) => {
  mkdirSync(dirname(CONFIG), { recursive: true })
  writeFileSync(CONFIG, text)
}
const baseConfig = (options = { yolo: false, ykb: false }, name = LACODE) =>
  `{\n  "plugin": [\n    ["${name}", ${JSON.stringify(options)}]\n  ]\n}\n`
const reset = () => writeConfig(baseConfig())

const {
  YKB_INSTRUCTION,
  readModes,
  recommendedAnswer,
  toggleMode,
  writeModes,
} = await import("../src/lib/modes.ts")
const { modesHooks } = await import("../src/plugins/modes.ts")

const fakeClient = () => {
  const calls = { permissions: [], questions: [], logs: [] }
  return {
    calls,
    client: {
      app: { log: async (entry) => { calls.logs.push(entry) } },
      postSessionIdPermissionsPermissionId: async (args) => { calls.permissions.push(args) },
      question: { reply: async (args) => { calls.questions.push(args) } },
      tui: { showToast: async () => {} },
    },
  }
}

after(() => rmSync(DIR, { recursive: true, force: true }))

test("modes store defaults to off, writes atomically, and toggles independently", () => {
  reset()
  assert.deepEqual(readModes(), { yolo: false, ykb: false })
  writeModes({ yolo: true, ykb: false })
  assert.deepEqual(readModes(), { yolo: true, ykb: false })
  assert.deepEqual(toggleMode("ykb"), { yolo: true, ykb: true })
  assert.deepEqual(JSON.parse(readFileSync(CONFIG, "utf8")).plugin[0], [LACODE, { yolo: true, ykb: true }])
  assert.equal(readdirSync(dirname(CONFIG)).some((name) => name.endsWith(".tmp")), false)
})

test("invalid live state falls back to the configured defaults", () => {
  reset()
  writeConfig("{ nope")
  assert.deepEqual(readModes({ yolo: true }), { yolo: true, ykb: false })
  assert.throws(() => toggleMode("yolo", { yolo: true }), /Failed to parse/)
})

test("recommendedAnswer prefers the (Recommended) option, then the first option", () => {
  assert.deepEqual(
    recommendedAnswer({ options: [{ label: "A" }, { label: "B" }, { label: "C (Recommended)" }] }),
    ["C (Recommended)"],
  )
  assert.deepEqual(recommendedAnswer({ options: [{ label: "A" }, { label: "B" }] }), ["A"])
  assert.deepEqual(recommendedAnswer({ options: [] }), [])
  assert.deepEqual(recommendedAnswer({}), [])
})

test("YOLO turns an ask into allow and never overrides deny", async () => {
  reset()
  writeModes({ yolo: true, ykb: false })
  const { client } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  const ask = { status: "ask" }
  await hooks["permission.ask"]({}, ask)
  assert.equal(ask.status, "allow")

  const deny = { status: "deny" }
  await hooks["permission.ask"]({}, deny)
  assert.equal(deny.status, "deny")

  writeModes({ yolo: false, ykb: false })
  const off = { status: "ask" }
  await hooks["permission.ask"]({}, off)
  assert.equal(off.status, "ask")
})

test("YOLO replies once to a permission request that still reaches the event bus", async () => {
  reset()
  writeModes({ yolo: true, ykb: false })
  const { client, calls } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  await hooks.event({
    event: {
      type: "permission.asked",
      properties: { id: "p1", sessionID: "s1", permission: "edit", patterns: ["*"], metadata: {} },
    },
  })

  assert.deepEqual(calls.permissions, [
    { path: { id: "s1", permissionID: "p1" }, body: { response: "once" } },
  ])
})

test("YKB auto-answers a question with its recommended option and leaves the rest alone", async () => {
  reset()
  writeModes({ yolo: false, ykb: true })
  const { client, calls } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  await hooks.event({
    event: {
      type: "question.asked",
      properties: {
        id: "q1",
        sessionID: "s1",
        questions: [
          { question: "Which?", header: "Which", options: [{ label: "one" }, { label: "two (Recommended)" }] },
        ],
      },
    },
  })
  assert.deepEqual(calls.questions, [{ requestID: "q1", answers: [["two (Recommended)"]] }])

  writeModes({ yolo: false, ykb: false })
  await hooks.event({
    event: {
      type: "question.asked",
      properties: {
        id: "q2",
        sessionID: "s1",
        questions: [{ question: "Which?", header: "Which", options: [{ label: "one" }] }],
      },
    },
  })
  assert.equal(calls.questions.length, 1)
})

test("YKB leaves a free-text question with no options for the user", async () => {
  reset()
  writeModes({ yolo: false, ykb: true })
  const { client, calls } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  await hooks.event({
    event: {
      type: "question.asked",
      properties: {
        id: "q3",
        sessionID: "s1",
        questions: [{ question: "Name?", header: "Name", options: [] }],
      },
    },
  })

  assert.equal(calls.questions.length, 0)
  assert.equal(calls.logs.length > 0, true)
})

test("YKB appends its instruction once and removes it when disabled", async () => {
  reset()
  writeModes({ yolo: false, ykb: true })
  const { client } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  const output = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({}, output)
  await hooks["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.filter((line) => line === YKB_INSTRUCTION).length, 1)

  writeModes({ yolo: false, ykb: false })
  const off = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({}, off)
  assert.deepEqual(off.system, ["base"])
})

test("plugin options apply only when the live config omits a key", () => {
  reset()
  writeConfig(`{\n  "plugin": [\n    ["${LACODE}", { "yolo": true }]\n  ]\n}\n`)
  assert.deepEqual(readModes({ yolo: false, ykb: true }), { yolo: true, ykb: true })
})

test("readModes fills a missing key from defaults and ignores unknown or non-boolean values", () => {
  reset()
  writeConfig(`{\n  "plugin": [\n    ["${LACODE}", { "yolo": true, "extra": "ignored" }]\n  ]\n}\n`)
  assert.deepEqual(readModes({ ykb: true }), { yolo: true, ykb: true })

  writeConfig(`{\n  "plugin": [\n    ["${LACODE}", { "yolo": "yes", "ykb": 1 }]\n  ]\n}\n`)
  assert.deepEqual(readModes({ yolo: true, ykb: true }), { yolo: true, ykb: true })
})

test("toggleMode preserves the other mode and uses defaults for a missing key", () => {
  reset()
  writeConfig(`{\n  "plugin": [\n    ["${LACODE}", { "yolo": true }]\n  ]\n}\n`)
  assert.deepEqual(toggleMode("ykb", { ykb: false }), { yolo: true, ykb: true })

  reset()
  writeConfig(`{\n  "plugin": [\n    ["${LACODE}", { "yolo": true }]\n  ]\n}\n`)
  assert.deepEqual(toggleMode("ykb", { ykb: true }), { yolo: true, ykb: false })
})

test("writeModes requires the lacode plugin entry", () => {
  writeConfig(`{ "plugin": ["other-plugin"] }\n`)
  assert.throws(() => writeModes({ yolo: true, ykb: false }), /lacode plugin entry not found/)
})

test("writeModes preserves JSONC comments and converts a string entry to a tuple", () => {
  writeConfig(`{\n  // keep this\n  "plugin": ["${LACODE}"]\n}\n`)
  writeModes({ yolo: true, ykb: false })
  const text = readFileSync(CONFIG, "utf8")
  assert.match(text, /\/\/ keep this/)
  assert.deepEqual(JSON.parse(text.replace(/\n\s*\/\/ keep this/, "")).plugin[0], [LACODE, { yolo: true, ykb: false }])
})

test("recommendedAnswer handles case, description markers, non-string labels and malformed input", () => {
  assert.deepEqual(recommendedAnswer({ options: [{ label: "A" }, { label: "B (recommended)" }] }), ["B (recommended)"])
  assert.deepEqual(recommendedAnswer({ options: [{ label: "A" }, { label: "B", description: "(RECOMMENDED)" }] }), ["B"])
  assert.deepEqual(recommendedAnswer({ options: [{ label: 1 }, { label: "B" }] }), ["B"])
  assert.deepEqual(recommendedAnswer({ options: "not-an-array" }), [])
  assert.deepEqual(recommendedAnswer(null), [])
})

test("a malformed permission event is ignored without throwing", async () => {
  reset()
  writeModes({ yolo: true, ykb: false })
  const { client, calls } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  await assert.doesNotReject(() => hooks.event({ event: { type: "permission.asked" } }))
  await assert.doesNotReject(() => hooks.event({ event: { type: "permission.asked", properties: {} } }))
  assert.equal(calls.permissions.length, 0)
})

test("YKB answers every question in one request and picks one option even when multiple is allowed", async () => {
  reset()
  writeModes({ yolo: false, ykb: true })
  const { client, calls } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  await hooks.event({
    event: {
      type: "question.asked",
      properties: {
        id: "q1",
        sessionID: "s1",
        questions: [
          { multiple: true, options: [{ label: "one" }, { label: "two" }] },
          { options: [{ label: "A" }, { label: "B (Recommended)" }] },
        ],
      },
    },
  })
  assert.deepEqual(calls.questions, [
    { requestID: "q1", answers: [["one"], ["B (Recommended)"]] },
  ])
})

test("YKB ignores a question request with no questions", async () => {
  reset()
  writeModes({ yolo: false, ykb: true })
  const { client, calls } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  await hooks.event({
    event: { type: "question.asked", properties: { id: "q1", sessionID: "s1", questions: [] } },
  })
  assert.equal(calls.questions.length, 0)
})

test("YKB system transform tolerates a non-array system field", async () => {
  reset()
  writeModes({ yolo: false, ykb: true })
  const { client } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  await assert.doesNotReject(() =>
    hooks["experimental.chat.system.transform"]({}, { system: "not-an-array" }),
  )
})

test("YOLO and YKB do not activate each other", async () => {
  reset()
  writeModes({ yolo: true, ykb: false })
  const { client } = fakeClient()
  const hooks = await modesHooks({ client }, {})

  const output = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({}, output)
  assert.deepEqual(output.system, ["base"])

  writeModes({ yolo: false, ykb: true })
  const ask = { status: "ask" }
  await hooks["permission.ask"]({}, ask)
  assert.equal(ask.status, "ask")
})

test("a failed question reply is logged instead of thrown", async () => {
  reset()
  writeModes({ yolo: false, ykb: true })
  const logs = []
  const client = {
    app: { log: async (entry) => { logs.push(entry) } },
    question: { reply: async () => { throw new Error("already answered") } },
    postSessionIdPermissionsPermissionId: async () => {},
  }
  const hooks = await modesHooks({ client }, {})

  await assert.doesNotReject(() =>
    hooks.event({
      event: {
        type: "question.asked",
        properties: { id: "q", sessionID: "s", questions: [{ options: [{ label: "one" }] }] },
      },
    }),
  )
  assert.match(JSON.stringify(logs), /could not auto-answer question q/)
})
