// A pool-cancelled task part is rewritten with the abort reason.
//
// opencode persists a bare "Task cancelled" tool part for a task this plugin
// aborted. The event hook patches that part through the server so the expanded
// card explains why the task died, whether the report was stored before the
// part arrived or after it. Run with: node --test tests/pool-cancelled-part-test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PRESET = join(HERE, "..", "presets", "free-tier.json")
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")

const pool = await import(join(HERE, "..", "src", "lib", "pool.ts"))
const { splitModel } = pool
const SLOTS = JSON.parse(readFileSync(PRESET, "utf8")).slots.map((s, i) => {
  const { provider, id: modelID } = splitModel(s.model)
  return { model: s.model, provider, modelID, index: i + 1 }
})

const { agentPoolHooks: AgentPool } = await import(PLUGIN)

const rateError = (message, extra = {}) => ({ name: "APIError", data: { message, isRetryable: true, ...extra } })

const cancelledPart = () => ({
  id: "part-1",
  sessionID: "parent",
  messageID: "msg-1",
  type: "tool",
  callID: "call-1",
  tool: "task",
  state: { status: "error", error: "Task cancelled", input: {}, time: { start: 1, end: 2 } },
})

// Boot a pool with a fake client and a fetch that answers the plugin's own
// catalog/refresh traffic as an empty model list while recording the PATCH the
// cancelled-part rewrite issues.
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), "cancelled-part-"))
  const calls = []
  const toasts = []
  const logs = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET"
    calls.push({ url: String(url), method, body: typeof init.body === "string" ? init.body : undefined })
    if (method === "PATCH") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      abort: async () => ({ data: true, response: { ok: true, status: 200 }, error: undefined, request: undefined }),
    },
    tui: { showToast: async (toast) => toasts.push(toast) },
  }
  const hooks = await AgentPool(
    { client, serverUrl: new URL("http://127.0.0.1:59999") },
    { id: "cancelled-part", dir, modelsFile: PRESET },
  )
  await hooks.config(shippedConfig())
  const cleanup = async () => {
    globalThis.fetch = realFetch
    try {
      await hooks.dispose()
    } catch {
      /* best-effort teardown */
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return { hooks, calls, toasts, logs, cleanup }
}

const spawn = async (hooks) => {
  const out = { args: { subagent_type: "explore", prompt: "x" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID: "parent", callID: "call-1", args: {} }, out)
  return SLOTS[Number(/-(\d+)$/.exec(out.args.subagent_type)[1]) - 1]
}

const bindChild = (hooks) =>
  hooks.event({ event: { type: "session.created", properties: { info: { id: "child-1", parentID: "parent" } } } })

const triggerFailover = (hooks, slot) =>
  hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          sessionID: "child-1",
          providerID: slot.provider,
          modelID: slot.modelID,
          error: rateError("Rate limit exceeded"),
        },
      },
    },
  })

const emitCancelledPart = (hooks) =>
  hooks.event({ event: { type: "message.part.updated", properties: { part: cancelledPart() } } })

const assertPatched = (calls, toasts) => {
  const patches = calls.filter((call) => call.method === "PATCH")
  assert.equal(patches.length, 1, `expected exactly one PATCH, got ${patches.length}`)
  const patch = patches[0]
  assert.ok(
    new URL(patch.url).pathname.endsWith("/session/parent/message/msg-1/part/part-1"),
    `PATCH must target the cancelled part, got ${patch.url}`,
  )
  const body = JSON.parse(patch.body)
  assert.equal(body.state.status, "error")
  assert.ok(
    body.state.error.startsWith("Task Cancelled by LaCode: "),
    `the rewritten error must name the cause, got ${body.state.error}`,
  )
  assert.match(body.state.error, /rate limited|provider error|no answer|overran/)
  assert.equal(body.callID, "call-1")
  assert.equal(body.tool, "task")
  assert.equal(toasts.length, 0, `the rewrite must not raise a toast, got ${JSON.stringify(toasts)}`)
}

test("rewrites a cancelled task part with the abort reason (report first)", async () => {
  const { hooks, calls, toasts, cleanup } = await setup()
  try {
    const slot = await spawn(hooks)
    await bindChild(hooks)
    await triggerFailover(hooks, slot)
    await emitCancelledPart(hooks)
    assertPatched(calls, toasts)
  } finally {
    await cleanup()
  }
})

test("rewrites a cancelled task part when it arrives before the abort report", async () => {
  const { hooks, calls, toasts, cleanup } = await setup()
  try {
    const slot = await spawn(hooks)
    await bindChild(hooks)
    await emitCancelledPart(hooks)
    await triggerFailover(hooks, slot)
    assertPatched(calls, toasts)
  } finally {
    await cleanup()
  }
})

test("uses SDK part.update when available (primary path) and avoids fetch PATCH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cancelled-part-sdk-"))
  const calls = []
  const toasts = []
  const logs = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET"
    calls.push({ url: String(url), method, body: typeof init.body === "string" ? init.body : undefined })
    if (method === "PATCH") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const updateCalls = []
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      abort: async () => ({ data: true, response: { ok: true, status: 200 }, error: undefined, request: undefined }),
    },
    tui: { showToast: async (toast) => toasts.push(toast) },
    part: {
      update: async (args) => {
        updateCalls.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
  const hooks = await AgentPool(
    { client, serverUrl: new URL("http://127.0.0.1:59999") },
    { id: "cancelled-part", dir, modelsFile: PRESET },
  )
  await hooks.config(shippedConfig())
  try {
    const slot = await spawn(hooks)
    await bindChild(hooks)
    await triggerFailover(hooks, slot)
    await emitCancelledPart(hooks)
    assert.equal(updateCalls.length, 1, `expected client.part.update called once`)
    const args = updateCalls[0]
    assert.equal(args.sessionID, "parent")
    assert.equal(args.messageID, "msg-1")
    assert.equal(args.partID, "part-1")
    assert.ok(args.part)
    assert.equal(args.part.callID, "call-1")
    assert.equal(args.part.tool, "task")
    assert.ok(args.part.state.error.startsWith("Task Cancelled by LaCode: "))
    const patches = calls.filter((call) => call.method === "PATCH")
    assert.equal(patches.length, 0, `no fetch PATCH should be issued, got ${patches.length}`)
    assert.equal(toasts.length, 0)
  } finally {
    globalThis.fetch = realFetch
    try {
      await hooks.dispose()
    } catch {
      /* best-effort teardown */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
