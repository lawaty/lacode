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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
const desktop = await import(join(HERE, "..", "src", "lib", "desktop-notify.ts"))
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

const { agentPoolHooks: AgentPool, reportText } = await import(PLUGIN)
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
process.env.LACODE_NOTIFY_DIR = scratch()
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

// --- matcher unit checks ------------------------------------------------------
{
  assert(pool.isAuthFailureText("401 Unauthorized") === true, "401 Unauthorized must be an auth failure")
  assert(pool.isAuthFailureText("403 Forbidden") === true, "403 Forbidden must be an auth failure")
  assert(pool.isAuthFailureText("Invalid API Token") === true, "Invalid API Token must be an auth failure")
  assert(pool.isAuthFailureText("invalid_api_key") === true, "invalid_api_key must be an auth failure")
  assert(pool.isAuthFailureText("authentication failed") === true, "authentication failed must be an auth failure")
  assert(pool.isAuthFailureText("rate limit exceeded") === false, "rate limit exceeded must not be an auth failure")
  assert(pool.isAuthFailureText("model not found") === false, "model not found must not be an auth failure")
  assert(pool.isLimitText("Invalid API Token") === false, "Invalid API Token must not be a limit")
  assert(pool.AUTH_FAILURE_COOLDOWN_MS === pool.QUOTA_COOLDOWN_MAX_MS, "auth cooldown must equal quota cooldown max")
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
  const after = pool.readLimits(s).get(model)
  assert(after?.reason === "no answer", `a timeout must re-bench the model as unresponsive, got ${after?.reason}`)
  assert(after?.strikes === before.strikes + 1, `a timeout must escalate the strike, got ${after?.strikes}`)
  assert(after.until - after.last === 120_000, `the generic backoff must double for strike 2, got ${after.until - after.last}ms`)
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
  const s2 = pool.state({ id: "probe-lapsed", dir: dir2, modelsFile: PRESET })
  pool.init(s2, () => {})
  pool.ensureSlots(s2, () => {})
  const lapsedModel = SLOT_MODELS[0]
  const limitFileName = `limit.${lapsedModel.replace(/[^a-zA-Z0-9._-]/g, "__")}.json`
  const { writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  writeFileSync(join(dir2, limitFileName), JSON.stringify({ model: lapsedModel, until: Date.now() - 1000, strikes: 1, reason: "quota", last: Date.now() - 60000 }))
  pool.readLimits(s2)
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

// --- an unanswered probe writes exactly one no-answer strike ---
{
  const dir = scratch()
  const model = SLOT_MODELS[0]
  const s = cooling("unresp-strike", dir, [], 0)
  const stub = stubClient({ [model]: "hang" })
  const report = await probe.probeModels(stub, { state: s, directory: "/tmp", models: [model], timeoutMs: 30 })
  const strike = pool.readLimits(s).get(model)
  assert(strike?.reason === "no answer", `a timeout must record the no-answer reason, got ${strike?.reason}`)
  assert(strike?.strikes === 1, `a first timeout is strike 1, got ${strike?.strikes}`)
  assert(strike.until - strike.last === 60_000, `the first no-answer backoff is 60s, got ${strike.until - strike.last}ms`)
  assert(limitFiles(dir).length === 1, `exactly one strike file, got ${limitFiles(dir).length}`)
  assert(report.outcomes[0].kind === "benched", `the outcome must say it was benched, got ${report.outcomes[0].kind}`)
  assert(report.outcomes[0].strikes === 1, `the outcome must carry the strike count, got ${report.outcomes[0].strikes}`)
}

// --- pickSlot skips a model benched by an unanswered probe and takes the next slot ---
{
  const dir = scratch()
  const model = SLOT_MODELS[0]
  const s = cooling("unresp-pick", dir, [], 0)
  const stub = stubClient({ [model]: "hang" })
  await probe.probeModels(stub, { state: s, directory: "/tmp", models: [model], timeoutMs: 30 })
  const picked = pool.pickSlot(s, pool.snapshot(s))
  assert(picked.model !== model, `a benched model must not be picked again, got ${picked.model}`)
  assert(picked.index === 2, `the next slot must be picked, got slot ${picked.index}`)
}

// --- a second unanswered probe escalates the strike and doubles the window ---
{
  const dir = scratch()
  const model = SLOT_MODELS[0]
  const s = cooling("unresp-escalate", dir, [], 0)
  const stub = stubClient({ [model]: "hang" })
  await probe.probeModels(stub, { state: s, directory: "/tmp", models: [model], timeoutMs: 30 })
  const first = pool.readLimits(s).get(model)
  await probe.probeModels(stub, { state: s, directory: "/tmp", models: [model], timeoutMs: 30 })
  const second = pool.readLimits(s).get(model)
  assert(second.strikes === 2, `the second timeout must be strike 2, got ${second.strikes}`)
  assert(second.until - second.last === 120_000, `the second window must double to 120s, got ${second.until - second.last}ms`)
  assert(second.until - second.last === 2 * (first.until - first.last), "the backoff must double each strike")
}

// --- reportText counts successes, benches and cooling instead of a fixed sentence ---
{
  const outcomes = [
    { model: "p/a", ok: true, reason: "answered", hadSeconds: 0, leftSeconds: 0, kind: "answered" },
    { model: "p/b", ok: true, reason: "answered", hadSeconds: 0, leftSeconds: 0, kind: "answered" },
    { model: "p/c", ok: true, reason: "answered", hadSeconds: 0, leftSeconds: 0, kind: "answered" },
    { model: "p/d", ok: false, reason: "no answer in 45s", hadSeconds: 30, leftSeconds: 60, kind: "benched", strikes: 1 },
  ]
  const text = reportText({ outcomes, cleared: ["p/a", "p/b", "p/c"], kept: [], missing: [], changed: true })
  assert(/p\/d: no answer in 45s — benched for 60s \(strike 1\)/.test(text), `the benched timeout must be named, got: ${text}`)
  assert(!text.includes("nothing was re-admitted"), `the fixed shortage sentence must be gone, got: ${text}`)
  assert(text.includes("summary: 3 answered, 1 benched, 0 still cooling"), `the summary must count outcomes, got: ${text}`)
}

// --- a probe that hits an auth failure benches the model for ~6h ---------------
{
  const dir = scratch()
  const model = SLOT_MODELS[0]
  const s = cooling("probe-auth", dir, [], 0)
  const stub = stubClient({ [model]: async () => ({ error: { name: "ProviderError", data: { statusCode: 401, message: "Invalid API Token" } } }) })
  const report = await probe.probeModels(stub, { state: s, directory: "/tmp", models: [model] })
  const outcome = report.outcomes[0]
  assert(outcome.ok === false, `auth probe must fail, got ${JSON.stringify(outcome)}`)
  assert(outcome.reason === pool.AUTH_FAILURE_REASON, `auth probe reason must be auth-failed, got ${outcome.reason}`)
  assert(outcome.kind === "benched", `auth probe must bench, got ${outcome.kind}`)
  assert(outcome.strikes === 1, `auth probe must be strike 1, got ${outcome.strikes}`)
  const strike = pool.readLimits(s).get(model)
  assert(!!strike, "auth probe must write a cooldown")
  assert(strike.reason === pool.AUTH_FAILURE_REASON, `cooldown reason must be auth-failed, got ${strike.reason}`)
  assert(strike.until > Date.now() + 5 * 60 * 60 * 1000, `auth bench must be ~6h, got ${strike.until - Date.now()}ms`)
  const text = reportText(report)
  assert(text.includes("auth-failed"), `reportText must contain auth-failed, got: ${text}`)
  assert(text.includes("benched"), `reportText must contain benched, got: ${text}`)
}

// --- two models, both auth-failed (multi-slot regression) ---------------------
{
  const dir = scratch()
  const m1 = SLOT_MODELS[0]
  const m2 = SLOT_MODELS[1]
  const s = cooling("probe-auth2", dir, [], 0)
  const answers = {}
  for (const m of [m1, m2]) answers[m] = async () => ({ error: { name: "ProviderError", data: { statusCode: 401, message: "Invalid API Token" } } })
  const stub = stubClient(answers)
  const report = await probe.probeModels(stub, { state: s, directory: "/tmp", models: [m1, m2] })
  assert(report.outcomes.length === 2, `two models must yield two outcomes, got ${report.outcomes.length}`)
  for (const o of report.outcomes) {
    assert(o.reason === pool.AUTH_FAILURE_REASON, `outcome reason must be auth-failed, got ${o.reason}`)
    assert(o.kind === "benched", `outcome must be benched, got ${o.kind}`)
  }
  const limits = pool.readLimits(s)
  for (const m of [m1, m2]) {
    const st = limits.get(m)
    assert(!!st && st.reason === pool.AUTH_FAILURE_REASON, `model ${m} must be benched with auth reason, got ${JSON.stringify(st)}`)
  }
}

// --- a probe re-admission of a quota-cooled model sends NO desktop notice -----
{
  const dir = scratch()
  const model = SLOT_MODELS[0]
  const { provider, id: modelID } = pool.splitModel(model)
  const stub = stubClient({ [model]: async () => ({ role: "assistant", providerID: provider, modelID }) })
  const sent = []
  const hooks = await AgentPool(
    { client: { ...client, ...stub }, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "notify-seam",
      dir,
      modelsFile: PRESET,
      probeMs: 0,
      watchMs: 0,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())

  // A pass that changes nothing must not touch the desktop.
  await hooks.tool.pool_recheck.execute({ models: ["fixture-provider/never-cooled"] }, {})
  assert(sent.length === 0, `an idle pass must not notify, got ${sent.join(" | ")}`)

  cooling("notify-seam", dir, [model], 60_000)
  const result = await hooks.tool.pool_recheck.execute({ models: [model] }, {})
  assert(/agent-pool:/.test(result.title), `the recheck tool must report: ${result.title}`)
  assert(sent.length === 0, `probe re-admission must not notify, got ${sent.length}: ${sent.join(" | ")}`)
  assert(limitFiles(dir).length === 0, "the cooldown file must be gone")
  await hooks.dispose?.()
}

// --- a cooldown that simply times out also raises a notice -------------------
{
  const dir = scratch()
  const model = SLOT_MODELS[1]
  const sent = []
  const hooks = await AgentPool(
    { client, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "expiry-watch",
      dir,
      modelsFile: PRESET,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 50,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())

  // Not cooling when the watcher starts: it must see it become cooling first,
  // then notice the window lapse without any probe at all.
  cooling("expiry-watch", dir, [model], 800)
  await new Promise((resolve) => setTimeout(resolve, 1_500))

  assert(sent.length === 1, `a natural expiry must notify once, got ${sent.length}: ${sent.join(" | ")}`)
  assert(sent[0].startsWith("LaCode: rate limit reset:"), `the notice must have a fixed title: ${sent[0]}`)
  assert(sent[0].includes(model), `the notice must name the recovered model: ${sent[0]}`)
  assert(/rate limit has reset/.test(sent[0]), `the notice must say the rate limit has reset: ${sent[0]}`)
  await hooks.dispose?.()
}

// --- the session-less sender uses the same helper contract -------------------
{
  const dir = scratch()
  const sent = join(dir, "sent.log")
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
  const previous = process.env.OC_NOTIFY_HELPER
  process.env.OC_NOTIFY_HELPER = helper
  try {
    assert(desktop.notifyDesktop("LaCode: rate limit reset", "slot-1 is available again — the rate limit has reset."), "a helper must be found and spawned")
    await new Promise((resolve) => setTimeout(resolve, 600))
    const lines = existsSync(sent) ? readFileSync(sent, "utf8").trim().split("\n").filter(Boolean) : []
    assert(lines.length === 1, `expected one helper call, got ${lines.length}: ${JSON.stringify(lines)}`)
    assert(
      lines[0].includes("LaCode: rate limit reset") && lines[0].includes("rate limit has reset"),
      `the helper must receive title and message: ${lines[0]}`,
    )
  } finally {
    if (previous === undefined) delete process.env.OC_NOTIFY_HELPER
    else process.env.OC_NOTIFY_HELPER = previous
  }
}

// --- auth/missing-model expiries must NOT produce a desktop notice ------------
{
  const dir = scratch()
  const model = SLOT_MODELS[2]
  const sent = []
  const hooks = await AgentPool(
    { client, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "expiry-watch-nonquota",
      dir,
      modelsFile: PRESET,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 50,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())

  cooling("expiry-watch-nonquota", dir, [model], 800)
  const s2 = pool.state({ id: "expiry-watch-nonquota", dir, modelsFile: PRESET })
  pool.init(s2, () => {})
  pool.ensureSlots(s2, () => {})
  // Replace with non-quota reason by recording again? recordStrike adds strikes; easier to just write directly
  const { writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const limitFileName = `limit.${model.replace(/[^a-zA-Z0-9._-]/g, "__")}.json`
  writeFileSync(join(dir, limitFileName), JSON.stringify({ model, until: Date.now() + 800, strikes: 1, reason: pool.AUTH_FAILURE_REASON, last: Date.now() }))
  await new Promise((resolve) => setTimeout(resolve, 1_500))

  assert(sent.length === 0, `an auth expiry must not notify, got ${sent.join(" | ")}`)
  await hooks.dispose?.()
}

// --- a probe that re-admits a non-quota-cooled model must NOT notify ---------
{
  const dir = scratch()
  const model = SLOT_MODELS[3]
  const { provider, id: modelID } = pool.splitModel(model)
  const stub = stubClient({ [model]: async () => ({ role: "assistant", providerID: provider, modelID }) })
  const sent = []
  const hooks = await AgentPool(
    { client: { ...client, ...stub }, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "notify-seam-nonquota",
      dir,
      modelsFile: PRESET,
      probeMs: 0,
      watchMs: 0,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())

  const { writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const limitFileName = `limit.${model.replace(/[^a-zA-Z0-9._-]/g, "__")}.json`
  writeFileSync(join(dir, limitFileName), JSON.stringify({ model, until: Date.now() + 60_000, strikes: 1, reason: "custom-outage", last: Date.now() }))
  const result = await hooks.tool.pool_recheck.execute({ models: [model] }, {})
  assert(result && result.title, `result must exist: ${JSON.stringify(result)}`)
  assert(sent.length === 0, `a non-quota reset must not notify, got ${sent.join(" | ")}`)
  await hooks.dispose?.()
}




// --- a cooldown removed BEFORE its until (early clear) produces NO notice -----
{
  const dir = scratch()
  const model = SLOT_MODELS[0 % SLOT_MODELS.length]
  const { provider, id: modelID } = pool.splitModel(model)
  const stub = stubClient({ [model]: async () => ({ role: "assistant", providerID: provider, modelID }) })
  const sent = []
  const hooks = await AgentPool(
    { client: { ...client, ...stub }, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "early-clear",
      dir,
      modelsFile: PRESET,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 50,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())
  // Let watcher observe a quota cooldown, then have a probe clear it early.
  cooling("early-clear", dir, [model], 60_000)
  await new Promise((resolve) => setTimeout(resolve, 100))
  await hooks.tool.pool_recheck.execute({ models: [model] }, {})
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert(sent.length === 0, `early probe/recheck clear must not notify, got ${sent.join(" | ")}`)
  await hooks.dispose?.()
}

// --- throttle: a second natural expiry within 30 min is suppressed -------------
{
  const dir = scratch()
  const model = SLOT_MODELS[1 % SLOT_MODELS.length]
  const sent = []
  const prevNotifyDir = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = scratch()
  const hooks = await AgentPool(
    { client, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "throttle-expiry",
      dir,
      modelsFile: PRESET,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 50,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())
  cooling("throttle-expiry", dir, [model], 400)
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert(sent.length === 1, `first natural expiry must notify once, got ${sent.length}: ${sent.join(" | ")}`)
  // Cool the same model again and let it expire naturally within 30 minutes of first notice.
  cooling("throttle-expiry", dir, [model], 400)
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert(sent.length === 1, `second natural expiry within 30 minutes must be throttled, got ${sent.length}: ${sent.join(" | ")}`)
  await hooks.dispose?.()
  if (prevNotifyDir === undefined) delete process.env.LACODE_NOTIFY_DIR
  else process.env.LACODE_NOTIFY_DIR = prevNotifyDir
}

// --- US-34: notify:false suppresses rate-limit reset notice -------------------
{
  const model = SLOT_MODELS[0]
  const sent = []
  const claimsDir = scratch()
  const modelsInline = { slots: [{ model, weight: 1, notify: false }] }
  const prevNotifyDir = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = scratch()
  const hooks = await AgentPool(
    { client, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "notify-off",
      dir: claimsDir,
      models: modelsInline,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 50,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())
  // Natural expiry path (probe/recheck must not announce).
  cooling("notify-off", claimsDir, [model], 400)
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert(sent.length === 0, `[US-34] Recovering slot configured notify:false -> NO reset notice is raised, got ${sent.join(" | ")}`)
  await hooks.dispose?.()
  if (prevNotifyDir === undefined) delete process.env.LACODE_NOTIFY_DIR
  else process.env.LACODE_NOTIFY_DIR = prevNotifyDir
}

// --- US-34 control: notify on -> exactly one reset notice ---------------------
{
  const model = SLOT_MODELS[1]
  const sent = []
  const claimsDir = scratch()
  const modelsInline = { slots: [{ model, weight: 1, notify: true }] }
  const prevNotifyDir = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = scratch()
  const hooks = await AgentPool(
    { client, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "notify-on-x",
      dir: claimsDir,
      models: modelsInline,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 50,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())
  cooling("notify-on-x", claimsDir, [model], 400)
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert(sent.length === 1, `[US-34] Control: notify on -> exactly one reset notice, got ${sent.length}: ${sent.join(" | ")}`)
  await hooks.dispose?.()
  if (prevNotifyDir === undefined) delete process.env.LACODE_NOTIFY_DIR
  else process.env.LACODE_NOTIFY_DIR = prevNotifyDir
}

// --- US-34: non-opencode default-off suppresses reset notice ------------------
{
  const model = "groq/openai/gpt-oss-120b"
  const sent = []
  const claimsDir = scratch()
  const modelsInline = { slots: [{ model, weight: 1 }] }
  const prevNotifyDir = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = scratch()
  const hooks = await AgentPool(
    { client, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" },
    {
      id: "notify-default-off",
      dir: claimsDir,
      models: modelsInline,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 50,
      notify: (title, message) => sent.push(`${title}: ${message}`),
    },
  )
  await hooks.config(shippedConfig())
  cooling("notify-default-off", claimsDir, [model], 400)
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert(sent.length === 0, `[US-34] a non-opencode slot with no explicit opt-in is silent by default, got ${sent.join(" | ")}`)
  await hooks.dispose?.()
  if (prevNotifyDir === undefined) delete process.env.LACODE_NOTIFY_DIR
  else process.env.LACODE_NOTIFY_DIR = prevNotifyDir
}

for (const dir of made) rmSync(dir, { recursive: true, force: true })
globalThis.fetch = realFetch
if (failures === 0) console.log("\nALL POOL RECHECK CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
