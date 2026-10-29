import { test } from "node:test"
import assert from "node:assert/strict"
import { pcmStats, hasSpeech, decodeWavPcm, isSilenceHallucination } from "../src/voice/audio.ts"
import { encodeWav } from "../src/voice/wav.ts"

test("1. pcmStats on 1s of zeros", () => {
  const pcm = new Int16Array(16000)
  const s = pcmStats(pcm, 16000)
  assert.equal(s.rms, 0)
  assert.equal(s.peak, 0)
  assert.equal(s.durationMs, 1000)
})

test("2. constant 1000 amplitude", () => {
  const pcm = new Int16Array(16000)
  for (let i = 0; i < pcm.length; i++) pcm[i] = 1000
  const s = pcmStats(pcm, 16000)
  assert.ok(Math.abs(s.rms - 1000) < 1e-9)
  assert.equal(s.peak, 1000)
})

test("3. hasSpeech cases", () => {
  const silence = new Int16Array(16000)
  assert.equal(hasSpeech(silence), false)

  const short = new Int16Array(1600)
  for (let i = 0; i < short.length; i++) short[i] = 5000
  assert.equal(hasSpeech(short), false) // 100ms < 250

  const low = new Int16Array(16000)
  for (let i = 0; i < low.length; i++) low[i] = 100
  assert.equal(hasSpeech(low), false) // rms below floor

  const loud = new Int16Array(16000)
  for (let i = 0; i < loud.length; i++) loud[i] = 5000
  assert.equal(hasSpeech(loud), true)
})

test("4. hasSpeech false for empty array", () => {
  assert.equal(hasSpeech(new Int16Array(0)), false)
})

test("5. decodeWavPcm round-trips", () => {
  const pcm = new Int16Array([1, -2, 3, 4, -32768, 32767])
  const wav = encodeWav(pcm, { sampleRate: 16000, channels: 1 })
  const dec = decodeWavPcm(wav)
  assert.ok(dec)
  assert.equal(dec.sampleRate, 16000)
  assert.equal(dec.channels, 1)
  assert.equal(dec.pcm.length, pcm.length)
  for (let i = 0; i < pcm.length; i++) assert.equal(dec.pcm[i], pcm[i])
})

test("6. decodeWavPcm invalid and extra chunk", () => {
  assert.equal(decodeWavPcm(new Uint8Array([1, 2, 3])), undefined)

  const pcm = new Int16Array([1, 2, 3])
  const wav = encodeWav(pcm)
  // find data chunk
  let dataOff = -1
  for (let i = 12; i < wav.length - 4; i++) {
    if (wav[i] === 0x64 && wav[i + 1] === 0x61 && wav[i + 2] === 0x74 && wav[i + 3] === 0x61) { dataOff = i; break }
  }
  assert.ok(dataOff >= 0)
  const extra = new Uint8Array(12)
  // "junk"
  extra[0] = 0x6a; extra[1] = 0x75; extra[2] = 0x6e; extra[3] = 0x6b
  // size 4
  extra[4] = 4; extra[5] = 0; extra[6] = 0; extra[7] = 0
  extra[8] = 1; extra[9] = 2; extra[10] = 3; extra[11] = 4
  const out = new Uint8Array(wav.length + extra.length)
  out.set(wav.slice(0, dataOff), 0)
  out.set(extra, dataOff)
  out.set(wav.slice(dataOff), dataOff + extra.length)
  const view = new DataView(out.buffer)
  view.setUint32(4, view.getUint32(4, true) + extra.length, true)
  const dec = decodeWavPcm(out)
  assert.ok(dec)
  assert.equal(dec.pcm.length, pcm.length)
  for (let i = 0; i < pcm.length; i++) assert.equal(dec.pcm[i], pcm[i])
})

test("7. odd data size does not throw", () => {
  const pcm = new Int16Array([1, 2, 3])
  const wav = encodeWav(pcm)
  // set dataSize to 5 (odd) and truncate to 44+5 bytes
  const out = new Uint8Array(44 + 5)
  out.set(wav.slice(0, 44 + 5), 0)
  const view = new DataView(out.buffer)
  view.setUint32(40, 5, true)
  view.setUint32(4, 36 + 5, true)
  let dec
  assert.doesNotThrow(() => { dec = decodeWavPcm(out) })
  // dec may be defined with 2 samples
  if (dec) {
    assert.equal(dec.pcm.length, 2)
  }
})

test("8. isSilenceHallucination", () => {
  assert.equal(isSilenceHallucination("Thank you.", 1500), true)
  assert.equal(isSilenceHallucination("Thank you.", 5000), false)
  assert.equal(isSilenceHallucination("thanks for watching!", 1000), true)
  assert.equal(isSilenceHallucination("  BYE.  ", 1000), true)
  assert.equal(isSilenceHallucination("you", 1000), true)
  assert.equal(isSilenceHallucination("Amara.org", 1000), true)
  assert.equal(isSilenceHallucination("Thank you for the update", 1000), false)
  assert.equal(isSilenceHallucination("hello world", 1000), false)
  assert.equal(isSilenceHallucination("", 1000), false)
})
