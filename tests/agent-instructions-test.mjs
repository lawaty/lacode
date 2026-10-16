// /agent-instructions: the client's one sanctioned way to change the project's
// root AGENTS.md.
//
// The command runs a hidden `instructions` agent -- the ONLY agent permitted to
// edit that file, and one no other agent can spawn. writer-rule.ts exempts
// exactly that name, so every other writer is still reported. These tests pin
// the command shape, the agent's scoped grant, its un-spawnability, and the guard.
//
// Run with: node tests/agent-instructions-test.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { COMMANDS, applyCommands } = await import(join(HERE, "..", "src", "commands.ts"))
const { buildAgentSet } = await import(join(HERE, "..", "src", "agents.ts"))
const { verifyWriterRule } = await import(join(HERE, "..", "src", "lib", "writer-rule.ts"))
const { AGENT_INSTRUCTIONS_COMMAND, AGENT_INSTRUCTIONS_WRITER } = await import(
  join(HERE, "..", "src", "lib", "agent-instructions.ts")
)

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

// The evaluated path of the project's root AGENTS.md, for a repo-rooted project.
const AGENTS_MD = "AGENTS.md"
// …and the form that fires when the project root is "/", hence the second pattern.
const ABS_AGENTS_MD = "some/where/AGENTS.md"

// --- the command runs the instructions agent as a subtask ---
{
  const cfg = { agent: {}, command: {} }
  applyCommands(cfg)
  const def = cfg.command[AGENT_INSTRUCTIONS_COMMAND]
  assert(def, "the agent-instructions command must be injected")
  assert(def.agent === AGENT_INSTRUCTIONS_WRITER, `it must run the instructions agent, got ${def.agent}`)
  assert(def.subtask === true, "it must run as a subtask so it cannot become a root session")
  assert(/\$ARGUMENTS/.test(def.template), `the template must pass the client's instruction through, got ${def.template}`)
  assert(/client-only/i.test(def.description ?? ""), `the description must mark it client-only, got ${def.description}`)
  assert(/AGENTS\.md/.test(def.template), `the template must name the file it maintains, got ${def.template}`)
}

// --- the instructions agent exists and its grant is scoped to AGENTS.md alone ---
{
  const set = buildAgentSet()
  const instr = set[AGENT_INSTRUCTIONS_WRITER]
  assert(instr, "buildAgentSet must inject the instructions agent")
  assert(instr.hidden === true, "the instructions agent must be hidden")
  assert(instr.mode === "subagent", "the instructions agent must be a subagent")

  // Both spellings are declared under a broad deny: LAST match wins, so the two
  // narrow allows must sit AFTER "*": "deny" to be the winning rule.
  for (const tool of ["edit", "read"]) {
    const rule = instr.permission[tool] ?? {}
    assert(rule["*"] === "deny", `${tool} must be a broad deny, got ${JSON.stringify(rule["*"])}`)
    const entries = Object.keys(rule)
    assert(entries.indexOf("AGENTS.md") > entries.indexOf("*"), `${tool}: the "AGENTS.md" allow must sit after the broad deny`)
    assert(entries.indexOf("*/AGENTS.md") > entries.indexOf("*"), `${tool}: the "*/AGENTS.md" allow must sit after the broad deny`)
    assert(winner(rule, AGENTS_MD)?.action === "allow", `${tool} must allow the project-root AGENTS.md`)
    assert(winner(rule, ABS_AGENTS_MD)?.action === "allow", `${tool} must allow the AGENTS.md form of a "/"-rooted project`)
    assert(winner(rule, "src/agents.ts")?.action === "deny", `${tool} must NOT reach any other path`)
    assert(winner(rule, ".opencode/context/architecture.md")?.action === "deny", `${tool} must NOT reach the context map`)
  }
  assert(instr.permission.bash === "deny", "the instructions agent must not run bash")
}

// --- no other agent can spawn the instructions agent ---
{
  for (const [name, def] of Object.entries(buildAgentSet())) {
    if (name === AGENT_INSTRUCTIONS_WRITER) continue
    const task = def.permission?.task ?? {}
    assert(task["*"] !== "allow", `agent ${name} grants every task, so it could spawn the instructions agent`)
    assert(task[AGENT_INSTRUCTIONS_WRITER] !== "allow", `agent ${name} may not spawn the instructions agent`)
    assert(task[`${AGENT_INSTRUCTIONS_WRITER}*`] !== "allow", `agent ${name} may not spawn the instructions agent by prefix`)
  }
  // …and the instructions agent itself cannot spawn anything.
  assert(buildAgentSet()[AGENT_INSTRUCTIONS_WRITER].permission.task["*"] === "deny", "the instructions agent must not spawn subagents")
}

// --- the writer guard: instructions is the one exemption, everyone else is caught ---
{
  const dir = mkdtempSync(join(tmpdir(), "instr-writer-"))
  const map = join(dir, ".opencode", "context")
  // A config that passes Direction 1 (the map is writable) and Direction 2 (no
  // second map writer), so anything reported comes from Direction 3.
  const MAP_EDIT = { "*": "deny", ".opencode/context/**": "allow", "*/.opencode/context/**": "allow" }
  const CARTOGRAPHER_EDIT = { "*": "allow", "*/.opencode/context/**": "deny", ".opencode/context/**": "deny", "AGENTS.md": "deny", "*/AGENTS.md": "deny" }
  const COPYCAT_EDIT = { "*": "deny", "AGENTS.md": "allow", "*/AGENTS.md": "allow" }

  // The shipped set, with the instructions agent in it, is accepted.
  const live = join(dir, "live.jsonc")
  writeFileSync(
    live,
    JSON.stringify({ agent: Object.fromEntries(Object.entries(buildAgentSet()).map(([n, d]) => [n, { permission: d.permission }])) }),
  )
  assert(verifyWriterRule(live, map, dir) === undefined, `the shipped agent set (with instructions) must pass, got: ${verifyWriterRule(live, map, dir)}`)

  // An agent named `instructions` holding an AGENTS.md grant is the sanctioned
  // writer and is skipped BY NAME, so a config carrying only that is silent.
  const sanctioned = join(dir, "sanctioned.jsonc")
  writeFileSync(
    sanctioned,
    JSON.stringify({
      agent: {
        context: { permission: { edit: MAP_EDIT } },
        [AGENT_INSTRUCTIONS_WRITER]: { permission: { edit: COPYCAT_EDIT } },
      },
    }),
  )
  assert(verifyWriterRule(sanctioned, map, dir) === undefined, `the instructions agent must never be reported, got: ${verifyWriterRule(sanctioned, map, dir)}`)

  // The same grant under a different name is still reported: the exemption is by
  // name, not by permission shape.
  const other = join(dir, "other.jsonc")
  writeFileSync(
    other,
    JSON.stringify({
      agent: {
        context: { permission: { edit: MAP_EDIT } },
        copycat: { permission: { edit: COPYCAT_EDIT } },
      },
    }),
  )
  const problem = verifyWriterRule(other, map, dir)
  assert(problem && /copycat/.test(problem), `an agent other than instructions must still be reported, got: ${problem}`)
  assert(/AGENTS\.md is writable by permission/.test(problem ?? ""), `the report must name AGENTS.md, got: ${problem}`)
  assert(!/ instructions \(/.test(problem ?? ""), `the instructions agent itself must never be reported, got: ${problem}`)

  // …including when it copies the cartographer's whole grant, which is how the
  // cartographer itself would be caught by Direction 3.
  const cartographerCopy = join(dir, "cartographer-copy.jsonc")
  writeFileSync(
    cartographerCopy,
    JSON.stringify({
      agent: {
        context: { permission: { edit: CARTOGRAPHER_EDIT } },
        copycat: { permission: { edit: COPYCAT_EDIT } },
      },
    }),
  )
  const copied = verifyWriterRule(cartographerCopy, map, dir)
  assert(copied && /copycat/.test(copied), `a copycat grant must be reported even beside a correct cartographer, got: ${copied}`)
  assert(!/ context \(/.test(copied ?? ""), `the cartographer's own deny-last must satisfy Direction 3, got: ${copied}`)

  rmSync(dir, { recursive: true, force: true })
}

// The command set is a single source of truth, and the names live in one place.
assert(COMMANDS[AGENT_INSTRUCTIONS_COMMAND]?.agent === AGENT_INSTRUCTIONS_WRITER, "COMMANDS must point the directive at the instructions agent")
assert(AGENT_INSTRUCTIONS_COMMAND === "agent-instructions", `the injected command key must be agent-instructions, got ${AGENT_INSTRUCTIONS_COMMAND}`)
assert(AGENT_INSTRUCTIONS_WRITER === "instructions", `the writer agent must be named instructions, got ${AGENT_INSTRUCTIONS_WRITER}`)

if (failures === 0) console.log("\nALL AGENT-INSTRUCTIONS CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}