// /manager-directive: the client's one sanctioned way to change manager.md.
//
// The command runs a hidden `manager` agent -- the ONLY agent permitted to edit
// that file, and one no other agent can spawn. writer-rule.ts exempts exactly
// that name, so every other writer is still reported. These tests pin the
// command shape, the agent's scoped grant, its un-spawnability, and the guard.
//
// Run with: node tests/manager-directive-test.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { COMMANDS, applyCommands } = await import(join(HERE, "..", "src", "commands.ts"))
const { buildAgentSet } = await import(join(HERE, "..", "src", "agents.ts"))
const { verifyWriterRule } = await import(join(HERE, "..", "src", "lib", "writer-rule.ts"))
const { MANAGER_AGENT_NAME, MANAGER_DIRECTIVE_COMMAND } = await import(join(HERE, "..", "src", "lib", "manager-directive.ts"))

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

// The opencode permission model: a pattern compiles to an anchored regex and the
// LAST match wins, so the winning rule is the last entry that matches.
const compiles = (pattern, file) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(file)
const winner = (rule, file) => {
  let win
  for (const [pattern, action] of Object.entries(rule ?? {})) if (compiles(pattern, file)) win = { pattern, action }
  return win
}

// --- the command runs the manager agent as a subtask ---
{
  const cfg = { agent: {}, command: {} }
  applyCommands(cfg)
  const def = cfg.command[MANAGER_DIRECTIVE_COMMAND]
  assert(def, "the manager-directive command must be injected")
  assert(def.agent === MANAGER_AGENT_NAME, `it must run the manager agent, got ${def.agent}`)
  assert(def.subtask === true, "it must run as a subtask so it cannot become a root session")
  assert(/\$ARGUMENTS/.test(def.template), `the template must pass the client's instruction through, got ${def.template}`)
  assert(/client-only/i.test(def.description ?? ""), `the description must mark it client-only, got ${def.description}`)
}

// --- the manager agent exists and its grant is scoped to manager.md alone ---
{
  const set = buildAgentSet()
  const mgr = set[MANAGER_AGENT_NAME]
  assert(mgr, "buildAgentSet must inject the manager agent")
  assert(mgr.hidden === true, "the manager agent must be hidden")
  assert(mgr.mode === "subagent", "the manager agent must be a subagent")

  const managerMd = ".opencode/context/manager.md"
  assert(winner(mgr.permission.edit, managerMd)?.action === "allow", `manager must be able to edit manager.md`)
  assert(winner(mgr.permission.edit, "src/agents.ts")?.action === "deny", `manager must NOT be able to edit any other path`)
  assert(winner(mgr.permission.read, managerMd)?.action === "allow", `manager may read manager.md`)
  assert(winner(mgr.permission.read, "src/agents.ts")?.action === "deny", `manager may not read anything else`)
  assert(mgr.permission.bash === "deny", "manager must not run bash")
}

// --- no other agent can spawn the manager agent ---
{
  for (const [name, def] of Object.entries(buildAgentSet())) {
    if (name === MANAGER_AGENT_NAME) continue
    const task = def.permission?.task ?? {}
    assert(task["*"] !== "allow", `agent ${name} grants every task, so it could spawn the manager agent`)
    assert(task[MANAGER_AGENT_NAME] !== "allow", `agent ${name} may not spawn the manager agent`)
    assert(task[`${MANAGER_AGENT_NAME}*`] !== "allow", `agent ${name} may not spawn the manager agent by prefix`)
  }
  // …and the manager agent itself cannot spawn anything.
  assert(buildAgentSet()[MANAGER_AGENT_NAME].permission.task["*"] === "deny", "the manager agent must not spawn subagents")
}

// --- the writer guard: manager is the one exemption, everyone else is caught ---
{
  const dir = mkdtempSync(join(tmpdir(), "mgr-writer-"))
  const map = join(dir, ".opencode", "context")

  // The shipped set, with the manager agent in it, is accepted.
  const live = join(dir, "live.jsonc")
  writeFileSync(
    live,
    JSON.stringify({ agent: Object.fromEntries(Object.entries(buildAgentSet()).map(([n, d]) => [n, { permission: d.permission }])) }),
  )
  assert(verifyWriterRule(live, map, dir) === undefined, `the shipped agent set (with manager) must pass, got: ${verifyWriterRule(live, map, dir)}`)

  // A different agent holding the same manager.md grant is still reported: the
  // exemption is by name, not by permission shape.
  const other = join(dir, "other.jsonc")
  writeFileSync(
    other,
    JSON.stringify({
      agent: {
        context: {
          permission: {
            edit: {
              "*": "deny",
              ".opencode/context/**": "allow",
              "*/.opencode/context/**": "allow",
              ".opencode/context/manager.md": "deny",
              "*/.opencode/context/manager.md": "deny",
            },
          },
        },
        copycat: { permission: { edit: { "*": "deny", ".opencode/context/manager.md": "allow", "*/.opencode/context/manager.md": "allow" } } },
      },
    }),
  )
  const problem = verifyWriterRule(other, map, dir)
  assert(problem && /copycat/.test(problem), `an agent other than manager must still be reported, got: ${problem}`)
  assert(!/ manager \(/.test(problem ?? ""), `the manager agent itself must never be reported, got: ${problem}`)

  rmSync(dir, { recursive: true, force: true })
}

// The command set is a single source of truth.
assert(COMMANDS[MANAGER_DIRECTIVE_COMMAND]?.agent === MANAGER_AGENT_NAME, "COMMANDS must point the directive at the manager agent")

if (failures === 0) console.log("\nALL MANAGER-DIRECTIVE CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
