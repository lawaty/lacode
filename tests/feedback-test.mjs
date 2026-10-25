// The feedback hint is a local, one-time note: no network, no telemetry. These
// checks drive the library and the factory directly, with an injected sink, a
// temp state file and an `env` that is NOT the test runner's -- so no real
// state directory and no toast are ever touched.
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  DISCUSSIONS_URL,
  FEEDBACK_HINT,
  FEEDBACK_HINT_ENV,
  ISSUES_URL,
  maybeShowFeedbackHint,
  readFeedbackState,
} from "../src/lib/feedback.ts"
import { feedbackHooks } from "../src/plugins/feedback.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, "..", "bin", "lacode")
const ROOT = mkdtempSync(join(tmpdir(), "lacode-feedback-test-"))
let counter = 0

after(() => rmSync(ROOT, { recursive: true, force: true }))

const freshState = () => join(ROOT, `state-${counter++}`, "feedback.json")

const recorder = () => {
  const seen = []
  return {
    seen,
    show: async (message) => {
      seen.push(message)
    },
  }
}

test("the hint shows once and is remembered", async () => {
  const statePath = freshState()
  const { seen, show } = recorder()

  assert.equal(await maybeShowFeedbackHint({ env: {}, statePath, interactive: true, show }), "shown")
  assert.equal(await maybeShowFeedbackHint({ env: {}, statePath, interactive: true, show }), "skipped")

  assert.deepEqual(seen, [FEEDBACK_HINT])
  assert.equal(readFeedbackState(statePath)?.feedbackHintShown, true)
})

test("feedbackHint: false opts out and writes nothing", async () => {
  const statePath = freshState()
  const { seen, show } = recorder()

  assert.equal(await maybeShowFeedbackHint({ feedbackHint: false, env: {}, statePath, interactive: true, show }), "disabled")
  assert.equal(seen.length, 0)
  assert.equal(existsSync(statePath), false)
})

test("LACODE_NO_FEEDBACK_HINT=1 opts out and writes nothing", async () => {
  const statePath = freshState()
  const { seen, show } = recorder()

  const env = { [FEEDBACK_HINT_ENV]: "1" }
  assert.equal(await maybeShowFeedbackHint({ env, statePath, interactive: true, show }), "disabled")
  assert.equal(seen.length, 0)
  assert.equal(existsSync(statePath), false)
})

test("a headless or piped run leaves the flag for a later interactive one", async () => {
  const statePath = freshState()
  const { seen, show } = recorder()

  assert.equal(await maybeShowFeedbackHint({ env: {}, statePath, interactive: false, show }), "unavailable")
  assert.equal(existsSync(statePath), false)

  assert.equal(await maybeShowFeedbackHint({ env: {}, statePath, interactive: true, show }), "shown")
  assert.deepEqual(seen, [FEEDBACK_HINT])
})

test("CI and the test runner never show the hint", async () => {
  const { seen, show } = recorder()

  assert.equal(await maybeShowFeedbackHint({ env: { CI: "true" }, statePath: freshState(), interactive: true, show }), "unavailable")
  assert.equal(await maybeShowFeedbackHint({ env: { NODE_TEST_CONTEXT: "1" }, statePath: freshState(), interactive: true, show }), "unavailable")
  assert.equal(seen.length, 0)
})

test("a failing state write is silent and skips the hint", async () => {
  const blocker = join(ROOT, "not-a-directory")
  writeFileSync(blocker, "")
  const statePath = join(blocker, "feedback.json")
  const { seen, show } = recorder()

  assert.equal(await maybeShowFeedbackHint({ env: {}, statePath, interactive: true, show }), "skipped")
  assert.equal(seen.length, 0)
})

test("a toast that fails does not consume the one-time note", async () => {
  const statePath = freshState()
  let attempts = 0
  const failing = async () => {
    attempts++
    throw new Error("no tui")
  }

  assert.equal(await maybeShowFeedbackHint({ env: {}, statePath, interactive: true, show: failing }), "skipped")
  assert.equal(attempts, 1)
  assert.equal(existsSync(statePath), false, "a failed toast must restore the flag")

  const { seen, show } = recorder()
  assert.equal(await maybeShowFeedbackHint({ env: {}, statePath, interactive: true, show }), "shown")
  assert.deepEqual(seen, [FEEDBACK_HINT])
})

test("the factory does not consume the flag when there is no TUI sink", async () => {
  const statePath = freshState()
  assert.deepEqual(await feedbackHooks({ client: {} }, {}, { env: {}, statePath, interactive: true }), {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(existsSync(statePath), false, "no TUI means no hint and no flag write")

  const seen = []
  const input = {
    client: {
      tui: {
        showToast: async ({ body }) => {
          seen.push(body.message)
        },
      },
    },
  }
  assert.deepEqual(await feedbackHooks(input, {}, { env: {}, statePath, interactive: true }), {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(seen, [FEEDBACK_HINT])
  assert.equal(readFeedbackState(statePath)?.feedbackHintShown, true)
})

test("the feedback links are the project's actual issue and discussion pages", () => {
  assert.equal(ISSUES_URL, "https://github.com/lawaty/lacode/issues")
  assert.equal(DISCUSSIONS_URL, "https://github.com/lawaty/lacode/discussions")
})

test("an unreadable state file is silent and skips the hint", async () => {
  const statePath = freshState()
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, "{ not json")
  const { seen, show } = recorder()

  assert.equal(await maybeShowFeedbackHint({ env: {}, statePath, interactive: true, show }), "skipped")
  assert.equal(seen.length, 0)
})

test("the factory shows the same one-time hint", async () => {
  const statePath = freshState()
  const { seen, show } = recorder()
  const input = { client: {} }

  assert.deepEqual(await feedbackHooks(input, {}, { env: {}, statePath, interactive: true, show }), {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(seen, [FEEDBACK_HINT])

  assert.deepEqual(await feedbackHooks(input, {}, { env: {}, statePath, interactive: true, show }), {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(seen, [FEEDBACK_HINT])
})

test("the factory respects feedbackHint: false", async () => {
  const statePath = freshState()
  const { seen, show } = recorder()

  assert.deepEqual(await feedbackHooks({ client: {} }, { feedbackHint: false }, { env: {}, statePath, interactive: true, show }), {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(seen.length, 0)
  assert.equal(existsSync(statePath), false)
})

test("lacode feedback prints both links without opening a browser", () => {
  const result = spawnSync(process.execPath, [CLI, "feedback"], { encoding: "utf8", timeout: 60000 })

  assert.equal(result.status, 0, `lacode feedback exited ${result.status}: ${result.stderr}`)
  assert.ok(result.stdout.includes(ISSUES_URL), `stdout did not name ${ISSUES_URL}`)
  assert.ok(result.stdout.includes(DISCUSSIONS_URL), `stdout did not name ${DISCUSSIONS_URL}`)
  assert.match(result.stdout, /No browser is opened/)
})
