export const VOICE_PROTOCOL_VERSION = 1

export type ClientMessage =
  | { t: "hello"; v: number; client?: string }
  | { t: "ping" }
  | { t: "toggle" }
  | { t: "arm" }
  | { t: "disarm" }
  | { t: "claim" }

export type DaemonMessage =
  | { t: "welcome"; v: number; armed: boolean; wake: boolean }
  | { t: "state"; armed: boolean; phase: "idle" | "recording" | "transcribing" }
  | { t: "transcript"; text: string; source: "wake" | "manual" }
  | { t: "error"; message: string }
  | { t: "pong" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toText(line: string | Buffer): string {
  return typeof line === "string" ? line : line.toString("utf8")
}

function normalizeLine(line: string | Buffer): string {
  let s = toText(line)
  if (s.endsWith("\n")) s = s.slice(0, -1)
  if (s.endsWith("\r")) s = s.slice(0, -1)
  return s
}

export function encodeMessage(message: ClientMessage | DaemonMessage): string {
  return JSON.stringify(message) + "\n"
}

export function decodeClientMessage(line: string | Buffer): ClientMessage | undefined {
  const text = normalizeLine(line)
  if (text.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const t = parsed.t
  switch (t) {
    case "hello": {
      if (typeof parsed.v !== "number") return undefined
      if (parsed.client !== undefined && typeof parsed.client !== "string") return undefined
      return { t: "hello", v: parsed.v, client: parsed.client as string | undefined }
    }
    case "ping":
      return { t: "ping" }
    case "toggle":
      return { t: "toggle" }
    case "arm":
      return { t: "arm" }
    case "disarm":
      return { t: "disarm" }
    case "claim":
      return { t: "claim" }
    default:
      return undefined
  }
}

export function decodeDaemonMessage(line: string | Buffer): DaemonMessage | undefined {
  const text = normalizeLine(line)
  if (text.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const t = parsed.t
  switch (t) {
    case "welcome": {
      if (typeof parsed.v !== "number") return undefined
      if (typeof parsed.armed !== "boolean") return undefined
      if (typeof parsed.wake !== "boolean") return undefined
      return { t: "welcome", v: parsed.v, armed: parsed.armed, wake: parsed.wake }
    }
    case "state": {
      if (typeof parsed.armed !== "boolean") return undefined
      if (parsed.phase !== "idle" && parsed.phase !== "recording" && parsed.phase !== "transcribing") return undefined
      return { t: "state", armed: parsed.armed, phase: parsed.phase as "idle" | "recording" | "transcribing" }
    }
    case "transcript": {
      if (typeof parsed.text !== "string") return undefined
      if (parsed.source !== "wake" && parsed.source !== "manual") return undefined
      return { t: "transcript", text: parsed.text, source: parsed.source as "wake" | "manual" }
    }
    case "error": {
      if (typeof parsed.message !== "string") return undefined
      return { t: "error", message: parsed.message }
    }
    case "pong":
      return { t: "pong" }
    default:
      return undefined
  }
}

export function createLineDecoder<T>(decode: (line: string) => T | undefined): (chunk: Buffer | string) => T[] {
  const MAX_LINE = 64 * 1024
  let buffer = ""
  return (chunk: Buffer | string): T[] => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    buffer += text
    const out: T[] = []
    // Process complete lines.
    while (true) {
      const idx = buffer.indexOf("\n")
      if (idx === -1) break
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.length > MAX_LINE) {
        // Drop by resetting the buffer.
        buffer = ""
        break
      }
      const msg = decode(line)
      if (msg !== undefined) out.push(msg)
    }
    // If the remaining partial buffer is too long, reset (drop).
    if (buffer.length > MAX_LINE) {
      buffer = ""
    }
    return out
  }
}
