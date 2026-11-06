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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { timelineHooks } from "../src/plugins/timeline.ts"
import {
  TIMELINE_STATE_VERSION,
  readEntries,
  readTimelineState,
  removeTimelineState,
  timelineStateFile,
  writeTimelineState,
} from "../src/lib/timeline.ts"

const ROOT = mkdtempSync(join(tmpdir(), "lacode-timeline-plugin-"))
process.env.LACODE_TIMELINE_DIR = join(ROOT, "timeline")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const LOG_LEVELS = ["debug", "info", "warn", "error"]

/**
 * Drive timelineHooks with a stub client. `session` is the root session the
 * event hook should see, `messages` its transcript, and `prompt` the
 * summarizer's answer.
 */
const boot = async ({ session, messages = [], prompt, timeline, childSessions = {}, childMessages = {}, throwSessionGetFor = [], directory = "/tmp/timeline-plugin" } = {}) => {
  const logs = []
  const created = []
  const getCalls = []
  const messagesCalls = []
  const promptTexts = []
  const systemTexts = []
  const throwSet = new Set(throwSessionGetFor)
  const client = {
    app: {
      log: async ({ body }) => {
        logs.push(body)
      },
    },
    session: {
      get: async ({ path }) => {
        getCalls.push(path.id)
        if (throwSet.has(path.id)) throw new Error(`fake session.get failure for ${path.id}`)
        if (path.id === session.id) return { data: session }
        if (Object.prototype.hasOwnProperty.call(childSessions, path.id)) return { data: childSessions[path.id] }
        return { data: undefined }
      },
      messages: async ({ path }) => {
        messagesCalls.push(path.id)
        if (path.id === session.id) return { data: messages }
        if (Object.prototype.hasOwnProperty.call(childMessages, path.id)) return { data: childMessages[path.id] }
        return { data: [] }
      },
      create: async ({ body }) => {
        created.push(body)
        return { data: { id: `summarizer-${created.length}` } }
      },
      prompt: async ({ body }) => {
        promptTexts.push(body?.parts?.[0]?.text ?? "")
        systemTexts.push(body?.system ?? "")
        if (prompt) return prompt({ body })
        return {
          data: { info: {}, parts: [{ type: "text", text: "- Built the thing\n- Ran the tests" }] },
        }
      },
      delete: async () => ({ data: true }),
      abort: async () => ({ data: true }),
    },
  }
  const hooks = timelineHooks(
    {
      client,
      directory,
      serverUrl: new URL("http://127.0.0.1:59999"),
      worktree: ROOT,
    },
    {
      dir: join(ROOT, `claims-${created.length}-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      models: { slots: [{ model: "fake/model", weight: 1 }] },
      ...(timeline ? { timeline } : {}),
    },
  )
  return { hooks, logs, getCalls, messagesCalls, promptTexts, systemTexts }
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

test("a NO_PROJECT_CHANGES summarization that produces no bullets still persists the advanced cursor", async () => {
  const session = { id: "root-state-no-bullets", title: "No bullets state" }
  const messages = transcript(session.id)
  const { hooks } = await boot({
    session,
    messages,
    prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "NO_PROJECT_CHANGES" }] } }),
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

test("NO_PROJECT_CHANGES produces no entries and advances pending and cursor", async () => {
  const session = { id: "root-no-project-changes", title: "No project changes" }
  const messages = transcript(session.id)
  const { hooks, logs } = await boot({
    session,
    messages,
    prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "  NO_PROJECT_CHANGES\n" }] } }),
  })

  await hooks.event({
    event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
  })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

  const settled = await waitFor(
    () => readTimelineState(session.id)?.cursor?.messageID === messages[messages.length - 1].info.id && readTimelineState(session.id)?.pending === false,
  )
  assert.ok(settled, "expected NO_PROJECT_CHANGES to advance the cursor and clear pending")
  assert.deepEqual(readEntries(session.id), [])
  const state = readTimelineState(session.id)
  assert.equal(state?.pending, false)
  assert.equal(state?.failures, 0)
  assert.ok(!logs.some((line) => line.message === "timeline: summarize failed"), `expected no summarize failure, got ${JSON.stringify(logs)}`)
  await hooks.dispose()
})

test("an empty summarizer response is a failure that keeps pending work", async () => {
  const session = { id: "root-empty-response", title: "Empty response" }
  const messages = transcript(session.id)
  const { hooks } = await boot({
    session,
    messages,
    prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "" }] } }),
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const failed = await waitFor(
      () => readTimelineState(session.id)?.pending === true && (readTimelineState(session.id)?.failures ?? 0) >= 1,
    )
    assert.ok(failed, "expected an empty summarizer response to be recorded as a failure with pending work")
    assert.deepEqual(readEntries(session.id), [])
    const state = readTimelineState(session.id)
    assert.equal(state?.pending, true)
    assert.ok((state?.failures ?? 0) >= 1, `expected failures to be incremented, got ${JSON.stringify(state)}`)
    assert.equal(typeof state?.nextAttemptAt, "number")
    assert.notEqual(state?.cursor?.messageID, messages[messages.length - 1].info.id, "expected the cursor not to advance on an empty response")
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("the summarizer prompt names NO_PROJECT_CHANGES and excludes side maintenance", async () => {
  const session = { id: "root-prompt-sentinel", title: "Prompt sentinel" }
  const { hooks, systemTexts } = await boot({ session, messages: transcript(session.id) })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => systemTexts.length > 0)
    assert.ok(prompted, "expected a summarizer prompt to be sent")
    const system = systemTexts.join("\n")
    assert.ok(system.includes("NO_PROJECT_CHANGES"), `expected prompt to contain NO_PROJECT_CHANGES, got ${system.slice(0, 400)}`)
    assert.ok(/cartographer/i.test(system), `expected prompt to mention cartographer as excluded, got ${system.slice(0, 400)}`)
    assert.ok(/timeline/i.test(system), `expected prompt to mention timeline as excluded, got ${system.slice(0, 400)}`)
    assert.ok(/pool/i.test(system), `expected prompt to mention pool as excluded, got ${system.slice(0, 400)}`)
    assert.ok(/context map/i.test(system), `expected prompt to mention the context map as excluded, got ${system.slice(0, 400)}`)
    assert.ok(/1-8/.test(system), `expected prompt to keep the 1-8 entry range, got ${system.slice(0, 400)}`)
    assert.ok(/6-16 words/i.test(system), `expected prompt to keep the 6-16 word rule, got ${system.slice(0, 400)}`)
    assert.ok(/past tense/i.test(system), `expected prompt to keep the past tense rule, got ${system.slice(0, 400)}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
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

test("a root task part expands to the child session title and outcome", async () => {
  const session = { id: "root-child-expand", title: "Child expand" }
  const childTitle = "Explore child investigation"
  const childOutcome = "Traced the summarizer path and identified the fix"
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please investigate" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Investigate the summarizer path", subagent_type: "explore" },
            output: '<task id="ses_child" state="completed">\nchild task output',
            metadata: { sessionId: "ses_child" },
          },
        },
      ],
    },
  ]
  const { hooks, getCalls, messagesCalls, promptTexts } = await boot({
    session,
    messages,
    childSessions: { ses_child: { id: "ses_child", title: childTitle } },
    childMessages: {
      ses_child: [
        { info: { id: "c1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: childOutcome }] },
      ],
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(getCalls.includes("ses_child"), `expected session.get for the child, got ${JSON.stringify(getCalls)}`)
    assert.ok(messagesCalls.includes("ses_child"), `expected session.messages for the child, got ${JSON.stringify(messagesCalls)}`)
    assert.ok(promptText.includes(childTitle), `expected child title in prompt, got ${promptText}`)
    assert.ok(promptText.includes(childOutcome), `expected child outcome in prompt, got ${promptText}`)
    assert.ok(!promptText.includes("<task id="), `expected no raw task markup in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("a context task part is not expanded and never reaches the prompt", async () => {
  const session = { id: "root-child-context", title: "Child context" }
  const cartographerTitle = "Cartographer marker title"
  const cartographerOutcome = "Cartographer marker outcome"
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please update the map" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Update the context map", subagent_type: "context" },
            output: '<task id="ses_child" state="completed">\ncartographer output',
            metadata: { sessionId: "ses_child" },
          },
        },
      ],
    },
  ]
  const { hooks, getCalls, messagesCalls, promptTexts } = await boot({
    session,
    messages,
    childSessions: { ses_child: { id: "ses_child", title: cartographerTitle } },
    childMessages: {
      ses_child: [
        { info: { id: "c1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: cartographerOutcome }] },
      ],
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    assert.ok(!getCalls.includes("ses_child"), `expected no session.get for a context child, got ${JSON.stringify(getCalls)}`)
    assert.ok(!messagesCalls.includes("ses_child"), `expected no session.messages for a context child, got ${JSON.stringify(messagesCalls)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(!promptText.includes(cartographerTitle), `expected no cartographer title in prompt, got ${promptText}`)
    assert.ok(!promptText.includes(cartographerOutcome), `expected no cartographer outcome in prompt, got ${promptText}`)
    assert.ok(!promptText.toLowerCase().includes("cartographer"), `expected no cartographer markers in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("side tool parts never appear in the summarizer prompt", async () => {
  const session = { id: "root-side-tools", title: "Side tools" }
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please do the work" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        { type: "tool", tool: "timeline_reprocess", state: { status: "completed", input: {}, output: "side-marker-reprocess-output" } },
        { type: "tool", tool: "pool_status", state: { status: "completed", input: {}, output: "side-marker-pool-status-output" } },
        { type: "tool", tool: "pool_recheck", state: { status: "completed", input: {}, output: "side-marker-pool-recheck-output" } },
        { type: "text", text: "finished the work" },
      ],
    },
  ]
  const { hooks, promptTexts } = await boot({ session, messages })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(!promptText.includes("timeline_reprocess"), `expected no timeline_reprocess in prompt, got ${promptText}`)
    assert.ok(!promptText.includes("pool_status"), `expected no pool_status in prompt, got ${promptText}`)
    assert.ok(!promptText.includes("pool_recheck"), `expected no pool_recheck in prompt, got ${promptText}`)
    assert.ok(!promptText.includes("side-marker-reprocess-output"), `expected no reprocess output in prompt, got ${promptText}`)
    assert.ok(!promptText.includes("side-marker-pool-status-output"), `expected no pool_status output in prompt, got ${promptText}`)
    assert.ok(!promptText.includes("side-marker-pool-recheck-output"), `expected no pool_recheck output in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("assistant text naming side tools never appears in the summarizer prompt", async () => {
  const session = { id: "root-side-text", title: "Side text" }
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please do the work" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        { type: "text", text: "side-marker: ran pool_recheck and pool_status for maintenance" },
        { type: "text", text: "finished the real work" },
      ],
    },
  ]
  const { hooks, promptTexts } = await boot({ session, messages })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(!promptText.includes("pool_recheck"), `expected no pool_recheck in prompt, got ${promptText}`)
    assert.ok(!promptText.includes("pool_status"), `expected no pool_status in prompt, got ${promptText}`)
    assert.ok(!promptText.includes("side-marker"), `expected no side text in prompt, got ${promptText}`)
    assert.ok(promptText.includes("finished the real work"), `expected normal assistant text in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("assistant text naming side tools is kept when the root owns the tooling", async () => {
  const ownsDir = mkdtempSync(join(tmpdir(), "lacode-timeline-owns-"))
  mkdirSync(join(ownsDir, "src/plugins"), { recursive: true })
  writeFileSync(join(ownsDir, "src/plugins/timeline.ts"), "")
  const session = { id: "root-side-text-owns", title: "Side text owns" }
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please do the work" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        { type: "text", text: "side-marker: ran pool_recheck and pool_status for maintenance" },
        { type: "text", text: "finished the real work" },
      ],
    },
  ]
  const { hooks, promptTexts } = await boot({ session, messages, directory: ownsDir })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(promptText.includes("pool_recheck"), `expected pool_recheck in prompt, got ${promptText}`)
    assert.ok(promptText.includes("pool_status"), `expected pool_status in prompt, got ${promptText}`)
    assert.ok(promptText.includes("side-marker"), `expected side text in prompt, got ${promptText}`)
    assert.ok(promptText.includes("finished the real work"), `expected normal assistant text in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
    rmSync(ownsDir, { recursive: true, force: true })
  }
})

test("a child fetch failure does not abort the tick", async () => {
  const session = { id: "root-child-throw", title: "Child throw" }
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please investigate" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Investigate the summarizer path", subagent_type: "explore" },
            output: '<task id="ses_child" state="completed">\nchild task output',
            metadata: { sessionId: "ses_child" },
          },
        },
      ],
    },
  ]
  const { hooks, promptTexts } = await boot({
    session,
    messages,
    childSessions: { ses_child: { id: "ses_child", title: "Explore child investigation" } },
    childMessages: {
      ses_child: [
        { info: { id: "c1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "Traced the summarizer path" }] },
      ],
    },
    throwSessionGetFor: ["ses_child"],
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a prompt despite the child fetch failure, got ${JSON.stringify(promptTexts)}`)
    const built = await waitFor(() => readEntries(session.id).length > 0)
    assert.ok(built, `expected timeline entries despite the child fetch failure, got ${JSON.stringify(readEntries(session.id))}`)
  } finally {
    await hooks.dispose()
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

test("task expansion starts after the seeded cursor and does not refetch older children", async () => {
  const session = { id: "root-cursor-expand", title: "Cursor expand" }
  const firstTitle = "Early child marker title"
  const firstOutcome = "Early child marker outcome"
  const secondTitle = "Late child marker title"
  const secondOutcome = "Late child marker outcome"
  const messages = [
    {
      info: { id: "m1", role: "assistant", time: { created: 1 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Early investigation", subagent_type: "explore" },
            output: '<task id="ses_first" state="completed">\nearly child task output',
            metadata: { sessionId: "ses_first" },
          },
        },
      ],
    },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Late investigation", subagent_type: "explore" },
            output: '<task id="ses_second" state="completed">\nlate child task output',
            metadata: { sessionId: "ses_second" },
          },
        },
      ],
    },
  ]
  writeTimelineState(session.id, {
    version: TIMELINE_STATE_VERSION,
    cursor: { messageID: messages[0].info.id, time: messages[0].info.time.created },
    failures: 0,
    pending: false,
    updatedAt: Date.now(),
  })
  const { hooks, getCalls, messagesCalls, promptTexts } = await boot({
    session,
    messages,
    childSessions: {
      ses_first: { id: "ses_first", title: firstTitle },
      ses_second: { id: "ses_second", title: secondTitle },
    },
    childMessages: {
      ses_first: [
        { info: { id: "c1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: firstOutcome }] },
      ],
      ses_second: [
        { info: { id: "c2", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: secondOutcome }] },
      ],
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(!getCalls.includes("ses_first"), `expected no session.get for the first child, got ${JSON.stringify(getCalls)}`)
    assert.ok(!messagesCalls.includes("ses_first"), `expected no session.messages for the first child, got ${JSON.stringify(messagesCalls)}`)
    assert.ok(getCalls.includes("ses_second"), `expected session.get for the second child, got ${JSON.stringify(getCalls)}`)
    assert.ok(messagesCalls.includes("ses_second"), `expected session.messages for the second child, got ${JSON.stringify(messagesCalls)}`)
    assert.deepEqual(
      getCalls.filter((id) => id === "ses_first" || id === "ses_second"),
      ["ses_second"],
    )
    assert.deepEqual(
      messagesCalls.filter((id) => id === "ses_first" || id === "ses_second"),
      ["ses_second"],
    )
    assert.ok(!promptText.includes(firstTitle), `expected no first child title in prompt, got ${promptText}`)
    assert.ok(!promptText.includes(firstOutcome), `expected no first child outcome in prompt, got ${promptText}`)
    assert.ok(promptText.includes(secondTitle), `expected second child title in prompt, got ${promptText}`)
    assert.ok(promptText.includes(secondOutcome), `expected second child outcome in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("a side-maintenance task part is not expanded and never reaches the prompt", async () => {
  const session = { id: "root-side-maintenance-task", title: "Side maintenance task" }
  const sideTitle = "Side maintenance child title marker"
  const sideOutcome = "Side maintenance child outcome marker"
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please do the work" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Side maintenance work",
              subagent_type: "explore",
              prompt: "Repo: /home/lawaty/Projects/lacode\nUpdate the tooling there",
            },
            output: '<task id="ses_side" state="completed">\nside task output',
            metadata: { sessionId: "ses_side" },
          },
        },
      ],
    },
  ]
  const { hooks, getCalls, messagesCalls, promptTexts } = await boot({
    session,
    messages,
    childSessions: { ses_side: { id: "ses_side", title: sideTitle } },
    childMessages: {
      ses_side: [
        { info: { id: "c1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: sideOutcome }] },
      ],
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    assert.ok(!getCalls.includes("ses_side"), `expected no session.get for a side-maintenance child, got ${JSON.stringify(getCalls)}`)
    assert.ok(!messagesCalls.includes("ses_side"), `expected no session.messages for a side-maintenance child, got ${JSON.stringify(messagesCalls)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(!promptText.includes(sideTitle), `expected no side-maintenance title in prompt, got ${promptText}`)
    assert.ok(!promptText.includes(sideOutcome), `expected no side-maintenance outcome in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("a normal project task with relative paths still expands", async () => {
  const session = { id: "root-normal-relative-task", title: "Normal relative task" }
  const localTitle = "Local project investigation marker"
  const localOutcome = "Local project investigation outcome marker"
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please investigate the routing" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Investigate local routing",
              subagent_type: "explore",
              prompt: "Read .opencode/context/architecture.md and src/lib/pool.ts and investigate the routing",
            },
            output: '<task id="ses_local" state="completed">\nlocal task output',
            metadata: { sessionId: "ses_local" },
          },
        },
      ],
    },
  ]
  const { hooks, getCalls, messagesCalls, promptTexts } = await boot({
    session,
    messages,
    childSessions: { ses_local: { id: "ses_local", title: localTitle } },
    childMessages: {
      ses_local: [
        { info: { id: "c1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: localOutcome }] },
      ],
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    assert.ok(getCalls.includes("ses_local"), `expected session.get for a normal project child, got ${JSON.stringify(getCalls)}`)
    assert.ok(messagesCalls.includes("ses_local"), `expected session.messages for a normal project child, got ${JSON.stringify(messagesCalls)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(promptText.includes(localTitle), `expected local child title in prompt, got ${promptText}`)
    assert.ok(promptText.includes(localOutcome), `expected local child outcome in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("a context task part remains skipped as a side tool", async () => {
  const session = { id: "root-context-side-task", title: "Context side task" }
  const contextTitle = "Context side child title marker"
  const contextOutcome = "Context side child outcome marker"
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please update the map" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Update the context map",
              subagent_type: "context",
              prompt: "Update the context map",
            },
            output: '<task id="ses_context_side" state="completed">\ncontext task output',
            metadata: { sessionId: "ses_context_side" },
          },
        },
      ],
    },
  ]
  const { hooks, getCalls, messagesCalls, promptTexts } = await boot({
    session,
    messages,
    childSessions: { ses_context_side: { id: "ses_context_side", title: contextTitle } },
    childMessages: {
      ses_context_side: [
        { info: { id: "c1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: contextOutcome }] },
      ],
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    assert.ok(!getCalls.includes("ses_context_side"), `expected no session.get for a context child, got ${JSON.stringify(getCalls)}`)
    assert.ok(!messagesCalls.includes("ses_context_side"), `expected no session.messages for a context child, got ${JSON.stringify(messagesCalls)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(!promptText.includes(contextTitle), `expected no context title in prompt, got ${promptText}`)
    assert.ok(!promptText.includes(contextOutcome), `expected no context outcome in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
  }
})

test("a side-maintenance task is not filtered when the root owns the tooling", async () => {
  const ownsDir = mkdtempSync(join(tmpdir(), "lacode-timeline-owns-"))
  mkdirSync(join(ownsDir, "src/plugins"), { recursive: true })
  writeFileSync(join(ownsDir, "src/plugins/timeline.ts"), "")
  const session = { id: "root-owns-tooling-task", title: "Owns tooling task" }
  const ownedTitle = "Owned tooling child title marker"
  const ownedOutcome = "Owned tooling child outcome marker"
  const messages = [
    { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "please do the tooling work" }] },
    {
      info: { id: "m2", role: "assistant", time: { created: 2 } },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Tooling work",
              subagent_type: "explore",
              prompt: "Repo: /home/lawaty/Projects/lacode\nUpdate the tooling there",
            },
            output: '<task id="ses_owns" state="completed">\nowned task output',
            metadata: { sessionId: "ses_owns" },
          },
        },
      ],
    },
  ]
  const { hooks, getCalls, messagesCalls, promptTexts } = await boot({
    session,
    messages,
    directory: ownsDir,
    childSessions: { ses_owns: { id: "ses_owns", title: ownedTitle } },
    childMessages: {
      ses_owns: [
        { info: { id: "c1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: ownedOutcome }] },
      ],
    },
  })

  try {
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: session.id, role: "assistant" } } },
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })

    const prompted = await waitFor(() => promptTexts.length > 0)
    assert.ok(prompted, `expected a summarizer prompt, got ${JSON.stringify(promptTexts)}`)
    assert.ok(getCalls.includes("ses_owns"), `expected session.get for an owned-tooling child, got ${JSON.stringify(getCalls)}`)
    assert.ok(messagesCalls.includes("ses_owns"), `expected session.messages for an owned-tooling child, got ${JSON.stringify(messagesCalls)}`)
    const promptText = promptTexts.join("\n")
    assert.ok(promptText.includes(ownedTitle), `expected owned child title in prompt, got ${promptText}`)
    assert.ok(promptText.includes(ownedOutcome), `expected owned child outcome in prompt, got ${promptText}`)
  } finally {
    await hooks.dispose()
    cleanupSession(session.id)
    rmSync(ownsDir, { recursive: true, force: true })
  }
})
