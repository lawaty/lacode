import { writeFileSync, renameSync, rmSync } from "node:fs"
import { tool, type Hooks, type PluginInput, type PluginOptions } from "@opencode-ai/plugin"
import * as pool from "../lib/pool.ts"
import {
  appendEntries,
  appendEntriesAt,
  buildExcerpt,
  isInternalTitle,
  parseBullets,
  readEntries,
  readEntriesAt,
  timelineFile,
  removeEntries,
  type TimelineCursor,
  type TimelineEntry,
  type TimelineMessage,
} from "../lib/timeline.ts"
// Per-session timeline summarizer.
//
// This is a HOOK FACTORY, not a plugin: it returns the hooks object and exports
// nothing else. Sessions are summarized on a timer after they show activity, and
// the summary is written to a small append-only timeline file next to the
// session id. The summarizer runs in its own internal session, which is tracked
// in `owned` so its own messages never count as activity and never trigger
// another run.

const DEFAULT_INTERVAL_MS = 300_000
const MIN_INTERVAL_MS = 10_000
const DEFAULT_MAX_ENTRIES = 8
const MAX_ENTRIES = 10
const PROMPT_TIMEOUT_MS = 90_000

const SYSTEM = `You are the session timeline summarizer. You receive a slice of a coding session transcript.
Write 1-8 timeline entries describing the work as tasks, features, fixes, or stages.

Rules:
- One entry per line, each starting with "- ".
- Each entry is 6-16 words, past tense, plain text.
- Cover each distinct task in the slice. Do not drop a provider, feature, fix, config, docs, or test change; merge only exact duplicates.
- Describe the TASK or OUTCOME, not the implementation. "Pool: added bucket-based routing" is right; "added b:<name> to pool.ts and agent-pool.ts" is too detailed.
- Never describe the mechanism: no flags, aliases, overrides, endpoints, probes, config keys, declarations, tags, or file changes. State what changed for the system: which capability now works, which bug is fixed, which behavior changed.
- Never use these words in an entry: tag, alias, override, flag, probe, endpoint, config key, catalog, file, line, count.
- For configuration plumbing, write the purpose: "Config: silenced warnings for unused providers", not "declared empty overrides".
- Use a short area prefix when it clarifies: "Pool:", "Providers:", "Config:", "Docs:", "Tests:", "Fix:", "Feature:".
- Name the capability, behavior, feature, bug, or decision. Do not name files, paths, functions, commands, environment variables, API keys, raw model IDs, test file names, or build artifacts. Provider and product names are allowed when they identify the task.
- Do not include counts of slots, providers, tests, lines, or files.
- Omit internal housekeeping: builds, dist rebuilds, test-file additions, formatting, and dependency churn. If the slice only contains housekeeping, output nothing.
- Describe what was DONE or DECIDED. Never write "User asked...", "Assistant said...", "Discussed...", "Reviewed...", "Explained...", or "Considered...".
- Merge related changes into one stage; do not repeat the same task in different words.
- No markdown: no bold, italics, backticks, or code blocks.
- If a technical detail is the essence of the task, name it at the capability level: "Added Cloudflare Workers AI as a provider", not its account-id variables.
- If the slice contains no substantive work or decision, output nothing.
- Output only the entries. No headings, no preamble, no closing sentence.

Example output:
- Pool: added bucket-based routing for model groups.
- Providers: added Gemini 3.5 Flash after the previous model timed out.
- Providers: added Cloudflare Workers AI with a tool-compatible model.
- Config: silenced warnings for unused providers.
- Config: standardized provider key naming and added Groq and Google.
- Docs: aligned the routing documentation with the implemented behavior.

Not this:
- Config: declared empty OpenRouter overrides to silence warnings.
- Providers: added a Google API key alias after Gemini 2.5-flash closure.
- Config: standardized provider keys to _KEY-only naming.
- Pool: reordered slots after tagging pool entries.
- Pool: added bucket support and kept tags in pool.
- Pool: standardized slots on opencode catalog.
- Providers: added Gemini 3.5 Flash and a Google API key alias.

This:
- Config: silenced warnings for unused providers.
- Providers: replaced the retired Gemini 2.5 Flash with an available model.
- Config: standardized provider key naming.
- Pool: moved shared-window models to the end.
- Pool: added named bucket support for model groups.
- Pool: moved shared-window models to the end.
- Providers: replaced the retired Gemini 2.5 Flash with Gemini 3.5 Flash.

Your entire response must consist only of lines beginning with "- ".`

type TimelineConfig = {
  enabled?: boolean
  intervalMs?: number
  maxEntries?: number
}

type TimelineState = {
  timer?: NodeJS.Timeout
  running: boolean
  pending: boolean
  root?: boolean
  cursor?: TimelineCursor
  failures: number
}

type SummarizerResult = {
  error?: unknown
  data?: {
    info?: { error?: unknown }
    parts?: Array<{ type: string; text?: string }>
  }
}

type SummarizeResult = { ok: boolean; bullets: string[]; error?: string }

export function timelineHooks(input: PluginInput, options?: PluginOptions): Hooks {
  const { client, directory } = input
  const opts = (options ?? {}) as { timeline?: false | TimelineConfig }
  const config = typeof opts.timeline === "object" && opts.timeline !== null ? opts.timeline : undefined
  const disabled = opts.timeline === false || config?.enabled === false || process.env.LACODE_TIMELINE === "0"

  const SERVICE = "timeline"
  const poolState = pool.state(options as { id?: string; dir?: string; modelsFile?: string; models?: unknown } | undefined)
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => {})
  const debug = (...args: unknown[]) => {
    if (process.env.LACODE_TIMELINE_DEBUG === "1") console.error("[timeline]", ...args)
  }

  const rawInterval = Number(process.env.LACODE_TIMELINE_INTERVAL_MS ?? config?.intervalMs ?? DEFAULT_INTERVAL_MS)
  const intervalMs = Number.isFinite(rawInterval) ? Math.max(MIN_INTERVAL_MS, rawInterval) : DEFAULT_INTERVAL_MS
  const rawMaxEntries = Number(config?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const maxEntries = Number.isFinite(rawMaxEntries)
    ? Math.min(MAX_ENTRIES, Math.max(1, Math.trunc(rawMaxEntries)))
    : DEFAULT_MAX_ENTRIES

  const shared = ((globalThis as any)[Symbol.for("lacode:timeline:state")] ??= {
    sessions: new Map<string, TimelineState>(),
    owned: new Set<string>(),
    reprocessing: new Set<string>(),
  }) as { sessions: Map<string, TimelineState>; owned: Set<string>; reprocessing: Set<string> }
  const sessions = shared.sessions
  const owned = shared.owned
  const reprocessing = shared.reprocessing
  const MAX_REPROCESS_SLICES = 100
  let disposed = false
  const promptModel = (raw: string) => {
    if (typeof raw !== "string" || !raw.includes("/")) return undefined
    const { provider, id } = pool.splitModel(raw)
    if (!id) return undefined
    return { providerID: provider, modelID: id }
  }

  const stateFor = (id: string): TimelineState => {
    let state = sessions.get(id)
    if (!state) {
      state = {
        running: false,
        pending: false,
        failures: 0,
        cursor: readEntries(id, 1)[0]?.through,
      }
      sessions.set(id, state)
      while (sessions.size > 500) {
        let evicted = false
        for (const [key, st] of sessions) {
          if (key === id) continue
          if (!st.timer && !st.running) {
            sessions.delete(key)
            evicted = true
            break
          }
        }
        if (!evicted) break
      }
    }
    return state
  }

  const note = (id: string) => {
    if (disabled || disposed) return
    const state = stateFor(id)
    if (state.root === false) return
    state.pending = true
    if (state.timer || state.running) return
    schedule(id, state)
  }

  function schedule(id: string, state: TimelineState) {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      void tick(id, state)
    }, intervalMs)
    state.timer.unref?.()
  }

  async function summarize(
    id: string,
    title: string,
    excerptText: string,
    prior: TimelineEntry[],
    abort?: AbortSignal,
  ): Promise<SummarizeResult> {
    if (abort?.aborted) return { ok: false, bullets: [], error: "aborted" }

    let slot: any
    try {
      pool.init(poolState, (m) => log("warn", m))
      const snap = pool.snapshot(poolState)
      slot = pool.pickSlot(poolState, snap)
    } catch (error) {
      log("warn", String(error))
      return { ok: false, bullets: [], error: String(error) }
    }

    const model = promptModel(slot?.model)
    if (!model) {
      log("warn", "timeline: slot model cannot be split into provider/model", { model: slot?.model })
      return { ok: false, bullets: [], error: "slot model cannot be split into provider/model" }
    }

    const created = await client.session.create({
      body: { title: "timeline (auto)" },
      query: { directory },
    })
    const target = created?.data?.id
    if (!target) {
      return { ok: false, bullets: [], error: "session create returned no id" }
    }

    const claimKey = pool.claimKey(target, "timeline")
    let claimed = false
    owned.add(target)
    let abortListener: (() => void) | undefined
    try {
      claimed = true
      pool.acquire(poolState, "context", slot, target, claimKey, target)

      const prompt = [
        `Session: ${title}`,
        ...(prior.length > 0
          ? ["Existing timeline (do not repeat):", ...prior.map((entry) => `- ${entry.text}`)]
          : []),
        "Transcript slice:",
        excerptText,
      ].join("\n")

      if (abort) {
        abortListener = () => {
          void client.session.abort({ path: { id: target }, query: { directory } }).catch(() => {})
        }
        abort.addEventListener("abort", abortListener)
      }

      let timer: NodeJS.Timeout | undefined
      let timedOut = false
      let result: SummarizerResult | undefined
      try {
        const answer = client.session
          .prompt({
            path: { id: target },
            query: { directory },
            body: {
              model,
              tools: { "*": false },
              system: SYSTEM,
              parts: [{ type: "text", text: prompt }],
            },
          })
          .then(
            (value) => value as SummarizerResult | undefined,
            (error) => ({ error }),
          )
        const deadline = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true
            void client.session
              .abort({ path: { id: target }, query: { directory } })
              .catch(() => {})
            resolve(undefined)
          }, PROMPT_TIMEOUT_MS)
        })
        result = await Promise.race([answer, deadline])
      } finally {
        if (timer) clearTimeout(timer)
      }

      if (abort?.aborted) {
        return { ok: false, bullets: [], error: "aborted" }
      }

      const failure = result?.error ?? result?.data?.info?.error
      if (timedOut || failure !== undefined) {
        return { ok: false, bullets: [], error: timedOut ? "timed out" : String(failure) }
      } else {
        const text = (result?.data?.parts ?? [])
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("\n")
        const bullets = parseBullets(text, maxEntries)
        if (bullets.length > 0) {
          return { ok: true, bullets }
        } else if (text.trim() === "") {
          return { ok: true, bullets: [] }
        } else {
          if (process.env.LACODE_TIMELINE_DEBUG === "1") {
            log("no bullet lines", { sessionID: id, text: text.slice(0, 300) })
          }
          return { ok: false, bullets: [], error: "no bullet lines" }
        }
      }
    } finally {
      if (abort && abortListener) abort.removeEventListener("abort", abortListener)
      if (claimed && claimKey) pool.release(poolState, claimKey)
      await client.session.delete({ path: { id: target }, query: { directory } }).catch(() => {})
      owned.delete(target)
    }
  }

  async function tick(id: string, state: TimelineState): Promise<void> {
    if (disposed) return
    if (reprocessing.has(id)) return
    try {
      state.running = true
      state.pending = false
      let title: string | undefined
      let info: any = {}
      if (state.root === undefined) {
        info = await client.session
          .get({ path: { id }, query: { directory } })
          .then((result) => result?.data)
          .catch(() => undefined)
        if (!info) {
          sessions.delete(id)
          return
        }
        title = info.title
        state.root = !info.parentID && !isInternalTitle(info.title)
        if (!state.root) {
          sessions.delete(id)
          return
        }
      }

      const response = await client.session.messages({ path: { id }, query: { directory } })
      const messages = response?.data ?? []
      const excerpt = buildExcerpt(messages as TimelineMessage[], state.cursor)
      if (!excerpt.text) {
        return
      }

      const result = await summarize(id, info.title ?? "untitled", excerpt.text, readEntries(id, 4))
      if (result.ok) {
        if (result.bullets.length) appendEntries(id, result.bullets, Date.now(), excerpt.next)
        state.cursor = excerpt.next
        state.failures = 0
      } else {
        state.failures++
        log("summarize failed", { sessionID: id, error: result.error })
      }
    } catch (error) {
      debug("tick failed", { sessionID: id, error })
    } finally {
      state.running = false
      if (sessions.get(id) === state && state.pending && !disabled && !disposed && state.root !== false) {
        schedule(id, state)
      }
    }
  }

  async function resolveRootSession(id: string): Promise<string> {
    let current = id
    const seen = new Set<string>()
    while (true) {
      if (seen.has(current)) return current
      seen.add(current)
      const info = await client.session
        .get({ path: { id: current }, query: { directory } })
        .then((result) => result?.data)
        .catch(() => undefined)
      if (!info?.parentID) return current
      current = info.parentID
    }
  }

  async function reprocess(id: string, abort?: AbortSignal): Promise<string> {
    const rootId = await resolveRootSession(id)
    if (reprocessing.has(rootId)) return "A timeline reprocess is already running for this session."
    if (sessions.get(rootId)?.running) return "The timeline is currently summarizing this session; try again in a moment."
    reprocessing.add(rootId)
    const targetFile = timelineFile(rootId)
    const temp = targetFile + ".reprocess." + process.pid + "." + Date.now() + ".tmp"
    let cursor: TimelineCursor | undefined
    let entries = 0
    let calls = 0
    try {
      const infoRes = await client.session.get({ path: { id: rootId }, query: { directory } })
      const info = infoRes?.data
      if (!info) return "Session not found."
      const msgRes = await client.session.messages({ path: { id: rootId }, query: { directory } })
      const messages = (msgRes?.data ?? []) as TimelineMessage[]
      writeFileSync(temp, "")
      for (let i = 0; i < MAX_REPROCESS_SLICES; i++) {
        if (abort?.aborted) {
          try { rmSync(temp, { force: true }) } catch {}
          return `Aborted after ${calls} summarizer calls; previous timeline kept.`
        }
        const excerpt = buildExcerpt(messages, cursor)
        if (!excerpt.text) break
        const prior = readEntriesAt(temp, 4)
        const result = await summarize(rootId, info.title ?? "untitled", excerpt.text, prior, abort)
        calls++
        if (!result.ok) {
          try { rmSync(temp, { force: true }) } catch {}
          return `Stopped after ${calls} summarizer calls: ${result.error}. Previous timeline kept.`
        }
        if (result.bullets.length) {
          entries += appendEntriesAt(temp, result.bullets, Date.now(), excerpt.next)
        }
        cursor = excerpt.next
      }
      if (abort?.aborted) {
        try { rmSync(temp, { force: true }) } catch {}
        return `Aborted after ${calls} summarizer calls; previous timeline kept.`
      }
      if (entries === 0) {
        try { rmSync(temp, { force: true }) } catch {}
        return "No entries generated; previous timeline kept."
      }
      renameSync(temp, targetFile)
      const state = sessions.get(rootId)
      if (state) {
        state.cursor = cursor
        state.failures = 0
        state.pending = false
      }
      return `Rebuilt ${messages.length} messages into ${entries} entries with ${calls} summarizer calls.`
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch {}
      return `Reprocess failed: ${String(error)}. Previous timeline kept.`
    } finally {
      reprocessing.delete(rootId)
    }
  }

  const timelineReprocess = tool({
    description: "Rebuild the root session's entire timeline from its transcript, replacing the existing entries. Used by /reprocess-timeline.",
    args: {},
    execute: async (_args, ctx) => {
      const output = await reprocess(ctx.sessionID, ctx.abort)
      return { title: "Timeline reprocess", output }
    },
  })

  return {
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "message.updated": {
            const id = event.properties.info?.sessionID
            if (!id) return
            if (owned.has(id)) return
            const role = event.properties.info?.role
            if (role === "user" || role === "assistant") note(id)
            return
          }
          case "message.part.updated": {
            const id = event.properties.part?.sessionID
            if (!id) return
            if (owned.has(id)) return
            const type = event.properties.part?.type
            if (type === "text" || type === "tool") note(id)
            return
          }
           case "session.created": {
             const info = event.properties.info
             if (!info) return
             if (isInternalTitle(info.title)) owned.add(info.id)
             return
           }
           case "session.deleted": {
             const id = event.properties.info?.id
             if (!id) return
             const state = sessions.get(id)
            if (state?.timer) {
              clearTimeout(state.timer)
              state.timer = undefined
            }
            sessions.delete(id)
            removeEntries(id)
            owned.delete(id)
            return
          }
          default:
            return
        }
      } catch (error) {
        debug("event failed", error)
      }
    },
    dispose: async () => {
      disposed = true
      for (const state of sessions.values()) {
        if (state.timer) {
          clearTimeout(state.timer)
          state.timer = undefined
        }
      }
      reprocessing.clear()
    },
    tool: { timeline_reprocess: timelineReprocess },
  }
}
