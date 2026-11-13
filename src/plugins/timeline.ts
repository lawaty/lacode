import { existsSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tool, type Hooks, type PluginInput, type PluginOptions } from "@opencode-ai/plugin"
import * as pool from "../lib/pool.ts"
import {
  appendEntries,
  appendEntriesAt,
  buildExcerpt,
  isInternalTitle,
  mentionsSideMaintenance,
  isSideMaintenanceTask,
  isSideTool,
  listTimelineStates,
  parseBullets,
  readEntries,
  readEntriesAt,
  readTimelineState,
  removeEntries,
  removeTimelineState,
  salvageBullets,
  taskChildSessionId,
  timelineFile,
  TIMELINE_STATE_VERSION,
  writeTimelineState,
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

const SYSTEM = `You are the session timeline summarizer. You receive a slice of a coding session transcript and write 1-8 timeline entries about the project work in it.

Record only what the session decided, found, or changed for the project: features, fixes, refactors, behavior changes, architectural decisions, data/model changes, test coverage of a capability, and docs that define behavior.

Rules:
- One entry per line, starting with "- ". Each entry is 6-16 words, past tense, plain text.
- Each entry is one meaningful stage of project work. Name the specific thing; a heading or option label that means nothing on its own ("Fix a bug or usability issue") is not an entry.
- State the decision or finding, not the path to it. "Unified all money precision to milli", not "wants this, it is significant, let me explore the scope".
- Never narrate the session. No "let me spawn explorers", "waiting for results", "I need to understand", "user asked", "discussed", or "considered".
- Options offered in a question are not events; collapse them into the one thing the user wanted.
- Stop at the stage of work. Do not inventory components, tables, tiers, fields, or intermediate steps.
- Never name mechanisms or locations: no flags, aliases, config keys, probes, endpoints, files, paths, functions, line numbers, counts, or commits. No markdown.
- Ignore self-maintenance: the context map/cartographer, timeline rebuilding, model pool status, plugin/config updates, formatting/lint/dependency churn, and build output.
- If the slice contains no project work, output exactly NO_PROJECT_CHANGES.

Example:
- Unified all money precision to milli across the codebase.
- Milli units cannot fold into minor units without precision loss.
- Dropped the milli suffix where the type already carries the unit.
- Reworked the product pricing view into a confirmed sell-price layer.

Not this:
- Let me spawn explorers to understand the full scope.
- Fix a bug or usability issue.
- ProductPricingSection: per-tier markup table with an edit modal.
- Chose Redesign the layout, or Simplify the view.

Output only the bullet lines, or exactly NO_PROJECT_CHANGES.`

type TimelineConfig = {
  enabled?: boolean
  intervalMs?: number
  maxEntries?: number
  retryMs?: number
  maxBackoffMs?: number
}

type TimelineState = {
  timer?: NodeJS.Timeout
  running: boolean
  pending: boolean
  root?: boolean
  cursor?: TimelineCursor
  failures: number
  nextAttemptAt?: number
  title?: string
}

type SummarizerResult = {
  error?: unknown
  data?: {
    info?: { error?: unknown }
    parts?: Array<{ type: string; text?: string }>
  }
}

type SummarizeResult = { ok: boolean; bullets: string[]; error?: string }

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message
    if (typeof message === "string" && message) return message
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

const MAX_TASK_CHILDREN_EXPANDED = 40

async function expandTaskSessions(
  client: any,
  messages: TimelineMessage[],
  directory: string,
  owned: Set<string>,
  onError?: (...args: unknown[]) => void,
  cursor?: string,
): Promise<TimelineMessage[]> {
  const projectOwnsTooling = existsSync(join(directory, "src/plugins/timeline.ts"))
  let attempts = 0
  const expandedMessages: TimelineMessage[] = []
  let startIndex = 0
  if (cursor) {
    const cursorIndex = messages.findIndex((m) => m.info.id === cursor)
    if (cursorIndex >= 0) startIndex = cursorIndex + 1
  }
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (messageIndex < startIndex) {
      expandedMessages.push(message)
      continue
    }
    const parts = message.parts ?? []
    let changed = false
    const nextParts: TimelineMessage["parts"] = []
    for (const part of parts) {
      if (message.info.role === "assistant" && part.type === "text" && !projectOwnsTooling && mentionsSideMaintenance(part.text ?? "")) {
        nextParts.push({ ...part, side: true })
        changed = true
        continue
      }
      if (part.type !== "tool" || part.tool !== "task" || attempts >= MAX_TASK_CHILDREN_EXPANDED) {
        nextParts.push(part)
        continue
      }
      if (isSideMaintenanceTask(part.state?.input, directory, projectOwnsTooling)) {
        nextParts.push({ ...part, side: true })
        continue
      }
      if (isSideTool("task", part.state?.input)) {
        nextParts.push({ ...part, side: true })
        continue
      }
      if (typeof part.childTitle === "string" && part.childTitle.trim() !== "") {
        nextParts.push(part)
        continue
      }
      const childId = taskChildSessionId(part)
      if (!childId || owned.has(childId)) {
        nextParts.push(part)
        continue
      }
      attempts++
      try {
        const fetched = await client.session.get({ path: { id: childId }, query: { directory } })
        const info = fetched?.data
        const rawTitle = typeof info?.title === "string" ? info.title.trim() : ""
        if (!rawTitle || isInternalTitle(info?.title)) {
          nextParts.push(part)
          continue
        }
        const childRes = await client.session.messages({ path: { id: childId }, query: { directory } })
        const childMessages = (childRes?.data ?? []) as TimelineMessage[]
        let childOutcome: string | undefined
        for (let i = childMessages.length - 1; i >= 0; i--) {
          const childMessage = childMessages[i]
          if (childMessage?.info?.role !== "assistant") continue
          const textParts = (childMessage.parts ?? [])
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text ?? "")
          const joined = textParts.join("\n").replace(/\s+/g, " ").trim()
          if (!joined) continue
          childOutcome = joined.length > 800 ? joined.slice(0, 800) : joined
          break
        }
        const cloned = childOutcome
          ? { ...part, childTitle: rawTitle, childOutcome }
          : { ...part, childTitle: rawTitle }
        nextParts.push(cloned)
        changed = true
      } catch (error) {
        if (onError) onError("expand-task-session failed", { childId, error })
        nextParts.push(part)
      }
    }
    expandedMessages.push(changed ? { ...message, parts: nextParts } : message)
  }
  return expandedMessages
}

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
  const rawRetryMs = Number(config?.retryMs ?? 30_000)
  const retryMs = Number.isFinite(rawRetryMs) ? Math.max(1, rawRetryMs) : 30_000
  const rawMaxBackoffMs = Number(config?.maxBackoffMs ?? 30 * 60_000)
  const maxBackoffMs = Math.max(retryMs, Number.isFinite(rawMaxBackoffMs) ? Math.max(1, rawMaxBackoffMs) : 30 * 60_000)
  const retryDelay = (failures: number) =>
    Math.min(retryMs * 2 ** Math.min(Math.max(failures - 1, 0), 20), maxBackoffMs)

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

  const persist = (id: string, state: TimelineState) => {
    try {
      writeTimelineState(id, {
        version: TIMELINE_STATE_VERSION,
        cursor: state.cursor,
        failures: state.failures,
        pending: state.pending,
        nextAttemptAt: state.nextAttemptAt,
        updatedAt: Date.now(),
      })
    } catch (error) {
      debug("persist failed", { sessionID: id, error })
    }
  }

  const stateFor = (id: string): TimelineState => {
    let state = sessions.get(id)
    if (!state) {
      const persisted = readTimelineState(id)
      state = {
        running: false,
        pending: persisted?.pending ?? false,
        failures: persisted?.failures ?? 0,
        cursor: persisted?.cursor ?? readEntries(id, 1)[0]?.through,
        nextAttemptAt: persisted?.nextAttemptAt,
      }
      sessions.set(id, state)
      while (sessions.size > 500) {
        let evicted = false
        for (const [key, st] of sessions) {
          if (key === id) continue
          if (!st.timer && !st.running && !st.pending && st.nextAttemptAt === undefined) {
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
    const wasPending = state.pending
    state.pending = true
    if (!wasPending) persist(id, state)
    if (state.timer || state.running) return
    schedule(id, state)
  }

  // Build now instead of waiting for the debounce: the session has handed
  // control back, so there is no more activity to batch with -- and a
  // one-shot run can exit before the timer ever fires. Only pending work
  // runs; the timer remains the debounce for an active session.
  function flush(id: string) {
    if (disabled || disposed) return
    let state = sessions.get(id)
    if (!state) {
      if (readTimelineState(id)?.pending === true) state = stateFor(id)
      else return
    }
    if (state.root === false) return
    if (!state.pending || state.running) return
    if (state.nextAttemptAt && state.nextAttemptAt > Date.now()) {
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      schedule(id, state)
      return
    }
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    void tick(id, state)
  }

  function schedule(id: string, state: TimelineState) {
    if (state.timer) clearTimeout(state.timer)
    const delay =
      typeof state.nextAttemptAt === "number"
        ? Math.max(0, state.nextAttemptAt - Date.now())
        : state.failures > 0
          ? retryDelay(state.failures)
          : intervalMs
    state.timer = setTimeout(() => {
      state.timer = undefined
      void tick(id, state)
    }, delay)
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
      if (!slot) {
        log("warn", "timeline: no routable pool slot")
        return { ok: false, bullets: [], error: "no routable pool slot" }
      }
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
        return { ok: false, bullets: [], error: timedOut ? "timed out" : errorText(failure) }
      }
      if (!result?.data) {
        return { ok: false, bullets: [], error: "no response" }
      }
      const parts = result.data.parts ?? []
      const textParts = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim()
      const reasoningParts = parts
        .filter((part) => part.type === "reasoning")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim()
      const text = textParts || reasoningParts
      const trimmed = text.trim()
      if (trimmed === "NO_PROJECT_CHANGES") {
        return { ok: true, bullets: [] }
      }
      if (trimmed === "") {
        return { ok: false, bullets: [], error: "empty summarizer output" }
      }
      const bullets = parseBullets(text, maxEntries)
      if (bullets.length > 0) {
        return { ok: true, bullets }
      }
      const salvaged = salvageBullets(text, maxEntries)
      if (salvaged.length > 0) {
        log("warn", "timeline: salvaged non-bulleted output", { sessionID: id, text: text.slice(0, 300) })
        return { ok: true, bullets: salvaged }
      }
      if (process.env.LACODE_TIMELINE_DEBUG === "1") {
        log("debug", "timeline: no bullet lines", { sessionID: id, text: text.slice(0, 300) })
      }
      return { ok: false, bullets: [], error: "no bullet lines" }
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
      let title: string | undefined
      let info: any = {}
      if (state.root === undefined) {
        info = await client.session
          .get({ path: { id }, query: { directory } })
          .then((result) => result?.data)
          .catch(() => undefined)
        if (!info) {
          sessions.delete(id)
          removeTimelineState(id)
          return
        }
        title = info.title
        state.title = info.title ?? state.title
        state.root = !info.parentID && !isInternalTitle(info.title)
        if (!state.root) {
          sessions.delete(id)
          removeTimelineState(id)
          return
        }
      }

      const response = await client.session.messages({ path: { id }, query: { directory } })
      const messages = response?.data ?? []
      const expanded = await expandTaskSessions(client, messages as TimelineMessage[], directory, owned, debug, state.cursor?.messageID)
      const excerpt = buildExcerpt(expanded, state.cursor)
      if (!excerpt.text) {
        state.pending = false
        state.failures = 0
        state.nextAttemptAt = undefined
        persist(id, state)
        return
      }

      const result = await summarize(id, state.title ?? info?.title ?? "untitled", excerpt.text, readEntries(id, 4))
      if (result.ok) {
        if (result.bullets.length) appendEntries(id, result.bullets, Date.now(), excerpt.next)
        state.cursor = excerpt.next
        state.failures = 0
        state.pending = false
        state.nextAttemptAt = undefined
        persist(id, state)
      } else {
        state.failures++
        state.pending = true
        state.nextAttemptAt = Date.now() + retryDelay(state.failures)
        persist(id, state)
        log("warn", "timeline: summarize failed", { sessionID: id, error: result.error })
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
      let messages = (msgRes?.data ?? []) as TimelineMessage[]
      writeFileSync(temp, "")
      for (let i = 0; i < MAX_REPROCESS_SLICES; i++) {
        if (abort?.aborted) {
          try { rmSync(temp, { force: true }) } catch {}
          return `Aborted after ${calls} summarizer calls; previous timeline kept.`
        }
        messages = await expandTaskSessions(client, messages, directory, owned, debug, cursor?.messageID)
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
        state.nextAttemptAt = undefined
      }
      persist(rootId, {
        running: state?.running ?? false,
        pending: false,
        failures: 0,
        cursor,
        nextAttemptAt: undefined,
      })
      return `Rebuilt ${messages.length} messages into ${entries} entries with ${calls} summarizer calls.`
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch {}
      return `Reprocess failed: ${String(error)}. Previous timeline kept.`
    } finally {
      reprocessing.delete(rootId)
    }
  }

  function resume() {
    if (disabled || disposed) return
    let listed: Array<{ sessionID: string; state: { pending: boolean; updatedAt: number } }>
    try {
      listed = listTimelineStates()
    } catch (error) {
      debug("resume failed", error)
      return
    }
    listed.sort((a, b) => b.state.updatedAt - a.state.updatedAt)
    let scheduled = 0
    for (const { sessionID, state } of listed) {
      if (state.pending !== true) continue
      if (sessions.has(sessionID)) continue
      if (scheduled >= 50) continue
      const loaded = stateFor(sessionID)
      if (loaded.root === false) continue
      schedule(sessionID, loaded)
      scheduled++
    }
  }

  resume()

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
          case "session.idle": {
            const id = event.properties.sessionID
            if (id) flush(id)
            return
          }
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
            removeTimelineState(id)
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
