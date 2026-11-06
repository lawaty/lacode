import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export type TimelineEntry = { ts: number; text: string; through?: TimelineCursor }
export type TimelineCursor = { messageID?: string; time?: number }
export const TIMELINE_STATE_VERSION = 1

export type TimelinePersistedState = {
  version: number
  cursor?: TimelineCursor
  failures: number
  pending: boolean
  nextAttemptAt?: number
  updatedAt: number
}
export type TimelinePart = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  side?: boolean
  tool?: string
  childTitle?: string
  childOutcome?: string
  state?: {
    status?: string
    input?: unknown
    title?: string
    output?: string
    error?: unknown
    metadata?: {
      sessionId?: string
      parentSessionId?: string
      model?: { providerID?: string; modelID?: string }
      truncated?: boolean
    }
    time?: { start?: number; end?: number }
  }
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

function assertValidSessionID(sessionID: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionID)) throw new Error("invalid sessionID")
}

export function timelineFile(sessionID: string): string {
  assertValidSessionID(sessionID)
  return join(timelineDir(), sessionID + ".jsonl")
}

export function timelineStateFile(sessionID: string): string {
  assertValidSessionID(sessionID)
  return join(timelineDir(), sessionID + ".state.json")
}

function normalizeThrough(through?: TimelineCursor): TimelineCursor | undefined {
  if (!through || typeof through !== "object") return undefined
  const out: TimelineCursor = {}
  if (typeof through.messageID === "string" && through.messageID.length > 0) out.messageID = through.messageID
  if (typeof through.time === "number" && Number.isFinite(through.time)) out.time = through.time
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

function normalizePersistedState(raw: unknown): TimelinePersistedState {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const cursor = normalizeThrough(obj.cursor as TimelineCursor | undefined)
  const failures =
    typeof obj.failures === "number" && Number.isFinite(obj.failures)
      ? Math.max(0, Math.trunc(obj.failures))
      : 0
  const pending = obj.pending === true
  const nextAttemptAt =
    typeof obj.nextAttemptAt === "number" && Number.isFinite(obj.nextAttemptAt) && obj.nextAttemptAt > 0
      ? obj.nextAttemptAt
      : undefined
  const updatedAt =
    typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) ? obj.updatedAt : Date.now()
  const state: TimelinePersistedState = {
    version: TIMELINE_STATE_VERSION,
    failures,
    pending,
    updatedAt,
  }
  if (cursor) state.cursor = cursor
  if (nextAttemptAt !== undefined) state.nextAttemptAt = nextAttemptAt
  return state
}

export function readTimelineState(sessionID: string): TimelinePersistedState | undefined {
  try {
    const raw = readFileSync(timelineStateFile(sessionID), "utf8")
    return normalizePersistedState(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export function writeTimelineState(sessionID: string, state: TimelinePersistedState): void {
  const file = timelineStateFile(sessionID)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2)
  try {
    writeFileSync(tmp, JSON.stringify(state) + "\n")
    renameSync(tmp, file)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore cleanup failure
    }
    throw err
  }
}

export function removeTimelineState(sessionID: string): void {
  try {
    rmSync(timelineStateFile(sessionID), { force: true })
  } catch {
    // swallow
  }
}

export function listTimelineStates(): Array<{ sessionID: string; state: TimelinePersistedState }> {
  let names: string[]
  try {
    names = readdirSync(timelineDir())
  } catch {
    return []
  }
  const out: Array<{ sessionID: string; state: TimelinePersistedState }> = []
  for (const name of names) {
    if (!name.endsWith(".state.json")) continue
    const sessionID = name.slice(0, -".state.json".length)
    if (!/^[A-Za-z0-9_.-]+$/.test(sessionID)) continue
    const state = readTimelineState(sessionID)
    if (!state) continue
    out.push({ sessionID, state })
  }
  return out
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

export function isSideTool(tool: string, input?: unknown): boolean {
  if (tool === "timeline_reprocess" || tool === "pool_status" || tool === "pool_recheck") return true
  if (tool === "task" && input !== null && input !== undefined && typeof input === "object") {
    return (input as Record<string, unknown>).subagent_type === "context"
  }
  return false
}

export function mentionsSideMaintenance(text: string): boolean {
  return /\b(?:timeline_reprocess|pool_status|pool_recheck|reprocess-timeline|cartographer)\b/i.test(text)
}

export function isSideMaintenanceTask(input: unknown, rootDirectory: string, projectOwnsTooling: boolean): boolean {
  if (projectOwnsTooling) return false
  let description = ""
  let prompt = ""
  if (input !== null && input !== undefined && typeof input === "object") {
    const rec = input as Record<string, unknown>
    if (typeof rec.description === "string") description = rec.description
    if (typeof rec.prompt === "string") prompt = rec.prompt
  }
  const text = [description, prompt].filter((s) => typeof s === "string" && s.length > 0).join("\n")
  if (text === "") return false
  if (/\.config\/(?:opencode|lacode)|\.local\/share\/opencode/i.test(text)) return true
  if (mentionsSideMaintenance(text)) return true
  const root = rootDirectory.replace(/\\/g, "/").replace(/\/+$/, "")
  for (const match of text.matchAll(/\/(?:home|Users|root|opt|srv|mnt|workspace|workspaces)\/[^\s"'`),;]+/gi)) {
    const cleaned = match[0].replace(/[.,:;!?]+$/, "")
    if (!(cleaned.includes("/Projects/") || cleaned.includes("/projects/"))) continue
    if (cleaned === root || cleaned.startsWith(root + "/")) continue
    return true
  }
  return false
}

export function taskChildSessionId(part: TimelinePart): string | undefined {
  const sessionId = part.state?.metadata?.sessionId
  if (typeof sessionId === "string" && sessionId.length > 0) return sessionId
  const output = part.state?.output
  if (typeof output !== "string") return undefined
  const taskMatch = output.match(/task id="([A-Za-z0-9_.-]+)"/)
  if (taskMatch) return taskMatch[1]
  const sesMatch = output.match(/ses_[A-Za-z0-9]+/)
  if (sesMatch) return sesMatch[0]
  return undefined
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
      if (p.side === true) continue
      if (p.type === "text") {
        const text = collapse(p.text ?? "")
        lines.push(`[assistant] ${trunc(text, 1500)}`)
      } else if (p.type === "tool") {
        if (p.side === true) continue
        const tool = p.tool ?? ""
        if (isSideTool(tool, p.state?.input)) continue
        const status = p.state?.status
        const summary = inputSummary(p.state?.input)
        let result = summarizeToolResult(p.state)
        let suppressInput = false
        if (tool === "task" && typeof p.childTitle === "string" && collapse(p.childTitle) !== "") {
          const title = trunc(collapse(p.childTitle), 160)
          result = title
          if (typeof p.childOutcome === "string" && collapse(p.childOutcome) !== "") {
            result = `${title}: ${trunc(collapse(p.childOutcome), 600)}`
          }
          if (summary && title.startsWith(summary)) suppressInput = true
        }
        let line = `[tool] ${tool}`
        if (status) line += ` (${status})`
        const inputPart = summary && !suppressInput ? trunc(summary, 220) : ""
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

export function salvageBullets(text: string, max: number = 6): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split("\n")) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith("```")) continue
    if (line.startsWith("#")) continue
    if (line.length > 320) continue
    line = line.replace(/^([-*+•]|\d+[.)])\s*/, "").trim()
    if (!line) continue
    line = line.replace(/`/g, "").replace(/\*\*/g, "").replace(/__/g, "").trim()
    const cleaned = stripAnsiAndControls(line).trim()
    if (!cleaned || cleaned.length > 320) continue
    if (cleaned.endsWith(":")) continue
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
