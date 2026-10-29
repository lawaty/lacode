import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createVoskWakeDetector,
  matchesWakePhrase,
  normalizeWakeText,
} from "../src/voice/wake-vosk.ts"
import { WakeConfigError } from "../src/voice/wake.ts"

function makeFake(overrides = {}) {
  const state = {
    modelArgs: [],
    modelInstance: null,
    recognizerArgs: null,
    acceptResult: false,
    partial: { partial: "" },
    result: { text: "" },
    modelThrow: null,
    recognizerThrow: null,
    acceptThrow: null,
    partialThrow: null,
    resetCount: 0,
    recognizerFreeCount: 0,
    modelFreeCount: 0,
    ...overrides,
  }

  class Model {
    constructor(path) {
      state.modelArgs.push(path)
      if (state.modelThrow) throw new Error(state.modelThrow)
      state.modelInstance = this
    }
    free() {
      state.modelFreeCount++
    }
  }

  class Recognizer {
    constructor(opts) {
      state.recognizerArgs = opts
      if (state.recognizerThrow) throw new Error(state.recognizerThrow)
    }
    acceptWaveform(buffer) {
      if (state.acceptThrow) throw new Error(state.acceptThrow)
      state.acceptedBuffer = buffer
      return state.acceptResult
    }
    partialResult() {
      if (state.partialThrow) throw new Error(state.partialThrow)
      return state.partial
    }
    result() {
      return state.result
    }
    reset() {
      state.resetCount++
    }
    free() {
      state.recognizerFreeCount++
    }
  }

  return { mod: { Model, Recognizer }, state }
}

const FRAME = new Int16Array(512)

test("1. passes grammar and sampleRate through to Recognizer", async () => {
  const { mod, state } = makeFake()
  const det = await createVoskWakeDetector(
    {
      modelPath: "/models/vosk",
      phrases: ["hey lacode", "hey la code"],
      sampleRate: 16000,
    },
    { load: async () => mod, exists: () => true },
  )

  assert.deepEqual(state.modelArgs, ["/models/vosk"])
  assert.deepEqual(state.recognizerArgs.grammar, ["hey lacode", "hey la code"])
  assert.equal(state.recognizerArgs.sampleRate, 16000)
  assert.equal(state.recognizerArgs.model, state.modelInstance)
  assert.equal(det.frameLength, 512)
  det.release()
})

test("2. partial matching a wake phrase returns true", async () => {
  const { mod, state } = makeFake({ partial: { partial: "hey la code" } })
  const det = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => mod, exists: () => true },
  )

  assert.equal(det.process(FRAME), true)
  assert.equal(state.acceptedBuffer.byteLength, 1024)
  det.release()
})

test("3. unrelated partial returns false", async () => {
  const { mod } = makeFake({ partial: { partial: "hello there" } })
  const det = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => mod, exists: () => true },
  )

  assert.equal(det.process(FRAME), false)
  det.release()
})

test("4. cooldown suppresses matches after a true result", async () => {
  const { mod, state } = makeFake({ partial: { partial: "hey la code" } })
  const det = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => mod, exists: () => true },
  )

  assert.equal(det.process(FRAME), true)
  assert.equal(state.resetCount, 1)

  for (let i = 0; i < 10; i++) {
    assert.equal(det.process(FRAME), false)
  }
  det.release()
})

test("5. matchesWakePhrase matches whole words only", () => {
  const phrases = ["hey lacode", "hey la code"]
  assert.equal(matchesWakePhrase("hey lacode", phrases), true)
  assert.equal(matchesWakePhrase("hey la code", phrases), true)
  assert.equal(matchesWakePhrase("well hey lacode now", phrases), true)
  assert.equal(matchesWakePhrase("hey lacodes", phrases), false)
  assert.equal(matchesWakePhrase("", phrases), false)
  assert.equal(normalizeWakeText("  Hey,   LA-code!  "), "hey la code")
})

test("6. empty or missing model path -> no-model", async () => {
  const { mod } = makeFake()
  const deps = { load: async () => mod, exists: () => true }

  await assert.rejects(
    () => createVoskWakeDetector({ modelPath: "" }, deps),
    (err) => err instanceof WakeConfigError && err.code === "no-model",
  )
  await assert.rejects(
    () => createVoskWakeDetector({ modelPath: "   " }, deps),
    (err) => err instanceof WakeConfigError && err.code === "no-model",
  )
  await assert.rejects(
    () => createVoskWakeDetector({ modelPath: "/missing" }, { ...deps, exists: () => false }),
    (err) => err instanceof WakeConfigError && err.code === "no-model",
  )
})

test("7. loader rejecting -> no-package", async () => {
  const err = new Error("Cannot find module 'vosk'")
  err.code = "MODULE_NOT_FOUND"

  await assert.rejects(
    () =>
      createVoskWakeDetector(
        { modelPath: "/models/vosk" },
        { load: async () => { throw err }, exists: () => true },
      ),
    (e) => e instanceof WakeConfigError && e.code === "no-package",
  )
})

test("8. Model constructor throwing -> init-failed", async () => {
  const { mod } = makeFake({ modelThrow: "boom model" })

  await assert.rejects(
    () =>
      createVoskWakeDetector(
        { modelPath: "/models/vosk" },
        { load: async () => mod, exists: () => true },
      ),
    (e) =>
      e instanceof WakeConfigError &&
      e.code === "init-failed" &&
      String(e.message).includes("boom model"),
  )
})

test("9. release calls both frees exactly once when called twice", async () => {
  const { mod, state } = makeFake()
  const det = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => mod, exists: () => true },
  )

  det.release()
  det.release()

  assert.equal(state.recognizerFreeCount, 1)
  assert.equal(state.modelFreeCount, 1)
})

test("10. malformed JSON and recognizer errors do not throw", async () => {
  const { mod, state } = makeFake({
    acceptResult: true,
    partial: "{not valid json",
    result: "also not json",
  })
  const det = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => mod, exists: () => true },
  )

  assert.equal(det.process(FRAME), false)

  state.acceptThrow = "recognizer blew up"
  assert.equal(det.process(FRAME), false)

  assert.equal(det.process(new Int16Array(3)), false)
  assert.equal(det.process(null), false)
  det.release()
})

test("11. JSON-string results are still parsed", async () => {
  const { mod, state } = makeFake({
    acceptResult: true,
    partial: '{"partial":"hey la code"}',
    result: '{"text":"hey la code"}',
  })
  const det = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => mod, exists: () => true },
  )

  assert.equal(det.process(FRAME), true)
  assert.equal(state.resetCount, 1)
  det.release()
})

test("12. final result object triggers a match when acceptWaveform is truthy", async () => {
  const { mod, state } = makeFake({
    acceptResult: true,
    partial: { partial: "" },
    result: { text: "hey la code" },
  })
  const det = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => mod, exists: () => true },
  )

  assert.equal(det.process(FRAME), true)
  assert.equal(state.resetCount, 1)
  det.release()
})

test("13. default phrase list does not match 'hey lacode' (Vosk cannot emit it)", async () => {
  const lacode = makeFake({ partial: { partial: "hey lacode" } })
  const missDetector = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => lacode.mod, exists: () => true },
  )

  assert.equal(missDetector.process(FRAME), false)
  missDetector.release()

  const laCode = makeFake({ partial: { partial: "hey la code" } })
  const hitDetector = await createVoskWakeDetector(
    { modelPath: "/models/vosk" },
    { load: async () => laCode.mod, exists: () => true },
  )

  assert.equal(hitDetector.process(FRAME), true)
  hitDetector.release()
})
