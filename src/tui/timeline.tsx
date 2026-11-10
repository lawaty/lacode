/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

let registered = false

/** The panel shows the most recent entries, newest first. */
const ENTRY_LINES = 14

type TimelineLine = { content: string; requestRender?: () => void }
type TimelineEntry = { ts: number; text: string }
type TimelineCache = { path: string | null; size: number; mtimeMs: number; ino: number; entries: TimelineEntry[]; rendered: string[] }

const tui: TuiPlugin = async (api) => {
  if (registered) return
  registered = true
  // built-in sidebar panels are context 100, MCP 200, LSP 300, todo 400, files 500, so 150 places the timeline right after context and above MCP
  api.slots.register({
    order: 150,
    slots: {
      // The rows are static and their text is written through the renderable's
      // `content` setter. Solid signals are deliberately NOT used here: the
      // plugin's `solid-js` is a different instance from the TUI renderer's, so
      // signal updates never reach the screen. Plain renderables always do.
      sidebar_content(ctx, props) {
        const rows: (TimelineLine | undefined)[] = []
        const muted = ctx.theme.current.textMuted
        const cache: TimelineCache = { path: null, size: -1, mtimeMs: -1, ino: -1, entries: [], rendered: [] }

        /** Read and parse one session's timeline file. Missing/malformed is "no entries". */
        const readEntries = (id: string | undefined): TimelineEntry[] => {
          if (typeof id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(id)) return []
          const rawDir = process.env.LACODE_TIMELINE_DIR
          const dir = rawDir ? resolve(rawDir) : join(homedir(), ".local/share/opencode/lacode/timeline")
          const path = join(dir, id + ".jsonl")
          try {
            const stat = statSync(path)
            if (cache.path === path && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs && cache.ino === stat.ino) {
              return cache.entries
            }
            const maxRead = 64 * 1024
            const start = Math.max(0, stat.size - maxRead)
            const length = stat.size - start
            const fd = openSync(path, "r")
            try {
              const buf = Buffer.alloc(length)
              let total = 0
              while (total < length) {
                const n = readSync(fd, buf, total, length - total, start + total)
                if (n <= 0) break
                total += n
              }
              if (total < length) {
                return []
              }
              let raw = buf.toString("utf8")
              if (start > 0) {
                const firstNl = raw.indexOf("\n")
                raw = firstNl === -1 ? "" : raw.slice(firstNl + 1)
              }
              const parsed: TimelineEntry[] = []
              for (const line of raw.split("\n")) {
                const trimmed = line.trim()
                if (!trimmed) continue
                try {
                  const obj = JSON.parse(trimmed) as { ts?: unknown; text?: unknown }
                  if (obj && typeof obj.ts === "number" && typeof obj.text === "string") {
                    parsed.push({ ts: obj.ts, text: obj.text })
                  }
                } catch {
                  // skip malformed lines
                }
              }
              const entries = parsed.slice(-ENTRY_LINES).reverse()
              cache.path = path
              cache.size = stat.size
              cache.mtimeMs = stat.mtimeMs
              cache.ino = stat.ino
              cache.entries = entries
              return entries
            } finally {
              closeSync(fd)
            }
          } catch {
            return []
          }
        }

        const paint = () => {
          const entries = readEntries(props.session_id)
          const next: string[] = []
          for (let i = 0; i < ENTRY_LINES; i++) {
            const text = entries[i]?.text
            next.push(text ? `• ${text}` : i === 0 && entries.length === 0 ? "No timeline yet" : "")
          }
          if (
            cache.rendered.length === ENTRY_LINES &&
            next.every((value, i) => value === cache.rendered[i])
          ) {
            return
          }
          for (let i = 0; i < ENTRY_LINES; i++) {
            const row = rows[i]
            if (!row) continue
            row.content = next[i]
            row.requestRender?.()
          }
          cache.rendered = next
        }

        const timer = setInterval(paint, 1000)
        timer.unref?.()
        api.lifecycle.onDispose(() => clearInterval(timer))

        return (
          <box flexDirection="column">
            <text fg={muted}>Timeline</text>
            {Array.from({ length: ENTRY_LINES }, (_, index) => (
              <text
                fg={index === 0 ? muted : undefined}
                ref={(node: TimelineLine | undefined) => {
                  rows[index] = node
                  // The last row mounts after every earlier one, so paint once
                  // the whole column exists rather than showing a blank frame.
                  if (index === ENTRY_LINES - 1) paint()
                }}
              >
                {""}
              </text>
            ))}
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "lacode.timeline",
  tui,
}

export default plugin
