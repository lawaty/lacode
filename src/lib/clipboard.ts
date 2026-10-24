/**
 * Clipboard image reading.
 *
 * Reads an image from the system clipboard through the platform's native
 * tooling: wl-paste/xclip on Linux, pngpaste on macOS, PowerShell on
 * Windows. Pure helper module: exports no plugin, never logs, never
 * throws; every failure path resolves to `null`.
 */

import { spawnSync } from "node:child_process"
import { readFile, rm } from "node:fs/promises"

export type ClipboardRun = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: Buffer; stderr: string }>

export type ClipboardDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: ClipboardRun
  have?: (cmd: string) => boolean
}

/** Real runs get this long before the child is killed. */
const RUN_TIMEOUT_MS = 3000

/**
 * Default runner, mirroring the spawn style of src/tunnel/index.ts: a
 * synchronous spawn in a never-throwing envelope. Differences the clipboard
 * contract forces: stdout stays a Buffer, the timeout kills with SIGKILL
 * (tunnel relies on the spawnSync default), and spawn errors (ENOENT,
 * ETIMEDOUT, ...) fold their reason into stderr instead of a detail field.
 */
const defaultRun: ClipboardRun = async (cmd, args) => {
  try {
    const result = spawnSync(cmd, args, {
      timeout: RUN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stderr = result.stderr ? result.stderr.toString().trim() : ""
    const detail = result.error
      ? String((result.error as NodeJS.ErrnoException).code ?? result.error.message)
      : ""
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: [stderr, detail].filter(Boolean).join("\n"),
    }
  } catch (error) {
    return { ok: false, stdout: Buffer.alloc(0), stderr: String(error) }
  }
}

/** Mirrors have() in src/tunnel/index.ts: sh -c "command -v <cmd>". */
const defaultHave = (cmd: string): boolean => {
  try {
    return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0
  } catch {
    return false
  }
}

/** Accept only bytes carrying a known image signature (PNG/JPEG/GIF/WebP). */
const hasImageSignature = (bytes: Buffer): boolean => {
  const head = bytes.toString("latin1", 0, 12)
  if (head.startsWith("\x89PNG")) return true
  if (head.startsWith("\xff\xd8\xff")) return true
  if (head.startsWith("GIF8")) return true
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return true
  return false
}

/** null unless the run succeeded and stdout is a non-empty image. */
const validImage = (result: { ok: boolean; stdout: Buffer }): Buffer | null => {
  if (!result.ok || result.stdout.length === 0) return null
  return hasImageSignature(result.stdout) ? result.stdout : null
}

/** Linux tool order: Wayland sessions try wl-paste first, X11 tries xclip first. */
const linuxCandidates = (env: NodeJS.ProcessEnv): Array<{ cmd: string; args: string[] }> => {
  const xclip = { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] }
  const wlPaste = { cmd: "wl-paste", args: ["--type", "image/png"] }
  const wayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland"
  return wayland ? [wlPaste, xclip] : [xclip, wlPaste]
}

/**
 * PowerShell: save the clipboard image to a temp PNG and print its path.
 * exit 1 when the clipboard holds no image, so ok comes back false.
 */
const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$img = [System.Windows.Forms.Clipboard]::GetImage()",
  "if ($null -eq $img) { exit 1 }",
  "$path = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName()) + '.png'",
  "$img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
  "Write-Output $path",
].join("\n")

/** Windows: PowerShell writes the image to a temp PNG and prints the path. */
const readWindows = async (run: ClipboardRun): Promise<Buffer | null> => {
  const result = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT])
  if (!result.ok) return null
  const path = result.stdout.toString("utf8").replace(/^\uFEFF/, "").trim()
  if (!path) return null
  try {
    return validImage({ ok: true, stdout: await readFile(path) })
  } finally {
    await rm(path, { force: true }).catch(() => {})
  }
}

/**
 * Read an image from the system clipboard. Returns the raw image bytes
 * (PNG, JPEG, GIF or WebP signature required), untouched, or null when the
 * clipboard holds no image, a needed binary is missing, or anything fails
 * along the way. Never logs, never throws.
 */
export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<Buffer | null> {
  try {
    const platform = deps.platform ?? process.platform
    const env = deps.env ?? process.env
    const run = deps.run ?? defaultRun
    const have = deps.have ?? defaultHave

    if (platform === "darwin") {
      if (!have("pngpaste")) return null
      return validImage(await run("pngpaste", ["-"]))
    }
    if (platform === "win32") {
      return await readWindows(run)
    }
    if (platform === "linux") {
      for (const candidate of linuxCandidates(env)) {
        if (!have(candidate.cmd)) continue
        const bytes = validImage(await run(candidate.cmd, candidate.args))
        if (bytes) return bytes
      }
    }
    return null
  } catch {
    return null
  }
}
