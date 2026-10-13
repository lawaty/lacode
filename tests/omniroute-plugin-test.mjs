// Offline suite for src/plugins/omniroute.ts -- the hook FACTORY. The pure
// library it calls is covered by tests/omniroute-test.mjs; this file pins the
// bridge: which options produce a provider, which produce nothing, and what the
// user's config looks like afterwards.
//
// It imports the TypeScript sources directly, the way tests/omniroute-test.mjs
// does: node >= 22.18 strips the types, so the `import type` of
// @opencode-ai/plugin never reaches the runtime and this suite needs neither the
// plugin package, a running opencode, nor a gateway. Every gateway call goes
// through the injected `fetchImpl`, so nothing here touches the network.
//
// What is load-bearing here is the DEGRADE chain, because a plugin that throws
// or that routes to a gateway nobody chose is worse than no plugin:
//
//   * disabled is SILENT -- no hook, no request, no log line;
//   * invalid warns ONCE and fetches nothing;
//   * a down / empty / allowlist-exhausted gateway falls back to lacode's normal
//     behaviour with one warning and leaves the config untouched;
//   * an existing `provider.omniroute` is never modified (merge-without-clobber);
//   * an api key never reaches a log line, so every test that logs anything is
//     also a leak check.

import { test } from "node:test"
import assert from "node:assert/strict"
import * as omni from "../src/lib/omniroute.ts"
import { omniRouteHooks } from "../src/plugins/omniroute.ts"

/** The stub opencode hands the plugin: one log sink, nothing else. */
const mkInput = (logs) => ({
  client: { app: { log: async ({ body }) => void logs.push(`${body.level} ${body.message}`) } },
})

/** A gateway answering `ids` from its model list, recording every call. */
const gateway = (ids) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    return { ok: true, status: 200, json: async () => ({ object: "list", data: ids.map((id) => ({ id })) }) }
  }
  return { fetchImpl, calls }
}

/** A gateway that is not listening: every call rejects, as ECONNREFUSED does. */
const down = () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    throw new Error("connect ECONNREFUSED 127.0.0.1:20128")
  }
  return { fetchImpl, calls }
}

/**
 * Boot the factory over one gateway and return the handles a test drives.
 *
 * `env` is passed explicitly rather than left to `process.env`, so a developer
 * with OMNIROUTE_API_KEY exported in their shell cannot flip an assertion in
 * this file -- the same hygiene tests/omniroute-test.mjs applies.
 *
 * `config()` additionally asserts the hook does not reject: a refusal to fall
 * back is the failure mode the whole factory exists to prevent, so an escaping
 * rejection must fail the test rather than surface as an unhandled error.
 */
const boot = async (omniroute, gate, env = {}) => {
  const logs = []
  const hooks = await omniRouteHooks(mkInput(logs), { omniroute }, { fetchImpl: gate.fetchImpl, env })
  return {
    hooks,
    logs,
    calls: gate.calls,
    warns: () => logs.filter((line) => line.startsWith("warn")),
    config: async (cfg) => {
      await assert.doesNotReject(() => hooks.config(cfg))
    },
  }
}

// ---------------------------------------------------------------------------
// The disabled path
// ---------------------------------------------------------------------------

test("a user with no omniroute block is silent: no hook, no request, no warning", async () => {
  // An absent block and `enabled: false` are the same state, and both are the
  // normal state of a user who does not run OmniRoute. Warning about "not
  // configured" would cry wolf on every startup, and probing localhost on every
  // startup would be a request for nothing.
  for (const omniroute of [undefined, { enabled: false }]) {
    const gate = gateway(["model-a"])
    const { hooks, logs, calls } = await boot(omniroute, gate)
    assert.equal(hooks.config, undefined, "the disabled path must not even carry a config hook")
    assert.equal(calls.length, 0, "the disabled path must not probe the gateway")
    assert.deepEqual(logs, [], "disabled is silent, not chatty")
  }
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("enabled + healthy registers the provider", async () => {
  const gate = gateway(["model-a", "model-b"])
  const { hooks, config } = await boot({ enabled: true, models: ["model-a", "model-b"] }, gate)
  assert.equal(typeof hooks.config, "function")

  const cfg = {}
  await config(cfg)

  const provider = cfg.provider.omniroute
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  assert.equal(provider.options.baseURL, omni.DEFAULT_BASE_URL)
  assert.deepEqual(Object.keys(provider.models), ["model-a", "model-b"])
})

test("the allowlist is a hard filter: a model outside it is never exposed", async () => {
  const { config } = await boot({ enabled: true, models: ["b"] }, gateway(["a", "b", "c"]))
  const cfg = {}
  await config(cfg)
  assert.deepEqual(Object.keys(cfg.provider.omniroute.models), ["b"], "the gateway advertising 'c' must not expose it")
})

test("the combo leads the exposed models even when the allowlist is narrower", async () => {
  const { config } = await boot({ enabled: true, combo: "static-best-free", models: ["a"] }, gateway(["a", "b"]))
  const cfg = {}
  await config(cfg)
  assert.deepEqual(Object.keys(cfg.provider.omniroute.models), ["static-best-free", "a"])
})

test("the env key beats the config key, lands in options, and never in a log line", async () => {
  const CFG_KEY = "cfg-key-regression-601"
  const ENV_KEY = "env-key-regression-602"
  const { config, logs, calls } = await boot(
    { enabled: true, apiKey: CFG_KEY, models: ["model-a"] },
    gateway(["model-a"]),
    { [omni.ENV_API_KEY]: ENV_KEY },
  )

  const cfg = {}
  await config(cfg)
  assert.equal(cfg.provider.omniroute.options.apiKey, ENV_KEY)
  // The key travels as a header, so the URL it was sent to cannot leak one.
  assert.equal(calls[0].headers.Authorization, `Bearer ${ENV_KEY}`)

  for (const line of logs) {
    assert(!line.includes(ENV_KEY), `log leaked the env key: ${line}`)
    assert(!line.includes(CFG_KEY), `log leaked the config key: ${line}`)
  }
})

// ---------------------------------------------------------------------------
// Fallbacks -- every one of them leaves the config as it found it
// ---------------------------------------------------------------------------

test("a gateway that is down falls back with one warning and adds nothing", async () => {
  const { config, warns } = await boot({ enabled: true, models: ["model-a"] }, down())
  const cfg = {}
  await config(cfg)

  assert.equal(cfg.provider, undefined, "a down gateway must add no provider block")
  assert.equal(warns().length, 1, "one warning per process, not one per config hook")
  assert.match(warns()[0], /health check failed/)
})

test("an unreachable model list falls back too, with healthCheck switched off", async () => {
  const { config, warns } = await boot({ enabled: true, healthCheck: false, models: ["model-a"] }, down())
  const cfg = {}
  await config(cfg)

  assert.equal(cfg.provider, undefined)
  assert.equal(warns().length, 1)
  assert.match(warns()[0], /unreachable/)
})

test("an empty model list falls back instead of registering an empty provider", async () => {
  // The gateway answered, but nothing survives the allowlist. Registering an
  // empty models map would hand opencode a provider that resolves no model at
  // all, which is worse than saying so.
  const { config, warns } = await boot({ enabled: true }, gateway([]))
  const cfg = {}
  await config(cfg)

  assert.equal(cfg.provider, undefined)
  assert.equal(warns().length, 1)
  assert.match(warns()[0], /no usable models/)
})

// ---------------------------------------------------------------------------
// The merge-without-clobber and non-destructive rules
// ---------------------------------------------------------------------------

test("an existing provider.omniroute is never modified", async () => {
  const { config, warns } = await boot({ enabled: true, models: ["model-a"] }, gateway(["model-a"]))
  const cfg = { provider: { omniroute: { name: "Mine", options: { baseURL: "http://x/v1" } } } }
  const before = structuredClone(cfg)

  await config(cfg)

  assert.deepEqual(cfg, before, "their provider, their key, their models -- untouched")
  assert.equal(warns().length, 1)
  assert.match(warns()[0], /already defined/)
})

test("an invalid block warns once and never fetches", async () => {
  const gate = gateway(["model-a"])
  const { hooks, calls, warns } = await boot({ enabled: true, baseURL: "ftp://x" }, gate)

  assert.equal(hooks.config, undefined, "an unusable block must not install a config hook")
  assert.equal(calls.length, 0, "a config that cannot be parsed must not reach the gateway")
  assert.equal(warns().length, 1)
  assert.match(warns()[0], /baseURL/)
})

test("injection is non-destructive to unrelated config", async () => {
  const { config } = await boot({ enabled: true, models: ["model-a"] }, gateway(["model-a"]))
  const cfg = {
    agent: { build: { mode: "primary" } },
    mcp: { x: { type: "local" } },
    plugin: ["foo"],
    model: "opencode/x",
  }
  const before = structuredClone(cfg)

  await config(cfg)

  assert.deepEqual(cfg.agent, before.agent)
  assert.deepEqual(cfg.mcp, before.mcp)
  assert.deepEqual(cfg.plugin, before.plugin)
  assert.equal(cfg.model, "opencode/x", "lacode registers a destination, it never chooses one")
  assert.deepEqual(Object.keys(cfg).sort(), [...Object.keys(before).sort(), "provider"], "one key added, nothing else touched")
  assert(cfg.provider?.omniroute, "the provider itself was still added")
})
