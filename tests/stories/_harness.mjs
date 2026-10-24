// Shared scaffolding for the story suites.
//
// Deliberately NOT a test file: it defines no `test()`, so `node --test` globs
// `*.test.mjs` only and this file is never run as a suite.
//
// What lives here is the machinery every epic needs, so each epic file stays a
// list of Given/When/Then rather than a pile of boilerplate:
//
//   * a stub `PluginInput` that records every app log line and answers
//     `session.get` from a table the test controls
//   * a fake clock. Every timeout in this package (cooldowns, claim TTL, hang
//     reaping) is `Date.now()`-derived, so overriding `Date.now` is the only
//     seam needed to test hours of pool behaviour in microseconds.
//   * a fresh claim directory per pool instance, so suites never see each
//     other's state and never touch ~/.local/share
//
// Nothing here reaches the network, spawns a real model, or sleeps for a wall
// clock second longer than it must.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, "..", "..")
export const PRESET = join(ROOT, "presets", "free-tier.json")
export const SNAPSHOT = join(ROOT, "tests", "models-snapshot.json")
export const STORIES_DOC = join(ROOT, "docs", "USER-STORIES.md")

/** The bundled preset, as data. Presets are the source of truth for the pool. */
export const preset = () => JSON.parse(readFileSync(PRESET, "utf8"))
export const presetModels = () => preset().slots.map((s) => s.model)

/** model id -> { cost_input, cost_output, ... }, from the pinned models.dev snapshot. */
export const snapshot = () => JSON.parse(readFileSync(SNAPSHOT, "utf8"))
export const snapshotModels = () => snapshot().models

export const scratch = (prefix = "lacode-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const cleanup = []
export const cleanupAll = () => {
  for (const fn of cleanup.splice(0)) fn()
}

// The notification plugin claims the (session, kind) pair before it raises a
// popup, so that two processes never raise the same one. The claim lives in
// the notification state directory, and a suite must not write into the
// developer's own data directory -- so the directory is redirected into a
// scratch one, per suite, before anything loads the plugin.
//
// It is also what keeps two suites from colliding: the claim is CROSS-PROCESS,
// and `node --test` runs the files in parallel processes. Two files sharing a
// state directory would fight over the same session ids, and one of them would
// lose a notification it was supposed to raise.
process.env.LACODE_NOTIFY_DIR = scratch("lacode-notify-")

/**
 * A controllable clock.
 *
 * `Date.now` is patched process-wide, which is what every consumer of time in
 * src/lib/pool.ts reads. Suites that install one must call `clock.restore()`;
 * `cleanupAll()` does it too, so a suite that throws cannot leak a fake clock
 * into the next file (node --test runs files in separate processes, but the
 * ordering inside a file still matters).
 */
export const fakeClock = (start = 1_700_000_000_000) => {
  const real = Date.now
  let now = start
  Date.now = () => now
  const restore = () => {
    Date.now = real
  }
  cleanup.push(restore)
  return {
    now: () => now,
    /** Move time forward. Nothing waits: every consumer reads the value. */
    advance(ms) {
      now += ms
      return now
    },
    set(value) {
      now = value
      return now
    },
    restore,
  }
}

/**
 * A stub PluginInput.
 *
 * `sessions` maps a session id to what `session.get` should answer. An id that
 * is absent resolves to undefined, which is the "session info unavailable" path
 * the real client produces for a deleted session.
 *
 * `created` collects `session.create` calls (context-autoupdate borrows a slot
 * that way, bypassing the task hook entirely).
 */
export const stubInput = ({ sessions = {}, directory = "/tmp/lacode-story", created = [], prompts = [], messages = [], deleted = [], sessionMessages = {} } = {}) => {
  const lines = []
  const client = {
    app: {
      log: async ({ body }) => {
        void lines.push({ level: body.level, message: body.message, service: body.service, extra: body.extra })
      },
    },
    session: {
      get: async ({ path: p }) => ({ data: sessions[p.id] }),
      create: async ({ body }) => {
        created.push(body)
        return { data: { id: `created-${created.length}` } }
      },
      prompt: async (input) => {
        prompts.push(input)
        return { data: { info: {} } }
      },
      // The cartographer retires its own session once the turn ends: it writes the
      // transcript out and then deletes the session so it stops appearing in the
      // user's session list. Both are observable here.
      messages: async ({ path: p }) => {
        messages.push(p.id)
        if (sessionMessages[p.id]) {
          return { data: sessionMessages[p.id] }
        }
        return { data: [{ info: { id: "m1" }, parts: [{ type: "text", text: `transcript for ${p.id}` }] }] }
      },
      delete: async ({ path: p }) => {
        deleted.push(p.id)
        return { data: true }
      },
      abort: async ({ path }) => {
        const res = await fetch(`http://localhost/session/${path.id}/abort`, { method: "POST" })
        const text = (await res.text()).trim()
        return { data: text === "true" ? true : text === "false" ? false : undefined, response: res, error: undefined, request: undefined }
      },
    },
  }
  return {
    client,
    directory,
    input: { client, directory, serverUrl: new URL("http://127.0.0.1:59999"), worktree: ROOT },
    lines,
    /** Log lines rendered as "level message", for substring assertions. */
    text: () => lines.map((l) => `${l.level} ${l.message}`),
    created,
    prompts,
    messages,
    deleted,
    sessionMessages,
  }
}

/** Build the hook object the way opencode does: default export + PluginInput. */
export const bootLaCode = async (stub, options = {}) => {
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))
  // Pin the pool to the bundled preset unless the caller overrides the source.
  // Without this the pool falls through to the real ~/.config/lacode/pool.txt,
  // so a developer's own slot list silently changes what these tests assert.
  // An inline `models` (which resolveModels prefers) still wins; a caller's own
  // `modelsFile` still wins via the spread.
  const hooks = await LaCode(stub.input, { modelsFile: PRESET, ...options })
  return hooks
}

/** A minimal but structurally real opencode config for the config hook. */
export const emptyConfig = () => ({ model: "some/provider", provider: { some: { whitelist: [] } }, agent: {}, command: {} })

/** A config whose providers are derived from the given model ids. */
export const configFor = (models) => {
  const provider = {}
  for (const model of models) {
    const slash = model.indexOf("/")
    const name = model.slice(0, slash)
    const id = model.slice(slash + 1)
    provider[name] ??= { whitelist: [] }
    provider[name].whitelist.push(id)
  }
  return { provider, agent: {}, command: {} }
}

/**
 * Route one spawn through the real tool.execute.before hook and report what the
 * plugin decided, both as the rewritten agent name and as the model that agent
 * was bound to.
 */
export const spawn = async (hooks, cfg, { subagent = "explore", callID = "c1", sessionID = "s1" } = {}) => {
  const out = { args: { subagent_type: subagent, prompt: "read src/index.ts" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
  const routed = out.args.subagent_type
  return { routed, model: cfg.agent?.[routed]?.model }
}

/** Fire an event at a plugin's event hook. */
export const emit = async (hooks, type, properties) => hooks.event?.({ event: { type, properties } })

/** Let already-queued microtasks and unref'd timers settle. */
export const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A recursive copy that skips node_modules and .git.
 *
 * Used to build an "installed package" fixture: the published `files` list
 * ships `dist/` and `presets/` and NOT `bin/oc-notify`, which is precisely why
 * the notify plugin's helper lookup can come up empty in the wild.
 */
export const copyTree = (from, to, { skip = new Set(["node_modules", ".git"]) } = {}) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    if (skip.has(entry)) continue
    const src = join(from, entry)
    if (statSync(src).isDirectory()) copyTree(src, join(to, entry), { skip })
    else copyFileSync(src, join(to, entry))
  }
  return to
}