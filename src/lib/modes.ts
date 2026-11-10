import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type ModeName = "yolo" | "ykb"
export type Modes = Record<ModeName, boolean>
export type ModeDefaults = Partial<Modes>

/** Live mode state. The TUI writes it; the server plugin reads it on every decision. */
export const MODES_FILE = process.env.LACODE_MODES_FILE ?? join(homedir(), ".config", "lacode", "modes.json")

export const YKB_INSTRUCTION =
  "YKB MODE (You Know Better) is ON. Do not ask the user questions, request clarification, or wait for confirmation. When a decision is needed, choose the option you would recommend, state the choice briefly, and continue until the task is complete. Stop only if you are genuinely blocked by a missing credential, an unrecoverable error, or a permission that cannot be granted."

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)

export function readModes(defaults: ModeDefaults = {}): Modes {
  const fallback = { yolo: defaults.yolo === true, ykb: defaults.ykb === true }
  try {
    const raw = JSON.parse(readFileSync(MODES_FILE, "utf8")) as Record<string, unknown>
    return { yolo: bool(raw?.yolo, fallback.yolo), ykb: bool(raw?.ykb, fallback.ykb) }
  } catch {
    return fallback
  }
}

export function writeModes(modes: Modes): void {
  const path = MODES_FILE
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ yolo: modes.yolo, ykb: modes.ykb }, null, 2)}\n`)
  renameSync(tmp, path)
}

export function toggleMode(name: ModeName, defaults: ModeDefaults = {}): Modes {
  const current = readModes(defaults)
  const next = { ...current, [name]: !current[name] }
  writeModes(next)
  return next
}

/** Seed the live file from plugin options only when no toggle has ever been made. */
export function seedModes(defaults: ModeDefaults): void {
  if (existsSync(MODES_FILE)) return
  if (defaults.yolo !== true && defaults.ykb !== true) return
  writeModes({ yolo: defaults.yolo === true, ykb: defaults.ykb === true })
}

/** Pick the option the question tool recommends, falling back to the first. */
export function recommendedAnswer(question: unknown): string[] {
  const q = question as { options?: Array<{ label?: unknown; description?: unknown }> } | undefined
  const options = (Array.isArray(q?.options) ? q.options : []).filter(
    (option): option is { label: string; description?: unknown } =>
      typeof option?.label === "string" && option.label.length > 0,
  )
  if (options.length === 0) return []
  const recommended = options.find(
    (option) =>
      /\(recommended\)/i.test(option.label) ||
      (typeof option.description === "string" && /\(recommended\)/i.test(option.description)),
  )
  return [(recommended ?? options[0]).label]
}
