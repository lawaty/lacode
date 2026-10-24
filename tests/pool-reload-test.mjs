// A pool file that changes on disk is picked up live.
//
// The table was read once per process; this pins the replacement: watch the
// files the resolution chain consults, reload the table when it ACTUALLY
// changed, re-bind the variant agents to it, and validate every slot -- a model
// the provider does not serve is benched before a spawn is routed to it.
//
// Run with: node tests/pool-reload-test.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PRESET = join(HERE, "..", "presets", "free-tier.json")
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")

const pool = await import(join(HERE, "..", "src", "lib", "pool.ts"))
const probe = await import(join(HERE, "..", "src", "lib", "probe.ts"))
const SLOT_MODELS = JSON.parse(readFileSync(PRESET, "utf8")).slots.map((s) => s.model)
const [A, B] = SLOT_MODELS
// A model id the stub reports as withdrawn. Deliberately not one of the preset's
// slots, so replacing a slot with it is a real table change.
const MISSING = "opencode-go/longcat-2.5-preview-free"

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
  const dir = mkdtempSync(join(tmpdir(), "reload-"))
  made.push(dir)
  return dir
}
const slotFile = (dir, name = "pool.json") => join(dir, name)
const writeSlots = (path, models) =>
  writeFileSync(path, JSON.stringify({ slots: models.map((model, i) => ({ model, weight: i === 0 ? 3 : 1 })) }))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 2500) => {
  const at = Date.now()
  while (Date.now() - at < timeoutMs) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

/** The four calls a probe makes; `answers` decides what each model does. */
const stubClient = (answers) => {
  const calls = { created: [], prompts: [], deleted: [] }
  let n = 0
  return {
    calls,
    session: {
      create: async (o) => {
        calls.created.push(o?.body?.title ?? "")
        return { data: { id: `probe-${++n}` } }
      },
      prompt: async (o) => {
        const { providerID, modelID } = o?.body?.model ?? {}
        const model = `${providerID}/${modelID}`
        calls.prompts.push(model)
        const answer = answers[model]
        if (typeof answer === "function") return { data: { info: await answer() } }
        return { data: { info: { error: { name: "ProviderError", data: { message: String(answer ?? "Rate limit exceeded") } } } } }
      },
      abort: async () => {},
      delete: async (o) => void calls.deleted.push(o?.path?.id),
    },
  }
}

// --- which files the chain consults ------------------------------------------
{
  const sources = pool.slotSources({})
  assert(sources.length === 3, `the default chain has three files, got ${JSON.stringify(sources)}`)
  assert(sources[0] === pool.USER_MODELS_TXT && sources[1] === pool.USER_MODELS_PATH && sources[2] === pool.DEFAULT_PRESET, `chain order: ${JSON.stringify(sources)}`)
  assert(JSON.stringify(pool.slotSources({ modelsFile: "/tmp/x.json" })) === JSON.stringify(["/tmp/x.json"]), "an explicit file replaces the chain")
  assert(pool.slotSources({ models: { slots: [] } }).length === 0, "an inline table has no file to watch")
}

// --- reload only when the table changed --------------------------------------
{
  const dir = scratch()
  const file = slotFile(dir)
  writeSlots(file, [A])
  const s = pool.state({ id: "reload-unit", dir: join(dir, "state"), modelsFile: file })
  pool.init(s, () => {})

  assert(pool.reloadSlots(s, () => {}).changed === false, "the table init just read has not changed")

  writeSlots(file, [A, MISSING])
  const changed = pool.reloadSlots(s, () => {})
  assert(changed.changed === true, "a new slot is a change")
  assert(changed.slots.length === 2 && changed.slots[1].model === MISSING, `the new table must be installed: ${JSON.stringify(changed.slots)}`)
  assert(s.slots.length === 2 && s.origin === file, "s.slots and s.origin must follow the reload")

  const same = pool.reloadSlots(s, () => {})
  assert(same.changed === false, "the same table, even rewritten, is not a change")
}

// --- the watcher: reload, re-bind, validate, and stop on dispose -------------
{
  const dir = scratch()
  const file = slotFile(dir)
  const stateDir = join(dir, "state")
  writeSlots(file, [A, B])

  const stub = stubClient({
    [A]: async () => ({ role: "assistant" }),
    [B]: async () => ({ role: "assistant" }),
    [MISSING]: `Model not found: ${MISSING}. Did you mean: longcat-2.0?`,
  })
  const opts = { id: "watcher", dir: stateDir, modelsFile: file, probeMs: 0, reapMs: 60_000, watchMs: 20, watchDebounceMs: 5 }
  const hooks = await AgentPool({ client: { ...client, session: stub.session }, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" }, opts)
  const cfg = shippedConfig()
  await hooks.config(cfg)
  const s = pool.state(opts)

  writeSlots(file, [A, MISSING])
  const reloaded = await waitFor(() => s.slots.some((slot) => slot.model === MISSING))
  assert(reloaded, `the watcher must install the changed table, has ${JSON.stringify(s.slots)}`)
  assert(cfg.agent["explore-2"]?.model === MISSING, `the variant must be re-bound, got ${cfg.agent["explore-2"]?.model}`)
  assert(cfg.agent["implement-2"]?.model === MISSING, `every base must be re-bound, got ${cfg.agent["implement-2"]?.model}`)

  const probed = await waitFor(() => stub.calls.prompts.includes(MISSING))
  assert(probed, `every slot must be validated, probed ${JSON.stringify(stub.calls.prompts)}`)
  assert(stub.calls.prompts.includes(A), `the surviving slot is validated too: ${JSON.stringify(stub.calls.prompts)}`)

  const bench = pool.readLimits(s).get(MISSING)
  assert(bench && bench.reason === pool.MODEL_MISSING_REASON, `a withdrawn model must be benched, got ${JSON.stringify(bench)}`)
  assert(bench.strikes === 1, `the bench is a cooling record, not an escalating strike: ${bench.strikes}`)
  assert(s.slots[1].model === MISSING, "the slot itself stays in the table; its cooldown is what removes it from routing")

  // The status is where an operator looks: it must say the watch is armed.
  const status = await hooks.tool.pool_status.execute({}, {})
  assert(/pool config watch:/.test(status.output), `pool_status must report the watch: ${status.output}`)
  assert(status.output.includes(MISSING), `pool_status must show the reloaded slot: ${status.output}`)

  const beforeDispose = stub.calls.prompts.length
  await hooks.dispose()
  writeSlots(file, [B, A])
  await sleep(150)
  assert(stub.calls.prompts.length === beforeDispose, `dispose must stop the watcher, ${beforeDispose} -> ${stub.calls.prompts.length}`)
}

// --- pool_recheck with models validates them even when they are not cooling ---
{
  const dir = scratch()
  const file = slotFile(dir)
  writeSlots(file, [A])

  const stub = stubClient({
    [A]: async () => ({ role: "assistant" }),
    [MISSING]: `Model not found: ${MISSING}. Did you mean: longcat-2.0?`,
  })
  const opts = { id: "explicit", dir: join(dir, "state"), modelsFile: file, probeMs: 0, reapMs: 60_000, watchMs: 0 }
  const hooks = await AgentPool({ client: { ...client, session: stub.session }, serverUrl: new URL("http://127.0.0.1:59999"), directory: "/tmp" }, opts)
  await hooks.config(shippedConfig())
  const s = pool.state(opts)

  const healthy = await hooks.tool.pool_recheck.execute({ models: [A] }, {})
  assert(/probed 1 model/.test(healthy.title), `an explicit model must be validated even when healthy: ${healthy.title}`)
  assert(stub.calls.prompts.includes(A), "the healthy model must actually be asked")

  // Omitted models keeps the old, cheap contract: nothing cooling, no probe.
  const idle = await hooks.tool.pool_recheck.execute({}, {})
  assert(/nothing cooling to probe/.test(idle.title), `nothing cooling means no probes: ${idle.title}`)

  const missing = await hooks.tool.pool_recheck.execute({ models: [MISSING] }, {})
  assert(stub.calls.prompts.includes(MISSING), "the explicit missing model must be asked")
  assert(/benched 1 missing/.test(missing.title), `the title must name the bench: ${missing.title}`)
  assert(pool.readLimits(s).get(MISSING)?.reason === pool.MODEL_MISSING_REASON, "the missing model must be benched")
  await hooks.dispose()
}

// --- a probe run already in flight wins over validation ----------------------
{
  const dir = scratch()
  const s = pool.state({ id: "busy-reload", dir: join(dir, "state"), modelsFile: PRESET })
  pool.init(s, () => {})
  s.probing = true
  const report = await probe.probeModels(stubClient({}), { state: s, directory: "/tmp", models: [A] })
  assert(report.outcomes.length === 0, "a validation must not overlap a probe")
  s.probing = false
}

for (const dir of made) rmSync(dir, { recursive: true, force: true })
globalThis.fetch = realFetch
if (failures === 0) console.log("\nALL POOL RELOAD CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
