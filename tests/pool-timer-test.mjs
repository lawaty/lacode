// Regression tests for the production failure where the hang reaper only ran on the
// next task spawn, so a task that hung while the session was idle was never reaped
// (observed: 18 minutes, slot held). Also covers the provider-wide free_tier_limit
// signal opencode reports itself, and the AI_APICallError limit-detection case that
// pool-limits-test.mjs owns.
// Run: node tests/pool-timer-test.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, "..", "opencode.jsonc")
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"))

// presets/free-tier.json owns the pool's models. Test 4 is about a provider-wide
// cooldown, so it is written against whichever provider slot 1 runs on and the
// slots on the other providers, rather than against fixed model names.
const { splitModel } = await import(join(HERE, "..", "src", "lib", "pool.ts"))
const SLOTS = JSON.parse(readFileSync(join(HERE, "..", "presets", "free-tier.json"), "utf8")).slots
const { provider: HOT_PROVIDER, id: HOT_MODEL } = splitModel(SLOTS[0].model) // provider whose free tier fills up
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
const sameProvider = SLOTS.filter((s) => s.model.startsWith(`${HOT_PROVIDER}/`)).map((s) => s.model)
const otherProviders = SLOTS.filter((s) => !s.model.startsWith(`${HOT_PROVIDER}/`)).map((s) => splitModel(s.model).id)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

const made = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "timer-"))
  made.push(d)
  return d
}

const aborted = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const m = /\/session\/([^/]+)\/abort/.exec(String(url))
  if (m) aborted.push(m[1])
  return new Response("true", { status: 200 })
}

const logs = []
const client = { app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) } }
const { agentPoolHooks: AgentPool } = await import(join(HERE, "..", "src", "plugins", "agent-pool.ts"))
const pool = await import(join(HERE, "..", "src", "lib", "pool.ts"))

const REAL = Date.now()
let clock = 0
Date.now = () => REAL + clock

const mk = async (id, dir) => {
  const h = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, { id, dir, reapMs: 20 })
  await h.config(cfg)
  return {
    hooks: h,
    logs,
    spawn: async (callID, requested = "explore-fast", sessionID = "parent") => {
      const out = { args: { subagent_type: requested, prompt: "x" } }
      await h["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
      return out.args.subagent_type
    },
    child: (parentID, childID) => h.event({ event: { type: "session.created", properties: { info: { id: childID, parentID } } } }),
    status: async () => (await h.tool.pool_status.execute({}, {})).output,
  }
}

const settle = () => new Promise((r) => setTimeout(r, 120))

// 1. a hung task is reaped by the timer alone -- with NO further task spawns.
//    This is the production failure: reaping used to hang off tool.execute.before.
{
  aborted.length = 0
  clock = 0
  const t = await mk("timer-1", scratch())
  await t.spawn("h1")
  await t.child("parent", "child-idle")
  clock = 10 * 60_000 // older than STUCK_MIN_AGE, silent the whole time
  await settle() // let the 30s interval tick
  await settle()
  assert(aborted.includes("child-idle"), `the interval must reap a hung task unaided, got ${JSON.stringify(aborted)}`)
  assert(t.logs.some((l) => l.includes("aborted session child-idle")), "reap must be logged")
  assert(t.logs.some((l) => l.includes("cooling") && l.includes("hang")), "a hang must cool the model")
  await t.hooks.dispose?.()
}

// 2. a working task is never reaped by the timer
{
  aborted.length = 0
  clock = 0
  const t = await mk("timer-2", scratch())
  await t.spawn("k1")
  await t.child("parent", "child-busy")
  for (let i = 0; i < 4; i++) {
    clock += 60_000
    await t.hooks.event({ event: { type: "message.part.updated", properties: { part: { sessionID: "child-busy", type: "text", text: "x" } } } })
    await settle()
  }
  assert(!aborted.includes("child-busy"), `a child still producing output must not be aborted, got ${JSON.stringify(aborted)}`)
  await t.hooks.dispose?.()
}

// 3. limit text is found wherever it sits in the error object (the real
//    production error was AI_APICallError, not APIError)
{
  clock = 0
  const t = await mk("timer-3", scratch())
  const shapes = [
    { name: "AI_APICallError", data: { message: "Rate limit exceeded. Please try again later." } },
    { name: "AI_APICallError", error: "Rate limit exceeded. Please try again later." },
    { message: "Rate limit exceeded. Please try again later." },
    { name: "APIError", data: { message: "5-hour usage limit reached. Resets in 25min.", statusCode: 429 } },
  ]
  for (const [i, error] of shapes.entries()) {
    await t.hooks.event({
      event: { type: "message.updated", properties: { info: { role: "assistant", providerID: HOT_PROVIDER, modelID: HOT_MODEL, error } } },
    })
    assert(t.logs.some((l) => l.includes(`cooling ${HOT_PROVIDER}/${HOT_MODEL}`)), `error shape ${i + 1} should have triggered a cooldown`)
  }
  await t.hooks.dispose?.()
}

// 4. opencode's own free_tier_limit status cools EVERY slot on that provider,
//    honouring the reset timestamp it reports
{
  clock = 0
  const t = await mk("timer-4", scratch())
  const until = REAL + 45 * 60_000
  await t.hooks.event({
    event: {
      type: "session.status",
      properties: {
        sessionID: "ses_x",
        status: {
          type: "retry",
          attempt: 1,
          message: "Free usage exceeded, subscribe to Go",
          next: until,
          action: { reason: "free_tier_limit", provider: HOT_PROVIDER },
        },
      },
    },
  })
  const status = await t.status()
  // The cooling list is one comma-separated line, so match each model inside it
  // rather than expecting each to start its own "cooling:" entry.
  const cooling = (status.split("cooling:")[1] ?? "").trim()
  // every slot on that provider cools, whatever the model is and which slot it is
  for (const model of sameProvider) {
    assert(new RegExp(`(^|, )${escape(model)} for \\d+s`).test(cooling), `${model} must cool with a window, got:\n${status}`)
  }
  for (const model of otherProviders) {
    assert(!new RegExp(`(^|, )${escape(model)} for \\d+s`).test(cooling), `${model} runs on another provider and must stay usable, got:\n${status}`)
  }
  const seconds = Number(new RegExp(`${escape(`${HOT_PROVIDER}/${HOT_MODEL}`)} for (\\d+)s`).exec(status)?.[1])
  assert(seconds > 2600 && seconds <= 2700, `the reported reset must be honoured, got ${seconds}s`)
  // and routing must now avoid the cooled provider
  const picks = []
  for (let i = 0; i < 4; i++) picks.push(await t.spawn(`z${i}`))
  const usableSlots = SLOTS.map((s, i) => (s.model.startsWith(`${HOT_PROVIDER}/`) ? null : i + 1)).filter(Boolean)
  assert(picks.every((p) => usableSlots.includes(Number(p.replace(/^[a-z-]+-/, "")))), `routing must avoid the cooled provider, got ${picks.join(",")}`)
  await t.hooks.dispose?.()
}

Date.now = REAL
globalThis.fetch = realFetch
for (const d of made) rmSync(d, { recursive: true, force: true })
if (failures === 0) console.log("\nALL TIMER/LIMIT CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}