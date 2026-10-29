import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"

export type CaptureDeps = {
  spawnImpl?: typeof import("node:child_process").spawn
  platform?: NodeJS.Platform
  exists?: (file: string) => boolean
  env?: Record<string, string | undefined>
}

export type CapturePlan = { bin: string; args: string[] }

export type Capture = {
  readonly running: boolean
  readonly plan: CapturePlan | undefined
  start(): void
  stop(): void
}

function resolveBinary(name: string, deps?: CaptureDeps): string | undefined {
  const env = deps?.env ?? {}
  const exists = deps?.exists ?? ((f: string) => {
    try {
      return existsSync(f)
    } catch {
      return false
    }
  })
  if (exists(name)) return name
  const pathEnv = env.PATH ?? process.env.PATH ?? ""
  const dirs = pathEnv
    .split(path.delimiter)
    .filter((d) => d.length > 0)
    .concat(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"])
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

function sanitizeVoiceInput(input: string | undefined, fallback: string): string {
  if (input === undefined) return fallback
  const trimmed = typeof input === "string" ? input.trim() : String(input).trim()
  if (trimmed === "") return fallback
  if (trimmed.startsWith("-")) return fallback
  return trimmed
}

export function planCapture(deps?: CaptureDeps): CapturePlan | undefined {
  const platform = deps?.platform ?? process.platform
  const env = deps?.env ?? {}
  const input = env.LACODE_VOICE_INPUT

  const ffmpeg = resolveBinary("ffmpeg", deps)
  const parec = resolveBinary("parec", deps)
  const arecord = resolveBinary("arecord", deps)

  if (platform === "linux") {
    if (ffmpeg) {
      const value = sanitizeVoiceInput(input, "default")
      return {
        bin: ffmpeg,
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "pulse",
          "-i",
          value,
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "s16le",
          "pipe:1",
        ],
      }
    }
    if (parec) {
      return {
        bin: parec,
        args: ["--format=s16le", "--rate=16000", "--channels=1", "--raw"],
      }
    }
    if (arecord) {
      return {
        bin: arecord,
        args: ["-q", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1"],
      }
    }
    return undefined
  }

  if (platform === "darwin") {
    if (ffmpeg) {
      const value = sanitizeVoiceInput(input, ":0")
      return {
        bin: ffmpeg,
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "avfoundation",
          "-i",
          value,
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "s16le",
          "pipe:1",
        ],
      }
    }
    return undefined
  }

  if (platform === "win32") {
    if (ffmpeg) {
      const value = sanitizeVoiceInput(input, "audio=default")
      return {
        bin: ffmpeg,
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "dshow",
          "-i",
          value,
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "s16le",
          "pipe:1",
        ],
      }
    }
    return undefined
  }

  return undefined
}

export function createCapture(
  onChunk: (chunk: Buffer) => void,
  deps?: CaptureDeps,
): Capture {
  const spawnImpl = deps?.spawnImpl ?? spawn
  const plan = planCapture(deps)

  let running = false
  let child: any = undefined

  const capture: Capture = {
    get running() {
      return running
    },
    get plan() {
      return plan
    },
    start() {
      if (running) return
      if (!plan) return
      if (child) {
        try {
          child.kill?.("SIGKILL")
        } catch {
          // ignore
        }
        child = undefined
      }
      let c: any
      try {
        c = spawnImpl(plan.bin, plan.args, { stdio: ["ignore", "pipe", "ignore"] })
      } catch {
        running = false
        child = undefined
        return
      }
      child = c
      running = true

      try {
        const stdout = c?.stdout
        if (stdout && typeof stdout.on === "function") {
          stdout.on("data", (chunk: Buffer) => {
            try {
              onChunk(chunk)
            } catch {
              // ignore
            }
          })
        }
      } catch {
        // ignore
      }

      try {
        if (c && typeof c.on === "function") {
          c.on("error", () => {
            running = false
          })
          c.on("exit", () => {
            running = false
          })
          c.on("close", () => {
            running = false
            child = undefined
          })
        }
      } catch {
        // ignore
      }
    },
    stop() {
      const c = child
      child = undefined
      running = false
      if (!c) return

      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
      }
      try {
        if (typeof c.on === "function") {
          c.on("close", cleanup)
          c.on("exit", cleanup)
        }
      } catch {
        // ignore
      }
      try {
        if (typeof c.kill === "function") c.kill("SIGTERM")
      } catch {
        cleanup()
      }
      timer = setTimeout(() => {
        try {
          if (typeof c.kill === "function") c.kill("SIGKILL")
        } catch {
          // ignore
        }
      }, 1500)
      try {
        timer?.unref?.()
      } catch {
        // ignore
      }
      try {
        c.unref?.()
      } catch {
        // ignore
      }
      try {
        c.stdout?.destroy?.()
      } catch {
        // ignore
      }
    },
  }

  return capture
}

export function createFrameSplitter(
  samples: number,
  onFrame: (frame: Int16Array) => void,
): (chunk: Buffer) => void {
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new Error("samples must be > 0")
  }
  const frameBytes = samples * 2
  let buf = Buffer.alloc(0)

  return (chunk: Buffer) => {
    buf = buf.length > 0 ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
    let off = 0
    while (off + frameBytes <= buf.length) {
      const slice = buf.subarray(off, off + frameBytes)
      const frame = new Int16Array(samples)
      for (let i = 0; i < samples; i++) {
        frame[i] = slice.readInt16LE(i * 2)
      }
      try {
        onFrame(frame)
      } catch {
        // ignore
      }
      off += frameBytes
    }
    buf = Buffer.from(buf.subarray(off))
  }
}
