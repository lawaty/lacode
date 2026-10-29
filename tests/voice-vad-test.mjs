import { test } from "node:test"
import assert from "node:assert/strict"
import { createVad } from "../src/voice/vad.ts"

const FRAME = 512
const SR = 16000

function frame(value, n = FRAME) {
  const a = new Int16Array(n)
  for (let i = 0; i < n; i++) a[i] = value
  return a
}

function silence(n = FRAME) { return frame(0, n) }

function collect(vad, frames) {
  const events = []
  for (const f of frames) events.push(...vad.push(f))
  return events
}

test("silence never emits anything", () => {
  const vad = createVad()
  const frames = Array.from({ length: 100 }, () => silence())
  const ev = collect(vad, frames)
  assert.equal(ev.length, 0)
})

test("single 1s speech burst + 1s silence emits one speech-start and one utterance", () => {
  const vad = createVad()
  const speechFrames = Math.ceil(16000 / FRAME)
  const silenceFrames = Math.ceil(16000 / FRAME)
  const frames = [
    ...Array.from({ length: speechFrames }, () => frame(1000)),
    ...Array.from({ length: silenceFrames }, () => silence()),
  ]
  const ev = collect(vad, frames)
  const starts = ev.filter(e => e.t === "speech-start")
  const utts = ev.filter(e => e.t === "utterance")
  assert.equal(starts.length, 1)
  assert.equal(utts.length, 1)
  const len = utts[0].audio.length
  const speechSamples = speechFrames * FRAME
  assert.ok(len >= speechSamples * 0.9 && len <= speechSamples * 1.2, `len=${len} speech=${speechSamples}`)
})

test("pre-roll includes preceding silence frames", () => {
  const vad = createVad()
  const preSilence = Array.from({ length: 10 }, () => silence())
  const speech = Array.from({ length: 20 }, () => frame(1000))
  const trailing = Array.from({ length: 30 }, () => silence())
  const ev = collect(vad, [...preSilence, ...speech, ...trailing])
  const utts = ev.filter(e => e.t === "utterance")
  assert.equal(utts.length, 1)
  const burstSamples = speech.length * FRAME
  assert.ok(utts[0].audio.length > burstSamples, `len=${utts[0].audio.length} burst=${burstSamples}`)
})

test("two bursts separated by 1.5s silence produce two utterances", () => {
  const vad = createVad()
  const burst = Array.from({ length: 20 }, () => frame(1000))
  const gap = Array.from({ length: Math.ceil(1500 / (FRAME / SR * 1000)) }, () => silence())
  const frames = [...burst, ...gap, ...burst, ...Array.from({ length: 30 }, () => silence())]
  const ev = collect(vad, frames)
  const utts = ev.filter(e => e.t === "utterance")
  assert.equal(utts.length, 2)
})

test("100ms blip dropped but following real burst works", () => {
  const vad = createVad()
  const blip = Array.from({ length: 4 }, () => frame(1000))
  const gap = Array.from({ length: 30 }, () => silence())
  const burst = Array.from({ length: 20 }, () => frame(1000))
  const trailing = Array.from({ length: 30 }, () => silence())
  const ev = collect(vad, [...blip, ...gap, ...burst, ...trailing])
  const utts = ev.filter(e => e.t === "utterance")
  assert.equal(utts.length, 1)
})

test("2s continuous tone with maxUtteranceMs 1000 emits at least two utterances", () => {
  const vad = createVad({ maxUtteranceMs: 1000 })
  const frames = Array.from({ length: 64 }, () => frame(1000))
  const ev = collect(vad, frames)
  const utts = ev.filter(e => e.t === "utterance")
  assert.ok(utts.length >= 2, `got ${utts.length}`)
})

test("adaptive floor detects burst after ambient noise", () => {
  const vad = createVad()
  const ambient = Array.from({ length: 62 }, () => frame(300))
  const burst = Array.from({ length: 20 }, () => frame(1200))
  const trailing = Array.from({ length: 30 }, () => silence())
  const ev = collect(vad, [...ambient, ...burst, ...trailing])
  const utts = ev.filter(e => e.t === "utterance")
  assert.ok(utts.length >= 1, "burst not detected")
})

test("steady ambient alone never triggers", () => {
  const vad = createVad()
  const ambient = Array.from({ length: 200 }, () => frame(300))
  const ev = collect(vad, ambient)
  const utts = ev.filter(e => e.t === "utterance")
  const starts = ev.filter(e => e.t === "speech-start")
  assert.equal(utts.length, 0)
  assert.equal(starts.length, 0)
})

test("flapping single speech frames do not start an utterance", () => {
  const vad = createVad()
  const frames = []
  for (let i = 0; i < 20; i++) {
    frames.push(frame(1000))
    for (let j = 0; j < 5; j++) frames.push(silence())
  }
  const ev = collect(vad, frames)
  const starts = ev.filter(e => e.t === "speech-start")
  const utts = ev.filter(e => e.t === "utterance")
  assert.equal(starts.length, 0)
  assert.equal(utts.length, 0)
})
