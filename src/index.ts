// LaCode — the published plugin. This file is the ONLY module in `src/` that
// exports a plugin, and it is the package's `.` export.
//
// WHY ONLY ONE: opencode loads every file under `plugins/`, calls EVERY export of
// each one with the plugin input, and uses the return value as that file's hooks
// object. A second export returning `undefined` poisons the shared hook registry
// and stops the process starting. So `src/plugins/*.ts` are hook FACTORIES --
// plain async functions returning hook objects -- and this file calls them and
// merges what they return into one hooks object.
//
// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------
//
//   // opencode.json / opencode.jsonc
//   { "plugin": [["@lawaty/lacode", { /* options, all optional */ }]] }
//
//   PluginOptions (Record<string, unknown>):
//
//     enabled?: boolean
//       The single off switch (US-17). `enabled: false` performs NO config
//       injection at all -- no pool model rewriting, no agent injection, no
//       command injection, no instruction injection -- and returns hooks that do
//       nothing. It never throws, and it short-circuits before any factory runs,
//       so no reaper timer is armed and no ~/.config/lacode directory is created.
//
//     models?: { slots: Array<{ model: string; weight?: number }> }
//       An inline slot list, the highest-priority pool source. Any model id is
//       accepted, free or paid (US-7); only structure is validated.
//
//     reapMs?: number        reaper interval, default 30s
//     id?: string            process identity for the claim files (tests)
//     dir?: string           claim directory (tests)
//     modelsFile?: string    an explicit slot file, short-circuits the chain
//
// ---------------------------------------------------------------------------
// POOL PRESET RESOLUTION CHAIN, in priority order
// ---------------------------------------------------------------------------
//
//   1. options.models                        ["@lawaty/lacode", { models }]
//   2. ~/.config/lacode/pool.json            created (empty parent) at startup
//   3. presets/free-tier.json                bundled with the package
//   ...and, failing all three, a built-in fallback so routing always works.
//
// Missing, unreadable or structurally broken falls through silently to the next
// link and logs a warning; nothing here ever throws into opencode. The bundled
// preset happens to be built from free models, but no part of the pool inspects
// what a model costs: cost is the user's decision. See presets/README.md and the
// header of src/lib/pool.ts.
//
// ---------------------------------------------------------------------------
// MERGE-WITHOUT-CLOBBER (US-16)
// ---------------------------------------------------------------------------
//
// Every agent, command and instruction this plugin adds is added ONLY when the
// key is absent from the user's config. A user-defined agent is never
// overwritten, patched, or partially merged. Skips are counted and logged once,
// not warned about one by one.
//
// Ordering inside the config hook is load-bearing: agents go in FIRST so the pool
// has variant agents to bind models to, and the pool binds LAST because binding
// writes into exactly the objects the agent injection just created.

import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { applyAgents, buildAgentSet } from "./agents.ts"
import { applyCommands, applyInstructions } from "./commands.ts"
import { agentPoolHooks } from "./plugins/agent-pool.ts"
import { contextAutoUpdateHooks } from "./plugins/context-autoupdate.ts"
import { notifyHooks } from "./plugins/notify.ts"

export type LacodeOptions = {
  enabled?: boolean
  models?: unknown
  reapMs?: number
  id?: string
  dir?: string
  modelsFile?: string
  [key: string]: unknown
}

/** Hooks that do nothing at all. Used by the `enabled: false` off switch. */
const inertHooks: Hooks = {
  config: async () => {},
  event: async () => {},
  dispose: async () => {},
}

const LaCode = (async (input: PluginInput, options?: PluginOptions) => {
  const opts = (options ?? {}) as LacodeOptions

  if (opts.enabled === false) return inertHooks

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    input.client.app.log({ body: { service: "lacode", level, message, extra } }).catch(() => {})

  // Everything below can reject -- a factory that arms a timer, a config hook
  // that reads a file -- and a rejected plugin stops opencode from starting. So
  // each piece is isolated and a failure costs one feature, not the process.
  const settled = async <T>(label: string, make: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await make()
    } catch (error) {
      await log("error", `${label} failed to start: ${String(error)}`)
      return undefined
    }
  }

  const agentSet = buildAgentSet()
  const pool = (await settled("agent-pool", () => agentPoolHooks(input, options))) ?? inertHooks
  const autoupdate = (await settled("context-autoupdate", () => contextAutoUpdateHooks(input, options))) ?? inertHooks
  const notifier = (await settled("notify", () => notifyHooks(input, options))) ?? inertHooks

  // Order is the whole design: the pool must see variant agents that already
  // exist, and the agent set must exist before the pool writes models into it.
  const config = async (cfg: Parameters<NonNullable<Hooks["config"]>>[0]) => {
    try {
      const injected = applyAgents(cfg as Record<string, unknown>, agentSet)
      if (injected.added.length > 0) {
        await log("info", `agents: added ${injected.added.length}, kept ${injected.kept.length} already defined by the user`)
      }
      const cmds = applyCommands(cfg as Record<string, unknown>)
      if (cmds.added.length > 0) {
        await log("info", `commands: added ${cmds.added.join(", ")}; kept ${cmds.kept.join(", ") || "none"} already defined`)
      }
      if (applyInstructions(cfg as Record<string, unknown>).added) {
        await log("info", "instructions: added the standing context-map rule (no user instructions were present)")
      }
      await pool.config?.(cfg)
    } catch (error) {
      await log("error", `config hook failed: ${String(error)}`)
    }
  }

  const event = async (payload: Parameters<NonNullable<Hooks["event"]>>[0]) => {
    await Promise.all([
      pool.event?.(payload).catch(() => {}),
      autoupdate.event?.(payload).catch(() => {}),
      notifier.event?.(payload).catch(() => {}),
    ])
  }

  return {
    config,
    event,
    // Both tool hooks and the tool registry come from the pool alone: it is the
    // only thing that routes task calls, so there is nothing to merge them with.
    "tool.execute.before": pool["tool.execute.before"],
    "tool.execute.after": pool["tool.execute.after"],
    tool: pool.tool,
    dispose: async () => {
      await pool.dispose?.()
      await autoupdate.dispose?.()
      await notifier.dispose?.()
    },
  } satisfies Hooks
}) satisfies Plugin

export default LaCode