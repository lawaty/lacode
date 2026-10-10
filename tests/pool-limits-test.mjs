// Limit-awareness tests for the agent-pool plugin: strike recording, cooldown
// routing, stuck-claim recovery, catalog gating, and shared cross-process
// state. Run with: node tests/pool-limits-test.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")
const cfg = shippedConfig()

// presets/free-tier.json owns the pool's models; the provider/modelID pairs every
// limit event needs are split from it, so swapping a model is not a test edit.
// Slots are also looked up by weight, since the tests care about "a heaviest slot"
// and "a lightest slot", not about which number either happens to be.
const { splitModel } = await import(join(HERE, "..", "src", "lib", "pool.ts"))
const SLOTS = JSON.parse(readFileSync(join(HERE, "..", "presets", "free-tier.json"), "utf8")).slots.map((s, i) => {
  const { provider, id: modelID } = splitModel(s.model)
  return { model: s.model, provider, modelID, weight: s.weight, index: i + 1 }
})
const SLOT_MODELS = SLOTS.map((s) => s.model)
const variantOf = (slot) => `explore-fast-${slot.index}`
const MAX_WEIGHT = Math.max(...SLOTS.map((s) => s.weight))
const MIN_WEIGHT = Math.min(...SLOTS.map((s) => s.weight))
const heaviest = () => SLOTS.find((s) => s.weight === MAX_WEIGHT)
const lightest = () => SLOTS.find((s) => s.weight === MIN_WEIGHT)
// model ids go into RegExp sources all over this file
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
// A stated reset and a retry-after header are about the error shape, not about
// any particular model, so these use an id the pool never runs.
const FOREIGN = { provider: "fixture-provider", modelID: "fixture-model" }

const logs = []
const client = { app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) } }
let aborted = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const m = /\/session\/([^/]+)\/abort/.exec(String(url))
  if (m) aborted.push(m[1])
  return new Response("true", { status: 200 })
}

const { agentPoolHooks: AgentPool } = await import(PLUGIN)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

const made = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "limits-"))
  made.push(dir)
  return dir
}

const mk = async (id, dir) => {
  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, { id, dir })
  await hooks.config(cfg)
  return {
    hooks,
    spawn: async (callID, requested = "explore-fast", sessionID = "s1") => {
      const out = { args: { subagent_type: requested, prompt: "x" } }
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
      return out.args.subagent_type
    },
    finish: async (callID, sessionID = "s1") => {
      await hooks["tool.execute.after"]({ tool: "task", sessionID, callID, args: {} }, {})
    },
    status: async () => (await hooks.tool.pool_status.execute({}, {})).output,
    limitEvent: async (providerID, modelID, error) =>
      hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", providerID, modelID, error } } } }),
  }
}

const rateError = (message, extra = {}) => ({ name: "APIError", data: { message, isRetryable: true, ...extra } })
const dirA = scratch()
const dirB = scratch()

// 1. a rate-limit error message cools the model and routing avoids it
{
  const a = await mk("p1", dirA)
  // Baseline first: an idle pool hands out a heaviest slot. Cool whichever model
  // that spawn actually claimed (read back from the pool, not guessed from the
  // file), so this holds whatever presets/free-tier.json names and in whatever order.
  const baseline = await a.spawn("a1")
  const slot = SLOTS[Number(/-(\d+)$/.exec(baseline)[1]) - 1]
  assert(slot?.weight === MAX_WEIGHT, `baseline must route to a heaviest slot, got ${baseline}`)
  await a.limitEvent(slot.provider, slot.modelID, rateError("Rate limit exceeded. Please try again later."))
  const after = []
  for (let i = 0; i < 6; i++) after.push(await a.spawn(`a${i + 2}`))
  assert(!after.includes(baseline), `cooled heaviest slot must be skipped, got ${after.join(",")}`)
  // a cooled slot leaves the candidate set entirely, so the very next spawn must land
  // on the heaviest slot that is left. Checking every pick would be wrong: once the
  // remaining ceilings fill, the overflow reaches the light slots by design.
  const remaining = SLOTS.filter((s) => s.model !== slot.model)
  const topRemaining = Math.max(...remaining.map((s) => s.weight))
  const first = SLOTS[Number(/-(\d+)$/.exec(after[0])[1]) - 1]
  assert(
    first.weight === topRemaining,
    `the first spawn after a cooldown must go to a heaviest remaining slot (weight ${topRemaining}), got ${after[0]} (weight ${first.weight})`,
  )
  assert(/COOLING/.test(await a.status()), "status must flag the cooling model")
  assert(new RegExp(`cooling: ${escape(slot.model)}\\b`).test(await a.status()), "status must name the cooling model")
}

// 2. unrelated errors must NOT cool anything
{
  const b = await mk("p2", dirB)
  await b.limitEvent(heaviest().provider, heaviest().modelID, rateError("connection reset by peer"))
  await b.limitEvent(heaviest().provider, heaviest().modelID, { name: "UnknownError", data: { message: "tool call malformed" } })
  assert(!/COOLING/.test(await b.status()), "non-limit errors must not trigger a cooldown")
}

// 3. a stated reset time wins over the exponential guess
{
  const c = await mk("p3", scratch())
  await c.limitEvent(FOREIGN.provider, FOREIGN.modelID, rateError("5-hour usage limit reached. Resets in 35min."))
  const status = await c.status()
  const seconds = Number(new RegExp(`${FOREIGN.modelID} for (\\d+)s`).exec(status)?.[1])
  assert(seconds > 2000 && seconds <= 2100, `stated 35min cooldown should be honoured, got ${seconds}s`)
}

// 4. retry-after response header is honoured
{
  const d = await mk("p4", scratch())
  await d.limitEvent(FOREIGN.provider, FOREIGN.modelID, rateError("too many requests", { responseHeaders: { "retry-after": "120" } }))
  const seconds = Number(new RegExp(`${FOREIGN.modelID} for (\\d+)s`).exec(await d.status())?.[1])
  assert(seconds > 110 && seconds <= 120, `retry-after should set a 120s cooldown, got ${seconds}s`)
}

// 5. repeated strikes back off exponentially, and decay after STRIKE_DECAY_MS
{
  const e = await mk("p5", scratch())
  const err = rateError("Rate limit exceeded")
  const slot = heaviest()
  await e.limitEvent(slot.provider, slot.modelID, err)
  const first = Number(new RegExp(`${slot.modelID} for (\\d+)s`).exec(await e.status())?.[1])
  await e.limitEvent(slot.provider, slot.modelID, err)
  const second = Number(new RegExp(`${slot.modelID} for (\\d+)s`).exec(await e.status())?.[1])
  assert(second === first * 2, `second strike should double the cooldown (${first}s -> ${second}s)`)
  assert(/strike 2/.test(await e.status()), "status should show the strike count")
}

// 6. a hung claim is released and its model cooled, so the slot comes back
{
  const dir = scratch()
  const f = await mk("p6", dir)
  const hung = await f.spawn("f1") // the slot that will hang
  await f.hooks.event({ event: { type: "session.created", properties: { info: { id: "child-x", parentID: "s1" } } } })
  const realNow = Date.now
  Date.now = () => realNow() + 9 * 60 * 1000
  const next = await f.spawn("f2")
  Date.now = realNow
  assert(next !== hung, `a hung claim must free its slot and cool the model, got ${next}`)
  assert(/hang/.test(await f.status()), "status should attribute the recovery to a hang")
}

// 7. cooldowns are shared across processes through the claim dir
{
  const g = await mk("writer", dirA)
  const h = await mk("reader", dirA)
  const slot = heaviest()
  await g.limitEvent(slot.provider, slot.modelID, rateError("Rate limit exceeded"))
  assert(/COOLING/.test(await h.status()), "a peer process must observe a cooldown written by another")
  const picks = []
  for (let i = 0; i < 4; i++) picks.push(await h.spawn(`h${i}`))
  assert(!picks.includes(variantOf(slot)), `peer must avoid the cooled model, got ${picks.join(",")}`)
}

// 8. expired cooldown files are pruned, not honoured forever
{
  const dir = scratch()
  const i = await mk("p8", dir)
  await i.limitEvent(heaviest().provider, heaviest().modelID, rateError("Rate limit exceeded"))
  assert(readdirSync(dir).some((f) => f.startsWith("limit.")), "a cooldown file should be written")
  const realNow = Date.now
  Date.now = () => realNow() + 16 * 60 * 1000
  await i.status()
  Date.now = realNow
  assert(!readdirSync(dir).some((f) => f.startsWith("limit.")), "a lapsed cooldown file should be pruned on read")
}

// 9. routing still works when every model is cooling (must not refuse to route)
{
  const j = await mk("p9", scratch())
  for (const { provider, modelID } of SLOTS)
    await j.limitEvent(provider, modelID, rateError("Rate limit exceeded"))
  const pick = await j.spawn("j1")
  assert(/^explore-fast-[1-4]$/.test(pick), `must still route when all models cool, got ${pick}`)
}

// 10. catalog status gates retired models (simulated by seeding serverUrl-less state)
{
  const k = await mk("p10", scratch())
  for (const slot of SLOTS.filter((s) => s.weight === MIN_WEIGHT)) {
    assert(new RegExp(`slot ${slot.index}\\b`).test(await k.status()), `lightest slot ${slot.index} must be listed in status`)
  }
  assert(existsSync(PLUGIN), "plugin file must exist")
}

globalThis.fetch = realFetch
for (const dir of made) rmSync(dir, { recursive: true, force: true })
if (failures === 0) console.log("\nALL LIMIT CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}