// pool_recheck: probing a cooled model by actually using it.
//
// A cooldown is a computed guess; a probe is a fact. These tests pin the whole
// loop with a stub client and no server: the probe session it opens, the model it
// targets, what happens when the model answers (cooldown cleared), what happens
// when it does not (the window is KEPT, never lengthened), that a probe's own
// failure is never counted as new evidence by the event hook, that it cannot bench
// a whole provider, and that the periodic pass arms and reports.
//
// Run with: node tests/pool-recheck-test.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PRESET = join(HERE, "..", "presets", "free-tier.json")
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")

// Never hardcode a pool model or a slot number: the preset owns the slot table
// (conventions.md).
const pool = await import(join(HERE, "..", "src", "lib", "pool.ts"))
const probe = await import(join(HERE, "..", "src", "lib", "probe.ts"))
const SLOTS = JSON.parse(readFileSync(PRESET, "utf8")).slots.map((s, i) => ({ ...s, index: i + 1 }))
const SLOT_MODELS = SLOTS.map((s) => s.model)

const logs = []
const toasts = []
const client = {
  app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
  tui: { showToast: async ({ body }) => toasts.push(`${body.title}: ${body.message}`) },
}
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response("true", { status: 200 })

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
  const dir = mkdtempSync(join(tmpdir(), "recheck-"))
  made.push(dir)
  return dir
}
const limitFiles = (dir) => readdirSync(dir).filter((e) => e.startsWith("limit.") && e.endsWith(".json"))

/**
 * A stub of the four session calls a probe makes, recording every one.
 *
 * `answers` decides what a given model does: a function returning a message answers,
 * anything else is surfaced as that error on the assistant message — the shape
 * opencode reports a rate limit in.
 */
const stubClient = (answers) => {
  const calls = { created: [], prompts: [], aborted: [], deleted: [] }
  let n = 0
  return {
    calls,
    session: {
      create: async (o) => {
        const title = o?.body?.title ?? ""
        calls.created.push(title)
        return { data: { id: `probe-${++n}` } }
      },
      prompt: async (o) => {
        const { providerID, modelID } = o?.body?.model ?? {}
        const model = `${providerID}/${modelID}`
        calls.prompts.push({ model, body: o.body })
        const answer = answers[model]
        if (typeof answer === "function") return { data: { info: await answer() } }
        if (answer === "hang") return new Promise(() => {})
        return { data: { info: { error: { name: "ProviderError", data: { message: String(answer ?? "Rate limit exceeded") } } } } }
      },
      abort: async (o) => void calls.aborted.push(o?.path?.id),
      delete: async (o) => void calls.deleted.push(o?.path?.id),
    },
  }
}

const cooling = (id, dir, models, ms) => {
  const s = pool.state({ id, dir, modelsFile: PRESET })
  pool.init(s, () => {})
  pool.ensureSlots(s, () => {})
  for (const model of models) pool.recordStrike(s, model, "quota", ms)
  return s
}

// --- the probe itself ---------------------------------------------------------
{
  const dir = scratch()
  const model = SLOT_MODELS[0]
  const { provider, id: modelID } = pool.splitModel(model)
  const s = cooling("probe-ok", dir, [model], 4 * 60 * 60 * 1000)

  const stub = stubClient({ [model]: async () => ({ role: "assistant", providerID: provider, modelID }) })
  const report = await probe.probeCooling(stub, { state: s, directory: "/tmp", models: [model] })

  assert(report.cleared.includes(model), `a model that answers must be re-admitted, got ${JSON.stringify(report)}`)
  assert(report.changed, "a cleared cooldown is a change")
  assert(limitFiles(dir).length === 0, "the cooldown file must be gone")
  assert(pool.readLimits(s).size === 0, "the cooldown must not survive in memory either")

  // It must be the REAL model and the cheapest possible request, or the check costs
  // what it is checking.
  assert(stub.calls.prompts.length === 1, `exactly one prompt per probe, got ${stub.calls.prompts.length}`)
  assert(stub.calls.prompts[0].model === model, `the probe must target the cooled model, got ${stub.calls.prompts[0].model}`)
  assert(typeof stub.calls.prompts[0].body.system === "string", "a probe must override the system prompt, not ship an agent's")
  assert(stub.calls.prompts[0].body.agent === undefined, "a probe must not name an agent: that would mean a claim and a slot")
  assert(stub.calls.deleted.length === 1, `the probe session must be deleted, deleted: ${stub.calls.deleted.join(", ")}`)
}

// --- a model that is still limited keeps its window, and does not lose it ------
{
  const dir = scratch()
  const model = SLOT_MODELS[1]
  const s = cooling("probe-limited", dir, [model], 90 * 60 * 1000)
  const before = pool.readLimits(s).get(model)

  const stub = stubClient({ [model]: "Rate limit exceeded" })
  const report = await probe.probeCooling(stub, { state: s, directory: "/tmp", models: [model] })

  assert(report.kept.includes(model) && !report.cleared.includes(model), `a limited model must stay benched, got ${JSON.stringify(report)}`)
  assert(report.changed === false, "a probe that confirms the cooldown changed nothing, and must say nothing")
  const after = pool.readLimits(s).get(model)
  assert(after, "the cooldown file must survive a failed probe")
  // THE load-bearing assertion: a probe must never lengthen the window it is
  // checking, or repeated probes would drive it to the cap and no probe could ever
  // pass again.
  assert(after.until === before.until, `the window must not grow: ${before.until} -> ${after.until}`)
  assert(after.strikes === before.strikes, `the strike count must not grow: ${before.strikes} -> ${after.strikes}`)
}

// --- a window the provider STATES is the one thing a failed probe may update ---
{
  const dir = scratch()
  const model = SLOT_MODELS[2]
  const s = cooling("probe-stated", dir, [model], 6 * 60 * 60 * 1000)

  const stub = stubClient({ [model]: "usage limit reached, Resets in 12min" })
  const report = await probe.probeCooling(stub, { state: s, directory: "/tmp", models: [model] })

  const after = pool.readLimits(s).get(model)
  const left = Math.ceil((after.until - Date.now()) / 60000)
  assert(left === 12, `a stated reset must replace the guessed window, got ${left}m`)
  assert(report.kept.includes(model), "the model is still limited, so it stays benched")
  assert(report.changed === true, "a window the provider corrected IS a change, and is worth saying")
}

// --- a probe that never answers is a failure, not a silent success -------------
{
  const dir = scratch()
  const model = SLOT_MODELS[3]
  const s = cooling("probe-hang", dir, [model], 30 * 60 * 1000)
  const before = pool.readLimits(s).get(model)

  const stub = stubClient({ [model]: "hang" })
  const report = await probe.probeCooling(stub, { state: s, directory: "/tmp", models: [model], timeoutMs: 30 })

  assert(report.kept.includes(model), "a probe with no answer must not count as one")
  assert(/no answer/.test(report.outcomes[0].reason), `the reason must say so plainly, got ${report.outcomes[0].reason}`)
  assert(stub.calls.aborted.length === 1, "a probe that overruns its deadline must be aborted")
  assert(pool.readLimits(s).get(model)?.until === before.until, "a timeout must not lengthen the window either")
}

// --- nothing cooling, and an overlapping run ----------------------------------
{
  const dir = scratch()
  const s = cooling("probe-idle", dir, [], 0)
  const stub = stubClient({})
  const report = await probe.probeCooling(stub, { state: s, directory: "/tmp" })
  assert(report.outcomes.length === 0 && report.changed === false, "nothing cooling means no probes at all")
  assert(stub.calls.prompts.length === 0, "an idle pool must cost no request")

  // A lapsed cooldown is not a cooled model: there is nothing to ask about.
  const dir2 = scratch()
  const s2 = cooling("probe-lapsed", dir2, [SLOT_MODELS[0]], -1)
  assert((await probe.probeCooling(stubClient({}), { state: s2, directory: "/tmp" })).outcomes.length === 0, "a lapsed cooldown must not be probed")

  const dir3 = scratch()
  const s3 = cooling("probe-busy", dir3, [SLOT_MODELS[0]], 60_000)
  s3.probing = true
  const busy = await probe.probeCooling(stubClient({}), { state: s3, directory: "/tmp" })
  assert(busy.outcomes.length === 0, "a run already in flight must refuse to double up")
  s3.probing = false
}

// --- the tool, end to end, through the plugin --------------------------------
{
  const dir = scratch()
  const model = SLOT_MODELS[0]
  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" }, { id: "tool", dir, modelsFile: PRESET, probeMs: 0 })
  await hooks.config(shippedConfig())

  const before = toasts.length
  const idle = await hooks.tool.pool_recheck.execute({}, {})
  assert(/nothing cooling to probe/.test(idle.title), `an idle pool must report an empty run: ${idle.title}`)
  assert(/nothing to probe/.test(idle.output), `and say so in the body: ${idle.output}`)
  // A pass that changed nothing must be SILENT: a toast every fifteen minutes
  // saying "nothing happened" is how a useful notification gets ignored.
  assert(toasts.length === before, `a silent pass must not toast, got ${toasts.join(" | ")}`)

  const result = await hooks.tool.pool_recheck.execute({ models: ["fixture-provider/never-cooled"] }, {})
  assert(/nothing cooling to probe/.test(result.title), `an unmatched filter must report an empty run: ${result.title}`)
  assert(logs.some((l) => l.includes("cooldown probe disabled")), `probeMs: 0 must be reported: ${logs.join(" | ")}`)
}

// --- a probe's failure is invisible to limit detection ------------------------
{
  const dir = scratch()
  const model = SLOT_MODELS[0]
  const { provider, id: modelID } = pool.splitModel(model)
  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" }, { id: "events", dir, modelsFile: PRESET, probeMs: 0 })
  await hooks.config(shippedConfig())
  const s = pool.state({ id: "events", dir, modelsFile: PRESET })
  cooling("events", dir, [model], 60 * 60 * 1000)

  const limitEvent = (sessionID) =>
    hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID, providerID: provider, modelID, error: { name: "ProviderError", data: { message: "Rate limit exceeded" } } } } } })

  // A REAL task hitting the limit still strikes: the prober must not have blinded
  // limit detection for everyone.
  await limitEvent("a-real-task-session")
  const afterReal = pool.readLimits(s).get(model)
  assert(afterReal && afterReal.strikes === 2, `a real failure must still strike, got ${afterReal?.strikes} strikes`)

  // A PROBE hitting the same limit does not.
  pool.markProbe(s, "a-probe-session")
  const before = pool.readLimits(s).get(model)
  await limitEvent("a-probe-session")
  assert(pool.readLimits(s).get(model).strikes === before.strikes, "a probe's failure must not count as a strike")

  // And it must not bench the provider: one 429 is evidence about one request.
  pool.coolUnavailable(s, "fixture-provider/other-model")
  // The other slot on the SAME provider as the one being cooled. Derived from the
  // preset rather than named, so swapping a pool model is not a test edit -- the
  // sibling pool tests already work that way.
  const other = SLOT_MODELS.find((m) => pool.splitModel(m).provider === provider && m !== model)
  assert(other, `the preset must give "${provider}" a second slot for this to test`)
  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "a-probe-session", status: { type: "retry", action: { reason: "free_tier_limit", provider: "opencode" } } },
    },
  })
  assert(!pool.readLimits(s).has(other), "a probe must not cool every slot on the provider")

  // ...while the same signal from real work still does.
  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "another-real-session", status: { type: "retry", action: { reason: "free_tier_limit", provider: "opencode" } } },
    },
  })
  assert(pool.readLimits(s).has(other), "a real provider-wide limit must still cool the provider's slots")
}

for (const dir of made) rmSync(dir, { recursive: true, force: true })
globalThis.fetch = realFetch
if (failures === 0) console.log("\nALL POOL RECHECK CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}