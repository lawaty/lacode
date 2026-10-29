import { test } from "node:test"
import assert from "node:assert/strict"
import { createVoiceDaemon } from "../src/voice/daemon.ts"
import { createVoiceServer, createVoiceClient } from "../src/voice/transport.ts"

function delay(ms) { return new Promise((r) => setTimeout(r, ms)) }
async function waitFor(cond, timeout = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timeout")
    await delay(10)
  }
}

function frameBuffer(first, n = 512) {
  const arr = new Int16Array(n)
  arr[0] = first
  return Buffer.from(arr.buffer)
}

function speechBuffer(n = 512, value = 5000) {
  const arr = new Int16Array(n)
  arr.fill(value)
  return Buffer.from(arr.buffer)
}

function speechPcm(ms = 1000, sampleRate = 16000, value = 5000) {
  const arr = new Int16Array(Math.round((ms / 1000) * sampleRate))
  arr.fill(value)
  return arr
}

const SPEECH_SAMPLES = 5120

function makeCapture() {
  let onChunk
  const cap = {
    running: false,
    stopCount: 0,
    start() { this.running = true },
    stop() { this.running = false; this.stopCount++ },
    push(chunk) { if (onChunk) onChunk(chunk) },
  }
  const factory = (cb) => { onChunk = cb; return cap }
  return { factory, cap }
}

function makeWake(throwOnCreate = false) {
  const state = { released: 0 }
  const factory = async () => {
    if (throwOnCreate) throw new Error("wake boom")
    const det = {
      frameLength: 512,
      process(frame) { return frame[0] === 1234 },
      release() { state.released++ },
    }
    return det
  }
  return { factory, state }
}

function makeVad() {
  const factory = () => ({
    speaking: false,
    push(frame) {
      if (frame[0] === 999) return [{ t: "utterance", audio: speechPcm() }]
      return []
    },
    reset() {},
  })
  return factory
}

const baseConfig = {
  groqKey: "gsk_test",
  picovoiceKey: "pv",
  wakeWordPath: "computer",
  wakeSensitivity: 0.5,
  wakeEngine: "vosk",
  voskModelPath: "/nonexistent/lacode-vosk-model",
  wakePhrases: ["hey lacode", "hey la code"],
  port: 0,
  host: "127.0.0.1",
  model: "whisper-large-v3-turbo",
  language: "en",
  armOnStart: true,
  sampleRate: 16000,
}

test("1. start resolves real port and wake true", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const transcribeCalls = []
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async (input) => { transcribeCalls.push(input); return "hello world" },
    log: () => {},
  })
  const res = await daemon.start()
  assert.equal(typeof res.port, "number")
  assert.ok(res.port > 0)
  assert.equal(res.wake, true)
  assert.equal(daemon.state.port, res.port)
  await daemon.stop()
})

test("2. wake path", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  // wake frame
  cap.cap.push(frameBuffer(1234))
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  // normal then 999
  cap.cap.push(frameBuffer(0))
  cap.cap.push(frameBuffer(999))
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "transcribing"))
  await waitFor(() => msgs.some((m) => m.t === "transcript" && m.text === "hello world" && m.source === "wake"))
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "idle"))
  client.stop()
  await daemon.stop()
})

test("3. manual path", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const transcribeCalls = []
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async (input) => { transcribeCalls.push(input); return "hello world" },
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  cap.cap.push(speechBuffer(SPEECH_SAMPLES))
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "transcript" && m.source === "manual"))
  const tcall = transcribeCalls[transcribeCalls.length - 1]
  assert.ok(tcall.audio instanceof Uint8Array)
  assert.equal(String.fromCharCode(tcall.audio[0], tcall.audio[1], tcall.audio[2], tcall.audio[3]), "RIFF")
  assert.equal(tcall.audio.length, 44 + SPEECH_SAMPLES * 2)
  assert.equal(tcall.filename, "audio.wav")
  client.stop()
  await daemon.stop()
})

test("4. transcribe rejecting -> error and idle", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => { throw new Error("transcribe failed") },
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  cap.cap.push(speechBuffer(SPEECH_SAMPLES))
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "error" && m.message === "transcribe failed"))
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "idle"))
  client.stop()
  await daemon.stop()
})

test("5. wake detector throwing -> wake false + wakeError, manual works", async () => {
  const cap = makeCapture()
  const wake = makeWake(true)
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: () => {},
  })
  const res = await daemon.start()
  assert.equal(res.wake, false)
  assert.ok(res.wakeError)
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  cap.cap.push(speechBuffer(SPEECH_SAMPLES))
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "transcript" && m.source === "manual"))
  client.stop()
  await daemon.stop()
})

test("6. no groqKey -> error mentioning key", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const cfg = { ...baseConfig, groqKey: undefined }
  const daemon = createVoiceDaemon({
    config: cfg,
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  cap.cap.push(speechBuffer(SPEECH_SAMPLES))
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "error" && /key/i.test(m.message)))
  client.stop()
  await daemon.stop()
})

test("7. disarm then wake frame -> no recording", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "disarm" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.armed === false))
  const before = msgs.length
  cap.cap.push(frameBuffer(1234))
  await delay(100)
  const recordingAfter = msgs.slice(before).some((m) => m.t === "state" && m.phase === "recording")
  assert.equal(recordingAfter, false)
  client.stop()
  await daemon.stop()
})

test("8. stop releases wake and stops capture once; double stop safe", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: () => {},
  })
  await daemon.start()
  await daemon.stop()
  assert.equal(wake.state.released, 1)
  assert.equal(cap.cap.stopCount, 1)
  await daemon.stop()
  assert.equal(wake.state.released, 1)
  assert.equal(cap.cap.stopCount, 1)
})

test("9. hello gets welcome; ping gets pong", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig, armOnStart: true },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "hello", v: 1 })
  await waitFor(() => msgs.some((m) => m.t === "welcome"))
  const w = msgs.find((m) => m.t === "welcome")
  assert.equal(w.armed, daemon.state.armed)
  assert.equal(w.wake, true)
  client.send({ t: "ping" })
  await waitFor(() => msgs.some((m) => m.t === "pong"))
  client.stop()
  await daemon.stop()
})

test("10. manual toggle with zero frames -> error and idle", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "error" && /No audio captured/.test(m.message)))
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "idle"))
  client.stop()
  await daemon.stop()
})

test("11. capture not running -> log and broadcast error", async () => {
  const logs = []
  const wake = makeWake()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: () => ({ running: false, plan: undefined, start() {}, stop() {} }),
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: (level, message) => logs.push({ level, message }),
  })
  await daemon.start()
  assert.ok(logs.some((l) => l.level === "error" && /not running/i.test(l.message)))
  await daemon.stop()
})

test("12. manual toggle silent -> No speech detected, no transcribe, idle", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const transcribeCalls = []
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async (input) => { transcribeCalls.push(input); return "hello world" },
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  cap.cap.push(frameBuffer(0))
  cap.cap.push(frameBuffer(0))
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "error" && m.message === "No speech detected"))
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "idle"))
  assert.equal(transcribeCalls.length, 0)
  client.stop()
  await daemon.stop()
})

test("13. short speech-shaped clip transcribing to a hallucination -> No speech detected, no transcript, idle", async () => {
  const cap = makeCapture()
  const wake = makeWake()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig },
    createCapture: cap.factory,
    createWakeDetector: wake.factory,
    createVad: makeVad(),
    transcribe: async () => "Thank you.",
    log: () => {},
  })
  const res = await daemon.start()
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  cap.cap.push(speechBuffer(SPEECH_SAMPLES))
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "error" && m.message === "No speech detected"))
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "idle"))
  assert.equal(msgs.some((m) => m.t === "transcript"), false)
  client.stop()
  await daemon.stop()
})

test("14. vosk dispatch with missing model -> wake false + wakeError, manual works", async () => {
  const cap = makeCapture()
  const daemon = createVoiceDaemon({
    config: { ...baseConfig, wakeEngine: "vosk", voskModelPath: "/nonexistent/lacode-vosk-model" },
    createCapture: cap.factory,
    createVad: makeVad(),
    transcribe: async () => "hello world",
    log: () => {},
  })
  const res = await daemon.start()
  assert.equal(res.wake, false)
  assert.ok(res.wakeError)
  const msgs = []
  const client = createVoiceClient({ port: res.port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "state" && m.phase === "recording"))
  cap.cap.push(speechBuffer(SPEECH_SAMPLES))
  client.send({ t: "toggle" })
  await waitFor(() => msgs.some((m) => m.t === "transcript" && m.source === "manual"))
  client.stop()
  await daemon.stop()
})
