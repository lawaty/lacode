import { test } from "node:test"
import assert from "node:assert/strict"
import { encodeWav, wavDurationMs } from "../src/voice/wav.ts"

function riff(b) { return String.fromCharCode(b[0], b[1], b[2], b[3]) }

test("1. header magic", () => {
  const wav = encodeWav(new Int16Array([1, 2, 3]))
  assert.equal(riff(wav.slice(0, 4)), "RIFF")
  assert.equal(riff(wav.slice(8, 12)), "WAVE")
  assert.equal(riff(wav.slice(12, 16)), "fmt ")
  assert.equal(riff(wav.slice(36, 40)), "data")
})

test("2. little-endian sizes", () => {
  const samples = new Int16Array([1, 2, 3, 4])
  const wav = encodeWav(samples)
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const chunkSize = view.getUint32(4, true)
  const dataSize = view.getUint32(40, true)
  assert.equal(chunkSize, 36 + dataSize)
  assert.equal(dataSize, samples.length * 2)
  assert.equal(wav.length, 44 + dataSize)
})

test("3. format fields", () => {
  const wav = encodeWav(new Int16Array([1, 2, 3]))
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getUint16(20, true), 1) // audioFormat
  assert.equal(view.getUint16(22, true), 1) // channels
  assert.equal(view.getUint32(24, true), 16000) // sampleRate
  assert.equal(view.getUint32(28, true), 32000) // byteRate
  assert.equal(view.getUint16(32, true), 2) // blockAlign
  assert.equal(view.getUint16(34, true), 16) // bitsPerSample
})

test("4. sample round-trip", () => {
  const input = new Int16Array([0, 1, -1, 32767, -32768])
  const wav = encodeWav(input)
  const out = new Int16Array(wav.buffer, wav.byteOffset + 44, input.length)
  for (let i = 0; i < input.length; i++) assert.equal(out[i], input[i])
})

test("5. custom format", () => {
  const wav = encodeWav(new Int16Array([1, 2]), { sampleRate: 44100, channels: 2 })
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getUint32(28, true), 176400) // byteRate
  assert.equal(view.getUint16(32, true), 4) // blockAlign
})

test("6. empty input", () => {
  const wav = encodeWav(new Int16Array(0))
  assert.equal(wav.length, 44)
  assert.equal(wavDurationMs(wav), 0)
})

test("7. duration", () => {
  const wav = encodeWav(new Int16Array(16000))
  const ms = wavDurationMs(wav)
  assert.ok(Math.abs(ms - 1000) <= 1, `ms=${ms}`)
})

test("8. invalid sampleRate falls back", () => {
  for (const sr of [0, NaN, 999999]) {
    const wav = encodeWav(new Int16Array([1, 2]), { sampleRate: sr })
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    assert.equal(view.getUint32(24, true), 16000, `sr=${sr}`)
  }
})
