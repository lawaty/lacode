import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, bootLaCode, cleanupAll, scratch, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const MODES_FILE = join(scratch("lacode-modes-story-"), "modes.json")
process.env.LACODE_MODES_FILE = MODES_FILE
process.env.LACODE_SOUND = "0"
process.env.LACODE_NO_SELFUPDATE = "1"
const HELPER = join(scratch("lacode-notify-helper-"), "oc-notify")
writeFileSync(HELPER, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 })
process.env.OC_NOTIFY_HELPER = HELPER

const {
  MODES_FILE: LIVE_MODES_FILE,
  YKB_INSTRUCTION,
  readModes,
  recommendedAnswer,
  toggleMode,
  writeModes,
} = await import("../../src/lib/modes.ts")
const { modesHooks } = await import("../../src/plugins/modes.ts")

const reset = () => rmSync(MODES_FILE, { force: true })
const stop = async (hooks) => {
  try {
    await hooks.dispose?.()
  } catch {}
}
const source = (path) => readFileSync(join(ROOT, path), "utf8")
const docs = () => `${source("README.md")}\n${source("docs/CONFIGURATION.md")}`
const emit = (hooks, type, properties) => hooks.event({ event: { type, properties } })

const boot = async (options = {}) => {
  const stub = stubInput()
  const replies = { permissions: [], questions: [] }
  stub.client.question = {
    reply: async (args) => {
      replies.questions.push(args)
      return true
    },
  }
  stub.client.postSessionIdPermissionsPermissionId = async (args) => {
    replies.permissions.push(args)
    return { response: { status: 200 } }
  }
  const hooks = await bootLaCode(stub, options)
  return { stub, hooks, replies }
}

const direct = async (modes) => {
  reset()
  writeModes({ yolo: false, ykb: false, ...modes })
  const logs = []
  const replies = { permissions: [], questions: [] }
  const client = {
    app: { log: async (entry) => { logs.push(entry) } },
    postSessionIdPermissionsPermissionId: async (args) => { replies.permissions.push(args) },
    question: { reply: async (args) => { replies.questions.push(args) } },
  }
  const hooks = await modesHooks({ client }, {})
  return { hooks, logs, replies }
}

// ---------------------------------------------------------------------------
// US-37 — YOLO
// ---------------------------------------------------------------------------

test("[US-37] an ask becomes allow while deny and allow are left alone", async () => {
  reset()
  const { hooks } = await boot({ yolo: true })

  const ask = { status: "ask" }
  await hooks["permission.ask"]({}, ask)
  assert.equal(ask.status, "allow")

  const deny = { status: "deny" }
  await hooks["permission.ask"]({}, deny)
  assert.equal(deny.status, "deny")

  const allow = { status: "allow" }
  await hooks["permission.ask"]({}, allow)
  assert.equal(allow.status, "allow")

  await stop(hooks)
})

test("[US-37] YOLO off leaves an ask for the user", async () => {
  reset()
  const { hooks } = await boot({ yolo: false })

  const ask = { status: "ask" }
  await hooks["permission.ask"]({}, ask)
  assert.equal(ask.status, "ask")

  await stop(hooks)
})

test("[US-37] a live toggle changes the next decision without a restart", async () => {
  reset()
  const { hooks } = await boot({ yolo: false })

  const before = { status: "ask" }
  await hooks["permission.ask"]({}, before)
  assert.equal(before.status, "ask")

  toggleMode("yolo")
  const after = { status: "ask" }
  await hooks["permission.ask"]({}, after)
  assert.equal(after.status, "allow")

  toggleMode("yolo")
  const again = { status: "ask" }
  await hooks["permission.ask"]({}, again)
  assert.equal(again.status, "ask")

  await stop(hooks)
})

test("[US-37] plugin options seed the live state, and a later TUI toggle wins", async () => {
  reset()
  assert.equal(LIVE_MODES_FILE, MODES_FILE)

  const first = await boot({ yolo: true })
  assert.deepEqual(readModes(), { yolo: true, ykb: false })
  await stop(first.hooks)

  toggleMode("yolo")
  assert.deepEqual(readModes(), { yolo: false, ykb: false })

  const second = await boot({ yolo: true })
  assert.deepEqual(readModes(), { yolo: false, ykb: false })
  await stop(second.hooks)
})

test("[US-37] a permission event is answered once while YOLO is on, and malformed events are ignored", async () => {
  reset()
  const { hooks, replies } = await boot({ yolo: true })

  await emit(hooks, "permission.asked", {
    id: "p1",
    sessionID: "s1",
    permission: "edit",
    patterns: ["*"],
    metadata: {},
  })
  assert.deepEqual(replies.permissions, [
    { path: { id: "s1", permissionID: "p1" }, body: { response: "once" } },
  ])

  await emit(hooks, "permission.asked", { sessionID: "s1" })
  await emit(hooks, "permission.asked", { id: "p2" })
  assert.equal(replies.permissions.length, 1)

  await stop(hooks)
})

test("[US-37] a failed auto-approval is logged instead of escaping the event handler", async () => {
  reset()
  writeModes({ yolo: true, ykb: false })
  const logs = []
  const client = {
    app: { log: async (entry) => { logs.push(entry) } },
    postSessionIdPermissionsPermissionId: async () => {
      throw new Error("already answered")
    },
  }
  const hooks = await modesHooks({ client }, {})

  await assert.doesNotReject(() =>
    emit(hooks, "permission.asked", { id: "p", sessionID: "s" }),
  )
  assert.match(JSON.stringify(logs), /could not auto-approve permission p/)
})

test("[US-37] the TUI registers /yolo and drains pending permissions; docs name it", () => {
  const tui = source("src/tui/index.ts")
  assert.match(tui, /name:\s*"lacode\.mode\.yolo"/)
  assert.match(tui, /slashName:\s*"yolo"/)
  assert.match(tui, /runToggleMode\("yolo"\)/)
  assert.match(tui, /drainPendingMode/)
  assert.match(tui, /fetchPending\(api\)/)
  assert.match(tui, /api\.client\.permission\.reply/)
  assert.match(tui, /toggleMode\(name\)/)

  const text = docs()
  assert.match(text, /`yolo`/)
  assert.match(text, /\/yolo/)
  assert.match(text, /\/modes/)
  assert.match(text, /modes\.json/)
  assert.match(text, /LACODE_MODES_FILE/)
})

// ---------------------------------------------------------------------------
// US-38 — YKB
// ---------------------------------------------------------------------------

test("[US-38] the system prompt carries the YKB instruction once, and not when the mode is off", async () => {
  reset()
  const { hooks } = await boot({ ykb: true })

  const output = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, output)
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, output)
  assert.equal(output.system.filter((line) => line === YKB_INSTRUCTION).length, 1)

  toggleMode("ykb")
  const off = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, off)
  assert.deepEqual(off.system, ["base"])

  await stop(hooks)
})

test("[US-38] each question selects its recommended option, or the first option", async () => {
  reset()
  const { hooks, replies } = await boot({ ykb: true })

  await emit(hooks, "question.asked", {
    id: "q1",
    sessionID: "s1",
    questions: [
      { question: "A?", header: "A", options: [{ label: "one" }, { label: "two (Recommended)" }] },
      { question: "B?", header: "B", options: [{ label: "first" }, { label: "second" }] },
    ],
  })
  assert.deepEqual(replies.questions, [
    { requestID: "q1", answers: [["two (Recommended)"], ["first"]] },
  ])

  await stop(hooks)
})

test("[US-38] the recommendation marker is case-insensitive and may be in the description", async () => {
  const { hooks, replies } = await direct({ ykb: true })

  await emit(hooks, "question.asked", {
    id: "q1",
    sessionID: "s1",
    questions: [
      { options: [{ label: "A" }, { label: "B (RECOMMENDED)" }] },
      { options: [{ label: "C", description: "This is recommended" }, { label: "D" }] },
    ],
  })
  assert.deepEqual(replies.questions, [
    { requestID: "q1", answers: [["B (RECOMMENDED)"], ["C"]] },
  ])
})

test("[US-38] a free-text question with no options is left for the user and logged", async () => {
  const { hooks, logs, replies } = await direct({ ykb: true })

  await emit(hooks, "question.asked", {
    id: "q1",
    sessionID: "s1",
    questions: [{ options: [] }],
  })
  assert.equal(replies.questions.length, 0)
  assert.match(JSON.stringify(logs), /no options to choose from/)
})

test("[US-38] YKB off sends no answer to a question", async () => {
  reset()
  const { hooks, replies } = await boot({ ykb: false })

  await emit(hooks, "question.asked", {
    id: "q1",
    sessionID: "s1",
    questions: [{ options: [{ label: "one" }] }],
  })
  assert.equal(replies.questions.length, 0)

  await stop(hooks)
})

test("[US-38] YOLO and YKB act only on their own events", async () => {
  reset()
  const { hooks, replies } = await boot({ yolo: true, ykb: true })

  const ask = { status: "ask" }
  await hooks["permission.ask"]({}, ask)
  assert.equal(ask.status, "allow")

  await emit(hooks, "question.asked", {
    id: "q1",
    sessionID: "s1",
    questions: [{ options: [{ label: "one" }] }],
  })
  assert.equal(replies.questions.length, 1)

  toggleMode("yolo")
  const afterYoloOff = { status: "ask" }
  await hooks["permission.ask"]({}, afterYoloOff)
  assert.equal(afterYoloOff.status, "ask")

  await emit(hooks, "question.asked", {
    id: "q2",
    sessionID: "s1",
    questions: [{ options: [{ label: "one" }] }],
  })
  assert.equal(replies.questions.length, 2)

  toggleMode("ykb")
  await emit(hooks, "question.asked", {
    id: "q3",
    sessionID: "s1",
    questions: [{ options: [{ label: "one" }] }],
  })
  assert.equal(replies.questions.length, 2)

  await stop(hooks)
})

test("[US-38] a failed auto-answer is logged instead of escaping the event handler", async () => {
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
    emit(hooks, "question.asked", {
      id: "q",
      sessionID: "s",
      questions: [{ options: [{ label: "one" }] }],
    }),
  )
  assert.match(JSON.stringify(logs), /could not auto-answer question q/)
})

test("[US-38] the TUI registers /ykb and /modes, drains pending questions, and docs name them", () => {
  const tui = source("src/tui/index.ts")
  assert.match(tui, /name:\s*"lacode\.mode\.ykb"/)
  assert.match(tui, /slashName:\s*"ykb"/)
  assert.match(tui, /name:\s*"lacode\.mode\.status"/)
  assert.match(tui, /slashName:\s*"modes"/)
  assert.match(tui, /runToggleMode\("ykb"\)/)
  assert.match(tui, /recommendedAnswer\(question\)/)
  assert.match(tui, /api\.client\.question\.reply/)

  const text = docs()
  assert.match(text, /`ykb`/)
  assert.match(text, /\/ykb/)
  assert.match(text, /\/modes/)
})
