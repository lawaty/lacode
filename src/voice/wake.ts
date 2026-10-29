import { existsSync } from "node:fs"

export type WakeDetector = {
  readonly frameLength: number
  process(frame: Int16Array): boolean
  release(): void
}

export type WakeConfigErrorCode = "no-key" | "no-model" | "no-package" | "init-failed"

export class WakeConfigError extends Error {
  readonly code: WakeConfigErrorCode
  constructor(code: WakeConfigErrorCode, message: string) {
    super(message)
    this.name = "WakeConfigError"
    this.code = code
  }
}

export type WakeDeps = {
  load?: () => Promise<unknown>
  exists?: (path: string) => boolean
}

const BUILTIN_NAMES = [
  "alexa",
  "americano",
  "blueberry",
  "bumblebee",
  "computer",
  "grapefruit",
  "grasshopper",
  "hey google",
  "hey siri",
  "jarvis",
  "ok google",
  "picovoice",
  "porcupine",
  "terminator",
]

function isBlank(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === ""
}

function clampSensitivity(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  const base = Number.isFinite(n) ? n : 0.5
  return Math.min(1, Math.max(0, base))
}

function coerceToInt16Array(input: unknown): Int16Array | null {
  if (input instanceof Int16Array) return input
  if (input == null) return null
  if (typeof input === "number" || typeof input === "string" || typeof input === "boolean") {
    return null
  }
  try {
    if (input instanceof ArrayBuffer) {
      return new Int16Array(input)
    }
    if (ArrayBuffer.isView(input)) {
      const view = input as ArrayBufferView
      return new Int16Array(view.buffer, view.byteOffset, view.byteLength / 2)
    }
    return new Int16Array(input as ArrayLike<number>)
  } catch {
    return null
  }
}

export async function createWakeDetector(
  options: { accessKey: string; keywordPath: string; sensitivity?: number },
  deps?: WakeDeps,
): Promise<WakeDetector> {
  const accessKey = options?.accessKey
  if (isBlank(accessKey)) {
    throw new WakeConfigError(
      "no-key",
      "Missing Picovoice access key: set picovoiceKey in ~/.config/lacode/voice.json or PICOVOICE_ACCESS_KEY.",
    )
  }

  const keywordPath = options?.keywordPath
  if (isBlank(keywordPath)) {
    throw new WakeConfigError(
      "no-model",
      "Missing wake word model: download a .ppn model and set wakeWordPath.",
    )
  }

  const trimmed = String(keywordPath).trim()
  const lower = trimmed.toLowerCase()

  let resolvedPath = ""
  let isBuiltin = false
  if (BUILTIN_NAMES.includes(lower)) {
    isBuiltin = true
  }

  const exists = deps?.exists ?? ((p: string) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })

  if (isBuiltin) {
    // resolved later via module's getBuiltinKeywordPath
  } else {
    resolvedPath = trimmed
    if (!exists(resolvedPath)) {
      throw new WakeConfigError(
        "no-model",
        `Wake word model not found at resolved path: ${resolvedPath}`,
      )
    }
  }

  const load = deps?.load ?? (() => import("@picovoice/porcupine-node"))

  let mod: any
  try {
    mod = await load()
  } catch (err: any) {
    throw new WakeConfigError(
      "no-package",
      "Missing @picovoice/porcupine-node: run `npm i @picovoice/porcupine-node`.",
    )
  }

  const ns = mod?.default && mod?.Porcupine == null ? mod.default : mod
  const PorcupineCtor = ns?.Porcupine ?? mod?.Porcupine
  const getBuiltinKeywordPath = ns?.getBuiltinKeywordPath ?? mod?.getBuiltinKeywordPath

  if (isBuiltin) {
    if (typeof getBuiltinKeywordPath !== "function") {
      throw new WakeConfigError("init-failed", "getBuiltinKeywordPath unavailable")
    }
    resolvedPath = getBuiltinKeywordPath(lower)
  }

  if (typeof PorcupineCtor !== "function") {
    throw new WakeConfigError("init-failed", "Porcupine constructor unavailable")
  }

  const sensitivity = clampSensitivity(options?.sensitivity)

  let instance: any
  try {
    instance = new PorcupineCtor(accessKey as any, [resolvedPath], [sensitivity])
  } catch (err: any) {
    const msg = err?.message != null ? String(err.message) : String(err)
    throw new WakeConfigError("init-failed", `Failed to initialize wake detector: ${msg}`)
  }

  let released = false
  const detector: WakeDetector = {
    get frameLength(): number {
      return instance.frameLength
    },
    process(frame: Int16Array): boolean {
      const coerced = coerceToInt16Array(frame)
      if (coerced == null) return false
      if (coerced.length !== instance.frameLength) return false
      try {
        return instance.process(coerced) >= 0
      } catch {
        return false
      }
    },
    release(): void {
      if (released) return
      released = true
      try {
        instance.release()
      } catch {
        // ignore
      }
    },
  }

  return detector
}
