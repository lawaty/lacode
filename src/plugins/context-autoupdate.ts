import { existsSync, readdirSync, statSync } from "node:fs"
import * as path from "node:path"
import type { Hooks } from "@opencode-ai/plugin"
import * as pool from "../lib/pool.ts"
import { verifyWriterRule } from "../lib/writer-rule.ts"

// Auto-maintains .opencode/context/ in every project.
//
// Trigger: a root session goes idle AND files outside .opencode/context/ were
// edited since the last run. v1.18.34 has no "repo opened" or
// "session.completed" event, so this approximates the requested lifecycle:
// bootstrap when the map is missing, incremental update when it exists.
//
// This module is a HOOK FACTORY, not a plugin -- see the note at the top of
// ./agent-pool.ts. src/index.ts calls it and merges its hooks; the root
// plugins/context-autoupdate.ts re-exports it under the plugin name so
// opencode's auto-discovery finds it in the working tree.

const SERVICE = "context-autoupdate"
const CONTEXT_DIR = path.join(".opencode", "context")
const COOLDOWN_MS = 10 * 60 * 1000
const OWNED_TTL_MS = 20 * 60 * 1000
const MAX_FILES_LISTED = 25
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "dist-test",
  "out",
  "build",
  "coverage",
  "target",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  ".git",
])

const toPosix = (value: string) => value.split(path.sep).join("/")

// The author's opencode.jsonc is the only place the one-writer permission rule
// can live, and this module no longer sits next to it (it lives in src/plugins/,
// one directory deeper, and in an installed package there is no opencode.jsonc at
// all). So walk up from here rather than assuming "..": repo checkout
// (src/plugins -> repo root) is found in one step, an installed package finds
// nothing in three and verifyWriterRule returns undefined, which is the correct
// answer for a user who has no config of their own.
const findProjectConfig = (): string | undefined => {
  let dir = (import.meta as { dir?: string }).dir ?? path.dirname(new URL(import.meta.url).pathname)
  for (let up = 0; up <= 3; up++) {
    const candidate = path.join(dir, "opencode.jsonc")
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

// A cartographer that cannot write reports success anyway: prompt() resolves, no
// error is raised, and the run logs "finished". That is how the map sat stale for
// three days while every run claimed it had applied changes -- the one-writer
// permission rule silently matched nothing. Count what actually changed on disk
// instead of what was offered to it, so a blocked run is distinguishable.
const snapshotMap = (dir: string) => {
  const out = new Map<string, string>()
  try {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      try {
        const st = statSync(file)
        if (st.isFile()) out.set(name, `${st.size}:${st.mtimeMs}`)
      } catch {}
    }
  } catch {}
  return out
}

const changedSince = (before: Map<string, string>, dir: string) => {
  const after = snapshotMap(dir)
  let changed = 0
  for (const [name, stamp] of after) if (before.get(name) !== stamp) changed++
  for (const name of before.keys()) if (!after.has(name)) changed++
  return changed
}

// NOTE: this module exports the hook factory and nothing else. opencode treats
// every export of a file under plugins/ as a plugin, calls it with the plugin
// input, and uses the return value as a hooks object. A stray export that returns
// undefined poisons the shared hook registry and breaks every hook dispatch in
// the process. See the note at the top of ./agent-pool.ts.

// A factory returning hooks, not a Plugin -- see the note in ./agent-pool.ts.
export const contextAutoUpdateHooks = (async ({ client, directory }): Promise<Hooks> => {
  const pending = new Set<string>()
  const owned = new Map<string, number>()
  let lastRun = 0
  const state = pool.state()

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => {})

  const root = path.resolve(directory)
  const contextAbs = path.join(root, CONTEXT_DIR)

  // Fail loudly and immediately rather than weeks later as a silently stale map.
  const config = findProjectConfig()
  const writerProblem = config ? verifyWriterRule(config, contextAbs, root) : undefined
  if (writerProblem) void log("error", writerProblem)

  const isTracked = (file: string) => {
    const absolute = path.resolve(root, file)
    // Only edits inside this project belong to this project's map.
    if (absolute !== root && !absolute.startsWith(root + path.sep)) return false
    // Never let the cartographer's own writes re-trigger it.
    if (absolute === contextAbs || absolute.startsWith(contextAbs + path.sep)) return false
    return !toPosix(absolute)
      .split("/")
      .some((segment) => IGNORED_SEGMENTS.has(segment))
  }

  const listed = (files: string[]) => {
    const shown = files.slice(0, MAX_FILES_LISTED)
    const rest = files.length - shown.length
    const lines = shown.map((file) => `- ${toPosix(file)}`).join("\n")
    return rest > 0 ? `${lines}\n- …and ${rest} more (check git status for the full set)` : lines
  }

  const compose = (mode: "bootstrap" | "update", files: string[]) =>
    mode === "bootstrap"
      ? [
          "Bootstrap the repository context map. Project root: " + directory,
          "",
          "`.opencode/context/` does not exist yet.",
          "",
          "This session touched these paths (starting context, not an exhaustive list):",
          listed(files),
          "",
          "Follow the bootstrap procedure in your system prompt: progressive exploration, then write the five context files within their size targets. When the project already has architecture or decision documentation, link to it instead of duplicating it. Write conclusions, not inventories.",
        ].join("\n")
      : [
          "Incremental context update. Project root: " + directory,
          "",
          "This session touched these paths (start from these and their immediate architectural neighborhood):",
          listed(files),
          "",
          'Follow the incremental-update procedure in your system prompt. Update a context file only if this work introduced or revealed information that will materially help future agents: a new boundary or module, a new or moved canonical entry point, a changed workflow, a new convention, an architectural decision, a new dependency between subsystems, a renamed or moved subsystem, or a previously undocumented invariant. Do not edit documentation merely because source files changed. If nothing material changed, make no edits and report "no update needed".',
        ].join("\n")

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "file.edited") {
          if (isTracked(event.properties.file)) pending.add(event.properties.file)
          return
        }

        if (event.type !== "session.idle") return

        const sessionID = event.properties.sessionID
        if (owned.delete(sessionID)) {
          lastRun = Date.now()
          return
        }
        // A cartographer that never reports back must not disable autoupdate
        // for the rest of the process lifetime.
        const now = Date.now()
        for (const [id, startedAt] of owned) if (now - startedAt > OWNED_TTL_MS) owned.delete(id)
        if (owned.size > 0) return
        if (Date.now() - lastRun < COOLDOWN_MS) return
        if (pending.size === 0) return

        const info = await client.session
          .get({ path: { id: sessionID }, query: { directory } })
          .then((result) => result.data)
          .catch(() => undefined)
        if (!info) return
        // Child sessions (subagents) go idle mid-task; the root session always
        // idles last.
        if (info.parentID) return

        // Consume only the paths this run covers: edits made while the cartographer
        // is working must survive for the next window. Requeue them if we fail to
        // get a session off the ground — losing them would strand the map.
        const files = [...pending]
        for (const file of files) pending.delete(file)
        const requeue = () => {
          for (const file of files) pending.add(file)
        }

        const mode = existsSync(contextAbs) ? "update" : "bootstrap"

        // Borrow a slot from the shared free-model pool. This agent is spawned
        // through the session API rather than the task tool, so it never passes
        // through the pool plugin's routing hook and must pick a slot itself.
        pool.init(state, (m) => void log("warn", m))
        const snap = pool.snapshot(state)
        const slot = pool.pickSlot(state, snap)
        const agent = pool.agentFor("context", slot.index)

        const created = await client.session.create({
          body: { title: `context (auto ${mode})` },
          query: { directory },
        })
        const target = created.data?.id
        if (!target) {
          requeue()
          await log("warn", "could not create context session")
          return
        }

        // Claim the slot against the session that does the work, so pool_status
        // counts it and the pool's hang reaper can abort this session directly.
        const claimKey = pool.claimKey(target, "context-autoupdate")
        pool.acquire(state, "context", slot, target, claimKey, target)
        await log("info", `borrowed pool slot ${slot.index} (${slot.model}, w${slot.weight}) for auto ${mode}`, {
          slot: slot.index,
          weight: slot.weight,
          model: slot.model,
        })

        // Only now is a run genuinely under way, so this is where the cooldown
        // starts. Nothing before this point should delay a retry.
        lastRun = Date.now()
        owned.set(target, Date.now())
        const before = snapshotMap(contextAbs)
        client.session
          .prompt({
            path: { id: target },
            query: { directory },
            body: { agent, parts: [{ type: "text", text: compose(mode, files) }] },
          })
          .then(async (result) => {
            pool.release(state, claimKey)
            // prompt() resolves when the turn ends — including when it ends in
            // an abort (host shutting down) or an error. Only report success
            // when the assistant message actually completed.
            const failure = result.error ?? result.data?.info?.error
            if (failure) {
              requeue()
              await log("warn", `auto ${mode} did not complete`, {
                sessionID: target,
                files: files.length,
                error: failure.name ?? String(failure),
              })
              return
            }
            // Report what landed on disk, not what was offered to the cartographer.
            // A run that was blocked from writing resolves exactly like one that
            // succeeded, so the file count is the only honest signal available.
            const changed = changedSince(before, contextAbs)
            if (changed > 0) {
              await log("info", `auto ${mode} finished`, { sessionID: target, considered: files.length, changed })
            } else {
              await log("warn", `auto ${mode} finished without changing the map`, {
                sessionID: target,
                considered: files.length,
                changed: 0,
                hint: "either nothing needed updating, or the cartographer could not write -- check the one-writer permission rule",
              })
            }
          })
          .catch(async (error) => {
            pool.release(state, claimKey)
            requeue()
            await log("error", `auto ${mode} failed: ${String(error)}`)
          })
      } catch (error) {
        await log("error", `handler failed: ${String(error)}`)
      }
    },
  }
})
