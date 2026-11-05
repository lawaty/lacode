// Offline unit suite for src/lib/provider-compat.ts.
//
// The suite exists for one production fault: an OpenAI-compatible provider
// streamed `choices[].delta.reasoning` as an object, opencode's chunk schema
// expects a string, and every spawn on that model died with `invalid_union` at
// `choices[0].delta.reasoning`. The normalizer must turn the object into the
// string the schema wants, must leave an already-conforming chunk alone, and
// must never drop bytes it cannot understand.
//
// Nothing here opens a socket. `wrapFetch()` is the injected seam the module was
// written around, so the transport tests run against a fake fetch and an
// in-memory Response.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createChunkNormalizer,
  installProviderCompat,
  normalizeChunk,
  normalizeSseLine,
  reasoningText,
  wrapFetch,
} from "../src/lib/provider-compat.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const sse = (obj) => `data: ${JSON.stringify(obj)}\n`

const chunk = (delta) => ({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta }] })

// ---------------------------------------------------------------------------
// reasoningText
// ---------------------------------------------------------------------------

test("a string reasoning is already the expected type", () => {
  assert.equal(reasoningText("thinking"), "thinking")
})

test("summary text wins over an empty content", () => {
  assert.equal(reasoningText({ encrypted_content: null, content: null, summary: { index: 0, text: "**" } }), "**")
})

test("a plain content string is used when there is no summary", () => {
  assert.equal(reasoningText({ content: "reasoned", summary: null }), "reasoned")
})

test("a summary list is concatenated", () => {
  assert.equal(
    reasoningText({ summary: [{ index: 0, text: "a" }, { index: 1, text: "b" }], content: null }),
    "ab",
  )
})

test("an encrypted-only item yields the empty string, never a guess", () => {
  assert.equal(reasoningText({ encrypted_content: "base64", content: null, summary: null }), "")
})

test("a null or scalar reasoning is not text", () => {
  assert.equal(reasoningText(null), "")
  assert.equal(reasoningText(42), "")
})

// ---------------------------------------------------------------------------
// normalizeChunk
// ---------------------------------------------------------------------------

test("the production chunk is rewritten and reports the change", () => {
  const value = chunk({
    role: "assistant",
    content: null,
    reasoning: { encrypted_content: null, content: null, summary: { index: 0, text: "**" } },
    tool_calls: null,
  })
  assert.equal(normalizeChunk(value), true)
  assert.equal(value.choices[0].delta.reasoning, "**")
})

test("a conforming chunk is left byte-identical", () => {
  const value = chunk({ content: "hello", reasoning: "already a string" })
  const before = JSON.stringify(value)
  assert.equal(normalizeChunk(value), false)
  assert.equal(JSON.stringify(value), before)
})

test("null reasoning is not an object and is left alone", () => {
  const value = chunk({ role: "assistant", reasoning: null, content: null })
  assert.equal(normalizeChunk(value), false)
  assert.equal(value.choices[0].delta.reasoning, null)
})

test("reasoning_content and a non-streaming message are covered too", () => {
  const value = chunk({ reasoning_content: { content: "r" } })
  assert.equal(normalizeChunk(value), true)
  assert.equal(value.choices[0].delta.reasoning_content, "r")

  const completion = { choices: [{ index: 0, message: { role: "assistant", reasoning: { text: "m" } } }] }
  assert.equal(normalizeChunk(completion), true)
  assert.equal(completion.choices[0].message.reasoning, "m")
})

test("content and tool calls survive the rewrite untouched", () => {
  const calls = [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }]
  const value = chunk({ content: "text", reasoning: { text: "t" }, tool_calls: calls })
  normalizeChunk(value)
  assert.equal(value.choices[0].delta.content, "text")
  assert.deepEqual(value.choices[0].delta.tool_calls, calls)
})

test("a payload that is not a chat chunk is not touched", () => {
  assert.equal(normalizeChunk({ error: { message: "boom" } }), false)
  assert.equal(normalizeChunk("data"), false)
  assert.equal(normalizeChunk(null), false)
})

// ---------------------------------------------------------------------------
// normalizeSseLine
// ---------------------------------------------------------------------------

test("a data frame keeps its trailing newline", () => {
  const line = sse(chunk({ reasoning: { summary: { text: "**" } } }))
  const out = normalizeSseLine(line)
  assert.ok(out.endsWith("\n"))
  assert.deepEqual(JSON.parse(out.slice("data: ".length)).choices[0].delta.reasoning, "**")
})

test("the [DONE] sentinel and non-data lines are passed through verbatim", () => {
  assert.equal(normalizeSseLine("data: [DONE]\n"), "data: [DONE]\n")
  assert.equal(normalizeSseLine("event: message\n"), "event: message\n")
  assert.equal(normalizeSseLine(": keep-alive\n"), ": keep-alive\n")
  assert.equal(normalizeSseLine("\n"), "\n")
})

test("unparseable data is forwarded instead of dropped", () => {
  const broken = "data: {not json\n"
  assert.equal(normalizeSseLine(broken), broken)
})

test("an unmodified line is returned by identity", () => {
  const line = sse(chunk({ content: "hello" }))
  assert.equal(normalizeSseLine(line), line)
})

// ---------------------------------------------------------------------------
// createChunkNormalizer
// ---------------------------------------------------------------------------

const streamOf = (parts) =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === "string" ? encoder.encode(part) : part)
      controller.close()
    },
  })

const drain = async (stream) => {
  let out = ""
  for await (const part of stream) out += decoder.decode(part, { stream: true })
  return out + decoder.decode()
}

test("a frame split across network chunks is reassembled before parsing", async () => {
  const line = sse(chunk({ reasoning: { summary: { text: "**" } } }))
  const cut = Math.floor(line.length / 2)
  const out = await drain(streamOf([line.slice(0, cut), line.slice(cut)]).pipeThrough(createChunkNormalizer()))
  assert.equal(out, sse(chunk({ reasoning: "**" })))
})

test("multi-byte characters survive the byte-level buffering", async () => {
  const line = sse(chunk({ reasoning: { summary: { text: "héllo ✓" } } }))
  const bytes = encoder.encode(line)
  const parts = []
  for (let i = 0; i < bytes.length; i += 3) parts.push(bytes.slice(i, i + 3))
  const out = await drain(streamOf(parts).pipeThrough(createChunkNormalizer()))
  assert.deepEqual(JSON.parse(out.slice("data: ".length)).choices[0].delta.reasoning, "héllo ✓")
})

test("a trailing frame with no newline is still flushed", async () => {
  const line = sse(chunk({ reasoning: { text: "tail" } })).trimEnd()
  const out = await drain(streamOf([line]).pipeThrough(createChunkNormalizer()))
  assert.equal(JSON.parse(out.slice("data: ".length)).choices[0].delta.reasoning, "tail")
})

// ---------------------------------------------------------------------------
// wrapFetch
// ---------------------------------------------------------------------------

const fakeFetch = (response) => Object.assign(async () => response, {})

test("an SSE response is rewritten and its stale length header removed", async () => {
  const body = streamOf([sse(chunk({ reasoning: { summary: { text: "**" } }, content: "hi" }))])
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream", "content-length": "999" },
  })

  const wrapped = wrapFetch(fakeFetch(response))
  const out = await wrapped("http://example.invalid/v1/chat/completions")

  assert.equal(out.headers.get("content-type"), "text/event-stream")
  assert.equal(out.headers.get("content-length"), null)
  const text = await out.text()
  const parsed = JSON.parse(text.slice("data: ".length))
  assert.equal(parsed.choices[0].delta.reasoning, "**")
  assert.equal(parsed.choices[0].delta.content, "hi")
})

test("a non-SSE response is returned as the original object", async () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  })
  const out = await wrapFetch(fakeFetch(response))("http://example.invalid/models")
  assert.equal(out, response)
  assert.equal(await out.text(), JSON.stringify({ ok: true }))
})

test("a null body is returned untouched", async () => {
  const response = new Response(null, { status: 204, headers: { "content-type": "text/event-stream" } })
  const out = await wrapFetch(fakeFetch(response))("http://example.invalid/empty")
  assert.equal(out, response)
})

// ---------------------------------------------------------------------------
// installProviderCompat
// ---------------------------------------------------------------------------

test("installing is idempotent and the undo restores the exact original", async () => {
  const original = globalThis.fetch
  const marker = async () => new Response("x")
  globalThis.fetch = marker

  try {
    const restore = installProviderCompat()
    const installed = globalThis.fetch
    assert.notEqual(installed, marker)

    // A second install must not nest a second transform.
    const restoreSecond = installProviderCompat()
    assert.equal(globalThis.fetch, installed)

    restoreSecond()
    restore()
    assert.equal(globalThis.fetch, marker)
  } finally {
    globalThis.fetch = original
  }
})
