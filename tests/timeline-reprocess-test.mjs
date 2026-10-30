import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { timelineHooks } from "../src/plugins/timeline.ts"
import { readEntries, timelineFile } from "../src/lib/timeline.ts"
import { PRESET } from "./stories/_harness.mjs"

const dir = mkdtempSync(join(tmpdir(), "lacode-timeline-reprocess-"))
process.env.LACODE_TIMELINE_DIR = dir

after(() => rmSync(dir, { recursive: true, force: true }))

let summarizers = 0
const POOL = { id: "reprocess-test", dir: join(dir, "pool"), modelsFile: PRESET }

function stub({ sessions = {}, sessionMessages = {} } = {}) {
  const calls = { get: [], messages: [], create: [], prompt: [], delete: [], abort: [] }
  const client = {
    app: { log: async () => ({ data: true }) },
    session: {
      get: async ({ path }) => {
        calls.get.push(path.id)
        return { data: sessions[path.id] }
      },
      messages: async ({ path }) => {
        calls.messages.push(path.id)
        return { data: sessionMessages[path.id] ?? [] }
      },
      create: async (input) => {
        calls.create.push(input)
        return { data: { id: `summarizer-${++summarizers}` } }
      },
      prompt: async (input) => {
        calls.prompt.push(input)
        return { data: { parts: [{ type: "text", text: "- Root bullet one\n- Root bullet two" }] } }
      },
      delete: async ({ path }) => {
        calls.delete.push(path.id)
        return { data: true }
      },
      abort: async ({ path }) => {
        calls.abort.push(path.id)
        return { data: true }
      },
    },
  }
  return { client, input: { client, directory: "/tmp/lacode-reprocess" }, calls }
}

const boot = (s) => timelineHooks(s.input, POOL)

function ctx(sessionID, signal) {
  return {
    sessionID,
    messageID: "m1",
    agent: "implement",
    directory: "/tmp/lacode-reprocess",
    worktree: "/tmp/lacode-reprocess",
    abort: signal ?? new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
}

const run = (hooks, sessionID, signal) => hooks.tool.timeline_reprocess.execute({}, ctx(sessionID, signal))

const user = (id, text, created = 1) => ({ info: { id, role: "user", time: { created } }, parts: [{ type: "text", text }] })
const assistant = (id, text, created = 2) => ({ info: { id, role: "assistant", time: { created } }, parts: [{ type: "text", text }] })

test("child session reprocesses its root, not itself", async () => {
  const s = stub({
    sessions: {
      "child-1": { id: "child-1", title: "Child title", parentID: "root-1" },
      "root-1": { id: "root-1", title: "Root title" },
    },
    sessionMessages: {
      "child-1": [user("c1", "child only")],
      "root-1": [user("u1", "root question", 1), assistant("a1", "root answer", 2)],
    },
  })
  const out = await run(boot(s), "child-1")
  assert.match(out.output, /^Rebuilt 2 messages into 2 entries/)
  assert.deepEqual(s.calls.messages, ["root-1"])
  assert.ok(existsSync(timelineFile("root-1")))
  assert.equal(existsSync(timelineFile("child-1")), false)
  assert.deepEqual(readEntries("root-1").map((e) => e.text), ["Root bullet one", "Root bullet two"])
  const promptText = s.calls.prompt[0].body.parts[0].text
  assert.match(promptText, /Session: Root title/)
  assert.doesNotMatch(promptText, /Child title/)
})

test("walks a nested parent chain to the topmost root", async () => {
  const s = stub({
    sessions: {
      "grand-1": { id: "grand-1", title: "Grand", parentID: "mid-1" },
      "mid-1": { id: "mid-1", title: "Mid", parentID: "top-1" },
      "top-1": { id: "top-1", title: "Top" },
    },
    sessionMessages: {
      "grand-1": [user("g1", "grand only")],
      "mid-1": [user("m1", "mid only")],
      "top-1": [user("t1", "top question", 1), assistant("t2", "top answer", 2)],
    },
  })
  const out = await run(boot(s), "grand-1")
  assert.match(out.output, /^Rebuilt 2 messages into 2 entries/)
  assert.deepEqual(s.calls.messages, ["top-1"])
  assert.ok(existsSync(timelineFile("top-1")))
  assert.equal(existsSync(timelineFile("mid-1")), false)
  assert.equal(existsSync(timelineFile("grand-1")), false)
})

test("root session still reprocesses itself and replaces the previous file", async () => {
  writeFileSync(timelineFile("solo-1"), JSON.stringify({ ts: 1, text: "stale entry" }) + "\n")
  const s = stub({
    sessions: { "solo-1": { id: "solo-1", title: "Solo" } },
    sessionMessages: { "solo-1": [user("u1", "solo question", 1), assistant("a1", "solo answer", 2)] },
  })
  const out = await run(boot(s), "solo-1")
  assert.match(out.output, /^Rebuilt 2 messages into 2 entries/)
  assert.deepEqual(s.calls.messages, ["solo-1"])
  assert.deepEqual(readEntries("solo-1").map((e) => e.text), ["Root bullet one", "Root bullet two"])
})

test("terminates on a cyclic parent chain", async () => {
  const s = stub({
    sessions: {
      "cyc-a": { id: "cyc-a", title: "A", parentID: "cyc-b" },
      "cyc-b": { id: "cyc-b", title: "B", parentID: "cyc-a" },
    },
    sessionMessages: {
      "cyc-a": [user("u1", "a question", 1), assistant("a1", "a answer", 2)],
      "cyc-b": [user("u2", "b question", 1), assistant("a2", "b answer", 2)],
    },
  })
  const out = await run(boot(s), "cyc-a")
  assert.equal(typeof out.output, "string")
  assert.match(out.output, /^Rebuilt 2 messages into 2 entries/)
  assert.deepEqual(s.calls.messages, ["cyc-a"])
})

test("reports a missing session", async () => {
  const out = await run(boot(stub()), "missing-1")
  assert.equal(out.output, "Session not found.")
})

test("keeps the previous timeline when the root excerpt is empty", async () => {
  writeFileSync(timelineFile("empty-1"), JSON.stringify({ ts: 1, text: "previous entry" }) + "\n")
  const s = stub({
    sessions: { "empty-1": { id: "empty-1", title: "Empty" } },
    sessionMessages: { "empty-1": [user("u1", "timeline_reprocess please")] },
  })
  const out = await run(boot(s), "empty-1")
  assert.equal(out.output, "No entries generated; previous timeline kept.")
  assert.deepEqual(readEntries("empty-1").map((e) => e.text), ["previous entry"])
  assert.equal(s.calls.prompt.length, 0)
})

test("checks the root's running state, not the child's", async () => {
  const shared = globalThis[Symbol.for("lacode:timeline:state")]
  shared.sessions.set("busy-root", { running: true, pending: false, failures: 0 })
  try {
    const s = stub({
      sessions: {
        "busy-child": { id: "busy-child", title: "Child", parentID: "busy-root" },
        "busy-root": { id: "busy-root", title: "Busy" },
      },
      sessionMessages: { "busy-root": [user("u1", "question", 1)] },
    })
    const out = await run(boot(s), "busy-child")
    assert.equal(out.output, "The timeline is currently summarizing this session; try again in a moment.")
    assert.equal(s.calls.messages.length, 0)
  } finally {
    shared.sessions.delete("busy-root")
  }
})

test("guards concurrent reprocesses by root id", async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = stub({
    sessions: {
      "conc-child": { id: "conc-child", title: "Child", parentID: "conc-root" },
      "conc-root": { id: "conc-root", title: "Root" },
    },
    sessionMessages: { "conc-root": [user("u1", "question", 1), assistant("a1", "answer", 2)] },
  })
  s.client.session.prompt = async (input) => {
    s.calls.prompt.push(input)
    await gate
    return { data: { parts: [{ type: "text", text: "- one" }] } }
  }
  const hooks = boot(s)
  const first = run(hooks, "conc-child")
  while (s.calls.prompt.length === 0) await new Promise((r) => setTimeout(r, 1))
  const second = await run(hooks, "conc-child")
  assert.equal(second.output, "A timeline reprocess is already running for this session.")
  release()
  const done = await first
  assert.match(done.output, /^Rebuilt 2 messages into 1 entries/)
})

test("honours an already-aborted signal and keeps the previous timeline", async () => {
  writeFileSync(timelineFile("abort-1"), JSON.stringify({ ts: 1, text: "previous" }) + "\n")
  const s = stub({
    sessions: { "abort-1": { id: "abort-1", title: "Abort" } },
    sessionMessages: { "abort-1": [user("u1", "question", 1), assistant("a1", "answer", 2)] },
  })
  const out = await run(boot(s), "abort-1", AbortSignal.abort())
  assert.equal(out.output, "Aborted after 0 summarizer calls; previous timeline kept.")
  assert.equal(s.calls.prompt.length, 0)
  assert.deepEqual(readEntries("abort-1").map((e) => e.text), ["previous"])
})

test("keeps the previous timeline when the summarizer fails", async () => {
  writeFileSync(timelineFile("fail-1"), JSON.stringify({ ts: 1, text: "previous" }) + "\n")
  const s = stub({
    sessions: { "fail-1": { id: "fail-1", title: "Fail" } },
    sessionMessages: { "fail-1": [user("u1", "question", 1), assistant("a1", "answer", 2)] },
  })
  s.client.session.prompt = async (input) => {
    s.calls.prompt.push(input)
    return { data: { info: { error: "boom" } } }
  }
  const out = await run(boot(s), "fail-1")
  assert.equal(out.output, "Stopped after 1 summarizer calls: boom. Previous timeline kept.")
  assert.deepEqual(readEntries("fail-1").map((e) => e.text), ["previous"])
})

test("falls back to the given session when the parent lookup throws", async () => {
  const s = stub({
    sessions: { "throw-1": { id: "throw-1", title: "Throw" } },
    sessionMessages: { "throw-1": [user("u1", "question", 1), assistant("a1", "answer", 2)] },
  })
  const realGet = s.client.session.get
  let n = 0
  s.client.session.get = async (args) => {
    n++
    if (n === 1) throw new Error("lookup down")
    return realGet(args)
  }
  const out = await run(boot(s), "throw-1")
  assert.match(out.output, /^Rebuilt 2 messages into 2 entries/)
  assert.deepEqual(s.calls.messages, ["throw-1"])
})
