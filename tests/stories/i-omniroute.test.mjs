// Epic B (provider resilience) — the local-gateway pool slot.
//
//   US-28 a local OpenAI-compatible gateway (OmniRoute) becomes the pool's
//         primary slot, so pooled mechanical work drains there before it reaches
//         the bundled opencode/opencode-go ("zen") models.
//
// The gateway is reached over HTTP at config time, so every test swaps
// `globalThis.fetch` for a stub and restores it afterwards. No socket is opened.
// Each test gets a unique `id`/`dir` so the pool's per-process state is fresh:
// the injected slot lives in that state object.

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

test("[US-28] a healthy gateway with an allowlist becomes the pool's first slot", async () => {
  const gw = gateway(["model-a", "model-b"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true, models: ["model-b"] } })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.equal(cfg.provider.omniroute.npm, "@ai-sdk/openai-compatible")
    assert.deepEqual(Object.keys(cfg.provider.omniroute.models), ["model-b"])

    // The gateway REPLACES slot 1 in place: same number of slots, same weights,
    // every other slot untouched. On the shipped preset that is gemini's slot.
    assert.equal(cfg.agent["explore-1"].model, "omniroute/model-b")
    assert.equal(cfg.agent["explore-2"].model, presetModels()[1])
    assert.equal(cfg.agent["explore-3"].model, presetModels()[2])
    assert.equal(cfg.agent["explore-4"].model, presetModels()[3])

    const routed = await spawn(hooks, cfg, { subagent: "explore" })
    assert.equal(routed.routed, "explore-1")
    assert.equal(routed.model, "omniroute/model-b")

    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] a named combo is used as the pool's first slot", async () => {
  const gw = gateway(["model-a"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true, combo: "static-best-free" } })
    const cfg = emptyConfig()
    await hooks.config(cfg)
    assert.equal(cfg.agent["explore-1"].model, "omniroute/static-best-free")
    assert.equal(cfg.provider.omniroute.models["static-best-free"].name, "static-best-free")
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] enabled with no choice falls back to OmniRoute's own auto router", async () => {
  const gw = gateway(["model-a", "model-b"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true } })
    const cfg = emptyConfig()
    await hooks.config(cfg)
    assert.equal(cfg.agent["explore-1"].model, "omniroute/auto")
    assert.equal(cfg.provider.omniroute.models.auto.name, "auto")
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] a disabled integration adds no slot and makes no request", async () => {
  const gw = gateway(["model-a"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub) // no omniroute block at all
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.equal(cfg.provider.omniroute, undefined)
    assert.equal(cfg.agent["explore-1"].model, presetModels()[0])
    assert.equal(gw.calls.some((url) => url.includes("/models")), false)
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] an unreachable gateway falls back to the bundled slots", async () => {
  const gw = gateway([], { fail: true })
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true, models: ["model-a"] } })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.equal(cfg.provider.omniroute, undefined)
    assert.equal(cfg.agent["explore-1"].model, presetModels()[0])
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

test("[US-28] a user pool already routing on omniroute is not doubled", async () => {
  const gw = gateway(["model-a"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, {
      omniroute: { enabled: true, models: ["model-a"] },
      models: {
        slots: [
          { model: "omniroute/keep-me", weight: 3 },
          { model: "opencode/space-bunny-free", weight: 2 },
        ],
      },
    })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    // The user's own omniroute slot stays first; the integration does not stack a
    // second slot on the same provider.
    assert.equal(cfg.agent["explore-1"].model, "omniroute/keep-me")
    assert.equal(cfg.agent["explore-2"].model, "opencode/space-bunny-free")
    assert.equal(
      stub.text().some((line) => line.includes("provider omniroute is already in the pool")),
      true,
    )
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] the primary slot replaces the first slot in place, keeping the slot count", async () => {
  const gw = gateway(["model-a"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, {
      omniroute: { enabled: true, models: ["model-a"] },
      models: {
        slots: [
          { model: "opencode/s1", weight: 3 },
          { model: "opencode/s2", weight: 2 },
          { model: "opencode-go/s3", weight: 1 },
          { model: "opencode-go/s4", weight: 1 },
        ],
      },
    })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    // Slot 1 is replaced in place; slots 2..4 are exactly as written -- nothing
    // is dropped, because no fifth slot is created.
    assert.equal(cfg.agent["explore-1"].model, "omniroute/model-a")
    assert.equal(cfg.agent["explore-2"].model, "opencode/s2")
    assert.equal(cfg.agent["explore-3"].model, "opencode-go/s3")
    assert.equal(cfg.agent["explore-4"].model, "opencode-go/s4")
    // It inherits the replaced slot's weight (s1's 3), so it is genuinely first.
    assert.equal(
      stub.text().some((line) => line.includes("1=omniroute/model-a w3")),
      true,
      "the primary slot keeps the weight of the slot it replaced",
    )
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

test("[US-28] registering the provider first means the pool does not warn it is missing", async () => {
  const gw = gateway(["model-a"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, { omniroute: { enabled: true, models: ["model-a"] } })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.equal(
      stub.text().some((line) => line.includes("provider omniroute is not configured")),
      false,
      "OmniRoute registers the provider before the pool binds its slots",
    )
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})
