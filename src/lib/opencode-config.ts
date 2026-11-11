import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"

export function globalOpencodeConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const jsonc = join(base, "opencode", "opencode.jsonc")
  return existsSync(jsonc) ? jsonc : join(base, "opencode", "opencode.json")
}

export type JsonObject = Record<string, unknown>

export type ModeOptions = { yolo?: boolean; ykb?: boolean }

export class OpenCodeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenCodeConfigError"
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function readOpencodeConfig(path = globalOpencodeConfigPath()): JsonObject {
  if (!existsSync(path)) return {}
  const text = readFileSync(path, "utf8")
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ")
    throw new OpenCodeConfigError(`Failed to parse ${path}: ${detail}`)
  }
  if (!isPlainObject(parsed)) {
    throw new OpenCodeConfigError(`Config root must be an object: ${path}`)
  }
  return parsed
}

export type LacodePluginEntry = { index: number; name: string; options: JsonObject | undefined }

function pluginName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

function matchesLacode(name: string): boolean {
  if (name === "@lawaty/lacode") return true
  const segments = name.split(/[\\/]/)
  return segments.some((s) => s.toLowerCase() === "lacode")
}

export function findLacodePlugin(config: JsonObject): LacodePluginEntry | undefined {
  const plugins = config.plugin
  if (!Array.isArray(plugins)) return undefined
  for (let index = 0; index < plugins.length; index++) {
    const entry = plugins[index]
    const name = pluginName(entry)
    if (!name || !matchesLacode(name)) continue
    const options = Array.isArray(entry) && isPlainObject(entry[1]) ? (entry[1] as JsonObject) : undefined
    return { index, name, options }
  }
  return undefined
}

export function readModeOptions(config = readOpencodeConfig()): ModeOptions {
  const entry = findLacodePlugin(config)
  const options = entry?.options
  const yolo = typeof options?.yolo === "boolean" ? options.yolo : undefined
  const ykb = typeof options?.ykb === "boolean" ? options.ykb : undefined
  return { yolo, ykb }
}

export function writeModeOptions(patch: ModeOptions, path = globalOpencodeConfigPath()): void {
  if (!existsSync(path)) {
    throw new OpenCodeConfigError(`Cannot write mode options: config does not exist: ${path}`)
  }
  let text = readFileSync(path, "utf8")
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length > 0) {
    const detail = errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join(", ")
    throw new OpenCodeConfigError(`Failed to parse ${path}: ${detail}`)
  }
  if (!isPlainObject(parsed)) {
    throw new OpenCodeConfigError(`Config root must be an object: ${path}`)
  }
  const entry = findLacodePlugin(parsed)
  if (!entry) {
    throw new OpenCodeConfigError(`lacode plugin entry not found in ${path}`)
  }

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  const pluginEntry = (parsed.plugin as unknown[])[entry.index]

  if (typeof pluginEntry === "string") {
    const obj: JsonObject = {}
    if (patch.yolo !== undefined) obj.yolo = patch.yolo
    if (patch.ykb !== undefined) obj.ykb = patch.ykb
    const edits = modify(text, ["plugin", entry.index], [entry.name, obj], { formattingOptions })
    text = applyEdits(text, edits)
  } else if (Array.isArray(pluginEntry) && !isPlainObject(pluginEntry[1])) {
    const obj: JsonObject = {}
    if (patch.yolo !== undefined) obj.yolo = patch.yolo
    if (patch.ykb !== undefined) obj.ykb = patch.ykb
    const edits = modify(text, ["plugin", entry.index, 1], obj, { formattingOptions })
    text = applyEdits(text, edits)
  } else {
    const keys: (keyof ModeOptions)[] = ["yolo", "ykb"]
    for (const key of keys) {
      const value = patch[key]
      if (value === undefined) continue
      const edits = modify(text, ["plugin", entry.index, 1, key], value, { formattingOptions })
      text = applyEdits(text, edits)
    }
  }

  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}
