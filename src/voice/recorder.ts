import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type RecorderDeps = {
  spawnImpl?: typeof import("node:child_process").spawn
  tmpdir?: string
  bin?: string
  maxSeconds?: number
  exists?: (path: string) => boolean
  readFile?: (path: string) => Uint8Array
  unlink?: (path: string) => void
  now?: () => number
}

export type Recorder = {
  readonly active: boolean
  readonly path: string | undefined
  start(): void
  stop(): Promise<Uint8Array | undefined>
  abort(): void
}

export function createRecorder(deps?: RecorderDeps): Recorder {
  const spawnImpl = deps?.spawnImpl ?? spawn
  const tmpdirVal = deps?.tmpdir ?? tmpdir()
  const maxSeconds = deps?.maxSeconds ?? 120
  const exists = deps?.exists ?? ((p: string) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p) as unknown as Uint8Array)
  const unlink = deps?.unlink ?? ((p: string) => {
    unlinkSync(p)
  })
  const now = deps?.now ?? Date.now

  let chosenBin: string | undefined = deps?.bin
  let active = false
  let childHandle: ReturnType<typeof spawn> | undefined
  let currentPath: string | undefined
  let exited = false
  let resolveWait: (() => void) | null = null

  const recorder: Recorder = {
    get active() {
      return active
    },
    get path() {
      return currentPath
    },
    start() {
      if (active) return
      if (chosenBin === undefined) {
        if (exists("/usr/bin/arecord") || exists("/usr/local/bin/arecord") || exists("arecord")) {
          chosenBin = "arecord"
        } else {
          chosenBin = "ffmpeg"
        }
      }
      const bin = chosenBin as string
      currentPath = join(tmpdirVal, `lacode-voice-${process.pid}-${now()}-${randomUUID()}.wav`)
      const path = currentPath
      const args =
        bin === "arecord"
          ? ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", "-d", String(maxSeconds), path]
          : ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ar", "16000", "-ac", "1", "-t", String(maxSeconds), "-y", path]

      exited = false
      let child: ReturnType<typeof spawn>
      try {
        child = spawnImpl(bin, args, { stdio: "ignore" })
      } catch {
        active = false
        currentPath = undefined
        return
      }
      childHandle = child
      active = true

      const onClose = () => {
        exited = true
        if (resolveWait) {
          const r = resolveWait
          resolveWait = null
          r()
        }
      }
      try {
        child.on("close", onClose)
        child.on("exit", onClose)
        child.on("error", (err: unknown) => {
          // record lastError implicitly; clear active
          exited = true
          if (resolveWait) {
            const r = resolveWait
            resolveWait = null
            r()
          }
          active = false
        })
      } catch {
        // ignore
      }
    },
    async stop() {
      if (!active || !childHandle) return undefined
      const child = childHandle
      const filePath = currentPath

      if (!exited) {
        await new Promise<void>((resolve) => {
          let done = false
          let timer: ReturnType<typeof setTimeout> | undefined
          const finish = () => {
            if (done) return
            done = true
            if (timer) clearTimeout(timer)
            if (resolveWait === resolve) resolveWait = null
            resolve()
          }
          resolveWait = resolve
          timer = setTimeout(() => {
            try {
              child.kill("SIGKILL")
            } catch {
              // already gone
            }
            finish()
          }, 3000)
          try {
            child.kill("SIGINT")
          } catch {
            finish()
          }
          if (exited) finish()
        })
      }

      let result: Uint8Array | undefined
      try {
        if (filePath) {
          const data = readFile(filePath)
          if (data && data.length > 0) result = data
        }
      } catch {
        result = undefined
      } finally {
        if (filePath) {
          try {
            unlink(filePath)
          } catch {
            // ignore
          }
        }
      }

      childHandle = undefined
      currentPath = undefined
      active = false
      return result
    },
    abort() {
      const child = childHandle
      const filePath = currentPath
      if (child) {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
      }
      if (filePath) {
        try {
          unlink(filePath)
        } catch {
          // ignore
        }
      }
      childHandle = undefined
      currentPath = undefined
      active = false
      exited = true
      if (resolveWait) {
        const r = resolveWait
        resolveWait = null
        r()
      }
    },
  }

  return recorder
}
