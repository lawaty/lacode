/**
 * Prompt critique (beta).
 *
 * Opt-in, default off. When the `promptCritique` option is `true`, LaCode
 * prepends this instruction to the prompts of the primary and planner agents
 * only. Subagents (explore, implement, context), the hidden instructions
 * writer, and the generated pool variants are deliberately left alone.
 *
 * The marker makes the prefix idempotent: the config hook can run more than
 * once, and the instruction must never be duplicated.
 */
export const PROMPT_CRITIQUE_MARKER = "<!-- lacode:prompt-critique:v1 -->"

export const PROMPT_CRITIQUE_INSTRUCTION =
  PROMPT_CRITIQUE_MARKER + "\n"
  + "Before acting on any request, critique the request itself against the global "
  + "standards. Check the user's prompt, proposal, or recommendation against what "
  + "the global rules and the project's documented standards require, and say so "
  + "plainly when they conflict. If the ask breaks a global rule, an architectural "
  + "decision, or a project convention, warn explicitly, name the rule and file it "
  + "conflicts with, and state the standards-conforming alternative. If a materially "
  + "better recommendation follows, say so in one or two sentences with the "
  + "trade-off. This is advisory, not a veto: never refuse, block, or silently "
  + "substitute your own preference -- after the critique, carry out what the user "
  + "asked unless they change their mind.\n\n"

/**
 * Agents that receive the critique instruction. These are the primary and
 * planner agents; `basic` and `expert` may be user-defined, and the opt-in
 * explicitly authorises prefixing them.
 */
export const PROMPT_CRITIQUE_AGENTS = ["build", "plan", "basic", "expert"] as const

/**
 * Prepend the critique instruction to the allowlisted agents present in the
 * config. Returns the names it actually changed. Idempotent: an agent whose
 * prompt already carries the marker is skipped, and a non-string prompt is
 * left alone.
 */
export function applyPromptCritique(
  cfg: Record<string, unknown>,
  enabled: boolean,
): string[] {
  if (!enabled) return []
  const agents = cfg.agent as Record<string, { prompt?: unknown }> | undefined
  if (!agents) return []
  const touched: string[] = []
  for (const name of PROMPT_CRITIQUE_AGENTS) {
    const def = agents[name]
    if (def === undefined || typeof def.prompt !== "string") continue
    if (def.prompt.startsWith(PROMPT_CRITIQUE_MARKER)) continue
    def.prompt = PROMPT_CRITIQUE_INSTRUCTION + def.prompt
    touched.push(name)
  }
  return touched
}
