// Provider compatibility: make opencode's transport tolerate the request and
// response shapes providers actually accept, instead of the one shape its
// schema assumes.
//
// THE FAULTS THIS EXISTS FOR.
//
// RESPONSE. `@ai-sdk/openai-compatible` validates every SSE chunk with a schema
// whose `choices[].delta.reasoning` is a `z.string()`. Some free gateways stream
// the OpenAI reasoning ITEM instead -- an object such as `{ encrypted_content,
// content, summary }` -- and the validator throws `invalid_union` at
// `choices[0].delta.reasoning` ("expected string, received object"). The
// provider never gets a chance to be tolerated: the whole spawn dies on the
// first chunk that carries reasoning, every time, because the mismatch is
// deterministic rather than transient.
//
// REQUEST. The `opencode.ai/inference` gateway sometimes forwards a default
// `reasoning_display: "summary"` to a model whose upstream rejects that value,
// answering HTTP 400 `invalid_request_error` before any token streams. It is a
// FLAKY UPSTREAM, not a client parameter problem: measured against
// `opencode-go/iceman-contributor-free`, the same body fails or succeeds
// nondeterministically across attempts, and NO client field (reasoning_effort,
// reasoning_display, reasoning, include_reasoning, thinking) changes the rate.
// The repair therefore retries the identical replayable request a bounded
// number of times at the transport seam; a later attempt lands on a healthy
// upstream and the spawn proceeds. Nothing is disabled and no field is invented.
//
// WHY A FETCH WRAPPER AND NOT A SCHEMA EDIT. The schema lives inside the
// compiled opencode binary, not in this package and not in any node_modules tree
// a patch could reach. The AI SDK resolves its transport lazily -- it reads
// `globalThis.fetch` at request time -- so a plugin that loads first can own the
// byte stream before the parser sees it. This module is that seam: it rewrites
// only the fields whose type varies, and it passes every other byte through
// untouched.
//
// WHAT IT DOES NOT DO. It never invents reasoning: an object whose summary and
// content are both null (an encrypted-only item) becomes the empty string, which
// is a valid string and carries no claim. It never touches `content`, tool
// calls, usage or framing, and it never rewrites a response that is not an SSE
// stream. A malformed line is forwarded verbatim, because a normalizer that
// drops bytes it cannot parse turns one broken chunk into a broken session.
//
// Everything here is pure except `installProviderCompat()`, which patches one
// global and returns its own undo. `wrapFetch()` is the injected seam the tests
// use, so no test opens a socket and no test needs a provider to be broken.

/** Think of `fetch` as this much and no more: the wrapper never reads a field it does not have to. */
export type FetchLike = (input: unknown, init?: unknown) => Promise<Response>

/** Marks a wrapped fetch so a second plugin load cannot nest a second transform. */
const WRAPPED = Symbol.for("lacode.providerCompat")

/** The delta/message fields whose declared type is `string` upstream. */
const REASONING_FIELDS = ["reasoning", "reasoning_content"] as const

const asText = (value: unknown): string => (typeof value === "string" ? value : "")

/** Pull the readable text out of one item of a `summary`/`content` list. */
const itemText = (item: unknown): string => {
  if (typeof item === "string") return item
  if (item && typeof item === "object") return asText((item as Record<string, unknown>).text)
  return ""
}

/**
 * The string a reasoning value stands for.
 *
 * Precedence follows what a reader would want first: an explicit `text`, then a
 * `summary` (a string, an `{ text }`, or a list of either), then `content` (a
 * string or a list). An encrypted-only item has none of these and yields "".
 */
export function reasoningText(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""

  const source = value as Record<string, unknown>

  const direct = asText(source.text)
  if (direct) return direct

  const summary = source.summary
  if (typeof summary === "string") return summary
  if (Array.isArray(summary)) return summary.map(itemText).join("")
  if (summary && typeof summary === "object") return asText((summary as Record<string, unknown>).text)

  const content = source.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(itemText).join("")

  return ""
}

/**
 * Rewrite the reasoning fields of one parsed chunk in place.
 *
 * Returns whether anything changed, so the caller can decide to re-serialize
 * (and, in the stream path, to forward the original line instead).
 */
export function normalizeChunk(value: unknown): boolean {
  if (!value || typeof value !== "object") return false

  const choices = (value as Record<string, unknown>).choices
  if (!Array.isArray(choices)) return false

  let changed = false
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue

    // Streaming chunks carry `delta`; a non-streaming completion carries the
    // same fields under `message`. Both are parsed against the same shape.
    for (const key of ["delta", "message"] as const) {
      const holder = (choice as Record<string, unknown>)[key]
      if (!holder || typeof holder !== "object") continue

      for (const field of REASONING_FIELDS) {
        const current = (holder as Record<string, unknown>)[field]
        if (current === null || typeof current !== "object") continue
        ;(holder as Record<string, unknown>)[field] = reasoningText(current)
        changed = true
      }
    }
  }

  return changed
}

// ---------------------------------------------------------------------------
// Request side: bounded retry for a flaky upstream 400
// ---------------------------------------------------------------------------

/** Total attempts for one replayable opencode inference request (1 try + 2 retries). */
export const UPSTREAM_ATTEMPTS = 3

/** Delay before each retry, in milliseconds. Exposed so tests run instantly. */
export const UPSTREAM_RETRY_DELAY_MS = 250

/**
 * The request-side fault this recognises: a 400 body from `opencode.ai/inference`
 * whose upstream rejected the gateway's default reasoning display. The client
 * cannot influence it (see the module header); it only clears on a retry.
 */
const TRANSIENT_UPSTREAM_PATTERN = /reasoning_display/i

/** The URL a fetch input names, or "" when it cannot be read without doing work. */
export function requestUrl(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  if (input && typeof input === "object") {
    const url = (input as { url?: unknown }).url
    if (typeof url === "string") return url
  }
  return ""
}

/**
 * Whether a URL is an opencode inference chat-completions endpoint.
 *
 * Scoped on purpose: this is the only host observed to return the transient
 * upstream 400, so no other provider's request is retried.
 */
export function isOpencodeInferenceChat(raw: string): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.hostname !== "opencode.ai" && !url.hostname.endsWith(".opencode.ai")) return false
  return url.pathname.includes("/inference/") && url.pathname.endsWith("/chat/completions")
}

/**
 * Whether the request can be replayed byte-for-byte.
 *
 * A string or a materialised byte body is fully available, so retrying it sends
 * the same bytes and cannot consume a stream. Anything else -- a
 * `ReadableStream`, `FormData`, a `Request` object's implicit body, no `init` at
 * all -- is NOT retried: a replay that cannot be proven identical is worse than
 * the flake it would hide.
 */
export function isReplayableInit(init: unknown): boolean {
  if (!init || typeof init !== "object") return false
  const body = (init as Record<string, unknown>).body
  return typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer
}

/**
 * Whether a response is the known transient upstream 400.
 *
 * Clones rather than reads, so the response is still usable by the caller when
 * this returns false and on the final attempt. A body that cannot be read is
 * treated as "not this fault" -- the wrapper never turns a read failure into a
 * retry storm.
 */
export async function isTransientUpstreamResponse(response: Response): Promise<boolean> {
  if (response.status !== 400) return false
  try {
    const text = await response.clone().text()
    return TRANSIENT_UPSTREAM_PATTERN.test(text) && /not\s+a\s+supported\s+value|unsupported/i.test(text)
  } catch {
    return false
  }
}

/**
 * Normalize one complete SSE frame line (including its trailing newline).
 *
 * Everything that is not a `data:` JSON frame -- comments, `event:` lines, the
 * `[DONE]` sentinel, a keep-alive blank line -- is returned exactly as given.
 */
export function normalizeSseLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) return line

  const payload = trimmed.slice("data:".length).trim()
  if (!payload || payload === "[DONE]") return line

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return line
  }

  if (!normalizeChunk(parsed)) return line

  const newline = line.endsWith("\n") ? "\n" : ""
  return `data: ${JSON.stringify(parsed)}${newline}`
}

/**
 * A byte-for-byte stream transform that buffers to newline, normalizes each
 * line, and re-emits it. Frames split across network chunks are reassembled
 * before they are parsed, so a chunk boundary is never mistaken for bad JSON.
 */
export function createChunkNormalizer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ""

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true })
      let newline = buffered.indexOf("\n")
      while (newline !== -1) {
        const line = buffered.slice(0, newline + 1)
        buffered = buffered.slice(newline + 1)
        controller.enqueue(encoder.encode(normalizeSseLine(line)))
        newline = buffered.indexOf("\n")
      }
    },
    flush(controller) {
      buffered += decoder.decode()
      if (buffered) controller.enqueue(encoder.encode(normalizeSseLine(buffered)))
    },
  })
}

/**
 * Wrap a fetch so an SSE response passes through `normalizeSseLine`.
 *
 * Every other response -- a JSON body, an error, a redirect, a null body -- is
 * returned as the original object, untouched, so this cannot change how any
 * caller's status/headers look. A failure inside the wrapper (a body that
 * cannot be piped) still returns the original response rather than throwing:
 * compatibility is a repair, not a gate.
 */
export type WrapFetchOptions = { attempts?: number; delayMs?: number }

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

/**
 * Wrap a fetch so an opencode inference request survives the flaky upstream 400
 * and an SSE response passes through `normalizeSseLine`.
 *
 * A request is retried only when all three hold: it targets an opencode
 * inference chat-completions endpoint, its body is a replayable string, and the
 * response is the known transient 400. Everything else -- a success, an SSE
 * body, a different status, a non-replayable body, any other host -- is returned
 * exactly as the original produced it. A failure inside the wrapper is still
 * downgraded to the original response: compatibility is a repair, not a gate.
 */
export function wrapFetch(original: FetchLike, options: WrapFetchOptions = {}): FetchLike {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? UPSTREAM_ATTEMPTS))
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? UPSTREAM_RETRY_DELAY_MS))

  const wrapped = async (input: unknown, init?: unknown): Promise<Response> => {
    const retryable =
      attempts > 1 && isReplayableInit(init) && isOpencodeInferenceChat(requestUrl(input))

    let response = await original(input, init)
    for (let attempt = 1; retryable && attempt < attempts; attempt++) {
      if (!(await isTransientUpstreamResponse(response))) break
      // The discarded attempt's body is the small JSON 400; release it rather
      // than leaving the clone's branch unread.
      try {
        await response.body?.cancel()
      } catch {
        /* nothing to release */
      }
      await sleep(delayMs)
      response = await original(input, init)
    }

    try {
      const contentType = response.headers.get("content-type") ?? ""
      if (!contentType.includes("text/event-stream") || !response.body) return response

      // The body is re-framed, so length/encoding headers are now lies. fetch
      // has already decoded the payload by the time it reaches us.
      const headers = new Headers(response.headers)
      headers.delete("content-length")
      headers.delete("content-encoding")
      headers.delete("transfer-encoding")

      return new Response(response.body.pipeThrough(createChunkNormalizer()), {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return response
    }
  }

  ;(wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true
  return wrapped
}

/**
 * Install the wrapper on `globalThis.fetch`.
 *
 * Idempotent: a fetch that already carries the wrapper is left alone, so two
 * plugin loads in one process cannot stack transforms. Returns the undo, which
 * restores the exact function it replaced -- and does nothing when the target
 * was not ours to replace.
 */
export function installProviderCompat(): () => void {
  const target = (globalThis as { fetch?: FetchLike }).fetch
  if (typeof target !== "function") return () => {}
  if ((target as unknown as Record<symbol, boolean>)[WRAPPED]) return () => {}

  const wrapped = wrapFetch(target)
  ;(globalThis as { fetch?: FetchLike }).fetch = wrapped

  return () => {
    // Only restore what we actually installed: a host that swapped fetch again
    // after us owns the current one, and undoing ours would drop their change.
    if ((globalThis as { fetch?: FetchLike }).fetch === wrapped) {
      ;(globalThis as { fetch?: FetchLike }).fetch = target
    }
  }
}
