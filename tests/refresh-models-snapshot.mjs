// Rebuild tests/models-snapshot.json from models.dev for exactly the models
// presets/free-tier.json currently names, so swapping a pool model does not leave a
// stale snapshot behind (pool-test.mjs fails on any slot the snapshot has never
// seen). Run after editing presets/free-tier.json:
//
//   node tests/refresh-models-snapshot.mjs
//
// The snapshot is the record of what each model cost and whether it can call
// tools at the moment it was picked; pool-test.mjs asserts against it rather than
// hitting the network, so a run stays offline and reproducible.

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const MODELS = join(HERE, "..", "presets", "free-tier.json")
const SNAPSHOT = join(HERE, "models-snapshot.json")
const SOURCE = "https://models.dev/api.json"

const slots = JSON.parse(readFileSync(MODELS, "utf8")).slots
const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`${SOURCE} returned ${res.status}`)
const api = await res.json()

const models = {}
const problems = []
for (const { model } of slots) {
  const slash = model.indexOf("/")
  const provider = model.slice(0, slash)
  const id = model.slice(slash + 1)
  const entry = api[provider]?.models?.[id]
  if (!entry) {
    problems.push(`${model}: not offered by provider "${provider}" on models.dev`)
    continue
  }
  models[model] = {
    cost_input: entry.cost.input,
    cost_output: entry.cost.output,
    context: entry.limit.context,
    tool_call: Boolean(entry.tool_call),
    reasoning: Boolean(entry.reasoning),
  }
}

if (problems.length > 0) {
  console.error(`${SNAPSHOT} left untouched; models.dev does not list:`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

writeFileSync(
  SNAPSHOT,
  `${JSON.stringify({ _source: SOURCE, _fetched: new Date().toISOString().slice(0, 10), models }, null, 2)}\n`,
)
console.log(`${SNAPSHOT}: recorded ${Object.keys(models).length} pool model(s)`)
for (const [model, m] of Object.entries(models)) {
  const flag = m.cost_input === 0 && m.cost_output === 0 ? "" : "  <- NOT free, unusable in the pool"
  const tools = m.tool_call ? "" : "  <- no tool calls, unusable as an explore agent"
  console.log(`  ${model} ${m.cost_input}/${m.cost_output} tool_call=${m.tool_call}${flag}${tools}`)
}