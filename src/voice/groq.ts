import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type GroqKeySource = "env" | "file" | "bashrc"
export type ResolvedGroqKey = { key: string; source: GroqKeySource }
export type ResolveKeyDeps = {
  env?: Record<string, string | undefined>
  home?: string
  readFile?: (path: string) => string | null
}

const DEFAULT_READ_FILE = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

export function resolveGroqKey(deps?: ResolveKeyDeps): ResolvedGroqKey | undefined {
  const env = deps?.env ?? process.env
  const home = deps?.home ?? homedir()
  const readFile = deps?.readFile ?? DEFAULT_READ_FILE
  const safeRead = (p: string): string | null => {
    try {
      return readFile(p)
    } catch {
      return null
    }
  }

  // 1. env
  const envVal = env?.GROQ_KEY
  if (typeof envVal === "string") {
    const trimmed = envVal.trim()
    if (trimmed !== "") return { key: trimmed, source: "env" }
  }

  // 2. file
  const filePath = join(home, ".config", "lacode", "voice.json")
  const fileContent = safeRead(filePath)
  if (typeof fileContent === "string") {
    let parsed: unknown
    try {
      parsed = JSON.parse(fileContent)
    } catch {
      parsed = undefined
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      const keys = ["groqKey", "GROQ_KEY", "apiKey", "groq_key"]
      for (const k of keys) {
        const v = obj[k]
        if (typeof v === "string") {
          const t = v.trim()
          if (t !== "") return { key: t, source: "file" }
        }
      }
    }
  }

  // 3. bashrc files
  const bashFiles = [join(home, ".bashrc"), join(home, ".bash_profile"), join(home, ".profile")]
  const skipPatterns = ["$(", "`", "$GROQ", "$HOME"]
  const regex = /^\s*(?:export\s+)?GROQ_KEY\s*=\s*(.+?)\s*$/
  for (const f of bashFiles) {
    const content = safeRead(f)
    if (typeof content !== "string") continue
    const lines = content.split(/\r?\n/)
    for (const line of lines) {
      const m = regex.exec(line)
      if (!m) continue
      let value = m[1]
      // determine quoted
      const isSingle = value.startsWith("'") && value.endsWith("'") && value.length >= 2
      const isDouble = value.startsWith('"') && value.endsWith('"') && value.length >= 2
      if (isSingle || isDouble) {
        value = value.slice(1, -1)
      } else {
        // unquoted: strip trailing # comment
        value = value.replace(/\s+#.*$/, "")
        value = value.trim()
      }
      // skip checks
      let skip = false
      for (const p of skipPatterns) {
        if (value.includes(p)) {
          skip = true
          break
        }
      }
      if (skip) continue
      if (value === "") continue
      return { key: value, source: "bashrc" }
    }
  }

  return undefined
}

export type TranscribeInput = {
  audio: Uint8Array
  key: string
  filename?: string
  model?: string
  language?: string
  prompt?: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export async function transcribe(input: TranscribeInput): Promise<string> {
  if (!input.audio || input.audio.length === 0) {
    throw new Error("no audio captured")
  }
  const filename = input.filename ?? "audio.wav"
  const model = input.model ?? "whisper-large-v3-turbo"
  const language = input.language ?? "en"
  const baseUrl = input.baseUrl ?? "https://api.groq.com/openai/v1"
  const timeoutMs = input.timeoutMs ?? 30000
  const fetchImpl = input.fetchImpl ?? fetch

  const form = new FormData()
  const blob = new Blob([input.audio as BlobPart], { type: "audio/wav" })
  form.append("file", blob, filename)
  form.append("model", model)
  form.append("language", language)
  form.append("temperature", "0")
  form.append("response_format", "json")
  if (input.prompt) form.append("prompt", input.prompt)

  const url = `${baseUrl}/audio/transcriptions`
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.key}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    try {
      await res.text()
    } catch {
      // ignore
    }
    throw new Error(`groq transcription failed (HTTP ${res.status})`)
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return ""
  }
  const text = (json as { text?: unknown } | null)?.text
  if (typeof text !== "string" || text.trim() === "") return ""
  return text.trim()
}
