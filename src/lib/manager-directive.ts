// The client's `.opencode/context/manager.md` and the one sanctioned way to edit
// it: the `/manager-directive` command, which runs the `manager` agent.
//
// Every other agent is permission-denied on that file (writer-rule.ts Direction 3
// guarantees it), and the `manager` agent is not in anyone's `task` allow-list, so
// no agent or subagent can spawn it -- only the user's command can. It holds that
// one grant, scoped to `manager.md` and nothing else.
//
// The names live here, in lib/, as single constants: agents.ts, commands.ts and
// writer-rule.ts all key off them, and a second spelling anywhere would let the
// guard and the grant drift apart.

/** The command name, exactly as it is injected into the user's config. */
export const MANAGER_DIRECTIVE_COMMAND = "manager-directive"

/** The hidden agent the command runs; the ONLY agent permitted to write manager.md. */
export const MANAGER_AGENT_NAME = "manager"
