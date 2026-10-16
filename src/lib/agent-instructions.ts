// The project's root `AGENTS.md` and the one sanctioned way to edit it: the
// `/agent-instructions` command, which runs the `instructions` agent.
//
// Every other agent is permission-denied on `AGENTS.md` (writer-rule.ts
// Direction 3 guarantees it), and the `instructions` agent is in no one's
// `task` allow-list, so no agent or subagent can spawn it -- only the user's
// command can. It holds that one grant, scoped to `AGENTS.md` and nothing else.
//
// The names live here, in lib/, as single constants: agents.ts, commands.ts and
// writer-rule.ts all key off them, and a second spelling anywhere would let the
// guard and the grant drift apart.

/** The command name, exactly as it is injected into the user's config. */
export const AGENT_INSTRUCTIONS_COMMAND = "agent-instructions"

/** The hidden agent the command runs; the ONLY agent permitted to write AGENTS.md. */
export const AGENT_INSTRUCTIONS_WRITER = "instructions"
