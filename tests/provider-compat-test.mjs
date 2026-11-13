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
  isOpencodeInferenceChat,
  isReplayableInit,
  isTransientUpstreamResponse,
  normalizeChunk,
  normalizeSseLine,
  reasoningText,
  requestUrl,
  UPSTREAM_ATTEMPTS,
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

// ---------------------------------------------------------------------------
// Request side: bounded retry for the flaky upstream `reasoning_display` 400
// ---------------------------------------------------------------------------

const GO_CHAT = "https://opencode.ai/inference/go/openai/v1/chat/completions"
const ZEN_CHAT = "https://opencode.ai/inference/openai/v1/chat/completions"

const transient400 = () =>
  new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "Upstream request failed: [invalid_request_error] `summary` is not a supported value for `reasoning_display`.",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  )

const okJson = () =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

test("requestUrl reads a string, a URL and a Request-like object", () => {
  assert.equal(requestUrl(GO_CHAT), GO_CHAT)
  assert.equal(requestUrl(new URL(GO_CHAT)), GO_CHAT)
  assert.equal(requestUrl({ url: GO_CHAT }), GO_CHAT)
  assert.equal(requestUrl(42), "")
})

test("only opencode inference chat-completions URLs are matched", () => {
  assert.equal(isOpencodeInferenceChat(GO_CHAT), true)
  assert.equal(isOpencodeInferenceChat(ZEN_CHAT), true)
  assert.equal(isOpencodeInferenceChat("https://opencode.ai/inference/go/openai/v1/models"), false)
  assert.equal(isOpencodeInferenceChat("https://api.groq.com/openai/v1/chat/completions"), false)
  assert.equal(isOpencodeInferenceChat("http://example.invalid/v1/chat/completions"), false)
  assert.equal(isOpencodeInferenceChat("not a url"), false)
})

test("a string body is replayable; a stream, FormData or no init is not", () => {
  assert.equal(isReplayableInit({ body: "{}" }), true)
  assert.equal(isReplayableInit({ body: new Uint8Array([1, 2]) }), true)
  assert.equal(isReplayableInit({ body: new ArrayBuffer(4) }), true)
  assert.equal(isReplayableInit({ body: new ReadableStream() }), false)
  assert.equal(isReplayableInit({ body: new FormData() }), false)
  assert.equal(isReplayableInit({}), false)
  assert.equal(isReplayableInit(undefined), false)
})

test("the known transient 400 is recognised by status and body", async () => {
  assert.equal(await isTransientUpstreamResponse(transient400()), true)
  assert.equal(await isTransientUpstreamResponse(okJson()), false)
  assert.equal(await isTransientUpstreamResponse(new Response(JSON.stringify({ error: "invalid request" }), { status: 400 })), false)
})

test("the response stays usable after the transient check", async () => {
  const response = transient400()
  assert.equal(await isTransientUpstreamResponse(response), true)
  // clone(), not read(): the caller can still read the original body.
  assert.match(await response.text(), /reasoning_display/)
})

test("a flaky opencode request is retried and the good response returned", async () => {
  let calls = 0
  const original = async () => {
    calls++
    return calls < 3 ? transient400() : okJson()
  }
  const wrapped = wrapFetch(original, { delayMs: 0 })
  const out = await wrapped(GO_CHAT, { method: "POST", body: "{}" })
  assert.equal(out.status, 200)
  assert.equal(calls, 3)
})

test("retries stop at the bounded attempt count and return the last 400", async () => {
  let calls = 0
  const original = async () => {
    calls++
    return transient400()
  }
  const wrapped = wrapFetch(original, { delayMs: 0 })
  const out = await wrapped(GO_CHAT, { method: "POST", body: "{}" })
  assert.equal(out.status, 400)
  assert.equal(calls, UPSTREAM_ATTEMPTS)
  assert.match(await out.text(), /reasoning_display/)
})

test("a different 400 is not retried", async () => {
  let calls = 0
  const original = async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: "context length exceeded" } }), { status: 400 })
  }
  const out = await wrapFetch(original, { delayMs: 0 })(GO_CHAT, { method: "POST", body: "{}" })
  assert.equal(out.status, 400)
  assert.equal(calls, 1)
})

test("a non-opencode host is not retried, even for the same body", async () => {
  let calls = 0
  const original = async () => {
    calls++
    return transient400()
  }
  const out = await wrapFetch(original, { delayMs: 0 })("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    body: "{}",
  })
  assert.equal(out.status, 400)
  assert.equal(calls, 1)
})

test("a non-replayable body is not retried", async () => {
  let calls = 0
  const original = async () => {
    calls++
    return transient400()
  }
  const out = await wrapFetch(original, { delayMs: 0 })(GO_CHAT, { method: "POST", body: new ReadableStream() })
  assert.equal(out.status, 400)
  assert.equal(calls, 1)
})

test("a successful SSE stream is returned without retry and still normalized", async () => {
  let calls = 0
  const original = async () => {
    calls++
    const body = streamOf([sse(chunk({ reasoning: { summary: { text: "**" } } }))])
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
  const wrapped = wrapFetch(original, { delayMs: 0 })
  const out = await wrapped(GO_CHAT, { method: "POST", body: "{}" })
  assert.equal(calls, 1)
  assert.equal(JSON.parse((await out.text()).slice("data: ".length)).choices[0].delta.reasoning, "**")
})
