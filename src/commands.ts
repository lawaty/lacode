// Slash commands as DATA, injected through the config hook.
//
// Like the agents, the templates are inline strings rather than pointers at
// `commands/*.md`: the injected form has to survive being resolved from a
// node_modules directory the package does not control, and `$ARGUMENTS` is
// substituted by opencode, not by us.
//
// All three delegate to `context`, which is a pooled agent: spawning it
// borrows a slot and the pool's own load balancing applies.
//
// ---------------------------------------------------------------------------
// MERGE-WITHOUT-CLOBBER (US-16)
// ---------------------------------------------------------------------------
//
// A command name that already exists in the user's config is left untouched. A
// user who wrote their own `/context-update` keeps it; this set only fills the
// names nobody has taken.

export type CommandDef = {
  template: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
}

export const COMMANDS: Record<string, CommandDef> = {
  "context-init": {
    description:
      "Bootstrap the repository context map (.opencode/context/) via the context agent.",
    agent: "context",
    subtask: true,
    template: `Bootstrap the repository context map.

If \`.opencode/context/\` already exists, do NOT start over — verify and refresh
it in place (correct stale entries, fill gaps) using the review procedure in
your system prompt.

Otherwise follow the bootstrap procedure in your system prompt: progressive
exploration (README → existing docs → manifests → top-level structure → build
and framework config → entry points → selective source), then write the five
context files inside their size targets.

Remember: write conclusions, not inventories. Link to the project's existing
documentation instead of duplicating it.

Report what you created or updated, what you deliberately left out, and
anything that contradicts the code or existing docs.`,
  },

  "context-update": {
    description:
      "Incrementally update .opencode/context/ after recent work via the context agent.",
    agent: "context",
    subtask: true,
    template: `Incremental context update.

Focus: $ARGUMENTS

If no focus was given, establish the recent work yourself (git status, git
diff, git log) and start from those changed files plus their immediate
architectural neighborhood.

Follow the incremental-update procedure in your system prompt: update a
context file only if this work introduced or revealed information that will
materially help future agents — a new boundary or module, a new or moved
canonical entry point, a changed workflow, a new convention, an architectural
decision, a new dependency between subsystems, a renamed or moved subsystem,
or a previously undocumented invariant.

Do not edit documentation just because source files changed. No
timestamp-only edits. If nothing material changed, make no edits and report
"no update needed".`,
  },

  "context-review": {
    description:
      "Audit .opencode/context/ for staleness, contradictions, excess size, duplication, and missing entry points.",
    agent: "context",
    subtask: true,
    template: `Context review.

Everything outside \`.opencode/context/\` is read-only for this run. Do not
modify source code under any circumstances.

Audit the five context files for:

- stale information — verify claims against the actual code
- contradictions between context files, or between the map and the code
- excessive size — consolidate toward the per-file targets in your system
  prompt
- duplicated information — one canonical place per fact; link to the
  project's own docs rather than restating them
- missing canonical entry points for significant subsystems
- unsupported assumptions — anything stated as fact that you cannot verify,
  or that lacks a confidence marker

Fix what you find in \`.opencode/context/\` only, then report: findings, fixes,
and anything you could not verify.`,
  },
}

/** Add every command the user's config does not already define (US-16). */
export function applyCommands(
  cfg: Record<string, unknown>,
  commands: Record<string, CommandDef> = COMMANDS,
): { added: string[]; kept: string[] } {
  const target = (cfg.command ??= {}) as Record<string, CommandDef>
  const added: string[] = []
  const kept: string[] = []
  for (const [name, def] of Object.entries(commands)) {
    if (target[name] !== undefined) {
      kept.push(name)
      continue
    }
    target[name] = JSON.parse(JSON.stringify(def)) as CommandDef
    added.push(name)
  }
  return { added, kept }
}

/**
 * A standing instruction for every agent in every project, mirroring the AGENTS.md
 * rule in the author's own setup: check the repository context map before broad
 * exploration.
 *
 * Injected ONLY when the user has no `instructions` array at all. Appending to a
 * list the user curated would silently rewrite their standing rules, which is the
 * one thing US-16 forbids; someone who wants this and already has instructions
 * adds the file themselves.
 */
export const STANDING_INSTRUCTION = `## Repository context map

This project may keep a navigation map in \`.opencode/context/\`. Before broad
exploration, check whether it exists (\`ls .opencode/context\` — never the \`glob\`
tool, which skips hidden directories). If it does, read only the file relevant to
the task — architecture.md, contexts.md, conventions.md, workflows.md,
decisions.md — then start from the canonical entry points it lists.

Source code is authoritative: if the map disagrees with the code, trust the code,
say so, and never edit source to match the map. Never edit \`.opencode/context/\`
yourself — the context agent owns it. Say in your final report if your
work revealed something that belongs in the map.`

/** Inject the standing instruction only when the user has none (US-16). */
export function applyInstructions(cfg: Record<string, unknown>): { added: boolean } {
  const existing = cfg.instructions
  if (Array.isArray(existing) && existing.length > 0) return { added: false }
  cfg.instructions = [STANDING_INSTRUCTION]
  return { added: true }
}