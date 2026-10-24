// The system prompt is handed to a model, so a literal pool slot variant in it
// teaches the model that name. scrubSlotNames removes those literals while
// leaving lookalikes and ordinary text untouched.

import { test } from "node:test"
import assert from "node:assert/strict"
import { scrubSlotNames } from "../src/lib/prompt-guard.ts"
import { bootLaCode, cleanupAll, scratch, stubInput } from "./stories/_harness.mjs"

test.after(cleanupAll)

test("scrubSlotNames strips slot variants and leaves lookalikes and ordinary text alone", () => {
  assert.equal(
    scrubSlotNames("spawn explore-1 and implement-4, not context-12"),
    "spawn explore and implement, not context",
  )
  assert.equal(scrubSlotNames("context-manager task-3 explorex explore-0"), "context-manager task-3 explorex explore-0")
  assert.equal(scrubSlotNames("no variants here"), "no variants here")
})

test("scrubSlotNames scrubs every occurrence and is idempotent", () => {
  const input = "explore-1 explore-2 implement-3 context-4 explore-1"
  const once = scrubSlotNames(input)
  assert.equal(once, "explore explore implement context explore", "every variant on the line must be scrubbed")
  assert.equal(scrubSlotNames(once), once, "scrubbing an already-scrubbed prompt must change nothing")
})

test("scrubSlotNames consumes consecutive numeric suffixes in one match", () => {
  assert.equal(scrubSlotNames("explore-1-2"), "explore")
  assert.equal(scrubSlotNames("implement-1-4"), "implement")
  const chained = "explore-1-2 and implement-1-4"
  const once = scrubSlotNames(chained)
  assert.equal(scrubSlotNames(once), once, "a chained variant must not become a new variant name")
})

test("the system transform scrubs slot names before the model sees them", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "prompt-guard-transform", dir: scratch() })
  const output = { system: ["never name explore-2"] }
  await hooks["experimental.chat.system.transform"]({}, output)
  assert.deepEqual(output.system, ["never name explore"])
  await hooks.dispose()
})
