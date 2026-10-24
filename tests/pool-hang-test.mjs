// Hang-reaping tests: a stuck subagent is detected from silence, its child
// session is aborted, the slot is freed, and the model is cooled. Also proves
// the reaper never kills a task that is still producing output.
// Run: node tests/pool-hang-test.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")
const cfg = shippedConfig()

// presets/free-tier.json owns the pool's models, so the model a hang cools is read
// from it rather than repeated here.
const { splitModel } = await import(join(HERE, "..", "src", "lib", "pool.ts"))
const { provider: SLOT_PROVIDER, id: SLOT_MODEL_ID } = splitModel(JSON.parse(readFileSync(join(HERE, "..", "presets", "free-tier.json"), "utf8")).slots[0].model)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

const made = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "hang-"))
  made.push(dir)
  return dir
}

// One stub for the whole file: any /session/<id>/abort lands in `aborted`.
let aborted = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const m = /\/session\/([^/]+)\/abort/.exec(String(url))
  if (m) aborted.push(m[1])
  return new Response("true", { status: 200 })
}

// A single controllable clock: advance minutes instead of patching/restoring.
const REAL = Date.now()
let clock = 0
Date.now = () => REAL + clock

const mk = async (id, dir) => {
  const logs = []
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      abort: async ({ path }) => {
        const res = await fetch(`http://localhost/session/${path.id}/abort`, { method: "POST" })
        const text = (await res.text()).trim()
        return { data: text === "true" ? true : text === "false" ? false : undefined, response: res, error: undefined, request: undefined }
      },
    },
  }
  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, { id, dir })
  await hooks.config(cfg)
  return {
    hooks,
    logs,
    spawn: async (callID, sessionID = "parent") => {
      const out = { args: { subagent_type: "explore", prompt: "x" } }
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
      return out.args.subagent_type
    },
    childCreated: (parentID, childID) =>
      hooks.event({ event: { type: "session.created", properties: { info: { id: childID, parentID } } } }),
    active: (sessionID) =>
      hooks.event({ event: { type: "message.part.updated", properties: { part: { sessionID, type: "text", text: "x" } } } }),
    status: async () => (await hooks.tool.pool_status.execute({}, {})).output,
  }
}

const { agentPoolHooks: AgentPool } = await import(PLUGIN)

// 1. silent hung child -> aborted, slot freed, model cooled
{
  aborted = []
  clock = 0
  const t = await mk("hang1", scratch())
  const variant = await t.spawn("h1", "parent")
  await t.childCreated("parent", "child-hung")

  clock = 6 * 60_000 // older than STUCK_MIN_AGE, but still producing output
  await t.active("child-hung")
  await t.spawn("h2", "parent")
  assert(!aborted.includes("child-hung"), `must not abort while the child is still active, got ${JSON.stringify(aborted)}`)

  clock = 10 * 60_000 // now 4min of silence: past STUCK_IDLE
  const afterHang = await t.spawn("h3", "parent")

  assert(aborted.includes("child-hung"), `hung child must be aborted, got ${JSON.stringify(aborted)}`)
  assert(afterHang !== variant, `slot must be freed and model cooled (stuck=${variant} next=${afterHang})`)
  assert(t.logs.some((l) => l.includes("aborted session child-hung")), "must log the abort")
  assert(/hang/.test(await t.status()), "status should show the model cooling for a hang")
}

// 2. a child that keeps emitting output is never reaped, however long it runs
{
  aborted = []
  clock = 0
  const t = await mk("hang2", scratch())
  await t.spawn("k1", "parent")
  await t.childCreated("parent", "child-busy")
  for (let i = 0; i < 12; i++) {
    clock += 2 * 60_000 // 24 minutes of total runtime
    await t.active("child-busy")
    await t.spawn(`k${i + 2}`, "parent")
  }
  const status = await t.status()
  assert(!aborted.includes("child-busy"), `a 24min working child must never be aborted, got ${JSON.stringify(aborted)}`)
  assert(/hung past \d+min with \d+min silence: 0/.test(status), `a busy pool must report 0 hung, got:\n${status}`)
}

// 3. the claiming parent session is never a reap target
{
  aborted = []
  clock = 0
  const t = await mk("hang3", scratch())
  await t.spawn("r1", "parent") // no child session ever binds
  clock = 30 * 60_000
  await t.spawn("r2", "parent")
  assert(!aborted.includes("parent"), `must never abort the claiming parent, got ${JSON.stringify(aborted)}`)
}

// 4. a stated provider reset survives into the hang cooldown. 40min is chosen
//    deliberately: 10min after the hang, a fresh HANG_COOLDOWN_MS fallback would
//    read 600s, so only honouring the stated 40min window gives 1800s.
{
  aborted = []
  clock = 0
  const t = await mk("hang4", scratch())
  await t.hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          providerID: SLOT_PROVIDER,
          modelID: SLOT_MODEL_ID,
          error: { name: "APIError", data: { message: "5-hour usage limit reached. Resets in 40min.", isRetryable: false } },
        },
      },
    },
  })
  await t.spawn("s1", "parent")
  await t.childCreated("parent", "child-reset")
  clock = 10 * 60_000
  await t.spawn("s2", "parent")
  const seconds = Number(new RegExp(`${SLOT_PROVIDER}/${SLOT_MODEL_ID} for (\\d+)s`).exec(await t.status())?.[1])
  assert(seconds > 1700 && seconds <= 1800, `hang must reuse the stated 40min reset (30min left), got ${seconds}s`)
}

// 5. each claim gets its own child; both are reaped independently
{
  aborted = []
  clock = 0
  const t = await mk("hang5", scratch())
  await t.spawn("m1", "parent")
  await t.spawn("m2", "parent")
  await t.childCreated("parent", "child-A")
  await t.childCreated("parent", "child-B")
  clock = 10 * 60_000
  await t.spawn("m3", "parent")
  assert(aborted.includes("child-A") && aborted.includes("child-B"), `both children should be reaped, got ${JSON.stringify(aborted)}`)
}

Date.now = REAL
globalThis.fetch = realFetch
for (const dir of made) rmSync(dir, { recursive: true, force: true })
if (failures === 0) console.log("\nALL HANG CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}