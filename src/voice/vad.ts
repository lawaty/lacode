export type VadConfig = {
  sampleRate?: number
  speechRms?: number
  noiseMultiplier?: number
  endSilenceMs?: number
  minUtteranceMs?: number
  maxUtteranceMs?: number
  preRollMs?: number
}

export type VadEvent =
  | { t: "speech-start" }
  | { t: "utterance"; audio: Int16Array }

export type Vad = {
  push(frame: Int16Array): VadEvent[]
  reset(): void
  readonly speaking: boolean
}

function rmsOf(frame: Int16Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]
    sum += v * v
  }
  return Math.sqrt(sum / frame.length)
}

function concatFrames(frames: Int16Array[]): Int16Array {
  let total = 0
  for (const f of frames) total += f.length
  const out = new Int16Array(total)
  let off = 0
  for (const f of frames) {
    out.set(f, off)
    off += f.length
  }
  return out
}

export function createVad(config?: VadConfig): Vad {
  const sampleRate = config?.sampleRate ?? 16000
  const speechRms = config?.speechRms ?? 500
  const noiseMultiplier = config?.noiseMultiplier ?? 2.5
  const endSilenceMs = config?.endSilenceMs ?? 800
  const minUtteranceMs = config?.minUtteranceMs ?? 250
  const maxUtteranceMs = config?.maxUtteranceMs ?? 30000
  const preRollMs = config?.preRollMs ?? 300

  const preRollSamples = Math.max(0, Math.round((preRollMs / 1000) * sampleRate))

  let noiseFloor = 200
  const alpha = 0.05

  let speaking = false
  let speechFrameCount = 0

  const ring: Int16Array[] = []
  let ringSamples = 0

  const accumulated: Int16Array[] = []
  let accumulatedSamples = 0
  const trailingSilence: Int16Array[] = []
  let silenceMs = 0

  function frameMs(n: number): number {
    return (n / sampleRate) * 1000
  }

  function resetState(): void {
    speaking = false
    speechFrameCount = 0
    ring.length = 0
    ringSamples = 0
    accumulated.length = 0
    accumulatedSamples = 0
    trailingSilence.length = 0
    silenceMs = 0
    noiseFloor = 200
  }

  function trimRing(): void {
    while (ring.length > 1 && ringSamples > preRollSamples) {
      const oldest = ring.shift() as Int16Array
      ringSamples -= oldest.length
    }
  }

  function finalizeUtterance(emit: (e: VadEvent) => void, removeTrailing: boolean): void {
    let frames = accumulated.slice()
    if (removeTrailing && trailingSilence.length > 0) {
      const removeCount = trailingSilence.length
      frames = frames.slice(0, frames.length - removeCount)
    }
    const audio = concatFrames(frames)
    const durMs = (audio.length / sampleRate) * 1000
    if (durMs >= minUtteranceMs) {
      emit({ t: "utterance", audio })
    }
    accumulated.length = 0
    accumulatedSamples = 0
    trailingSilence.length = 0
    silenceMs = 0
  }

  const vad: Vad = {
    get speaking(): boolean {
      return speaking
    },
    push(frame: Int16Array): VadEvent[] {
      const events: VadEvent[] = []
      const emit = (e: VadEvent) => events.push(e)

      ring.push(frame)
      ringSamples += frame.length
      trimRing()

      const rms = rmsOf(frame)
      const threshold = Math.max(speechRms, noiseFloor * noiseMultiplier)
      const isSpeech = rms > threshold

      const durMs = frameMs(frame.length)

      if (!speaking) {
        if (isSpeech) {
          speechFrameCount++
          if (speechFrameCount >= 3) {
            speaking = true
            accumulated.length = 0
            accumulatedSamples = 0
            for (const f of ring) {
              accumulated.push(f)
              accumulatedSamples += f.length
            }
            trailingSilence.length = 0
            silenceMs = 0
            emit({ t: "speech-start" })
          }
        } else {
          speechFrameCount = 0
          noiseFloor = noiseFloor + alpha * (rms - noiseFloor)
        }
      } else {
        if (isSpeech) {
          accumulated.push(frame)
          accumulatedSamples += frame.length
          trailingSilence.length = 0
          silenceMs = 0
        } else {
          accumulated.push(frame)
          accumulatedSamples += frame.length
          trailingSilence.push(frame)
          silenceMs += durMs

          if (silenceMs >= endSilenceMs) {
            finalizeUtterance(emit, true)
            speaking = false
            speechFrameCount = 0
          }
        }

        if (speaking) {
          const accDurMs = (accumulatedSamples / sampleRate) * 1000
          if (accDurMs >= maxUtteranceMs) {
            finalizeUtterance(emit, false)
            silenceMs = 0
            trailingSilence.length = 0
          }
        }
      }

      return events
    },
    reset(): void {
      resetState()
    },
  }

  return vad
}
