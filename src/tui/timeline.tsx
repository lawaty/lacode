/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

let registered = false

/** The panel shows the most recent entries, newest first. */
const ENTRY_LINES = 14

type TimelineLine = { content: string; requestRender?: () => void }

/** Read and parse one session's timeline file. Missing/malformed is "no entries". */
const readEntries = (id: string | undefined): string[] => {
  if (typeof id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(id)) return []
  const rawDir = process.env.LACODE_TIMELINE_DIR
  const dir = rawDir ? resolve(rawDir) : join(homedir(), ".local/share/opencode/lacode/timeline")
  try {
    const raw = readFileSync(join(dir, id + ".jsonl"), "utf8")
    const parsed: string[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed) as { ts?: unknown; text?: unknown }
        if (obj && typeof obj.ts === "number" && typeof obj.text === "string") parsed.push(obj.text)
      } catch {
        // skip malformed lines
      }
    }
    return parsed.slice(-ENTRY_LINES).reverse()
  } catch {
    return []
  }
}

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

        const paint = () => {
          const entries = readEntries(props.session_id)
          for (let i = 0; i < ENTRY_LINES; i++) {
            const row = rows[i]
            if (!row) continue
            const text = entries[i]
            row.content = text ? `• ${text}` : i === 0 && entries.length === 0 ? "No timeline yet" : ""
            row.requestRender?.()
          }
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
