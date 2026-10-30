// Provider/connectivity and session.error handling for the agent pool.
// Run: node tests/pool-provider-test.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"
import { UNBOUND_CLAIM_MS } from "../src/lib/pool.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")
const cfg = shippedConfig()

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

const made = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-provider-"))
  made.push(dir)
  return dir
}

const REAL = Date.now()
let clock = 0
Date.now = () => REAL + clock

const { agentPoolHooks: AgentPool } = await import(PLUGIN)

// Scenario 1
{
  const dir = scratch()
  const modelsFile = join(dir, "models.txt")
  writeFileSync(modelsFile, "missing/x 2\nopencode/big-pickle 1\n")

  const logs = []
  let providerEntries = [
    { id: "opencode", env: [], key: "test-key", options: {}, models: {} },
    { id: "missing", env: ["LACODE_TEST_MISSING_KEY"], options: {}, models: {} },
  ]
  const connectedProviders = ["opencode", "missing"]
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    provider: {
      list: async () => ({ data: { connected: connectedProviders, all: providerEntries } }),
    },
  }

  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, { id: "provider-1", dir, modelsFile })
  await hooks.config(cfg)

  const spawn = async (callID, sessionID = "parent") => {
    const out = { args: { subagent_type: "explore", prompt: "x" } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
    return out.args.subagent_type
  }
  const status = async () => (await hooks.tool.pool_status.execute({}, {})).output

  const s1 = await spawn("a1", "parent")
  const s2 = await spawn("a2", "parent")
  assert(s1 === "explore-2", `first spawn should go to slot 2, got ${s1}`)
  assert(s2 === "explore-2", `second spawn should go to slot 2, got ${s2}`)

  const st1 = await status()
  assert(st1.includes("slot 1 w2  missing/x"), `status must show slot 1 unavailable info, got:\n${st1}`)
  assert(st1.includes("UNAVAILABLE (provider-unconfigured: missing"), `status must report provider-unconfigured for missing, got:\n${st1}`)

  // Simulate credential arriving
  providerEntries = [
    { id: "opencode", env: [], key: "test-key", options: {}, models: {} },
    { id: "missing", env: ["LACODE_TEST_MISSING_KEY"], options: {}, key: "test-key", models: {} },
  ]

  await status() // force-refreshes
  const s3 = await spawn("a3", "parent")
  assert(s3 === "explore-1", `after provider connected, should route to slot 1, got ${s3}`)
}

// Scenario 2
{
  clock = 0
  const dir = scratch()
  const modelsFile = join(dir, "models.txt")
  writeFileSync(modelsFile, "opencode/big-pickle 2\n")

  const logs = []
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    provider: {
      list: async () => ({ data: { connected: ["opencode"], all: [{ id: "opencode", env: [], key: "test-key", options: {}, models: {} }] } }),
    },
  }

  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, { id: "failed-spawn-1", dir, modelsFile })
  await hooks.config(cfg)

  const spawn = async (callID, sessionID = "parent") => {
    const out = { args: { subagent_type: "explore", prompt: "x" } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
    return out.args.subagent_type
  }
  const status = async () => (await hooks.tool.pool_status.execute({}, {})).output
  const childCreated = (parentID, childID) =>
    hooks.event({ event: { type: "session.created", properties: { info: { id: childID, parentID } } } })
  const sessionError = (sessionID, error) =>
    hooks.event({ event: { type: "session.error", properties: { sessionID, error } } })

  const f1 = await spawn("f1", "parent")
  assert(f1 === "explore-1", `first spawn should be explore-1, got ${f1}`)
  let st = await status()
  assert(st.includes("slot 1 w2  opencode/big-pickle  load=1/2"), `status must show load=1/2, got:\n${st}`)

  await childCreated("parent", "child-1")
  await sessionError("child-1", { name: "UnknownError", data: { message: "Model not found: opencode/big-pickle" } })

  st = await status()
  assert(st.includes("load=0/2"), `after model-not-found, load must be 0/2, got:\n${st}`)
  assert(st.includes("COOLING"), `after model-not-found, slot must be COOLING, got:\n${st}`)
  assert(st.includes("model-missing"), `after model-not-found, reason must be model-missing, got:\n${st}`)

  const f2 = await spawn("f2", "parent")
  assert(f2 === "explore-1", `spawn after cooling should route to explore-1, got ${f2}`)

  await childCreated("parent", "child-2")
  await sessionError("child-2", { name: "UnknownError", data: { message: "boom" } })

  st = await status()
  assert(st.includes("load=0/2"), `after generic error, load must be 0/2, got:\n${st}`)

  // A. Assistant-message model-not-found
  const fMsg = await spawn("f-msg", "parent")
  assert(fMsg === "explore-1", `spawn f-msg should route to explore-1, got ${fMsg}`)
  await childCreated("parent", "child-msg")
  hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          sessionID: "child-msg",
          providerID: "opencode",
          modelID: "big-pickle",
          error: { name: "UnknownError", data: { message: "Model not found: opencode/big-pickle" } },
        },
      },
    },
  })
  st = await status()
  assert(st.includes("load=0/2"), `after assistant-message model-not-found, load must be 0/2, got:\n${st}`)
  assert(st.includes("model-missing"), `after assistant-message model-not-found, status must still contain model-missing, got:\n${st}`)

  // B. Unbound claim + model-not-found error on the parent
  await spawn("f-unbound", "parent")
  await sessionError("parent", { name: "UnknownError", data: { message: "Model not found: opencode/big-pickle" } })
  st = await status()
  assert(st.includes("load=0/2"), `after unbound claim + parent model-not-found, load must be 0/2, got:\n${st}`)

  // Unbound-claim expiry
  clock = 0
  await spawn("f-expiry", "parent")
  clock = UNBOUND_CLAIM_MS + 1000
  st = await status()
  assert(st.includes("load=0/2"), `after unbound claim expiry, load must be 0/2, got:\n${st}`)
}

// Scenario 3
{
  const dir = scratch()
  const modelsFile = join(dir, "models.txt")
  writeFileSync(modelsFile, "configured/y 1\n")

  const client = {
    app: { log: async () => {} },
    provider: {
      list: async () => ({ data: { connected: ["configured"], all: [{ id: "configured", env: [], options: {}, models: {} }] } }),
    },
  }

  const cfg3 = shippedConfig()
  if (cfg3.provider && cfg3.provider.configured) {
    cfg3.provider.configured = { options: { apiKey: "resolved-secret" } }
  } else if (cfg3.provider) {
    cfg3.provider.configured = { options: { apiKey: "resolved-secret" } }
  } else {
    cfg3.provider = { configured: { options: { apiKey: "resolved-secret" } } }
  }

  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, { id: "provider-3", dir, modelsFile })
  await hooks.config(cfg3)

  const spawn = async (callID, sessionID = "parent") => {
    const out = { args: { subagent_type: "explore", prompt: "x" } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
    return out.args.subagent_type
  }

  const s1 = await spawn("c1", "parent")
  assert(s1 === "explore-1", `config-resolved credential should allow routing, got ${s1}`)
}

Date.now = REAL
for (const dir of made) rmSync(dir, { recursive: true, force: true })
if (failures === 0) {
  console.log("\nALL CHECKS PASSED")
} else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
