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

// Hook-level: a context-overflow session.error must cool the model for the
// context-overflow window, attempt to abort the session, release the claim,
// and must NOT be recorded as a rate-limit/quota strike.
{
  const { readFileSync, readdirSync, existsSync } = await import("node:fs")
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-overflow-"))
  const logs = []
  const aborted = []
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      abort: async ({ path }) => {
        aborted.push(path.id)
        return { data: true, response: { ok: true }, error: undefined, request: undefined }
      },
    },
  }
  const hooks = await agentPoolHooks(
    { client, serverUrl: undefined, directory: HERE },
    {
      id: "agent-pool-overflow-test",
      dir,
      reapMs: 60000,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 0,
      models: {
        slots: [
          { model: "unit/overflow-a", weight: 2, context: 131072 },
          { model: "unit/overflow-b", weight: 2, context: 131072 },
        ],
      },
    },
  )
  const cfg = shippedConfig()
  cfg.provider.unit = { whitelist: [] }
  await hooks.config(cfg)

  const out = { args: { subagent_type: "explore", prompt: "read something" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID: "parent-overflow", callID: "overflow-1" }, out)
  const variant = out.args.subagent_type
  assert(/^explore-\d$/.test(variant), `spawn must route to a variant, got ${variant}`)

  await hooks.event({ event: { type: "session.created", properties: { info: { id: "child-overflow", parentID: "parent-overflow" } } } })
  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "child-overflow",
        error: { data: { message: "This model's maximum context length is 8192 tokens." } },
      },
    },
  })

  assert(aborted.includes("child-overflow"), `overflow must attempt abort, got ${JSON.stringify(aborted)}; logs: ${logs.join(" | ")}`)

  const claimFile = join(dir, "claims.agent-pool-overflow-test.json")
  const claims = existsSync(claimFile) ? readFileSync(claimFile, "utf8") : "{}"
  assert(claims === "{}", `overflow claim must be released, got ${claims}`)

  const limits = readdirSync(dir).filter((f) => f.startsWith("limit."))
  assert(limits.length > 0, `overflow must create a cooldown/limit file, got ${JSON.stringify(readdirSync(dir))}`)
  const limit = JSON.parse(readFileSync(join(dir, limits[0]), "utf8"))
  assert(limit.reason === "context overflow", `overflow reason must be "context overflow", got ${JSON.stringify(limit.reason)}`)
  assert(/overflow/.test(limit.model) && !/quota|rate|429|too-many|overloaded/i.test(limit.reason), "overflow must not be recorded as a rate-limit/quota reason")
  const untilMs = limit.until - Date.now()
  assert(untilMs > 8 * 60 * 1000 && untilMs < 12 * 60 * 1000, `overflow cooldown must be ~10m, got ${Math.round(untilMs / 1000)}s (${JSON.stringify(limit)})`)

  if (hooks.tool?.pool_status?.execute) {
    const status = (await hooks.tool.pool_status.execute({}, {})).output
    assert(/COOLING/i.test(status) || /overflow/i.test(status) || /context/i.test(status), `pool_status should reflect cooled model, got: ${status}`)
  }

  console.log("hook session.error context overflow -> aborted, claim released, cooled ~10m (reason context overflow)")

  await hooks.dispose?.()
  rmSync(dir, { recursive: true, force: true })
}

// Shared harness for the request-too-large / input-too-long failover cases.
async function runOverflowCase({ id, message, minMs, maxMs, logNeedle, expectLearnedTpm }) {
  const { readFileSync, readdirSync, existsSync } = await import("node:fs")
  const dir = mkdtempSync(join(tmpdir(), `agent-pool-${id}-`))
  const logs = []
  const aborted = []
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      abort: async ({ path }) => {
        aborted.push(path.id)
        return { data: true, response: { ok: true }, error: undefined, request: undefined }
      },
    },
  }
  const hooks = await agentPoolHooks(
    { client, serverUrl: undefined, directory: HERE },
    {
      id: `agent-pool-${id}`,
      dir,
      reapMs: 60000,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 0,
      models: {
        slots: [
          { model: "unit/overflow-a", weight: 2, context: 131072 },
          { model: "unit/overflow-b", weight: 2, context: 131072 },
        ],
      },
    },
  )
  const cfg = shippedConfig()
  cfg.provider.unit = { whitelist: [] }
  await hooks.config(cfg)

  const out = { args: { subagent_type: "explore", prompt: "read something" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID: `parent-${id}`, callID: `${id}-1` }, out)
  const variant = out.args.subagent_type
  assert(/^explore-\d$/.test(variant), `${id}: spawn must route to a variant, got ${variant}`)

  await hooks.event({ event: { type: "session.created", properties: { info: { id: `child-${id}`, parentID: `parent-${id}` } } } })
  await hooks.event({
    event: { type: "session.error", properties: { sessionID: `child-${id}`, error: { data: { message } } } },
  })

  assert(aborted.includes(`child-${id}`), `${id}: must attempt abort, got ${JSON.stringify(aborted)}; logs: ${logs.join(" | ")}`)

  const claimFile = join(dir, `claims.agent-pool-${id}.json`)
  const claims = existsSync(claimFile) ? readFileSync(claimFile, "utf8") : "{}"
  assert(claims === "{}", `${id}: claim must be released, got ${claims}`)

  const limits = readdirSync(dir).filter((f) => f.startsWith("limit."))
  assert(limits.length > 0, `${id}: must create a limit file, got ${JSON.stringify(readdirSync(dir))}`)
  const limit = JSON.parse(readFileSync(join(dir, limits[0]), "utf8"))
  assert(limit.reason === "context overflow", `${id}: reason must be "context overflow", got ${JSON.stringify(limit.reason)}`)
  const untilMs = limit.until - Date.now()
  assert(untilMs > minMs && untilMs <= maxMs, `${id}: cooldown out of range, got ${Math.round(untilMs / 1000)}s (${JSON.stringify(limit)})`)
  assert(logs.some((l) => l.includes(logNeedle)), `${id}: log must mention ${JSON.stringify(logNeedle)}; logs: ${logs.join(" | ")}`)

  if (expectLearnedTpm !== undefined) {
    const learnedPath = join(dir, "learned-tpm.json")
    assert(existsSync(learnedPath), `${id}: learned-tpm.json must be written when TPM is observed`)
    const learned = JSON.parse(readFileSync(learnedPath, "utf8"))
    assert(learned["unit/overflow-a"] === expectLearnedTpm || learned["unit/overflow-b"] === expectLearnedTpm, `${id}: learned-tpm.json must map the routed overflow model to ${expectLearnedTpm}, got ${JSON.stringify(learned)}`)
  } else {
    // A context-window limit is not a TPM: it must not be persisted as one.
    assert(!existsSync(join(dir, "learned-tpm.json")), `${id}: a context limit must not write learned-tpm.json`)
  }

  await hooks.dispose?.()
  rmSync(dir, { recursive: true, force: true })
}

// Groq free tier: "Request too large ... (TPM): Limit 8000". The stated limit is
// below MIN_SLOT_CONTEXT, so the model is dropped for the long cooldown instead
// of the normal 10-minute overflow window.
await runOverflowCase({
  id: "request-too-large",
  message:
    "Request too large for model `openai/gpt-oss-120b` in organization `org_01m5tp9dvdegvv766grf16409v` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9584, please reduce your message size and try again.",
  minMs: 5 * 60 * 60 * 1000,
  maxMs: 6 * 60 * 60 * 1000,
  logNeedle: "8000",
  expectLearnedTpm: 8000,
})
console.log("hook request-too-large -> aborted, claim released, dropped ~6h, learned-tpm.json written (reason context overflow)")

// A real, large stated limit is still just a normal overflow cooldown.
await runOverflowCase({
  id: "input-too-long",
  message: "Input too long: 275934 input tokens, limit is 202752 for this model",
  minMs: 8 * 60 * 1000,
  maxMs: 12 * 60 * 1000,
  logNeedle: "cooling it",
})
console.log("hook input-too-long -> aborted, claim released, cooled ~10m (reason context overflow)")

// session.error with response header only (no stated limit in text) must learn TPM from x-ratelimit-limit-tokens.
{
  const { readFileSync, readdirSync, existsSync } = await import("node:fs")
  const dir = mkdtempSync(join(tmpdir(), "agent-pool-header-tpm-"))
  const logs = []
  const aborted = []
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      abort: async ({ path }) => {
        aborted.push(path.id)
        return { data: true, response: { ok: true }, error: undefined, request: undefined }
      },
    },
  }
  const hooks = await agentPoolHooks(
    { client, serverUrl: undefined, directory: HERE },
    {
      id: "agent-pool-header-tpm",
      dir,
      reapMs: 60000,
      probeMs: 0,
      watchMs: 0,
      expiryMs: 0,
      models: {
        slots: [
          { model: "unit/overflow-a", weight: 2, context: 131072 },
          { model: "unit/overflow-b", weight: 2, context: 131072 },
        ],
      },
    },
  )
  const cfg = shippedConfig()
  cfg.provider.unit = { whitelist: [] }
  await hooks.config(cfg)

  const out = { args: { subagent_type: "explore", prompt: "read something" } }
  await hooks["tool.execute.before"]({ tool: "task", sessionID: "parent-header-tpm", callID: "header-tpm-1" }, out)
  assert(/^explore-\d$/.test(out.args.subagent_type), `spawn must route to a variant, got ${out.args.subagent_type}`)

  await hooks.event({ event: { type: "session.created", properties: { info: { id: "child-header-tpm", parentID: "parent-header-tpm" } } } })
  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "child-header-tpm",
        error: {
          data: {
            message: "Request too large for this model",
            responseHeaders: { "x-ratelimit-limit-tokens": "8000" },
          },
        },
      },
    },
  })

  assert(aborted.includes("child-header-tpm"), `header TPM overflow must attempt abort, got ${JSON.stringify(aborted)}; logs: ${logs.join(" | ")}`)
  const claimFile = join(dir, "claims.agent-pool-header-tpm.json")
  const claims = existsSync(claimFile) ? readFileSync(claimFile, "utf8") : "{}"
  assert(claims === "{}", `header TPM overflow claim must be released, got ${claims}`)

  const learnedPath = join(dir, "learned-tpm.json")
  assert(existsSync(learnedPath), "header TPM overflow must write learned-tpm.json")
  const learned = JSON.parse(readFileSync(learnedPath, "utf8"))
  assert(learned["unit/overflow-a"] === 8000 || learned["unit/overflow-b"] === 8000, `learned-tpm.json must map the routed model to 8000, got ${JSON.stringify(learned)}`)

  const limits = readdirSync(dir).filter((f) => f.startsWith("limit."))
  assert(limits.length > 0, "header TPM overflow must create a limit file")
  const limit = JSON.parse(readFileSync(join(dir, limits[0]), "utf8"))
  assert(limit.reason === "context overflow", `header TPM overflow reason must be "context overflow", got ${JSON.stringify(limit.reason)}`)

  console.log("hook session.error header x-ratelimit-limit-tokens:8000 -> aborted, claim released, learned-tpm.json written")

  await hooks.dispose?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log("\nALL CHECKS PASSED")
