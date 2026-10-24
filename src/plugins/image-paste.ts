import type { FilePart } from "@opencode-ai/sdk"
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { createHash, randomUUID } from "node:crypto"
import { globSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { readClipboardImage } from "../lib/clipboard.ts"

export type ImagePasteOptions = {
  enabled?: boolean
  maxBytes?: number
  maxImages?: number
  dir?: string
}

export type ImagePasteDeps = {
  readClipboard?: () => Promise<Buffer | null>
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

function resolveMaxBytes(opts: ImagePasteOptions): number {
  if (typeof opts.maxBytes === "number" && Number.isFinite(opts.maxBytes)) return opts.maxBytes
  const parsed = Number.parseInt(process.env.LACODE_IMAGE_MAX_BYTES ?? "", 10)
  return Number.isNaN(parsed) ? DEFAULT_MAX_BYTES : parsed
}

const DEFAULT_MAX_IMAGES = 10
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

function resolveMaxImages(opts: ImagePasteOptions): number {
  if (typeof opts.maxImages === "number" && Number.isFinite(opts.maxImages)) return opts.maxImages
  const parsed = Number.parseInt(process.env.LACODE_IMAGE_MAX_IMAGES ?? "", 10)
  return Number.isNaN(parsed) ? DEFAULT_MAX_IMAGES : parsed
}

type ImageKind = {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  ext: "png" | "jpg" | "gif" | "webp"
}

/** Sniff the image type from the leading bytes; null means unrecognized. */
function detectImageKind(bytes: Buffer): ImageKind | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" }
  }
  if (bytes.length >= 4 && bytes.toString("latin1", 0, 4) === "GIF8") {
    return { mime: "image/gif", ext: "gif" }
  }
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" }
  }
  return null
}

/**
 * Split an argument string on unquoted whitespace, honouring single and double
 * quotes: the quote chars are stripped, whitespace inside an open quote is
 * literal, and an unterminated quote gracefully takes the rest of the string.
 * Empty segments are dropped.
 */
function splitArguments(input: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | null = null
  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current !== "") out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current !== "") out.push(current)
  return out
}

function expandTilde(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

/** Expand one glob argument; a pattern with no matches falls back to the literal path. */
function expandGlob(p: string): string[] {
  try {
    const matches = globSync(p)
    if (matches.length > 0) return [...matches].sort()
  } catch {}
  return [p]
}

/**
 * Sniff, hash and archive one image, returning the synthesized FilePart. The
 * disk file is content-addressed (`<sha256>.<ext>`); the part's filename is
 * `<label>-<hash8>.<ext>`. Null means the bytes are not a recognized image.
 */
function storeImage(bytes: Buffer, dir: string, sessionID: string, label: string): { part: FilePart; hash: string } | null {
  const kind = detectImageKind(bytes)
  if (kind === null) return null
  const hash = createHash("sha256").update(bytes).digest("hex")
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${hash}.${kind.ext}`)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, bytes, { mode: 0o600 })
  renameSync(tmp, target)
  const part: FilePart = {
    id: randomUUID(),
    sessionID,
    messageID: randomUUID(),
    type: "file",
    mime: kind.mime,
    filename: `${label}-${hash.slice(0, 8)}.${kind.ext}`,
    url: `data:${kind.mime};base64,${bytes.toString("base64")}`,
  }
  return { part, hash }
}

function warn(input: PluginInput, message: string): void {
  input.client.app.log({ body: { service: "image-paste", level: "warn", message } }).catch(() => {})
}

async function toast(input: PluginInput, message: string): Promise<void> {
  try {
    await input.client.tui.showToast({ body: { title: "lacode", message, variant: "warning" } })
  } catch {}
}

export async function imagePasteHooks(
  input: PluginInput,
  options?: PluginOptions,
  deps?: ImagePasteDeps,
): Promise<Hooks> {
  try {
    const opts = (options ?? {}) as ImagePasteOptions
    if (opts.enabled === false) return {}
    const maxBytes = resolveMaxBytes(opts)
    const maxImages = resolveMaxImages(opts)
    const dir = opts.dir ?? process.env.LACODE_IMAGE_DIR ?? join(homedir(), ".local/share/opencode/lacode/images")
    const readClipboard = (deps ?? {}).readClipboard ?? readClipboardImage
    return {
      "command.execute.before": async (cmd, output) => {
        try {
          if (cmd.command === "image-in-cb") {
            const bytes = await readClipboard()
            if (bytes === null) {
              warn(input, "No image on the clipboard")
              await toast(input, "No image on the clipboard")
              return
            }
            if (bytes.length > maxBytes) {
              const message = `image too large: ${bytes.length} bytes, max ${maxBytes}`
              warn(input, message)
              await toast(input, message)
              return
            }
            const stored = storeImage(bytes, dir, cmd.sessionID, "clipboard")
            if (stored === null) {
              warn(input, "unsupported clipboard image format (expected PNG, JPEG, GIF or WebP)")
              await toast(input, "unsupported clipboard image format (expected PNG, JPEG, GIF or WebP)")
              return
            }
            const firstText = output.parts.findIndex((p) => p.type === "text")
            if (firstText === -1) output.parts.push(stored.part)
            else output.parts.splice(firstText, 0, stored.part)
            return
          }
          if (cmd.command === "image") {
            const rawArgs = typeof cmd.arguments === "string" ? cmd.arguments : ""
            const resolved: string[] = []
            for (const arg of splitArguments(rawArgs)) resolved.push(...expandGlob(expandTilde(arg)))

            const parts: FilePart[] = []
            const seen = new Set<string>() // sha256 dedupe within this message
            let totalBytes = 0
            const skipped: string[] = [] // basenames of dropped files

            for (const filePath of resolved) {
              const name = basename(filePath)
              let size: number
              try {
                const stat = statSync(filePath)
                if (!stat.isFile()) {
                  skipped.push(name)
                  continue
                }
                size = stat.size
              } catch {
                skipped.push(name) // missing or unreadable
                continue
              }
              if (size > maxBytes) {
                skipped.push(name) // oversize per file: never read it
                continue
              }
              let bytes: Buffer
              try {
                bytes = readFileSync(filePath)
              } catch {
                skipped.push(name)
                continue
              }
              if (detectImageKind(bytes) === null) {
                skipped.push(name) // unsupported format
                continue
              }
              const hash = createHash("sha256").update(bytes).digest("hex")
              if (seen.has(hash)) continue // duplicate: silently deduped, not counted as skipped
              if (parts.length >= maxImages || totalBytes + bytes.length > MAX_TOTAL_BYTES) {
                skipped.push(name)
                continue
              }
              const stored = storeImage(bytes, dir, cmd.sessionID, name.replace(/\.[^.]+$/, "") || "image")
              if (stored === null) {
                skipped.push(name)
                continue
              }
              seen.add(hash)
              parts.push(stored.part)
              totalBytes += bytes.length
            }

            if (skipped.length > 0) {
              const message = `skipped ${skipped.length} image file${skipped.length === 1 ? "" : "s"}: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ", …" : ""}`
              warn(input, message)
              await toast(input, message)
            }
            if (parts.length > 0) {
              const firstText = output.parts.findIndex((p) => p.type === "text")
              if (firstText === -1) output.parts.push(...parts)
              else output.parts.splice(firstText, 0, ...parts)
            }
            return
          }
        } catch (error) {
          try {
            input.client.app
              .log({ body: { service: "image-paste", level: "error", message: `image-paste failed: ${String(error)}` } })
              .catch(() => {})
          } catch {}
        }
      },
    }
  } catch {
    return {}
  }
}
