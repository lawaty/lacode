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

import { AGENT_INSTRUCTIONS_COMMAND, AGENT_INSTRUCTIONS_WRITER } from "./lib/agent-instructions.ts"
import { USER_MODELS_TXT, MAX_SLOTS, MAX_WEIGHT } from "./lib/pool.ts"

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
context files inside their size targets. Also create
\`.opencode/context/active.md\` with its heading and no tasks.

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

Audit the context files and the backlog for:

- stale information — verify claims against the actual code
- contradictions between context files, or between the map and the code
- excessive size — consolidate toward the per-file targets in your system
  prompt
- duplicated information — one canonical place per fact; link to the
  project's own docs rather than restating them
- missing canonical entry points for significant subsystems
- unsupported assumptions — anything stated as fact that you cannot verify,
  or that lacks a confidence marker
- backlog tasks that are finished but carry no date — the retention window
  cannot age those out, so they stay forever

Fix what you find in \`.opencode/context/\` only, then report: findings, fixes,
and anything you could not verify.`,
  },

  [AGENT_INSTRUCTIONS_COMMAND]: {
    description:
      "Apply a client instruction to the project's AGENTS.md. Client-only — runs the instructions agent, the only writer of that file.",
    agent: AGENT_INSTRUCTIONS_WRITER,
    subtask: true,
    template: `Apply this instruction to the project's \`AGENTS.md\`, and edit only that file:

$ARGUMENTS

Follow the rules for the file in your system prompt, then report what you changed.`,
  },

  "lacode-doctor": {
    description:
      "Check the LaCode setup — pool slots, model resolution, and the OmniRoute gateway. Report only; changes nothing.",
    template: `Diagnose this machine's LaCode setup. Report only; change nothing.

Print one PASS/FAIL line per check below, with the exact fix for any FAIL.

1. Pool status — call the \`pool_status\` tool. Report the slot list, each
   slot's load against its ceiling (twice the slot's weight), and which models
   are cooling.

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

  "pool": {
    description:
      "Modify this machine's LaCode pool from a short instruction — the shared free-model slot table in ~/.config/lacode/pool.txt. Restarts opencode afterwards.",
    template: `Apply this change to the LaCode pool on this machine:

$ARGUMENTS

The pool is ONE global slot table shared by every pooled base (explore, implement, context) — there are no per-base model lists, so "put X on explore" means "give X a slot", not a per-base override.

1. Establish the baseline. Read \`${USER_MODELS_TXT}\`. If it is absent, the pool is resolving from the bundled preset \`presets/free-tier.json\`; read that file to learn what is in effect. Call the \`pool_status\` tool only if you need live load or cooldown state.

2. Resolve the instruction above into a target slot table. These are the rules the loader enforces — never write a file that breaks one:
   - one slot per line: \`<provider>/<model-id>  [weight]\`
   - at most ${MAX_SLOTS} slots, and a model may appear only once
   - weight is optional (default 1) and must be a number in (0, ${MAX_WEIGHT}]. It is the slot's share of the rotation — how many turns it takes per cycle — and its concurrency ceiling is twice that. NOT a priority; pick order follows line order.
   - \`#\` starts a comment (whole-line or trailing); blank lines are ignored.
   If the instruction names a model ambiguously, or would need more than ${MAX_SLOTS} slots, stop and ask rather than guessing.

3. Write the WHOLE file, not a patch. This file is an override, not an edit target: any slot you drop disappears, and slot numbers are line positions, so a partial write silently renumbers the rotation. Keep the existing comment header. If the write fails on a missing directory, create \`~/.config/lacode\` first and retry.

4. Report the before → after slot table, the resolved path, and this reminder in substance: nothing hot-reloads, so every running opencode process must be restarted before the new pool takes effect.

Two traps that fail silently, so check and state them explicitly:
- A slot's provider must already exist in the user's opencode config, or that slot cannot resolve at all. If the instruction adds a model on a provider that is not configured, say so.
- If a slot model is \`omniroute/<id>\`, that id must also appear in the plugin's \`omniroute.models\` allowlist (or be the \`combo\` id, which needs no entry) — otherwise the pool resolves and every spawn fails with \`ProviderModelNotFoundError\`.
- A provider \`whitelist\` is an allowlist, and the plugin appends your model to it at config time. Nothing for you to do there.

If the instruction is to RESET or REVERT rather than to change models, delete \`${USER_MODELS_TXT}\` instead, and report that the pool falls back to the bundled preset — with the same restart reminder.

Change nothing else. In particular do not touch \`presets/free-tier.json\`, \`~/.config/lacode/pool.json\`, \`FALLBACK_SLOTS\` in \`src/lib/pool.ts\`, or \`tests/models-snapshot.json\`: this command owns the per-machine override and nothing else.`,
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