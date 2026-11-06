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
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { timelineHooks } from "../src/plugins/timeline.ts"
import { readEntries, readTimelineState, removeTimelineState, timelineStateFile } from "../src/lib/timeline.ts"

const ROOT = mkdtempSync(join(tmpdir(), "lacode-timeline-plugin-"))
process.env.LACODE_TIMELINE_DIR = join(ROOT, "timeline")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const LOG_LEVELS = ["debug", "info", "warn", "error"]

/**
 * Drive timelineHooks with a stub client. `session` is the root session the
 * event hook should see, `messages` its transcript, and `prompt` the
 * summarizer's answer.
 */
const boot = async ({ session, messages = [], prompt, timeline } = {}) => {
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
      dir: join(ROOT, `claims-${created.length}-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      models: { slots: [{ model: "fake/model", weight: 1 }] },
      ...(timeline ? { timeline } : {}),
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

test("after a successful idle flush, the state file records a settled cursor", async () => {
  const session = { id: "root-state-flush", title: "State flush" }
  const messages = transcript(session.id)
  const { hooks } = await boot({ session, messages })

  await hooks.event({
    event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
  })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

  const built = await waitFor(
    () => readEntries(session.id).length > 0 && readTimelineState(session.id)?.pending === false,
  )
  assert.ok(built, "expected a durable timeline state after a successful flush")
  const state = readTimelineState(session.id)
  assert.equal(state?.pending, false)
  assert.equal(state?.failures, 0)
  assert.equal(state?.cursor?.messageID, messages[messages.length - 1].info.id)
  assert.equal(typeof state?.cursor?.time, "number")
  await hooks.dispose()
})

test("a successful summarization that produces no bullets still persists the advanced cursor", async () => {
  const session = { id: "root-state-no-bullets", title: "No bullets state" }
  const messages = transcript(session.id)
  const { hooks } = await boot({
    session,
    messages,
    prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "" }] } }),
  })

  await hooks.event({
    event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
  })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

  const persisted = await waitFor(() => readTimelineState(session.id)?.cursor?.messageID === messages[messages.length - 1].info.id)
  assert.ok(persisted, "expected the advanced cursor to be persisted even with no bullets")
  assert.deepEqual(readEntries(session.id), [])
  const state = readTimelineState(session.id)
  assert.equal(state?.pending, false)
  assert.equal(state?.failures, 0)
  await hooks.dispose()
})

test("session.deleted removes both the timeline file and the state file", async () => {
  const session = { id: "root-state-deleted", title: "Deleted state" }
  const { hooks } = await boot({ session, messages: transcript(session.id) })

  await hooks.event({
    event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
  })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

  const built = await waitFor(() => existsSync(timelineStateFile(session.id)) && readEntries(session.id).length > 0)
  assert.ok(built, "expected both timeline and state files before deletion")

  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: session.id } } } })

  assert.equal(existsSync(timelineStateFile(session.id)), false)
  assert.deepEqual(readEntries(session.id), [])
  await hooks.dispose()
})

const cleanupSession = (sessionID) => {
  try {
    rmSync(join(process.env.LACODE_TIMELINE_DIR, sessionID + ".jsonl"), { force: true })
  } catch {}
  try {
    removeTimelineState(sessionID)
  } catch {}
}

test("a failed summary retries on its own with backoff", async () => {
  const session = { id: "root-retry-backoff", title: "Retry backoff" }
  let prompts = 0
  const { hooks } = await boot({
    session,
    messages: transcript(session.id),
    timeline: { intervalMs: 10_000, retryMs: 10, maxBackoffMs: 20 },
    prompt: async () => {
      prompts++
      if (prompts === 1) return { data: { info: { error: "boom" } } }
      return { data: { info: {}, parts: [{ type: "text", text: "- Built the thing\n- Ran the tests" }] } }
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const built = await waitFor(() => prompts >= 2 && readEntries(session.id).length > 0)
    assert.ok(built, `expected retry to build timeline, prompts=${prompts}`)
    const state = readTimelineState(session.id)
    assert.equal(state?.pending, false)
    assert.equal(state?.failures, 0)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("a pending timeline resumes after a restart", async () => {
  const session = { id: "root-resume-restart", title: "Resume restart" }
  const first = await boot({
    session,
    messages: transcript(session.id),
    timeline: { intervalMs: 10_000, retryMs: 10, maxBackoffMs: 20 },
    prompt: async () => ({ data: { info: { error: "boom" } } }),
  })

  try {
    await first.hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await first.hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })
    const pending = await waitFor(
      () => readTimelineState(session.id)?.pending === true && typeof readTimelineState(session.id)?.nextAttemptAt === "number",
    )
    assert.ok(pending, "expected pending state after failed first attempt")
  } finally {
    await first.hooks.dispose()
  }

  const shared = globalThis[Symbol.for("lacode:timeline:state")]
  shared.sessions.clear()
  shared.owned.clear()
  shared.reprocessing.clear()

  // Ensure the backoff window has elapsed so resume can flush immediately.
  const state = readTimelineState(session.id)
  if (state?.nextAttemptAt && state.nextAttemptAt > Date.now()) {
    await new Promise((resolve) => setTimeout(resolve, state.nextAttemptAt - Date.now() + 5))
  }

  const second = await boot({
    session,
    messages: transcript(session.id),
    timeline: { intervalMs: 10_000, retryMs: 10, maxBackoffMs: 20 },
    prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "- Resumed build" }] } }),
  })

  try {
    const built = await waitFor(() => readEntries(session.id).some((entry) => entry.text === "Resumed build"), 4000)
    assert.ok(built, "expected resumed timeline without emitting any new event")
    assert.equal(readTimelineState(session.id)?.pending, false)
  } finally {
    await second.hooks.dispose()
    cleanupSession(session.id)
  }
})

test("session.idle during backoff does not bypass the wait", async () => {
  const session = { id: "root-idle-backoff", title: "Idle backoff" }
  let prompts = 0
  const { hooks } = await boot({
    session,
    messages: transcript(session.id),
    timeline: { retryMs: 150, maxBackoffMs: 150 },
    prompt: async () => {
      prompts++
      return { data: { info: { error: "boom" } } }
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })
    const first = await waitFor(() => prompts === 1 && !!readTimelineState(session.id)?.nextAttemptAt)
    assert.ok(first, `expected one prompt and nextAttemptAt, prompts=${prompts}`)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(prompts, 1)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})
