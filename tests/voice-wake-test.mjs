import { test } from "node:test"
import assert from "node:assert/strict"
import { createWakeDetector, WakeConfigError } from "../src/voice/wake.ts"

function makeFake(overrides = {}) {
  const state = {
    ctorArgs: null,
    getBuiltinArgs: [],
    releaseCount: 0,
    processResult: overrides.processResult ?? -1,
    ctorThrow: overrides.ctorThrow ?? null,
    frameLength: overrides.frameLength ?? 512,
  }
  const getBuiltinKeywordPath = (name) => {
    state.getBuiltinArgs.push(name)
    return overrides.builtinPath ?? `/builtin/${name}.ppn`
  }
  class Porcupine {
    constructor(accessKey, keywordPaths, sensitivities) {
      state.ctorArgs = { accessKey, keywordPaths, sensitivities }
      if (state.ctorThrow) throw new Error(state.ctorThrow)
    }
    get frameLength() {
      return state.frameLength
    }
    process(_frame) {
      return state.processResult
    }
    release() {
      state.releaseCount++
    }
  }
  const mod = { Porcupine, getBuiltinKeywordPath, BuiltinKeyword: {} }
  return { mod, state }
}

test("1. no access key -> no-key", async () => {
  const { mod } = makeFake()
  await assert.rejects(
    () => createWakeDetector({ accessKey: "", keywordPath: "computer" }, { load: async () => mod, exists: () => true }),
    (err) => err instanceof WakeConfigError && err.code === "no-key",
  )
})

test("2. no keyword path -> no-model", async () => {
  const { mod } = makeFake()
  await assert.rejects(
    () => createWakeDetector({ accessKey: "key", keywordPath: "" }, { load: async () => mod, exists: () => true }),
    (err) => err instanceof WakeConfigError && err.code === "no-model",
  )
})

test("3. built-in Computer resolves via getBuiltinKeywordPath", async () => {
  const { mod, state } = makeFake()
  const det = await createWakeDetector({ accessKey: "key", keywordPath: "Computer" }, { load: async () => mod, exists: () => false })
  assert.equal(state.getBuiltinArgs.includes("computer"), true)
  assert.equal(state.ctorArgs.keywordPaths[0], "/builtin/computer.ppn")
  det.release()
})

test("4. non-existent custom path -> no-model containing path", async () => {
  const { mod } = makeFake()
  const p = "/tmp/does-not-exist.ppn"
  await assert.rejects(
    () => createWakeDetector({ accessKey: "key", keywordPath: p }, { load: async () => mod, exists: () => false }),
    (err) => err instanceof WakeConfigError && err.code === "no-model" && String(err.message).includes(p),
  )
})

test("5. loader rejecting MODULE_NOT_FOUND -> no-package", async () => {
  const err = new Error("Cannot find module '@picovoice/porcupine-node'")
  err.code = "MODULE_NOT_FOUND"
  await assert.rejects(
    () => createWakeDetector({ accessKey: "key", keywordPath: "computer" }, { load: async () => { throw err } }),
    (e) => e instanceof WakeConfigError && e.code === "no-package",
  )
})

test("6. constructor throwing -> init-failed", async () => {
  const { mod } = makeFake({ ctorThrow: "boom constructor" })
  await assert.rejects(
    () => createWakeDetector({ accessKey: "key", keywordPath: "computer" }, { load: async () => mod, exists: () => true }),
    (e) => e instanceof WakeConfigError && e.code === "init-failed" && String(e.message).includes("boom constructor"),
  )
})

test("7. process maps -1 to false and 0 to true; wrong-length returns false", async () => {
  const { mod, state } = makeFake({ processResult: -1, frameLength: 4 })
  const det = await createWakeDetector({ accessKey: "key", keywordPath: "computer" }, { load: async () => mod, exists: () => true })
  assert.equal(det.frameLength, 4)
  state.processResult = -1
  assert.equal(det.process(new Int16Array(4)), false)
  state.processResult = 0
  assert.equal(det.process(new Int16Array(4)), true)
  // wrong length
  state.processResult = 0
  assert.equal(det.process(new Int16Array(3)), false)
  // non-Int16Array coercion
  state.processResult = 0
  assert.equal(det.process([1, 2, 3, 4]), true)
  det.release()
})

test("8. release twice calls underlying release once", async () => {
  const { mod, state } = makeFake()
  const det = await createWakeDetector({ accessKey: "key", keywordPath: "computer" }, { load: async () => mod, exists: () => true })
  det.release()
  det.release()
  assert.equal(state.releaseCount, 1)
})

test("9. sensitivity clamped (2 -> 1)", async () => {
  const { mod, state } = makeFake()
  const det = await createWakeDetector({ accessKey: "key", keywordPath: "computer", sensitivity: 2 }, { load: async () => mod, exists: () => true })
  assert.deepEqual(state.ctorArgs.sensitivities, [1])
  det.release()
})
