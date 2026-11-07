// estimateContextTokens: the task hook's context need estimate and its
// hook-level routing, mirroring the pickSlot checks in pool-context-test.mjs.
// No framework and no network: the hook is called with a stub client and a
// scratch claim dir, the same shape as pool-timer-test.mjs.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { estimateContextTokens, CONTEXT_HEADROOM_TOKENS, agentPoolHooks } from "../src/plugins/agent-pool.ts"
import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
}

// The helper: 40 000 chars at ~4 chars per token plus headroom.
{
  const prompt = "x".repeat(40_000)
  const got = estimateContextTokens(prompt)
  const want = 10_000 + CONTEXT_HEADROOM_TOKENS
  assert(got === want, `estimate(40000 chars) must be ${want}, got ${got}`)
  console.log("estimateContextTokens 40000 ->", got)
}
{
  assert(estimateContextTokens("") === undefined, "empty string must be undefined")
  assert(estimateContextTokens(42) === undefined, "non-string must be undefined")
  assert(estimateContextTokens(null) === undefined, "null must be undefined")
  assert(estimateContextTokens(undefined) === undefined, "undefined must be undefined")
  assert(estimateContextTokens({ prompt: "x" }) === undefined, "object must be undefined")
  console.log("estimateContextTokens empty/non-string -> undefined ok")
}

// Hook-level: a short prompt fits the small-context slot, a prompt whose
// estimate is above 131072 must route to the large-context slot.
{
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-context-"))
  const logs = []
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      abort: async ({ path }) => ({ data: true, response: { ok: true }, error: undefined }),
    },
  }
  const hooks = await agentPoolHooks(
    { client, serverUrl: undefined, directory: HERE },
    {
      id: "agent-pool-context-test",
      dir,
      reapMs: 60000,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 0,
      models: {
        slots: [
          { model: "unit/small", weight: 2, context: 131072 },
          { model: "unit/large", weight: 2, context: 1048576 },
        ],
      },
    },
  )
  const cfg = shippedConfig()
  cfg.provider.unit = { whitelist: [] }
  await hooks.config(cfg)

  const spawn = async (prompt, callID, sessionID) => {
    const out = { args: { subagent_type: "explore", prompt } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
    return out.args.subagent_type
  }

  const short = await spawn("read src/index.ts", "ctx-short", "parent-short")
  assert(short === "explore-1", `short prompt must route to slot 1 (small), got ${short}; logs: ${logs.join(" | ")}`)
  console.log("hook short prompt ->", short)

  // 500k chars: ceil(500000/4)=125000 + 20000 = 145000 > 131072.
  const longPrompt = "x".repeat(500_000)
  const estimate = estimateContextTokens(longPrompt)
  assert(estimate !== undefined && estimate > 131072, `long prompt must estimate above 131072, got ${estimate}`)
  const long = await spawn(longPrompt, "ctx-long", "parent-long")
  assert(long === "explore-2", `long prompt must route to slot 2 (large), got ${long}; logs: ${logs.join(" | ")}`)
  console.log("hook long prompt ->", long, "(estimate", estimate, ")")

  await hooks.dispose?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log("\nALL CHECKS PASSED")
