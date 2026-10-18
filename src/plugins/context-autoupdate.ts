import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"
import type { Hooks, PluginOptions } from "@opencode-ai/plugin"
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
  // Generated payloads. These are OUTPUT, not source: a single decoded corpus or
  // derived report in one of these is routinely tens of megabytes, and an agent
  // that samples one with `head`/`cat` produces a tool output large enough to
  // be worth recording on its own.
  "derived_outputs",
  "derived",
  "artifacts",
  "corpus",
  "corpora",
])

// What the cartographer must NOT read, and why this is stated rather than left
// to judgement.
//
// A tool output is not a local variable: opencode persists it as a
// `message.part.updated` event carrying the whole payload, and that log is
// append-only. So one `cat` of a minified bundle or a decoded corpus does not
// cost a few KB of context -- it costs megabytes of database, permanently, and
// the process holds that growth in memory. IGNORED_SEGMENTS above cannot prevent
// it: that set only decides whether an EDIT re-triggers this agent, while the
// read that does the damage is the agent's own choice, made from its prompt.
//
// The rule is therefore in the prompt, and it points at the alternative rather
// than only the prohibition: the file that PRODUCES the payload is the thing that
// carries architectural meaning, and it is orders of magnitude smaller.
const NO_BULK_READS = [
  "Do not read generated, vendored or corpus payloads: `node_modules/`, `dist/`,",
  "`build/`, `out/`, `*.min.js`, `derived_outputs/`, `*.bytes`, and large `.json`/`.csv`",
  "corpora. They are megabytes each and describe no architecture. Read the source",
  "that PRODUCES or CONSUMES them instead. If a payload must be sampled, use",
  "`head -c 2000` or `wc -c` — never `cat` or a bare `grep -r` across one.",
].join(" ")

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

/** How many finished cartographer transcripts to keep on disk. */
const RETAIN_TRANSCRIPTS = 20
// Resolved LAZILY, at call time, and never cached: `os.homedir()` reads HOME when
// it is called, so a test that redirects HOME gets its own directory for free.
// Computing it once at module load would pin the real one and let the suite write
// into the developer's data directory.
const transcriptDir = () =>
  process.env.LACODE_TRANSCRIPT_DIR ?? path.join(homedir(), ".local", "share", "opencode", "lacode", "cartographer")

/**
 * Take a finished cartographer session out of the user's session list, keeping
 * its transcript somewhere readable.
 *
 * The obvious alternative — nest it under the session that triggered it, so
 * opencode's list (which shows only root sessions) skips it — is unsafe. Nesting
 * makes it a child of a root that is holding unbound claims for its own in-flight
 * explore tasks, and `pool.bindChild` adopts a fresh child into exactly such a
 * claim; the reaper would then abort the cartographer as though it were the hung
 * task. Archiving is not available either: 1.18.34 exposes no archive method and
 * `session.list` takes only `directory`.
 *
 * So the session is written out and then deleted. The transcript is the point:
 * deleting without it would lose the only record of what the cartographer did,
 * and the user asked to be able to look without it cluttering the list.
 *
 * Never throws. Retiring is housekeeping; a failure here must not be able to
 * fail the autoupdate run that triggered it.
 */
const retireSession = async (
  client: { session: { messages: (o: unknown) => Promise<unknown>; delete: (o: unknown) => Promise<unknown> } },
  directory: string,
  sessionID: string,
  mode: string,
) => {
  try {
    const transcript = await client.session
      .messages({ path: { id: sessionID }, query: { directory } })
      .then((r) => (r as { data?: unknown }).data)
      .catch(() => undefined)
    const dir = transcriptDir()
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const file = path.join(dir, `${stamp}-${mode}.json`)
    writeFileSync(file, JSON.stringify({ sessionID, mode, messages: transcript ?? null }, null, 2))
    pruneTranscripts(dir)
    await client.session.delete({ path: { id: sessionID }, query: { directory } }).catch(() => undefined)
  } catch {
    /* an unreadable or undeletable session stays in the list; that is survivable */
  }
}

// Oldest-first, by the timestamp in the filename. Bounded so a long-lived server
// does not trade a cluttered list for a cluttered disk.
const pruneTranscripts = (dir: string) => {
  try {
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
    for (const name of entries.slice(0, Math.max(0, entries.length - RETAIN_TRANSCRIPTS))) {
      try { unlinkSync(path.join(dir, name)) } catch {}
    }
  } catch {
    /* no transcripts yet */
  }
}

// NOTE: this module exports the hook factory and nothing else. opencode treats
// every export of a file under plugins/ as a plugin, calls it with the plugin
// input, and uses the return value as a hooks object. A stray export that returns
// undefined poisons the shared hook registry and breaks every hook dispatch in
// the process. See the note at the top of ./agent-pool.ts.

// A factory returning hooks, not a Plugin -- see the note in ./agent-pool.ts.
export const contextAutoUpdateHooks = (async ({ client, directory }, options?: PluginOptions): Promise<Hooks> => {
  const pending = new Set<string>()
  const owned = new Map<string, number>()
  let lastRun = 0
  // Same state identity the agent-pool uses (id, dir, models source) so the
  // borrow and the pool it borrows from can never disagree about the slots.
  // Passing the options through is what lets a test pin modelsFile: PRESET and
  // keeps the plugin honouring a user's explicit slot options.
  const state = pool.state(options as { id?: string; dir?: string; modelsFile?: string; models?: unknown } | undefined)

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
          NO_BULK_READS,
          "",
          "Follow the bootstrap procedure in your system prompt: progressive exploration, then write the five context files within their size targets. When the project already has architecture or decision documentation, link to it instead of duplicating it. Write conclusions, not inventories.",
        ].join("\n")
      : [
          "Incremental context update. Project root: " + directory,
          "",
          "This session touched these paths (start from these and their immediate architectural neighborhood):",
          listed(files),
          "",
          NO_BULK_READS,
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
        // A pool probe is a root session like any other, and it goes idle within
        // seconds — so without this its idleness would start a cartographer run the
        // user never asked for, borrowing a slot and editing the map on the strength
        // of a health check. The prober shares this state object precisely so this
        // check is possible (see State.probes).
        if (pool.isProbe(state, sessionID)) return
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

        // Keyed on a generated map file, not on the directory: an existing but
        // otherwise empty context directory would otherwise report "update" for a
        // project that has no map at all and skip the bootstrap entirely.
        const mode = existsSync(path.join(contextAbs, "contexts.md")) ? "update" : "bootstrap"

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
            // Retire the session from the list as soon as it is done with, and
            // only AFTER writing its transcript somewhere the user can still read
            // it. See retireSession for why it cannot simply be nested away.
            await retireSession(client, directory, target, mode)
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
            await retireSession(client, directory, target, mode)
            requeue()
            await log("error", `auto ${mode} failed: ${String(error)}`)
          })
      } catch (error) {
        await log("error", `handler failed: ${String(error)}`)
      }
    },
  }
})
