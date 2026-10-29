import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync } from "node:fs"
import { resolveGroqKey } from "./groq.ts"

export type VoiceConfig = {
  groqKey?: string
  groqSource?: "env" | "file" | "bashrc"
  picovoiceKey?: string
  wakeWordPath?: string
  wakeSensitivity: number
  wakeEngine: "vosk" | "porcupine"
  voskModelPath: string
  wakePhrases: string[]
  port: number
  host: string
  model: string
  language: string
  armOnStart: boolean
  sampleRate: number
  input?: string
}

export type VoiceConfigDeps = {
  env?: Record<string, string | undefined>
  home?: string
  readFile?: (path: string) => string | null
}

export type VoiceDataDeps = {
  env?: Record<string, string | undefined>
  home?: string
}

const DEFAULT_WAKE_PHRASES = ["hey la code"]

export const VOICE_DATA_DIR: (deps?: VoiceDataDeps) => string = (deps?: VoiceDataDeps) => {
  const env = deps?.env ?? process.env
  const home = deps?.home ?? homedir()
  const xdg = env.XDG_DATA_HOME
  if (typeof xdg === "string" && xdg.trim() !== "") {
    return join(xdg.trim(), "lacode", "voice")
  }
  return join(home, ".local", "share", "lacode", "voice")
}

const DEFAULT_READ_FILE = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

export const VOICE_CONFIG_PATH: (home?: string) => string = (home?: string) =>
  join(home ?? homedir(), ".config", "lacode", "voice.json")

function safeRead(readFile: (p: string) => string | null, p: string): string | null {
  try {
    return readFile(p)
  } catch {
    return null
  }
}

function envGet(env: Record<string, string | undefined> | undefined, names: string[]): string | undefined {
  if (!env) return undefined
  for (const n of names) {
    const v = env[n]
    if (typeof v === "string") return v
  }
  return undefined
}

function toInt(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isInteger(raw) ? raw : undefined
  }
  if (typeof raw === "string") {
    const t = raw.trim()
    if (t === "" || !/^-?\d+$/.test(t)) return undefined
    const n = Number(t)
    return Number.isInteger(n) ? n : undefined
  }
  return undefined
}

function toFloat(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined
  }
  if (typeof raw === "string") {
    const t = raw.trim()
    if (t === "") return undefined
    const n = Number(t)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function expandHome(value: string, home: string): string {
  const v = value.trim()
  if (v === "~") return home
  if (v.startsWith("~/")) return join(home, v.slice(2))
  return v
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === "127.0.0.1" || h === "::1" || h === "localhost"
}

function normalizeEngine(raw: unknown): "vosk" | "porcupine" | undefined {
  if (typeof raw !== "string") return undefined
  const v = raw.trim().toLowerCase()
  if (v === "vosk" || v === "porcupine") return v
  return undefined
}

function normalizePhrases(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    const v = entry.trim()
    if (v !== "") out.push(v)
  }
  return out.length > 0 ? out : undefined
}

function parsePhraseEnv(raw: string): string[] | undefined {
  return normalizePhrases(raw.split(","))
}

const PORT_ENV = ["LACODE_VOICE_PORT", "LACODE_PORT", "VOICE_PORT"]
const SENS_ENV = ["LACODE_WAKE_SENSITIVITY", "LACODE_VOICE_SENSITIVITY", "VOICE_SENSITIVITY", "LACODE_SENSITIVITY"]
const MODEL_ENV = ["LACODE_VOICE_MODEL", "LACODE_MODEL", "VOICE_MODEL", "LACODE_VOICE_TRANSCRIPTION_MODEL"]
const LANG_ENV = ["LACODE_VOICE_LANGUAGE", "LACODE_LANGUAGE", "LACODE_VOICE_LANG", "VOICE_LANGUAGE"]
const PK_ENV = ["PICOVOICE_ACCESS_KEY", "PICOVOICE_KEY", "LACODE_PICOVOICE_KEY"]
const WW_ENV = ["LACODE_WAKE_WORD", "LACODE_VOICE_WAKE_WORD", "LACODE_WAKE_WORD_PATH", "LACODE_VOICE_WAKEWORD"]
const INPUT_ENV = ["LACODE_VOICE_INPUT", "LACODE_INPUT", "VOICE_INPUT"]
const SR_ENV = ["LACODE_VOICE_SAMPLE_RATE", "LACODE_SAMPLE_RATE"]
const HOST_ENV = ["LACODE_VOICE_HOST", "LACODE_HOST"]

export function resolveVoiceConfig(deps?: VoiceConfigDeps): VoiceConfig {
  const env = deps?.env ?? process.env
  const home = deps?.home ?? homedir()
  const defaults: VoiceConfig = {
    wakeSensitivity: 0.5,
    wakeEngine: "vosk",
    voskModelPath: join(VOICE_DATA_DIR({ env, home }), "vosk-model-small-en-us-0.15"),
    wakePhrases: [...DEFAULT_WAKE_PHRASES],
    port: 8765,
    host: "127.0.0.1",
    model: "whisper-large-v3-turbo",
    language: "en",
    armOnStart: true,
    sampleRate: 16000,
  }

  try {
    const readFile = deps?.readFile ?? DEFAULT_READ_FILE

    const filePath = VOICE_CONFIG_PATH(home)
    const content = safeRead(readFile, filePath)

    let json: Record<string, unknown> | null = null
    if (typeof content === "string") {
      try {
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>
        }
      } catch {
        json = null
      }
    }

    const j = json ?? {}

    // groqKey via resolveGroqKey
    let groqKey: string | undefined
    let groqSource: VoiceConfig["groqSource"] | undefined
    try {
      const resolved = resolveGroqKey({ env, home, readFile })
      if (resolved) {
        groqKey = resolved.key
        groqSource = resolved.source
      }
    } catch {
      groqKey = undefined
      groqSource = undefined
    }

    // picovoiceKey
    let picovoiceKey: string | undefined
    const pkEnv = envGet(env, PK_ENV)
    if (typeof pkEnv === "string" && pkEnv.trim() !== "") {
      picovoiceKey = pkEnv.trim()
    } else {
      for (const k of ["picovoiceKey", "picovoice_access_key", "picovoiceAccessKey"]) {
        const v = j[k]
        if (typeof v === "string" && v.trim() !== "") {
          picovoiceKey = v.trim()
          break
        }
      }
    }

    // wakeWordPath
    let wakeWordPath: string | undefined
    const wwEnv = envGet(env, WW_ENV)
    if (typeof wwEnv === "string" && wwEnv.trim() !== "") {
      wakeWordPath = expandHome(wwEnv, home)
    } else {
      for (const k of ["wakeWordPath", "wake_word_path", "wakeWord"]) {
        const v = j[k]
        if (typeof v === "string" && v.trim() !== "") {
          wakeWordPath = expandHome(v, home)
          break
        }
      }
    }

    // wakeSensitivity
    const sensEnv = envGet(env, SENS_ENV)
    const sensRaw = sensEnv !== undefined ? sensEnv : j.wakeSensitivity ?? j.wake_sensitivity
    const sensNum = toFloat(sensRaw)
    let wakeSensitivity = 0.5
    if (sensNum !== undefined) {
      wakeSensitivity = Math.min(1, Math.max(0, sensNum))
    }

    // wakeEngine
    let wakeEngine: VoiceConfig["wakeEngine"] = "vosk"
    const engineEnv = env.LACODE_WAKE_ENGINE
    if (typeof engineEnv === "string" && engineEnv.trim() !== "") {
      wakeEngine = normalizeEngine(engineEnv) ?? "vosk"
    } else {
      wakeEngine = normalizeEngine(j.wakeEngine) ?? "vosk"
    }

    // voskModelPath
    let voskModelPath = join(VOICE_DATA_DIR({ env, home }), "vosk-model-small-en-us-0.15")
    const voskEnv = env.LACODE_VOSK_MODEL
    if (typeof voskEnv === "string" && voskEnv.trim() !== "") {
      voskModelPath = expandHome(voskEnv, home)
    } else {
      const vv = j.voskModelPath
      if (typeof vv === "string" && vv.trim() !== "") {
        voskModelPath = expandHome(vv, home)
      }
    }

    // wakePhrases
    let wakePhrases = [...DEFAULT_WAKE_PHRASES]
    const phraseEnv = env.LACODE_WAKE_PHRASES
    const envPhrases = typeof phraseEnv === "string" ? parsePhraseEnv(phraseEnv) : undefined
    if (envPhrases) {
      wakePhrases = envPhrases
    } else {
      const jsonPhrases = normalizePhrases(j.wakePhrases)
      if (jsonPhrases) wakePhrases = jsonPhrases
    }

    // port
    const portEnv = envGet(env, PORT_ENV)
    const portRaw = portEnv !== undefined ? portEnv : j.port
    const portNum = toInt(portRaw)
    let port = 8765
    if (portNum !== undefined && portNum >= 1 && portNum <= 65535) {
      port = portNum
    }

    // host
    const allowNonLocal =
      (typeof env.LACODE_VOICE_ALLOW_NONLOCAL === "string" &&
        ["1", "true", "True", "TRUE"].includes(env.LACODE_VOICE_ALLOW_NONLOCAL.trim())) ||
      j.allowNonLocal === true
    let host = "127.0.0.1"
    const hostEnv = envGet(env, HOST_ENV)
    if (typeof hostEnv === "string" && hostEnv.trim() !== "") {
      const h = hostEnv.trim()
      if (isLoopbackHost(h) || allowNonLocal) {
        host = h
      } else {
        host = "127.0.0.1"
      }
    } else {
      const hv = j.host
      if (typeof hv === "string" && hv.trim() !== "") {
        const h = hv.trim()
        if (isLoopbackHost(h) || allowNonLocal) {
          host = h
        } else {
          host = "127.0.0.1"
        }
      }
    }

    // model
    let model = "whisper-large-v3-turbo"
    const modelEnv = envGet(env, MODEL_ENV)
    if (typeof modelEnv === "string" && modelEnv.trim() !== "") {
      model = modelEnv.trim()
    } else {
      const mv = j.model
      if (typeof mv === "string" && mv.trim() !== "") {
        model = mv.trim()
      }
    }

    // language
    let language = "en"
    const langEnv = envGet(env, LANG_ENV)
    if (typeof langEnv === "string" && langEnv.trim() !== "") {
      language = langEnv.trim()
    } else {
      const lv = j.language
      if (typeof lv === "string" && lv.trim() !== "") {
        language = lv.trim()
      }
    }

    // armOnStart
    let armOnStart = true
    const jsonArm = j.armOnStart ?? j.arm_on_start
    if (typeof jsonArm === "boolean") {
      armOnStart = jsonArm
    }
    const noArm = env.LACODE_VOICE_NO_ARM
    if (noArm === "1" || noArm === "true" || noArm === "True" || noArm === "TRUE") {
      armOnStart = false
    }

    // sampleRate
    const srEnv = envGet(env, SR_ENV)
    const srRaw = srEnv !== undefined ? srEnv : (j.sampleRate ?? j.sample_rate)
    const srNum = toInt(srRaw)
    let sampleRate = 16000
    if (srNum !== undefined && srNum > 0) {
      sampleRate = srNum
    }

    // input
    let input: string | undefined
    const inputEnv = envGet(env, INPUT_ENV)
    if (typeof inputEnv === "string" && inputEnv.trim() !== "") {
      input = inputEnv.trim()
    } else {
      const iv = j.input
      if (typeof iv === "string" && iv.trim() !== "") {
        input = iv.trim()
      }
    }

    return {
      groqKey,
      groqSource,
      picovoiceKey,
      wakeWordPath,
      wakeSensitivity,
      wakeEngine,
      voskModelPath,
      wakePhrases,
      port,
      host,
      model,
      language,
      armOnStart,
      sampleRate,
      input,
    }
  } catch {
    return { ...defaults }
  }
}
