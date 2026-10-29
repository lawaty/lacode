export type PcmStats = { samples: number; durationMs: number; rms: number; peak: number }

function readU16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8)
}

function readU32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
}

export function pcmStats(pcm: Int16Array, sampleRate: number = 16000): PcmStats {
  const samples = pcm ? pcm.length : 0
  let sumSq = 0
  let peak = 0
  if (pcm) {
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i]
      sumSq += v * v
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
    }
  }
  const rms = samples === 0 ? 0 : Math.sqrt(sumSq / samples)
  const durationMs = sampleRate > 0 ? (samples / sampleRate) * 1000 : 0
  return { samples, durationMs, rms, peak }
}

export function hasSpeech(
  pcm: Int16Array,
  options?: {
    sampleRate?: number
    minDurationMs?: number
    minRms?: number
    minPeak?: number
  },
): boolean {
  const sampleRate = options?.sampleRate ?? 16000
  const minDurationMs = options?.minDurationMs ?? 250
  const minRms = options?.minRms ?? 400
  const minPeak = options?.minPeak ?? 1500
  const stats = pcmStats(pcm, sampleRate)
  return stats.durationMs >= minDurationMs && stats.rms >= minRms && stats.peak >= minPeak
}

const SILENCE_HALLUCINATIONS: ReadonlySet<string> = new Set([
  "thank you","thanks","thanks for watching","thank you for watching",
  "thank you for watching!","you","bye","bye bye","please subscribe",
  "subscribe","amara.org","subtitles by","the end","okay","ok",
])

export function isSilenceHallucination(text: string, durationMs: number): boolean {
  const normalised = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
  return durationMs < 3000 && SILENCE_HALLUCINATIONS.has(normalised)
}

export function decodeWavPcm(
  bytes: Uint8Array,
): { pcm: Int16Array; sampleRate: number; channels: number } | undefined {
  if (!bytes || bytes.length < 12) return undefined
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return undefined
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return undefined

  let off = 12
  const total = bytes.length
  let fmtFound = false
  let audioFormat = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataSize = 0
  let dataFound = false

  while (off + 8 <= total) {
    const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
    const size = readU32(bytes, off + 4)
    const chunkStart = off + 8
    if (chunkStart > total) return undefined
    if (size > total - chunkStart) return undefined

    if (id === "fmt ") {
      if (size < 16) return undefined
      if (chunkStart + 16 > total) return undefined
      audioFormat = readU16(bytes, chunkStart)
      channels = readU16(bytes, chunkStart + 2)
      sampleRate = readU32(bytes, chunkStart + 4)
      bitsPerSample = readU16(bytes, chunkStart + 14)
      fmtFound = true
    } else if (id === "data" && !dataFound) {
      dataOffset = chunkStart
      dataSize = size
      dataFound = true
    }

    let advance = 8 + size
    if (size % 2 === 1) advance += 1
    if (advance < 8) return undefined
    off += advance
    if (off > total) return undefined
  }

  if (!fmtFound) return undefined
  if (!dataFound) return undefined
  if (audioFormat !== 1) return undefined
  if (bitsPerSample !== 16) return undefined
  if (channels < 1 || channels > 2) return undefined
  if (sampleRate <= 0) return undefined
  if (dataOffset < 0) return undefined
  if (dataOffset + dataSize > total) return undefined

  const sampleCount = Math.floor(dataSize / 2)
  const pcm = new Int16Array(sampleCount)
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, sampleCount * 2)
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = view.getInt16(i * 2, true)
  }
  return { pcm, sampleRate, channels }
}
