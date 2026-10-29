import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export type TimelineEntry = { ts: number; text: string; through?: TimelineCursor }
export type TimelineCursor = { messageID?: string; time?: number }
export type TimelinePart = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  tool?: string
  state?: { status?: string; input?: unknown; title?: string; output?: string; error?: unknown }
}
export type TimelineMessage = {
  info: {
    id: string
    role: string
    time?: { created?: number }
    model?: { providerID: string; modelID: string }
    providerID?: string
    modelID?: string
    title?: string
  }
  parts: TimelinePart[]
}

export function timelineDir(): string {
  const env = process.env.LACODE_TIMELINE_DIR
  if (env) return resolve(env)
  return join(homedir(), ".local/share/opencode/lacode/timeline")
}

export function timelineFile(sessionID: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionID)) throw new Error("invalid sessionID")
  return join(timelineDir(), sessionID + ".jsonl")
}

function normalizeThrough(through?: TimelineCursor): TimelineCursor | undefined {
  if (!through || typeof through !== "object") return undefined
  const out: TimelineCursor = {}
  if (typeof through.messageID === "string") out.messageID = through.messageID
  if (typeof through.time === "number") out.time = through.time
  if (out.messageID === undefined && out.time === undefined) return undefined
  return out
}

export function appendEntriesAt(file: string, texts: string[], now?: number, through?: TimelineCursor): number {
  mkdirSync(dirname(file), { recursive: true })
  const cleaned: string[] = []
  for (const t of texts) {
    if (typeof t !== "string" || t.length === 0) continue
    cleaned.push(t.slice(0, 320))
  }
  let recent: TimelineEntry[] = []
  try {
    recent = readEntriesAt(file, 20)
  } catch {
    recent = []
  }
  const recentSet = new Set(recent.map((e) => e.text.toLowerCase()))
  const batchSeen = new Set<string>()
  const toAppend: string[] = []
  for (const t of cleaned) {
    const key = t.toLowerCase()
    if (recentSet.has(key)) continue
    if (batchSeen.has(key)) continue
    batchSeen.add(key)
    toAppend.push(t)
  }
  const validThrough = normalizeThrough(through)
  let count = 0
  for (const t of toAppend) {
    const ts = now ?? Date.now()
    const line: { ts: number; text: string; through?: TimelineCursor } = { ts, text: t }
    if (validThrough) line.through = validThrough
    appendFileSync(file, JSON.stringify(line) + "\n")
    count++
  }
  return count
}

export function readEntriesAt(file: string, limit?: number): TimelineEntry[] {
  let raw = ""
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const entries: TimelineEntry[] = []
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj.ts === "number" && typeof obj.text === "string") {
        const entry: TimelineEntry = { ts: obj.ts, text: obj.text }
        const t = normalizeThrough(obj.through)
        if (t) entry.through = t
        entries.push(entry)
      }
    } catch {
      // skip malformed
    }
  }
  if (limit != null && limit <= 0) return []
  const lim = limit == null ? 50 : limit
  return entries.slice(-lim)
}

export function appendEntries(sessionID: string, texts: string[], now?: number, through?: TimelineCursor): number {
  return appendEntriesAt(timelineFile(sessionID), texts, now, through)
}

export function readEntries(sessionID: string, limit?: number): TimelineEntry[] {
  return readEntriesAt(timelineFile(sessionID), limit)
}

export function removeEntries(sessionID: string): void {
  try {
    rmSync(timelineFile(sessionID), { force: true })
  } catch {
    // swallow
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

function stripAnsiAndControls(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code === 0x1b) {
      // CSI
      if (i + 1 < s.length && s[i + 1] === "[") {
        i += 2
        while (i < s.length) {
          const c = s.charCodeAt(i)
          // final byte 0x40-0x7E
          if (c >= 0x40 && c <= 0x7e) {
            break
          }
          i++
        }
        continue
      }
      // OSC
      if (i + 1 < s.length && s[i + 1] === "]") {
        i += 2
        while (i < s.length) {
          const c = s.charCodeAt(i)
          if (c === 0x07) break // BEL
          if (c === 0x1b && i + 1 < s.length && s[i + 1] === "\\") {
            i += 1
            break
          }
          i++
        }
        continue
      }
      // other escape sequences: skip one char
      if (i + 1 < s.length) {
        i += 1
      }
      continue
    }
    if (code === 0x09 || code === 0x0a) {
      out += s[i]
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      continue
    }
    out += s[i]
  }
  return out
}

function inputSummary(input: unknown): string {
  if (input === null || input === undefined) return ""
  if (typeof input !== "object") {
    try {
      return trunc(collapse(JSON.stringify(input)), 160)
    } catch {
      return ""
    }
  }
  const rec = input as Record<string, unknown>
  const keys = ["filePath", "path", "command", "description", "pattern", "query", "url", "name", "title"]
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(rec, k) && rec[k] != null) {
      const v = rec[k]
      const s = typeof v === "string" ? v : JSON.stringify(v)
      return trunc(collapse(s), 160)
    }
  }
  try {
    return trunc(collapse(JSON.stringify(rec)), 160)
  } catch {
    return ""
  }
}

function summarizeToolResult(state: TimelinePart["state"]): string {
  if (!state) return ""
  const err = state.error
  if (typeof err === "string") {
    if (err.trim() === "") return ""
    return `error: ${trunc(err, 180)}`
  }
  if (err && typeof err === "object") {
    try {
      const s = JSON.stringify(err)
      if (typeof s === "string" && s.trim() !== "") {
        return trunc(s, 180)
      }
    } catch {
      // ignore
    }
    return ""
  }
  if (typeof state.output === "string") {
    for (const raw of state.output.split("\n")) {
      const line = raw.trim()
      if (line.length > 0) {
        return trunc(line, 180)
      }
    }
  }
  if (typeof state.title === "string" && state.title.trim() !== "") {
    return trunc(state.title, 180)
  }
  return ""
}

function renderMessage(m: TimelineMessage): string[] {
  const role = m.info.role
  const lines: string[] = []
  if (role === "user") {
    for (const p of m.parts) {
      if (p.type === "text" && !p.synthetic && !p.ignored) {
        if ((p.text ?? "").includes("timeline_reprocess")) continue
        const text = collapse(p.text ?? "")
        lines.push(`[user] ${trunc(text, 2000)}`)
      }
    }
  } else if (role === "assistant") {
    for (const p of m.parts) {
      if (p.type === "text") {
        const text = collapse(p.text ?? "")
        lines.push(`[assistant] ${trunc(text, 1500)}`)
      } else if (p.type === "tool") {
        const tool = p.tool ?? ""
        if (tool === "timeline_reprocess") continue
        const status = p.state?.status
        const summary = inputSummary(p.state?.input)
        const result = summarizeToolResult(p.state)
        let line = `[tool] ${tool}`
        if (status) line += ` (${status})`
        const inputPart = summary ? trunc(summary, 220) : ""
        let rest = ""
        if (inputPart) rest += ` ${inputPart}`
        if (result) rest += ` -> ${result}`
        // collapse double space if input empty: " ->" stays
        line += rest
        lines.push(line)
      }
    }
  }
  return lines
}

export function buildExcerpt(
  messages: TimelineMessage[],
  cursor?: TimelineCursor,
  budget: number = 8000,
): {
  text: string
  next?: TimelineCursor
  count: number
  model?: { providerID: string; modelID: string }
} {
  let start = 0
  if (cursor?.messageID) {
    const idx = messages.findIndex((m) => m.info.id === cursor.messageID)
    if (idx >= 0) {
      start = idx + 1
    } else if (cursor.time != null) {
      const i = messages.findIndex((m) => (m.info.time?.created ?? -Infinity) > cursor.time!)
      start = i < 0 ? messages.length : i
    }
  } else if (cursor?.time != null) {
    const i = messages.findIndex((m) => (m.info.time?.created ?? -Infinity) > cursor.time!)
    start = i < 0 ? messages.length : i
  }

  const outLines: string[] = []
  const included: TimelineMessage[] = []
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]
    const msgLines = renderMessage(m)
    if (msgLines.length === 0) continue
    const candidateLines = outLines.length === 0 ? [...msgLines] : [...outLines, ...msgLines]
    const candidateText = candidateLines.join("\n")
    if (included.length > 0 && candidateText.length > budget) {
      break
    }
    if (included.length === 0 && candidateText.length > budget) {
      const block = msgLines.join("\n")
      outLines.push(block.slice(0, budget))
      included.push(m)
      break
    }
    outLines.push(...msgLines)
    included.push(m)
  }

  let model: { providerID: string; modelID: string } | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role !== "user") continue
    if (info.model) {
      model = { providerID: info.model.providerID, modelID: info.model.modelID }
      break
    }
    if (info.providerID && info.modelID) {
      model = { providerID: info.providerID, modelID: info.modelID }
      break
    }
  }

  const lastIncluded = included[included.length - 1]
  const next = lastIncluded
    ? { messageID: lastIncluded.info.id, time: lastIncluded.info.time?.created }
    : undefined

  return {
    text: outLines.join("\n"),
    next,
    count: included.length,
    model,
  }
}

export function parseBullets(text: string, max: number = 6): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("```")) continue
    if (line.length > 320) continue
    const m = line.match(/^([-*•]|\d+[.)])\s+(.*)$/)
    if (!m) continue
    const stripped = m[2].trim().replace(/`/g, "").replace(/\*\*/g, "").trim()
    if (!stripped) continue
    const cleaned = stripAnsiAndControls(stripped).trim()
    if (!cleaned) continue
    if (cleaned.length > 320) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(cleaned)
    if (result.length >= max) break
  }
  return result
}

export function isInternalTitle(title?: string): boolean {
  const t = (title ?? "").trim()
  return t.startsWith("context (auto") || t.startsWith("timeline (auto") || t.startsWith("pool probe")
}
