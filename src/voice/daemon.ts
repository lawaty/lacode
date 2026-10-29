import { resolveVoiceConfig } from "./config.ts"
import { createCapture, createFrameSplitter } from "./capture.ts"
import { createVad } from "./vad.ts"
import { createWakeDetector as createPorcupineWakeDetector } from "./wake.ts"
import { createVoskWakeDetector } from "./wake-vosk.ts"
import { transcribe } from "./groq.ts"
import { encodeWav } from "./wav.ts"
import { hasSpeech, isSilenceHallucination } from "./audio.ts"
import { createVoiceServer } from "./transport.ts"
import { VOICE_PROTOCOL_VERSION } from "./protocol.ts"
import { cleanTranscript } from "./parse.ts"

export type DaemonLogLevel = "info" | "warn" | "error"
export type VoiceDaemonDeps = {
  config?: VoiceConfig
  createCapture?: typeof createCapture
  createVad?: typeof createVad
  createWakeDetector?: typeof createPorcupineWakeDetector
  transcribe?: typeof transcribe
  createServer?: typeof createVoiceServer
  log?: (level: DaemonLogLevel, message: string) => void
}
export type DaemonState = {
  armed: boolean
  phase: "idle" | "recording" | "transcribing"
  wake: boolean
  port: number | undefined
  clients: number
}
export type VoiceDaemon = {
  start(): Promise<{ port: number; wake: boolean; wakeError?: string }>
  stop(): Promise<void>
  readonly state: DaemonState
}

import type { VoiceConfig } from "./config.ts"
import type { Capture } from "./capture.ts"
import type { Vad } from "./vad.ts"
import type { WakeDetector } from "./wake.ts"
import type { VoiceServer } from "./transport.ts"

export function createVoiceDaemon(deps?: VoiceDaemonDeps): VoiceDaemon {
  const log = deps?.log ?? ((_level: DaemonLogLevel, _message: string) => {})

  const state: DaemonState = {
    armed: false,
    phase: "idle",
    wake: false,
    port: undefined,
    clients: 0,
  }

  let config: VoiceConfig
  let server: VoiceServer | undefined
  let capture: Capture | undefined
  let vad: Vad | undefined
  let wakeDetector: WakeDetector | undefined
  let splitter: ((chunk: Buffer) => void) | undefined
  let frameLength = 512

  let source: "wake" | "manual" | undefined
  let utteranceFrames: Int16Array[] = []
  let manualSamples = 0
  let stopped = false
  let inFlight: Promise<void> | undefined
  let captureCheckTimer: ReturnType<typeof setTimeout> | undefined

  const concatFrames = (frames: Int16Array[]): Int16Array => {
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

  const broadcast = (msg: any): void => {
    if (stopped) return
    try {
      server?.broadcast(msg)
    } catch {
      // ignore
    }
  }

  const broadcastState = (): void => {
    broadcast({ t: "state", armed: state.armed, phase: state.phase })
  }

  const beginRecording = (src: "wake" | "manual"): void => {
    state.phase = "recording"
    source = src
    utteranceFrames = []
    manualSamples = 0
    try {
      vad?.reset()
    } catch {
      // ignore
    }
    broadcastState()
  }

  const finish = async (audio: Int16Array, src: "wake" | "manual"): Promise<void> => {
    if (state.phase === "transcribing" || stopped) return
    if (audio.length === 0) {
      state.phase = "idle"
      source = undefined
      try {
        vad?.reset()
      } catch {
        // ignore
      }
      broadcastState()
      broadcast({ t: "error", message: "No audio captured" })
      inFlight = undefined
      return
    }
    if (!hasSpeech(audio, { sampleRate: config.sampleRate })) {
      state.phase = "idle"
      source = undefined
      try {
        vad?.reset()
      } catch {
        // ignore
      }
      broadcastState()
      broadcast({ t: "error", message: "No speech detected" })
      inFlight = undefined
      return
    }
    state.phase = "transcribing"
    source = undefined
    broadcastState()

    const run = async (): Promise<void> => {
      try {
        if (!config.groqKey) {
          broadcast({ t: "error", message: "Groq key is not configured" })
        } else {
          const transcribeFn = deps?.transcribe ?? transcribe
          const wav = encodeWav(audio, { sampleRate: config.sampleRate })
          const text = cleanTranscript(
            await transcribeFn({
              audio: wav,
              filename: "audio.wav",
              key: config.groqKey ?? "",
              model: config.model,
              language: config.language,
            }),
          )
          if (isSilenceHallucination(text, (audio.length / config.sampleRate) * 1000)) {
            broadcast({ t: "error", message: "No speech detected" })
          } else if (text) {
            broadcast({ t: "transcript", text, source: src })
          }
        }
      } catch (err: any) {
        const msg = err?.message != null ? String(err.message) : String(err)
        broadcast({ t: "error", message: msg })
      } finally {
        state.phase = "idle"
        try {
          vad?.reset()
        } catch {
          // ignore
        }
        broadcastState()
        inFlight = undefined
      }
    }

    inFlight = run()
    try {
      await inFlight
    } catch {
      // never throw
    }
  }

  const handleClientMessage = (msg: any): void => {
    if (stopped) return
    if (!msg || typeof msg !== "object") return
    switch (msg.t) {
      case "hello":
        broadcast({ t: "welcome", v: VOICE_PROTOCOL_VERSION, armed: state.armed, wake: state.wake })
        break
      case "ping":
        broadcast({ t: "pong" })
        break
      case "arm":
        state.armed = true
        broadcastState()
        break
      case "disarm":
        state.armed = false
        if (state.phase === "recording") {
          try {
            vad?.reset()
          } catch {
            // ignore
          }
           state.phase = "idle"
           source = undefined
           utteranceFrames = []
           manualSamples = 0
         }
        broadcastState()
        break
      case "toggle":
        if (state.phase === "idle") {
          beginRecording("manual")
        } else if (state.phase === "recording" && source === "manual") {
          const audio = concatFrames(utteranceFrames)
          if (audio.length === 0) {
            state.phase = "idle"
            source = undefined
            try {
              vad?.reset()
            } catch {
              // ignore
            }
            broadcastState()
            broadcast({ t: "error", message: "No audio captured" })
          } else {
            void finish(audio, "manual")
          }
        }
        break
      default:
        break
    }
  }

  const onFrame = (frame: Int16Array): void => {
    if (stopped) return
    if (state.phase === "recording") {
      if (source === "manual") {
        const sr = (config as any)?.sampleRate ?? 16000
        const limit = 120 * sr
        if (manualSamples < limit) {
          utteranceFrames.push(new Int16Array(frame))
          manualSamples += frame.length
        }
      } else if (source === "wake") {
        const events = vad ? vad.push(frame) : []
        for (const ev of events) {
          if (ev.t === "utterance") {
            void finish(ev.audio, "wake")
          }
          if (state.phase !== "recording") break
        }
      }
    } else if (state.phase === "idle" && state.armed && state.wake && wakeDetector) {
      try {
        if (wakeDetector.process(frame)) {
          beginRecording("wake")
        }
      } catch {
        // ignore
      }
    }
    // ignore transcribing
  }

  const daemon: VoiceDaemon = {
    state,
    async start() {
      config = deps?.config ?? resolveVoiceConfig()

      const createServerFn = deps?.createServer ?? createVoiceServer
      server = createServerFn({
        port: config.port,
        host: config.host,
        onMessage: (m: any) => handleClientMessage(m),
        onClientCount: (c: number) => {
          state.clients = c
          broadcastState()
        },
      })
      const resolvedPort = await server.start()
      state.port = resolvedPort

      // wake detector
      let wakeError: string | undefined
      try {
        if (deps?.createWakeDetector) {
          wakeDetector = await deps.createWakeDetector({
            accessKey: config.picovoiceKey ?? "",
            keywordPath: config.wakeWordPath ?? "",
            sensitivity: config.wakeSensitivity,
          })
        } else if (config.wakeEngine === "porcupine") {
          wakeDetector = await createPorcupineWakeDetector({
            accessKey: config.picovoiceKey ?? "",
            keywordPath: config.wakeWordPath ?? "",
            sensitivity: config.wakeSensitivity,
          })
        } else {
          wakeDetector = await createVoskWakeDetector({
            modelPath: config.voskModelPath,
            phrases: config.wakePhrases,
            sampleRate: config.sampleRate,
          })
        }
        state.wake = true
      } catch (err: any) {
        state.wake = false
        wakeError = err?.message != null ? String(err.message) : String(err)
        log("warn", wakeError)
      }

      const createVadFn = deps?.createVad ?? createVad
      vad = createVadFn({ sampleRate: config.sampleRate })

      state.armed = Boolean(config.armOnStart && state.wake)

      frameLength = wakeDetector?.frameLength ?? 512
      splitter = createFrameSplitter(frameLength, (frame: Int16Array) => onFrame(frame))

      const createCaptureFn = deps?.createCapture ?? createCapture
      capture = createCaptureFn((chunk: Buffer) => {
        try {
          splitter?.(chunk)
        } catch {
          // ignore
        }
      })
      try {
        capture.start()
      } catch {
        // ignore
      }

      // capture-not-running check
      try {
        const cap = capture
        const notRunning = !cap || !cap.running || cap.plan === undefined
        if (notRunning) {
          const detail =
            !cap || !cap.running
              ? "not running"
              : cap.plan === undefined
                ? "plan undefined"
                : cap.plan
          const detailStr =
            typeof detail === "string" ? detail : JSON.stringify(detail)
          const message = `microphone capture is not running: ${detailStr}`
          log("error", message)
          broadcast({ t: "error", message: "microphone capture is not running" })
        }
      } catch {
        // ignore
      }

      // one-shot 750ms check
      try {
        captureCheckTimer = setTimeout(() => {
          if (stopped) return
          try {
            if (!capture?.running) {
              const message = "Microphone capture stopped unexpectedly"
              log("error", message)
              broadcast({ t: "error", message })
            }
          } catch {
            // ignore
          }
        }, 750)
        captureCheckTimer?.unref?.()
      } catch {
        // ignore
      }

      return { port: state.port as number, wake: state.wake, wakeError }
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (captureCheckTimer) {
        try {
          clearTimeout(captureCheckTimer)
        } catch {
          // ignore
        }
        captureCheckTimer = undefined
      }
      try {
        capture?.stop()
      } catch {
        // ignore
      }
      try {
        wakeDetector?.release()
      } catch {
        // ignore
      }
       try {
         vad?.reset()
       } catch {
         // ignore
       }
       if (inFlight) {
         try {
           await Promise.race([inFlight, new Promise((r) => setTimeout(r, 5000))])
         } catch {
           // ignore
         }
         inFlight = undefined
       }
       try {
         await server?.stop()
       } catch {
         // ignore
       }
    },
  }

  return daemon
}
