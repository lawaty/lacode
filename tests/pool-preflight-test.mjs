// Route preflight: a slot that refuses a request is skipped BEFORE the spawn.
//
// The contract this pins is the one the caller sees: one `task` call in, one
// working slot out. A refusing candidate costs a one-word probe, not a spawned
// child session, an abort, and a primary-agent turn — and when every candidate
// refuses, the error leads with the nearest cooldown and its remaining seconds.
//
// Run with: node tests/pool-preflight-test.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")
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
  const dir = mkdtempSync(join(tmpdir(), "pool-preflight-"))
  made.push(dir)
  return dir
}

const refused = () => ({
  error: { name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429, isRetryable: true } },
})
const answered = () => ({ data: { info: {} } })

/**
 * A hook harness with a session client that records every probe.
 *
 * `answers` maps a model id to a response: a function is called per request, a
 * plain object is returned as-is. A model missing from the map answers.
 */
const make = async ({ dir, models, answers, preflightMs }) => {
  const modelsFile = join(dir, "models.txt")
  writeFileSync(modelsFile, `${models.map((model) => `${model} 1`).join("\n")}\n`)

  const calls = { created: [], prompts: [], aborted: [], deleted: [] }
  let n = 0
  const client = {
    app: { log: async () => {} },
    provider: {
      list: async () => ({
        data: {
          connected: ["opencode"],
          all: [{ id: "opencode", env: [], key: "test-key", options: {}, models: {} }],
        },
      }),
    },
    session: {
      create: async (options) => {
        calls.created.push(options?.body?.title ?? "")
        return { data: { id: `probe-${++n}` } }
      },
      prompt: async (options) => {
        const { providerID, modelID } = options?.body?.model ?? {}
        const model = `${providerID}/${modelID}`
        calls.prompts.push(model)
        const answer = answers[model]
        return typeof answer === "function" ? answer() : (answer ?? answered())
      },
      abort: async (options) => {
        calls.aborted.push(options?.path?.id ?? "")
        return {}
      },
      delete: async (options) => {
        calls.deleted.push(options?.path?.id ?? "")
        return {}
      },
    },
  }

  const opts = { id: `preflight-${process.pid}-${Math.random()}`, dir, modelsFile, probeMs: 0 }
  if (preflightMs !== undefined) opts.preflightMs = preflightMs
  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, opts)
  await hooks.config(shippedConfig())
  return { hooks, calls }
}

const spawn = async (hooks, callID, sessionID = "parent") => {
  const out = { args: { subagent_type: "explore", prompt: "x" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
  return out.args.subagent_type
}

// 1. The first slot refuses; the second answers; ONE task call routes to it.
{
  const { hooks, calls } = await make({
    dir: scratch(),
    models: ["opencode/alpha", "opencode/beta"],
    answers: { "opencode/alpha": refused(), "opencode/beta": answered() },
  })

  const routed = await spawn(hooks, "p1")
  assert(routed === "explore-2", `expected routing to the answering slot 2, got ${routed}`)
  assert(
    calls.prompts.join(",") === "opencode/alpha,opencode/beta",
    `expected one probe per candidate in order, got ${calls.prompts.join(",")}`,
  )
  assert(calls.deleted.length === 2, `both probe sessions must be deleted, got ${calls.deleted.length}`)
  assert(calls.created.length === 2, `preflight must create probe sessions only, got ${calls.created.length}`)

  // A model that answered is trusted for the TTL: the next spawn must not pay a
  // probe again, or the optimisation becomes a per-spawn slowdown.
  const promptsBefore = calls.prompts.length
  const second = await spawn(hooks, "p2")
  assert(second === "explore-2", `the verified slot must keep winning, got ${second}`)
  assert(
    calls.prompts.length === promptsBefore,
    `a verified slot must not be probed again inside the TTL (${promptsBefore} -> ${calls.prompts.length})`,
  )
}

// 2. Every candidate refuses: refuse the spawn with the nearest cooldown, not a
//    dead slot. The caller gets one actionable retry instead of a loop.
{
  const { hooks, calls } = await make({
    dir: scratch(),
    models: ["opencode/alpha", "opencode/beta"],
    answers: { "opencode/alpha": refused(), "opencode/beta": refused() },
  })

  let error
  try {
    await spawn(hooks, "p3")
  } catch (caught) {
    error = caught
  }
  assert(error instanceof Error, "an all-refusing pool must fail the spawn, not route")
  assert(/no slots to route to/i.test(String(error?.message)), `error must name the refusal, got ${error?.message}`)
  assert(/cooling/i.test(String(error?.message)), `error must say the slots are cooling, got ${error?.message}`)
  assert(/nearest is/i.test(String(error?.message)), `error must name the nearest cooldown, got ${error?.message}`)
  assert(/in \d+s/i.test(String(error?.message)), `error must state the remaining seconds, got ${error?.message}`)
  assert(calls.prompts.length === 2, `preflight must have asked both candidates once, got ${calls.prompts.length}`)
}

// 3. preflightMs: 0 restores blind routing and costs no request.
{
  const { hooks, calls } = await make({
    dir: scratch(),
    models: ["opencode/alpha", "opencode/beta"],
    answers: { "opencode/alpha": refused(), "opencode/beta": answered() },
    preflightMs: 0,
  })

  const routed = await spawn(hooks, "p4")
  assert(routed === "explore-1", `disabled preflight must take the first slot, got ${routed}`)
  assert(calls.prompts.length === 0, `disabled preflight must send no probe, got ${calls.prompts.length}`)
}

for (const dir of made) rmSync(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`)
  process.exitCode = 1
} else {
  console.log("\nALL PREFLIGHT CHECKS PASSED")
}
