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

const poolModels = (cfg) => [1, 2, 3, 4].map((i) => cfg.agent[`explore-${i}`]?.model)

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
          { model: "opencode/big-pickle", weight: 2 },
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

// The whole setup story, as a user actually writes it: one block, one key, no
// hand-picked model list. `models: []` is a hard allowlist of nothing, so the
// combo is the only thing the gateway exposes.
test("[US-28] the trivial client recipe exposes the combo alone and writes the pool nothing", async () => {
  const gw = gateway(["model-a", "model-b"])
  const stub = stubInput()
  try {
    const hooks = await boot(stub, {
      omniroute: { enabled: true, apiKey: "test-key", combo: "auto", models: [] },
    })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    assert.deepEqual(Object.keys(cfg.provider.omniroute.models), ["auto"])
    assert.equal(cfg.provider.omniroute.models.auto.name, "auto")

    // Registering a provider IS the whole feature: the pool's own slot list is
    // untouched, so a user who wants pooled work on the gateway says so by
    // listing omniroute/auto in it themselves.
    assert.deepEqual(poolModels(cfg), presetModels())
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

// US-28 criterion 2, on a pool source the user supplied: enabling a healthy
// gateway must not add, drop, reorder or rebind a slot. Registering a provider
// is the whole integration -- opting in means listing omniroute/<model> in this
// list yourself.
test("[US-28] a healthy gateway leaves a user-supplied pool exactly as written", async () => {
  const gw = gateway(["model-a", "model-b"])
  const stub = stubInput()
  try {
    // The user's own pool source (options.models), deliberately naming no
    // omniroute model at all.
    const declared = presetModels().slice(0, 2)
    const hooks = await boot(stub, {
      omniroute: { enabled: true, combo: "auto" },
      models: { slots: declared.map((model, i) => ({ model, weight: i === 0 ? 3 : 2 })) },
    })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    // The gateway is really up and registered, so "unchanged" is a fact about
    // a live integration rather than one that quietly did nothing.
    assert.equal(cfg.provider.omniroute.models.auto.name, "auto")

    // Same models, same order, same count: no omniroute slot was prepended,
    // substituted for a user slot, or appended to fill an empty position.
    assert.deepEqual(poolModels(cfg), [declared[0], declared[1], undefined, undefined])
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})

// US-28 criterion 5, the positive half: the gateway is DOWN and the user has
// already listed omniroute/auto as slot 1. The decided behaviour is warning-only
// -- the slot is kept exactly as the user wrote it, so nothing here silently
// re-routes the pool behind their back.
test("[US-28] a down gateway with an omniroute slot warns once, keeps the slot bound and leaves the others alone", async () => {
  const gw = gateway([], { fail: true })
  const stub = stubInput()
  try {
    const hooks = await boot(stub, {
      omniroute: { enabled: true, combo: "auto" },
      models: {
        slots: [
          { model: "omniroute/auto", weight: 3 },
          { model: "opencode/big-pickle", weight: 2 },
        ],
      },
    })
    const cfg = emptyConfig()
    await hooks.config(cfg)

    const UNCONFIGURED =
      "provider omniroute is not configured in opencode.jsonc; slot 1 (omniroute/auto) cannot resolve"
    // Exact line, exactly once: the gateway being down must not turn into a
    // warning per config hook.
    assert.equal(
      stub.text().filter((line) => line === `warn ${UNCONFIGURED}`).length,
      1,
      "the unreachable gateway is warned about once, naming the slot it costs",
    )

    // Nothing is registered, so the pool sees the provider missing...
    assert.equal(cfg.provider.omniroute, undefined)
    // ...but the slot the user chose is still bound to it.
    assert.equal(cfg.agent["explore-1"].model, "omniroute/auto")
    // Every other slot keeps working exactly as written.
    assert.equal(cfg.agent["explore-2"].model, "opencode/big-pickle")
    await hooks.dispose?.()
  } finally {
    gw.restore()
    cleanupAll()
  }
})
