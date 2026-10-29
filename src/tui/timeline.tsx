/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, createEffect, onCleanup, For } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const tui: TuiPlugin = async (api) => {
  // built-in sidebar panels are context 100, MCP 200, LSP 300, todo 400, files 500, so 150 places the timeline right after context and above MCP
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(ctx, props) {
        const [entries, setEntries] = createSignal<string[]>([])

         const read = (id: string) => {
           if (typeof id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(id)) {
             setEntries([])
             return
           }
          const rawDir = process.env.LACODE_TIMELINE_DIR
          const dir = rawDir ? resolve(rawDir) : join(homedir(), ".local/share/opencode/lacode/timeline")
          const file = join(dir, id + ".jsonl")
          try {
            const raw = readFileSync(file, "utf8")
            const parsed: string[] = []
            for (const line of raw.split("\n")) {
              const trimmed = line.trim()
              if (!trimmed) continue
              try {
                const obj = JSON.parse(trimmed) as { ts?: unknown; text?: unknown }
                if (obj && typeof obj.ts === "number" && typeof obj.text === "string") {
                  parsed.push(obj.text)
                }
              } catch {
                // skip malformed lines
              }
            }
            setEntries(parsed.slice(-14).reverse())
          } catch {
            setEntries([])
          }
        }

        createEffect(() => {
          const id = props.session_id
          read(id)
          const timer = setInterval(() => read(id), 1000)
          onCleanup(() => clearInterval(timer))
        })

        return (
          <box flexDirection="column">
            <text fg={ctx.theme.current.textMuted}>Timeline</text>
            {entries().length === 0 ? (
              <text fg={ctx.theme.current.textMuted}>No timeline yet</text>
            ) : (
              <For each={entries()}>{(text) => <text>{`• ${text}`}</text>}</For>
            )}
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
