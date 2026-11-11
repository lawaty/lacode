import { readModeOptions, writeModeOptions } from "./opencode-config.ts"

export type ModeName = "yolo" | "ykb"
export type Modes = Record<ModeName, boolean>
export type ModeDefaults = Partial<Modes>

export const YKB_INSTRUCTION =
  "YKB MODE (You Know Better) is ON. Do not ask the user questions, request clarification, or wait for confirmation. When a decision is needed, choose the option you would recommend, state the choice briefly, and continue until the task is complete. Stop only if you are genuinely blocked by a missing credential, an unrecoverable error, or a permission that cannot be granted."

export function readModes(defaults: ModeDefaults = {}): Modes {
  try {
    const options = readModeOptions()
    return {
      yolo: options.yolo ?? defaults.yolo === true,
      ykb: options.ykb ?? defaults.ykb === true,
    }
  } catch {
    return { yolo: defaults.yolo === true, ykb: defaults.ykb === true }
  }
}

export function writeModes(modes: Modes): void {
  writeModeOptions({ yolo: modes.yolo, ykb: modes.ykb })
}

export function toggleMode(name: ModeName, defaults: ModeDefaults = {}): Modes {
  const current = readModes(defaults)
  const next = { ...current, [name]: !current[name] }
  writeModes(next)
  return next
}

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
