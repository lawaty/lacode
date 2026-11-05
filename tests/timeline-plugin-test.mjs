// The timeline hook factory is not exported through src/index.ts (that file is
// the only Plugin), so this suite imports it directly and drives its event hook
// with a stub client, the way tests/stories/_harness.mjs drives the whole
// plugin. Two behaviours are pinned here:
//
//   1. a session that goes idle gets its timeline built at that moment, not
//      only after the five-minute debounce -- a one-shot run can exit before
//      the timer ever fires, and that is a session with no timeline;
//   2. a failed summarization is logged with a level opencode accepts. The old
//      call passed the message as the level, so the runtime rejected the
//      payload and the failure was invisible.
//
// Neither test waits for real time: the idle flush is immediate, and a build
// that did not happen is reported as a timeout after a few seconds.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { timelineHooks } from "../src/plugins/timeline.ts"
import { readEntries } from "../src/lib/timeline.ts"

const ROOT = mkdtempSync(join(tmpdir(), "lacode-timeline-plugin-"))
process.env.LACODE_TIMELINE_DIR = join(ROOT, "timeline")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const LOG_LEVELS = ["debug", "info", "warn", "error"]

/**
 * Drive timelineHooks with a stub client. `session` is the root session the
 * event hook should see, `messages` its transcript, and `prompt` the
 * summarizer's answer.
 */
const boot = async ({ session, messages = [], prompt } = {}) => {
  const logs = []
  const created = []
  const client = {
    app: {
      log: async ({ body }) => {
        logs.push(body)
      },
    },
    session: {
      get: async ({ path }) => ({ data: path.id === session.id ? session : undefined }),
      messages: async ({ path }) => ({ data: path.id === session.id ? messages : [] }),
      create: async ({ body }) => {
        created.push(body)
        return { data: { id: `summarizer-${created.length}` } }
      },
      prompt:
        prompt ??
        (async () => ({
          data: { info: {}, parts: [{ type: "text", text: "- Built the thing\n- Ran the tests" }] },
        })),
      delete: async () => ({ data: true }),
      abort: async () => ({ data: true }),
    },
  }
  const hooks = timelineHooks(
    {
      client,
      directory: "/tmp/timeline-plugin",
      serverUrl: new URL("http://127.0.0.1:59999"),
      worktree: ROOT,
    },
    {
      dir: join(ROOT, `claims-${created.length}-${process.pid}`),
      models: { slots: [{ model: "fake/model", weight: 1 }] },
    },
  )
  return { hooks, logs }
}

const transcript = (sessionID) => [
  { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please build it" }] },
  { info: { id: "m2", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "built it" }] },
]

const waitFor = async (check, ms = 4000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

test("a session that goes idle has its timeline built immediately", async () => {
  const session = { id: "root-idle", title: "Idle session" }
  const { hooks } = await boot({ session, messages: transcript(session.id) })

  await hooks.event({
    event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
  })
  // The interval is five minutes; nothing has been built yet.
  assert.deepEqual(readEntries(session.id), [])

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

  const built = await waitFor(() => readEntries(session.id).length > 0)
  const entries = readEntries(session.id)
  assert.ok(built, "session.idle must flush the pending timeline without waiting for the timer")
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["Built the thing", "Ran the tests"],
  )
  await hooks.dispose()
})

test("a failed summarization is logged with a level opencode accepts", async () => {
  const session = { id: "root-failing", title: "Failing session" }
  const { hooks, logs } = await boot({
    session,
    messages: transcript(session.id),
    prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "Here are the entries:" }] } }),
  })
  process.env.LACODE_TIMELINE_DEBUG = "1"
  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const logged = await waitFor(() => logs.some((line) => line.message === "timeline: summarize failed"))
    assert.ok(logged, `expected a summarize failure line, got ${JSON.stringify(logs)}`)
    assert.ok(
      logs.every((line) => LOG_LEVELS.includes(line.level)),
      `every log line must carry a real level, got ${JSON.stringify(logs.map((line) => line.level))}`,
    )
    const failure = logs.find((line) => line.message === "timeline: summarize failed")
    assert.equal(failure.level, "warn")
    assert.equal(failure.extra?.sessionID, session.id)
    const noBullets = logs.find((line) => line.message === "timeline: no bullet lines")
    assert.equal(noBullets?.level, "debug")
  } finally {
    delete process.env.LACODE_TIMELINE_DEBUG
    await hooks.dispose()
  }
})

test("a non-bulleted reply is salvaged and logged", async () => {
  const session = { id: "root-salvaged", title: "Salvaged session" }
  const { hooks, logs } = await boot({
    session,
    messages: transcript(session.id),
    prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "Pool: added routing" }] } }),
  })

  await hooks.event({
    event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
  })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

  const salvaged = await waitFor(() => logs.some((line) => line.message === "timeline: salvaged non-bulleted output"))
  assert.ok(salvaged, `expected a salvage log line, got ${JSON.stringify(logs)}`)
  const entries = readEntries(session.id)
  assert.ok(entries.some((entry) => entry.text === "Pool: added routing"), `expected salvaged entry, got ${JSON.stringify(entries)}`)
  await hooks.dispose()
})

test("a reasoning-only reply becomes timeline entries", async () => {
  const session = { id: "root-reasoning", title: "Reasoning session" }
  const { hooks, logs } = await boot({
    session,
    messages: transcript(session.id),
    prompt: async () => ({ data: { info: {}, parts: [{ type: "reasoning", text: "- Reasoned entry" }] } }),
  })

  await hooks.event({
    event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
  })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

  const built = await waitFor(() => readEntries(session.id).length > 0)
  assert.ok(built, "reasoning-only output should produce timeline entries")
  const entries = readEntries(session.id)
  assert.ok(entries.some((entry) => entry.text === "Reasoned entry"), `expected reasoning entry, got ${JSON.stringify(entries)}`)
  assert.ok(
    !logs.some((line) => line.message === "timeline: summarize failed"),
    `expected no summarize failure, got ${JSON.stringify(logs)}`,
  )
  await hooks.dispose()
})
