// Probe-result predicate tests: the pure guards in scripts/probe-result.mjs.
// Run with: node --test tests/probe-result-test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"

import { hasDirectAnswer, hasSessionAnswer } from "../scripts/probe-result.mjs"

test("[US-39] direct: empty-string content -> false", () => {
  assert.equal(hasDirectAnswer({ choices: [{ message: { content: "" } }] }), false)
})

test("[US-39] direct: whitespace content -> false", () => {
  assert.equal(hasDirectAnswer({ choices: [{ message: { content: "   \n\t  " } }] }), false)
})

test("[US-39] direct: non-empty content -> true", () => {
  assert.equal(hasDirectAnswer({ choices: [{ message: { content: "ok" } }] }), true)
})

test("[US-39] direct: tool_calls with empty content -> true", () => {
  assert.equal(
    hasDirectAnswer({
      choices: [{ message: { content: "", tool_calls: [{ id: "call_1", type: "function" }] } }],
    }),
    true,
  )
})

test("[US-39] direct: no message -> true", () => {
  assert.equal(hasDirectAnswer({ choices: [{}] }), true)
})

test("[US-39] direct: content array with text part -> true", () => {
  assert.equal(
    hasDirectAnswer({ choices: [{ message: { content: [{ type: "text", text: "ok" }] } }] }),
    true,
  )
})

test("[US-39] direct: content array with whitespace text -> false", () => {
  assert.equal(
    hasDirectAnswer({ choices: [{ message: { content: [{ type: "text", text: "  " }] } }] }),
    false,
  )
})

test("[US-39] session: empty parts -> false", () => {
  assert.equal(hasSessionAnswer({ parts: [] }), false)
})

test("[US-39] session: text part with content -> true", () => {
  assert.equal(hasSessionAnswer({ parts: [{ type: "text", text: "ok" }] }), true)
})

test("[US-39] session: whitespace text part -> false", () => {
  assert.equal(hasSessionAnswer({ parts: [{ type: "text", text: "   " }] }), false)
})

test("[US-39] session: tool part -> true", () => {
  assert.equal(hasSessionAnswer({ parts: [{ type: "tool" }] }), true)
})

test("[US-39] session: missing parts -> true", () => {
  assert.equal(hasSessionAnswer({ info: { id: "msg_1" } }), true)
})
