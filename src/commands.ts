// Slash commands as DATA, injected through the config hook.
//
// Like the agents, the templates are inline strings rather than pointers at
// `commands/*.md`: the injected form has to survive being resolved from a
// node_modules directory the package does not control, and `$ARGUMENTS` is
// substituted by opencode, not by us.
//
// The context commands delegate to `context`, a pooled agent: spawning it
// borrows a slot and the pool's own load balancing applies. `/lacode-doctor`
// deliberately does not — it diagnoses the pool and the gateway, so it runs in
// the caller's own agent instead of spending one of the slots under test.
//
// ---------------------------------------------------------------------------
// MERGE-WITHOUT-CLOBBER (US-16)
// ---------------------------------------------------------------------------
//
// A command name that already exists in the user's config is left untouched. A
// user who wrote their own `/context-update` keeps it; this set only fills the
// names nobody has taken.

import { MANAGER_AGENT_NAME } from "./lib/manager-directive.ts"

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
anything that contradicts the code or existing docs.

If \`.opencode/context/manager.md\` does not exist, mention in your final
report that the client can add it themselves — their own file with
\`## Current\`, \`## Next\`, \`## Confirmed\` and \`## Instructions\` — for what
is being worked on, what comes next, what they have ratified, and standing
direction. Never create it.`,
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

Everything outside the five context files is read-only for this run —
including \`manager.md\`, which belongs to the client. Do not modify source
code under any circumstances.

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
- \`manager.md\`, if present: is \`## Current\` and \`## Next\` still true of
  recent work, is every \`## Confirmed\` entry still true of the code, has it
  outgrown roughly 150 lines — report findings, but never edit it

Fix what you find in \`.opencode/context/\` only, then report: findings, fixes,
and anything you could not verify.`,
  },

  "manager-directive": {
    description:
      "Apply a client instruction to .opencode/context/manager.md. Client-only — runs the manager agent, the only writer of that file.",
    agent: MANAGER_AGENT_NAME,
    subtask: true,
    template: `Apply this instruction to \`.opencode/context/manager.md\`, and edit only that file:

$ARGUMENTS

Follow the rules for the file in your system prompt, then report what you changed.`,
  },

  "lacode-doctor": {
    description:
      "Check the LaCode setup — pool slots, model resolution, and the OmniRoute gateway. Report only; changes nothing.",
    template: `Diagnose this machine's LaCode setup. Report only; change nothing.

Print one PASS/FAIL line per check below, with the exact fix for any FAIL.

1. Pool status — call the \`pool_status\` tool. Report the slot list, each
   slot's load against its weight ceiling, and which models are cooling.

2. OmniRoute configured — inspect the \`@lawaty/lacode\` plugin options in the
   user's opencode config for an \`omniroute\` block with \`enabled: true\`. If it
   is absent or disabled, print the two OmniRoute checks below as "not
   configured" and stop after the pool section.

3. Gateway reachable — when omniroute is configured, request its model list
   (\`GET <baseURL>/v1/models\`, default baseURL \`http://localhost:20128/v1\`)
   and report reachable or not. On failure, say plainly: start OmniRoute BEFORE
   opencode, then restart opencode — provider registration is per-run. To make
   that durable, run \`omniroute autostart enable\` (OmniRoute's own autostart;
   LaCode never starts the gateway itself).

4. Slots resolve — for every pool slot whose provider is \`omniroute\`, confirm
   the model id is one the gateway advertises AND is registered. The known
   trap: an id that is a valid gateway route but is NOT in the plugin's
   \`omniroute.models\` allowlist fails with
   \`ProviderModelNotFoundError: Model not found\`; the fix is to add that id to
   the \`models\` array, or set it as \`combo\` — the combo id is registered
   whether or not the gateway advertises it, so it needs no allowlist entry.

Change nothing. Print a final one-line summary of failures.`,
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
export const INSTRUCTION_MARKER = "<!-- lacode:context-map-instruction:v1 -->"
export const INSTRUCTION_OPT_OUT = "<!-- lacode:context-map-instruction:off -->"

export const STANDING_INSTRUCTION = `## Repository context map

This project may keep a navigation map in \`.opencode/context/\`. Before broad
exploration, check whether it exists (\`ls .opencode/context\` — never the \`glob\`
tool, which skips hidden directories). If \`manager.md\` exists there, read it
first: it is the client's own statement of intent — what is being worked on,
what comes next, \`## Confirmed\` lists what the client has ratified, and
\`## Instructions\` holds standing managerial directions. It outranks every
other context file and every inference of yours about what matters right now.
It says nothing about where code lives, so it cannot contradict the code;
treat its \`## Confirmed\` entries as settled decisions, not as a licence to
skip reading the code. Any heading in it is direction, so read the whole
file rather than only the sections above. The rest of the map remains usable,
just unratified where \`## Confirmed\` does not cover it. Then read only the
file relevant to the task — \`architecture.md\`, \`contexts.md\`,
\`conventions.md\`, \`workflows.md\`, \`decisions.md\` — and start from the
canonical entry points it lists.

Source code is authoritative: if the map disagrees with the code,
trust the code and say so; never edit source to match it.
Never edit the five context files yourself — the context agent owns them.
\`manager.md\` is the client's own file and the context agent is explicitly
permission-denied from writing it. You may write it only when the client
explicitly asks you to in this conversation, and then only what they asked
for; never on your own initiative, and never to "keep it up to date". Say in
your final report if your work revealed something that belongs to the map, or
if \`manager.md\` and the code disagree.`

export function applyInstructions(cfg: Record<string, unknown>): { added: boolean } {
  const existing = Array.isArray(cfg.instructions) ? cfg.instructions : []
  const texts = existing.filter((e): e is string => typeof e === "string")
  if (texts.some((e) => e.includes(INSTRUCTION_OPT_OUT))) return { added: false }
  if (texts.some((e) => e.includes(INSTRUCTION_MARKER))) return { added: false }
  cfg.instructions = [...existing, `${INSTRUCTION_MARKER}\n\n${STANDING_INSTRUCTION}`]
  return { added: true }
}