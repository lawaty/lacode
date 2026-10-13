// Epic B (provider resilience) — the local gateway as an ordinary provider.
//
//   US-28 enabling OmniRoute REGISTERS a `provider.omniroute` entry so the
//         gateway's models become selectable, and does nothing else. It never
//         touches the pool: to route pooled work through the gateway the user
//         lists `omniroute/<model>` in pool.txt (or pool.json / options.models)
//         like any other provider.
//
// The gateway is reached over HTTP at config time, so every test swaps
// `globalThis.fetch` for a stub and restores it afterwards. No socket is opened.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  bootLaCode,
  cleanupAll,
  emptyConfig,
  presetModels,
  scratch,
  spawn,
  stubInput,
} from "./_harness.mjs"

const REAL_FETCH = globalThis.fetch

/** Replace fetch with a fake gateway. `fail` simulates the gateway being down. */
const gateway = (models, { fail = false } = {}) => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (fail) throw new Error("ECONNREFUSED")
    if (String(url).includes("/models")) {
      return { ok: true, status: 200, json: async () => ({ object: "list", data: models.map((id) => ({ id })) }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  return { calls, restore: () => { globalThis.fetch = REAL_FETCH } }
}

let n = 0
/** Boot the real plugin with a unique pool identity and the bundled preset. */
const boot = async (stub, options = {}) =>
  bootLaCode(stub, { id: `omniroute-story-${n++}`, dir: scratch(), selfUpdate: false, ...options })

const poolModels = (cfg) => [1, 2, 3, 4].map((i) => cfg.agent[`explore-${i}`].model)

test("[US-28] a healthy gateway registers provider.omniroute and leaves the pool alone", async () => {
  const gw = gateway(["model-a", "model-b"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true, models: ["model-b"] } })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.equal(cfg.provider.omniroute.npm, "@ai-sdk/openai-compatible")
    assert.deepEqual(Object.keys(cfg.provider.omniroute.models), ["model-b"])

    // The plugin WRITES THE POOL NOTHING: every slot is exactly the preset's.
    assert.deepEqual(poolModels(cfg), presetModels())
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] a named combo is exposed as a selectable model", async () => {
  const gw = gateway(["model-a"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true, combo: "static-best-free" } })
    const cfg = emptyConfig()
    await hooks.config(cfg)
    assert.equal(cfg.provider.omniroute.models["static-best-free"].name, "static-best-free")
    assert.deepEqual(poolModels(cfg), presetModels())
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] enabled with no allowlist exposes the gateway's whole catalog", async () => {
  const gw = gateway(["model-a", "model-b"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true } })
    const cfg = emptyConfig()
    await hooks.config(cfg)
    assert.deepEqual(Object.keys(cfg.provider.omniroute.models).sort(), ["model-a", "model-b"])
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] an omniroute slot listed in the pool routes through the gateway", async () => {
  const gw = gateway(["model-a"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, {
      omniroute: { enabled: true, combo: "auto" },
      models: {
        slots: [
          { model: "omniroute/auto", weight: 3 },
          { model: "opencode/space-bunny-free", weight: 2 },
        ],
      },
    })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    // The user's pool decides, exactly like any other provider.
    assert.equal(cfg.agent["explore-1"].model, "omniroute/auto")
    assert.equal(cfg.provider.omniroute.models.auto.name, "auto")

    const routed = await spawn(hooks, cfg, { subagent: "explore" })
    assert.equal(routed.routed, "explore-1")
    assert.equal(routed.model, "omniroute/auto")
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] a disabled integration registers nothing and makes no request", async () => {
  const gw = gateway(["model-a"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub) // no omniroute block at all
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.equal(cfg.provider.omniroute, undefined)
    assert.deepEqual(poolModels(cfg), presetModels())
    assert.equal(gw.calls.some((url) => url.includes("/models")), false)
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] an unreachable gateway registers nothing and leaves the pool alone", async () => {
  const gw = gateway([], { fail: true })
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true, models: ["model-a"] } })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.equal(cfg.provider.omniroute, undefined)
    assert.deepEqual(poolModels(cfg), presetModels())
    assert.equal(
      stub.text().some((line) => line.includes("health check failed")),
      true,
      "the fallback is warned about once",
    )
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] registering the provider first means a pool slot naming it is not warned as unconfigured", async () => {
  const gw = gateway(["auto"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, {
      omniroute: { enabled: true, combo: "auto" },
      models: { slots: [{ model: "omniroute/auto", weight: 3 }] },
    })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.equal(
      stub.text().some((line) => line.includes("provider omniroute is not configured")),
      false,
      "OmniRoute registers the provider before the pool checks its slots",
    )
    assert.equal(cfg.agent["explore-1"].model, "omniroute/auto")
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})
