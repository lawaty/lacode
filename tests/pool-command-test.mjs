// /pool: the client's command to manage the LaCode pool.
//
// This command allows adjusting the pool of models available for tasks. These
// tests pin the command injection, the template interpolation of pool
// constraints, and the safety guard against clobbering existing commands.
//
// Run with: node tests/pool-command-test.mjs
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { COMMANDS, applyCommands } = await import(join(HERE, "..", "src", "commands.ts"))
const { USER_MODELS_TXT, MAX_WEIGHT } = await import(join(HERE, "..", "src", "lib", "pool.ts"))

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

// --- command injection and runtime properties ---
{
  assert(COMMANDS.pool, "COMMANDS.pool must exist")
  const cfg = { agent: {}, command: {} }
  applyCommands(cfg)
  const def = cfg.command.pool
  assert(def, "the pool command must be injected")
  assert(def.agent === undefined, `it must run inline, got agent: ${def.agent}`)
  assert(def.subtask === undefined, `it must run inline, got subtask: ${def.subtask}`)
  assert(/\$ARGUMENTS/.test(def.template), "the template must pass instructions")
  assert(def.description && def.description.includes("pool.txt"), "description mentions pool.txt")
}

// --- template interpolation and constraints ---
{
  const cfg = { agent: {}, command: {} }
  applyCommands(cfg)
  const def = cfg.command.pool
  const template = def.template

  assert(template.includes(USER_MODELS_TXT), `template must interpolate USER_MODELS_TXT: ${USER_MODELS_TXT}`)
  assert(template.includes(String(MAX_WEIGHT)), `template must interpolate MAX_WEIGHT: ${MAX_WEIGHT}`)
  assert(!template.includes("${USER_MODELS_TXT}"), "template must not contain literal ${USER_MODELS_TXT}")
  assert(template.includes("any number of slots"), "template must state there is no slot cap")
  assert(!/at most \d+ slots/i.test(template), "template must not state a slot cap")
  assert(template.includes("appear on more than one line"), "template must allow repeated models")
  assert(template.includes("sum of the weights"), "template must state total capacity = sum of weights")

  assert(template.includes("(0, 100]"), "template must name weight range (0, 100]")
  assert(template.includes("<provider>/<model-id>"), "template must name provider/model-id shape")
  assert(template.includes("#"), "template must name # comment syntax")

  // Scoping
  assert(template.includes("pool.txt"), "template must name pool.txt")
  assert(template.includes("presets/free-tier.json"), "template must mention presets/free-tier.json")
  assert(template.includes("pool.json"), "template must mention pool.json")
  assert(template.includes("FALLBACK_SLOTS"), "template must mention FALLBACK_SLOTS")
  assert(template.includes("tests/models-snapshot.json"), "template must mention tests/models-snapshot.json")

  // Traps & reminders
  assert(template.includes("restart"), "template must include restart reminder")
  assert(template.includes("omniroute"), "template must include omniroute allowlist trap")
}

// --- /pool-recheck: the manual trigger for the probe tool ---
{
  assert(COMMANDS["pool-recheck"], "COMMANDS['pool-recheck'] must exist")
  const cfg = { agent: {}, command: {} }
  applyCommands(cfg)
  const def = cfg.command["pool-recheck"]
  assert(def, "the recheck command must be injected")
  assert(def.agent === undefined, `it must run inline, not borrow a pool slot, got agent: ${def.agent}`)
  assert(def.subtask === undefined, `it must not spawn a subagent, got subtask: ${def.subtask}`)
  assert(/\$ARGUMENTS/.test(def.template), "it must accept an optional model list")
  assert(/pool_recheck/.test(def.template), "it must name the tool it calls")
  assert(/models/.test(def.template), "it must say the arguments become the tool's models filter")
  assert(/change nothing/i.test(def.template), "it must report, not edit the pool")
  assert(/currently cooling/i.test(def.template), "it must state the no-argument meaning")
}

// --- refusal to clobber ---
{
  const sentinel = { template: "sentinel-pool-def", description: "do-not-clobber" }
  const cfg = { agent: {}, command: { pool: sentinel } }
  const result = applyCommands(cfg)
  assert(result.kept.includes("pool"), "it must report pool as kept")
  assert(!result.added.includes("pool"), "it must not report pool as added")
  assert(cfg.command.pool === sentinel, "it must be byte-identical (sentinel preserved)")
}

if (failures === 0) console.log("\nALL POOL COMMAND CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
