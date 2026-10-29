import { existsSync } from "node:fs"

import { WakeConfigError } from "./wake.ts"
import type { WakeDetector } from "./wake.ts"

const DEFAULT_PHRASES = ["hey la code"]
const DEFAULT_SAMPLE_RATE = 16000
const FRAME_LENGTH = 512
const COOLDOWN_SAMPLES = 16000

export type VoskWakeOptions = {
  modelPath: string
  phrases?: string[]
  sampleRate?: number
}

export type VoskWakeDeps = {
  load?: () => Promise<unknown>
  exists?: (path: string) => boolean
}

export function normalizeWakeText(text: string): string {
  if (typeof text !== "string") return ""
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function matchesWakePhrase(text: string, phrases: string[]): boolean {
  const haystack = ` ${normalizeWakeText(text)} `
  if (haystack.trim() === "") return false
  for (const phrase of phrases ?? []) {
    const needle = normalizeWakeText(phrase)
    if (needle !== "" && haystack.includes(` ${needle} `)) return true
  }
  return false
}

const readResultField = (value: unknown, field: string): string => {
  if (!value) return ""
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object"
        ? String((parsed as Record<string, unknown>)[field] ?? "")
        : ""
    } catch {
      return ""
    }
  }
  if (typeof value === "object") return String((value as Record<string, unknown>)[field] ?? "")
  return ""
}

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function errorMessage(err: unknown): string {
  return err != null && typeof err === "object" && "message" in err
    ? String((err as { message: unknown }).message)
    : String(err)
}

export async function createVoskWakeDetector(
  options: VoskWakeOptions,
  deps?: VoskWakeDeps,
): Promise<WakeDetector> {
  const rawPath = options?.modelPath
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new WakeConfigError(
      "no-model",
      "Missing Vosk model: set voskModelPath in ~/.config/lacode/voice.json.",
    )
  }

  const modelPath = rawPath.trim()
  const exists = deps?.exists ?? ((p: string) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })

  if (!exists(modelPath)) {
    throw new WakeConfigError("no-model", `Vosk model not found at resolved path: ${modelPath}`)
  }

  const phrases = Array.isArray(options?.phrases) ? options.phrases : DEFAULT_PHRASES
  const sampleRate =
    typeof options?.sampleRate === "number" && Number.isFinite(options.sampleRate) && options.sampleRate > 0
      ? options.sampleRate
      : DEFAULT_SAMPLE_RATE

  const load = deps?.load ?? (() => import("vosk"))

  let mod: any
  try {
    mod = await load()
  } catch {
    throw new WakeConfigError("no-package", "Missing vosk: run `npm i vosk`.")
  }

  const ns = mod?.default && mod?.Model == null ? mod.default : mod
  const ModelCtor = ns?.Model ?? mod?.Model
  const RecognizerCtor = ns?.Recognizer ?? mod?.Recognizer

  if (typeof ModelCtor !== "function" || typeof RecognizerCtor !== "function") {
    throw new WakeConfigError("init-failed", "Vosk Model/Recognizer constructor unavailable")
  }

  let model: any
  let recognizer: any
  try {
    model = new ModelCtor(modelPath)
    recognizer = new RecognizerCtor({ model, sampleRate, grammar: phrases })
  } catch (err: unknown) {
    try {
      recognizer?.free?.()
    } catch {
      // ignore
    }
    try {
      model?.free?.()
    } catch {
      // ignore
    }
    throw new WakeConfigError(
      "init-failed",
      `Failed to initialize Vosk wake detector: ${errorMessage(err)}`,
    )
  }

  let released = false
  let cooldown = 0

  const resetRecognizer = (): void => {
    try {
      if (typeof recognizer?.reset === "function") {
        recognizer.reset()
        return
      }
      recognizer = new RecognizerCtor({ model, sampleRate, grammar: phrases })
    } catch {
      // A failed reset must not break the detector.
    }
  }

  const detector: WakeDetector = {
    frameLength: FRAME_LENGTH,
    process(frame: Int16Array): boolean {
      const length =
        frame != null && typeof (frame as { length?: unknown }).length === "number"
          ? (frame as Int16Array).length
          : NaN

      if (cooldown > 0) {
        const dec = typeof length === "number" && Number.isFinite(length) && length > 0 ? length : FRAME_LENGTH
        cooldown = Math.max(0, cooldown - dec)
        return false
      }

      if (!(frame instanceof Int16Array) || frame.length !== FRAME_LENGTH) return false

      let isFinal = false
      try {
        const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
        isFinal = Boolean(recognizer.acceptWaveform(buffer))
      } catch {
        return false
      }

      const partialText = normalizeWakeText(
        readResultField(safeCall(() => recognizer.partialResult()), "partial"),
      )
      const finalText = isFinal
        ? normalizeWakeText(readResultField(safeCall(() => recognizer.result()), "text"))
        : ""

      if (matchesWakePhrase(partialText, phrases) || matchesWakePhrase(finalText, phrases)) {
        resetRecognizer()
        cooldown = COOLDOWN_SAMPLES
        return true
      }

      return false
    },
    release(): void {
      if (released) return
      released = true
      try {
        recognizer?.free?.()
      } catch {
        // ignore
      }
      try {
        model?.free?.()
      } catch {
        // ignore
      }
    },
  }

  return detector
}
