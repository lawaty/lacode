export type PcmFormat = { sampleRate?: number; channels?: number }

const DEFAULT_SAMPLE_RATE = 16000
const DEFAULT_CHANNELS = 1
const MIN_SAMPLE_RATE = 8000
const MAX_SAMPLE_RATE = 48000
const MIN_CHANNELS = 1
const MAX_CHANNELS = 2

function normalizeFormat(format?: PcmFormat): { sampleRate: number; channels: number } {
  let sampleRate = format?.sampleRate
  if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate < 0) {
    sampleRate = DEFAULT_SAMPLE_RATE
  }
  if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    sampleRate = DEFAULT_SAMPLE_RATE
  }
  let channels = format?.channels
  if (typeof channels !== "number" || !Number.isFinite(channels) || channels < 0) {
    channels = DEFAULT_CHANNELS
  }
  if (channels < MIN_CHANNELS || channels > MAX_CHANNELS) {
    channels = DEFAULT_CHANNELS
  }
  // round channels to integer if fractional but in range? keep as is? clamp
  channels = Math.trunc(channels)
  if (channels < MIN_CHANNELS || channels > MAX_CHANNELS) channels = DEFAULT_CHANNELS
  sampleRate = Math.trunc(sampleRate)
  return { sampleRate, channels }
}

function readU16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8)
}
function readU32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
}

export function encodeWav(pcm: Int16Array, format?: PcmFormat): Uint8Array {
  const { sampleRate, channels } = normalizeFormat(format)
  const dataSize = pcm.length * 2
  const total = 44 + dataSize
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  // RIFF
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46 // RIFF
  view.setUint32(4, 36 + dataSize, true)
  out[8] = 0x57; out[9] = 0x41; out[10] = 0x56; out[11] = 0x45 // WAVE
  out[12] = 0x66; out[13] = 0x6d; out[14] = 0x74; out[15] = 0x20 // fmt 
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // audioFormat PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true) // byteRate
  view.setUint16(32, channels * 2, true) // blockAlign
  view.setUint16(34, 16, true) // bitsPerSample
  out[36] = 0x64; out[37] = 0x61; out[38] = 0x74; out[39] = 0x61 // data
  view.setUint32(40, dataSize, true)
  // samples little-endian
  let off = 44
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(off, pcm[i], true)
    off += 2
  }
  return out
}

export function wavDurationMs(bytes: Uint8Array, format?: PcmFormat): number {
  if (!bytes || bytes.length < 44) return 0
  const dataSize = readU32(bytes, 40)
  let sampleRate: number
  let channels: number
  if (format) {
    const n = normalizeFormat(format)
    sampleRate = n.sampleRate
    channels = n.channels
  } else {
    channels = readU16(bytes, 22)
    sampleRate = readU32(bytes, 24)
    const nn = normalizeFormat({ sampleRate, channels })
    sampleRate = nn.sampleRate
    channels = nn.channels
  }
  const bytesPerSec = sampleRate * channels * 2
  if (bytesPerSec <= 0) return 0
  if (dataSize === 0) return 0
  return (dataSize / bytesPerSec) * 1000
}
