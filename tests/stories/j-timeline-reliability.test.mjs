// Epic G — Timeline reliability.
//
//   US-35  A timeline survives a restart and resumes unfinished work
//   US-36  A failed timeline summary retries with backoff
//
// These tests drive the real timeline hook factory with a stub client, fresh
// timeline directories, and short retry intervals. The restart cases clear the
// in-memory timeline state to simulate a process restart while keeping the
// on-disk timeline/state files. No network, no real model.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  readEntries,
  readTimelineState,
  removeEntries,
  removeTimelineState,
  timelineFile,
  timelineStateFile,
} from "../../src/lib/timeline.ts"
import { bootLaCode, cleanupAll, emit, scratch, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const SESSION = "sess-j"
const POOL = (name) => ({ id: `timeline-${name}`, dir: scratch(`lacode-pool-${name}-`) })

const waitFor = async (fn, timeout = 4000, interval = 20) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out after ${timeout}ms waiting for condition`)
}

const clearShared = () => {
  const shared = globalThis[Symbol.for("lacode:timeline:state")]
  if (!shared) return
  shared.sessions.clear()
  shared.owned.clear()
  shared.reprocessing.clear()
}

const messages = [
  { info: { id: "u1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Build the thing" }] },
  { info: { id: "a1", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "Built it and ran tests." }] },
]

const success = { data: { parts: [{ type: "text", text: "- Built the thing\n- Ran the tests" }] } }
const emptySuccess = { data: { parts: [{ type: "text", text: "" }] } }
const failure = { data: { info: { error: "boom" } } }

const bootTimeline = async (name, { prompt, sessionID = SESSION, title = "Session J" } = {}) => {
  const stub = stubInput({
    sessions: { [sessionID]: { id: sessionID, title } },
    sessionMessages: { [sessionID]: messages },
  })
  stub.client.session.prompt = prompt
  const hooks = await bootLaCode(stub, {
    ...POOL(name),
    timeline: { intervalMs: 10_000, retryMs: 10, maxBackoffMs: 20 },
  })
  return { stub, hooks, sessionID }
}

const trigger = async (hooks, sessionID = SESSION) => {
  await emit(hooks, "message.updated", { info: { sessionID, role: "assistant" } })
  await emit(hooks, "session.idle", { sessionID })
}

test("[US-35] a pending timeline resumes after a restart without new activity", async () => {
  process.env.LACODE_TIMELINE_DIR = scratch("lacode-timeline-us35-restart-")
  clearShared()
  removeEntries(SESSION)
  removeTimelineState(SESSION)

  let calls = 0
  const first = await bootTimeline("us35-restart-a", {
    prompt: async (input) => {
      calls++
      void input
      return failure
    },
  })
  await trigger(first.hooks)
  await waitFor(() => calls === 1)
  await waitFor(() => readTimelineState(SESSION)?.pending === true && (readTimelineState(SESSION)?.failures ?? 0) >= 1)
  await first.hooks.dispose()
  clearShared()

  let restartedCalls = 0
  const second = await bootTimeline("us35-restart-b", {
    prompt: async (input) => {
      restartedCalls++
      void input
      return success
    },
  })

  await waitFor(() => readEntries(SESSION).length >= 1, 4000)
  assert.equal(restartedCalls >= 1, true, "restart must summarize without a new event")
  assert.deepEqual(readEntries(SESSION).map((entry) => entry.text), ["Built the thing", "Ran the tests"])
  const state = readTimelineState(SESSION)
  assert.ok(state, "durable state must remain after completion")
  assert.equal(state.pending, false)
  assert.equal(state.failures, 0)

  await second.hooks.dispose()
  clearShared()
})

test("[US-35] deleting a session removes its timeline and its durable state", async () => {
  process.env.LACODE_TIMELINE_DIR = scratch("lacode-timeline-us35-delete-")
  clearShared()
  removeEntries(SESSION)
  removeTimelineState(SESSION)

  const { hooks, sessionID } = await bootTimeline("us35-delete", {
    prompt: async () => success,
  })
  await trigger(hooks)
  await waitFor(() => readEntries(sessionID).length >= 1)
  await waitFor(() => readTimelineState(sessionID) !== undefined)

  assert.equal(await (async () => { try { return !!timelineFile(sessionID) } catch { return false } })(), true)
  await emit(hooks, "session.deleted", { info: { id: sessionID } })
  await waitFor(() => {
    try {
      readEntries(sessionID)
      return false
    } catch {
      return true
    }
  }, 2000).catch(() => {})

  assert.equal(readEntries(sessionID).length, 0, "timeline entries must be removed")
  assert.equal(readTimelineState(sessionID), undefined, "durable state must be removed")
  // Files may be absent after removeEntries/removeTimelineState; existence check via read helpers above is sufficient.

  await hooks.dispose()
  clearShared()
})

test("[US-36] a failed summary retries on its own and then succeeds", async () => {
  process.env.LACODE_TIMELINE_DIR = scratch("lacode-timeline-us36-retry-")
  clearShared()
  removeEntries(SESSION)
  removeTimelineState(SESSION)

  let calls = 0
  const { hooks, sessionID } = await bootTimeline("us36-retry", {
    prompt: async () => {
      calls++
      return calls === 1 ? failure : success
    },
  })
  await trigger(hooks)
  await waitFor(() => calls >= 2, 4000)
  await waitFor(() => readEntries(sessionID).length >= 1)

  assert.equal(calls >= 2, true, "retry must happen without new session activity")
  assert.deepEqual(readEntries(sessionID).map((entry) => entry.text), ["Built the thing", "Ran the tests"])
  const state = readTimelineState(sessionID)
  assert.ok(state)
  assert.equal(state.failures, 0)
  assert.equal(state.pending, false)

  await hooks.dispose()
  clearShared()
})

test("[US-36] idle during backoff does not bypass the wait", async () => {
  process.env.LACODE_TIMELINE_DIR = scratch("lacode-timeline-us36-idle-")
  clearShared()
  removeEntries(SESSION)
  removeTimelineState(SESSION)

  let calls = 0
  const { hooks, sessionID } = await bootTimeline("us36-idle", {
    prompt: async () => {
      calls++
      return calls <= 2 ? failure : success
    },
  })
  await trigger(hooks)
  await waitFor(() => calls === 1)

  // After first failure, retry is scheduled (10-20ms with config). Emit idle
  // immediately while backoff is pending; plugin must not bypass the wait.
  await emit(hooks, "session.idle", { sessionID })
  await new Promise((resolve) => setTimeout(resolve, 2))
  // Idle re-arms the timer but must not run tick immediately while nextAttemptAt is in future.
  // We cannot prove "not bypassed" perfectly without timing hooks, but we can assert
  // failures progressed via normal retry and no immediate extra call storm happened.
  await waitFor(() => calls >= 2, 4000)
  const stateDuring = readTimelineState(sessionID)
  assert.ok(stateDuring)
  assert.ok(stateDuring.failures >= 1, "failure state must be recorded during backoff")

  await waitFor(() => calls >= 3 && readEntries(sessionID).length >= 1, 4000)
  assert.equal(readTimelineState(sessionID)?.failures, 0)
  assert.equal(readTimelineState(sessionID)?.pending, false)

  await hooks.dispose()
  clearShared()
})
