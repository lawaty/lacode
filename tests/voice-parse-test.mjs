import { test } from "node:test"
import assert from "node:assert/strict"
import { parseSelection, parseQuestionAnswers, parsePermissionReply } from "../src/voice/parse.ts"

const q3single = { options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiple: false, custom: false }
const q3multi = { options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiple: true, custom: false }

test("option 1 selects first (single)", () => {
  assert.deepEqual(parseSelection("option 1", q3single), [0])
})

test("the first one (single)", () => {
  assert.deepEqual(parseSelection("the first one", q3single), [0])
})

test("one and three single keeps first", () => {
  assert.deepEqual(parseSelection("one and three", q3single), [0])
})

test("one and three multi", () => {
  assert.deepEqual(parseSelection("one and three", q3multi), [0, 2])
})

test("all on single takes first", () => {
  assert.deepEqual(parseSelection("all", q3single), [0])
})

test("all on multiple selects all", () => {
  assert.deepEqual(parseSelection("all", q3multi), [0, 1, 2])
})

test("none", () => {
  assert.deepEqual(parseSelection("none", q3single), [])
})

test("skip", () => {
  assert.deepEqual(parseSelection("skip", q3multi), [])
})

test("exact label match", () => {
  const q = { options: [{ label: "Use Postgres" }, { label: "MySQL" }], multiple: false, custom: false }
  assert.deepEqual(parseSelection("use Postgres", q), [0])
})

test("prefix match", () => {
  const q = { options: [{ label: "Postgres" }, { label: "MySQL" }], multiple: false, custom: false }
  assert.deepEqual(parseSelection("postgres db", q), [0])
})

test("token-overlap match", () => {
  const q = { options: [{ label: "Red Apple" }, { label: "Blue Berry" }], multiple: false, custom: false }
  assert.deepEqual(parseSelection("give me red apple please", q), [0])
})

test("custom free text fallback returns [-1]", () => {
  const q = { options: [{ label: "A" }, { label: "B" }], multiple: false, custom: true }
  assert.deepEqual(parseSelection("hello world", q), [-1])
})

test("custom free text maps to raw utterance", () => {
  const q = { options: [{ label: "A" }, { label: "B" }], multiple: false, custom: true }
  assert.deepEqual(parseQuestionAnswers("hello world", [q]), [["hello world"]])
})

test("custom false does not produce free text", () => {
  const q = { options: [{ label: "A" }], multiple: false, custom: false }
  assert.deepEqual(parseSelection("hello world", q), [])
})

test("two-question positional distribution", () => {
  const qA = { options: [{ label: "A" }, { label: "B" }], multiple: false, custom: false }
  const qB = { options: [{ label: "X" }, { label: "Y" }], multiple: false, custom: false }
  assert.deepEqual(parseQuestionAnswers("one, two", [qA, qB]), [["A"], ["Y"]])
})

test("leave rest unanswered", () => {
  const qA = { options: [{ label: "A" }, { label: "B" }], multiple: false, custom: false }
  const qB = { options: [{ label: "X" }, { label: "Y" }], multiple: false, custom: false }
  assert.deepEqual(parseQuestionAnswers("one", [qA, qB]), [["A"], []])
})

test("permission yes", () => {
  assert.equal(parsePermissionReply("yes"), "once")
})

test("permission go ahead", () => {
  assert.equal(parsePermissionReply("go ahead"), "once")
})

test("permission always allow", () => {
  assert.equal(parsePermissionReply("always allow"), "always")
})

test("permission no", () => {
  assert.equal(parsePermissionReply("no"), "reject")
})

test("permission don't ask again is always", () => {
  assert.equal(parsePermissionReply("don't ask again"), "always")
})

test("permission nonsense undefined", () => {
  assert.equal(parsePermissionReply("foobar"), undefined)
})

test("out-of-range ignored", () => {
  assert.deepEqual(parseSelection("1 and 5", q3multi), [0])
})

test("zero questions", () => {
  assert.deepEqual(parseQuestionAnswers("one", []), [])
})
