// Epic B — Provider resilience.
//
//   US-4  a rate limit moves work to another provider instead of failing
//   US-5  weights express preference between models
//   US-6  live pool visibility (the pool_status tool)
//   US-7  a paid model is just another slot
//
// Every test drives the real plugin default export with a stub PluginInput and
// an isolated claim directory. No network, no server, no real sleeps: the clock
// is injected, so a 60-minute cooldown is asserted in microseconds.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  bootLaCode,
  cleanupAll,
  configFor,
  emit,
  fakeClock,
  presetModels,
  scratch,
  spawn,
  stubInput,
} from "./_harness.mjs"

test.after(cleanupAll)

/** Boot a pool whose slots are exactly the given { model, weight } list. */
const bootPool = async (slots, id, options = {}) => {
  const stub = stubInput()
  const dir = scratch()
  const hooks = await bootLaCode(stub, { id, dir, models: { slots }, ...options })
  const cfg = configFor(slots.map((s) => s.model))
  await hooks.config(cfg)
  return { stub, dir, hooks, cfg, models: slots.map((s) => s.model) }
}

/** Boot a pool over a config the test supplies, not one seeded from the models. */
const bootConfig = async (slots, cfg, id, options = {}) => {
  const stub = stubInput()
  const dir = scratch()
  const hooks = await bootLaCode(stub, { id, dir, models: { slots }, ...options })
  await hooks.config(cfg)
  return { stub, dir, hooks, cfg, models: slots.map((s) => s.model) }
}

/** Route `n` spawns concurrently and report the variant each one was sent to. */
const burst = async (hooks, cfg, n, base = "explore") => {
  const out = []
  for (let i = 0; i < n; i++) out.push((await spawn(hooks, cfg, { subagent: base, callID: `c${i}`, sessionID: `s${i}` })).routed)
  return out
}

const limitFile = (dir, model) => join(dir, `limit.${model.replace(/[^a-zA-Z0-9._-]/g, "__")}.json`)

// ---------------------------------------------------------------------------
// US-4 — failover
// ---------------------------------------------------------------------------

test("[US-4] a rate-limit-shaped error marks the model cooling and writes a cooldown file", async () => {
  const clock = fakeClock()
  const { dir, hooks, models, stub } = await bootPool([{ model: "prov/one", weight: 2 }], "us4-strike")

  // Deliberately NOT the shape the plugin used to assume (data.message): the
  // error text lives under responseBody, which is what a gateway actually sends.
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "one",
      error: { name: "APIError", data: { statusCode: 429, responseBody: "Rate limit reached for requests" } },
    },
  })

  const file = limitFile(dir, models[0])
  assert.ok(existsSync(file), `a cooldown file must be written, got: ${readdirSync(dir).join(", ")}`)
  const strike = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(strike.model, models[0])
  assert.ok(strike.until > clock.now(), "the cooldown must be in the future")
  assert.match(strike.reason, /rate-limit|quota|usage/i, `the reason must be recorded, got ${strike.reason}`)
  assert.ok(
    stub.text().some((line) => line.startsWith("warn") && line.includes(`cooling ${models[0]}`)),
    `the strike must be logged:\n${stub.text().join("\n")}`,
  )
  await hooks.dispose()
})

test("[US-4] with model A cooling, the next spawn goes elsewhere and is never refused", async () => {
  // Weights chosen so the healthy slot can absorb the whole burst: that is what
  // makes "spare was not needed" a real assertion rather than an accident of
  // two weight-1 slots filling up.
  const slots = [
    { model: "prov/hot", weight: 1 },
    { model: "prov/cool", weight: 2 },
    { model: "prov/spare", weight: 1 },
  ]
  const { hooks, cfg } = await bootPool(slots, "us4-failover")

  await emit(hooks, "message.updated", {
    info: { role: "assistant", providerID: "prov", modelID: "hot", error: { message: "429 Too Many Requests" } },
  })

  const routed = await burst(hooks, cfg, 2)
  for (const variant of routed) {
    assert.notEqual(variant, "explore-1", "a cooling model must not be picked again")
    assert.match(variant, /^explore-[1-9]$/, `every spawn must still route somewhere, got ${variant}`)
  }
  // And specifically: it fell through to the slot that is NOT cooling.
  assert.deepEqual(routed, ["explore-2", "explore-2"], `expected failover to the healthy slot, got ${routed}`)
  assert.ok(!routed.includes("explore-3"), "the last resort should not be burned while a healthy slot is free")
  await hooks.dispose()
})

test("[US-4] when every model is cooling, routing degrades to the least-loaded slot instead of refusing", async () => {
  const { hooks, cfg, models } = await bootPool(
    [
      { model: "prov/a", weight: 1 },
      { model: "prov/b", weight: 1 },
    ],
    "us4-all-cooling",
  )

  for (const model of models) {
    const [provider, id] = [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)]
    await emit(hooks, "message.updated", {
      info: { role: "assistant", providerID: provider, modelID: id, error: { message: "usage limit reached" } },
    })
  }

  // The whole point: a refused spawn would fail the task. A degraded one does not.
  const routed = await burst(hooks, cfg, 2)
  for (const variant of routed) {
    assert.match(variant, /^explore-[1-9]$/, `the pool must degrade, not refuse: got ${variant}`)
  }
  await hooks.dispose()
})

test("[US-4] a stated reset time is used as the cooldown instead of a guessed backoff", async () => {
  const clock = fakeClock()
  const { dir, hooks, models } = await bootPool([{ model: "prov/stated", weight: 1 }], "us4-stated")

  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "stated",
      error: { message: "Rate limit exceeded. Resets in 35min" },
    },
  })

  const strike = JSON.parse(readFileSync(limitFile(dir, models[0]), "utf8"))
  const seconds = Math.round((strike.until - clock.now()) / 1000)
  assert.equal(seconds, 35 * 60, `the provider's stated reset must win, got ${seconds}s`)
  // The base backoff is 60s, so this distinguishes the two: a guess would read 60.
  assert.notEqual(seconds, 60)
  await hooks.dispose()
})

test("[US-4] a Retry-After header is honoured when the error text states no reset window", async () => {
  const clock = fakeClock()
  const { dir, hooks, models } = await bootPool([{ model: "prov/header", weight: 1 }], "us4-retry-after")

  // Limit-shaped (so it is recognised at all) but with no "Resets in …" in the
  // text: the header is then the only stated window available.
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "header",
      error: { message: "Rate limit exceeded", data: { responseHeaders: { "retry-after": "120" } } },
    },
  })

  const strike = JSON.parse(readFileSync(limitFile(dir, models[0]), "utf8"))
  assert.equal(Math.round((strike.until - clock.now()) / 1000), 120, "Retry-After must be used verbatim, not replaced by the base backoff")
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-5 — weighted preference
// ---------------------------------------------------------------------------

test("[US-5] a heavy slot holds more turns in the run than a light one, which still takes its own", async () => {
  // Not a drain order. The slots are expanded into a run -- one position per unit
  // of weight, in declaration order -- so weights [3,1] produce [1,1,1,2] and the
  // light slot's single position is still inside it, after the heavy one's three.
  const { hooks, cfg } = await bootPool(
    [
      { model: "prov/heavy", weight: 3 },
      { model: "prov/light", weight: 1 },
    ],
    "us5-run-shape",
  )
  const routed = await burst(hooks, cfg, 4)
  assert.deepEqual(routed, ["explore-1", "explore-1", "explore-1", "explore-2"], `got ${routed}`)
  await hooks.dispose()
})

test("[US-5] the run is walked in order, so a light slot ahead of a heavier one is served first", async () => {
  // The rule is order-first: each spawn takes the first slot in the run which is
  // available and under its ceiling, so the run [1,2,2] gives slot 1 its turn and
  // slot 2 the two after it. Weight-as-priority would answer 2,2,1 here instead.
  const { hooks, cfg } = await bootPool(
    [
      { model: "prov/one", weight: 1 },
      { model: "prov/two", weight: 2 },
    ],
    "us5-run-order",
  )
  const routed = await burst(hooks, cfg, 3)
  assert.deepEqual(routed, ["explore-1", "explore-2", "explore-2"], `got ${routed}`)
  await hooks.dispose()
})

test("[US-5] past every ceiling, the spawn overflows to the least-loaded slot", async () => {
  const { hooks, cfg } = await bootPool(
    [
      { model: "prov/a", weight: 1 },
      { model: "prov/b", weight: 1 },
    ],
    "us5-overflow",
  )
  const routed = await burst(hooks, cfg, 3)
  assert.deepEqual(routed.slice(0, 2), ["explore-1", "explore-2"], `weighted phase first, got ${routed}`)
  // Third: both are full, so it must spread rather than pile on slot 1.
  assert.match(routed[2], /^explore-[12]$/, `overflow must still route, got ${routed[2]}`)
  assert.notEqual(routed[2], routed[1], "overflow must go to the OTHER slot so load stays even")
  await hooks.dispose()
})

test("[US-5] equal weights round-robin in declaration order", async () => {
  const slots = ["prov/a", "prov/b", "prov/c"].map((model) => ({ model, weight: 1 }))
  const { hooks, cfg } = await bootPool(slots, "us5-roundrobin")
  const routed = await burst(hooks, cfg, 6)
  assert.deepEqual(routed, ["explore-1", "explore-2", "explore-3", "explore-1", "explore-2", "explore-3"], `got ${routed}`)
  await hooks.dispose()
})

test("[US-5] no slot exceeds its weight ceiling except through overflow", async () => {
  const slots = [
    { model: "prov/heavy", weight: 3 },
    { model: "prov/mid", weight: 2 },
    { model: "prov/light", weight: 1 },
  ]
  const { hooks, cfg } = await bootPool(slots, "us5-ceiling-bound")
  // Exactly the summed ceilings: the weight gate is still in charge and no slot
  // may be carrying more than its own number.
  const capacity = slots.reduce((sum, s) => sum + s.weight, 0)
  await burst(hooks, cfg, capacity)

  const loadsOf = async () => {
    const status = await hooks.tool.pool_status.execute({}, {})
    return status.output
      .split("\n")
      .filter((line) => /^\s*slot \d/.test(line))
      .map((line) => {
        const [, load, weight] = /load=(\d+)\/(\d+)/.exec(line)
        return { load: Number(load), weight: Number(weight) }
      })
  }

  const atCapacity = await loadsOf()
  assert.equal(atCapacity.length, slots.length)
  for (const { load, weight } of atCapacity) {
    assert.ok(load <= weight, `load ${load} must never exceed the weight ceiling ${weight}`)
  }
  assert.equal(
    atCapacity.reduce((sum, s) => sum + s.load, 0),
    capacity,
    "every spawn must be accounted for on some slot",
  )

  // One past capacity is overflow, which is allowed -- and must be visible.
  await burst(hooks, cfg, 1, "implement")
  const after = await loadsOf()
  assert.ok(
    after.some((s) => s.load > s.weight),
    `one spawn past capacity must be visible as an over-ceiling slot: ${JSON.stringify(after)}`,
  )
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-6 — live visibility
// ---------------------------------------------------------------------------

test("[US-6] the status view shows every process's claims and the aggregate load per slot", async () => {
  const slots = [{ model: "prov/shared", weight: 4 }]
  const dir = scratch()
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us6-mine", dir, models: { slots } })
  const cfg = configFor(slots.map((s) => s.model))
  await hooks.config(cfg)

  await burst(hooks, cfg, 2)

  // A sibling opencode process, exactly as another process would write it.
  writeFileSync(
    join(dir, "claims.sibling.json"),
    JSON.stringify({
      "peer:1": { v: "implement", k: 1, m: "prov/shared", t: Date.now() },
      "peer:2": { v: "explore", k: 1, m: "prov/shared", t: Date.now() },
    }),
  )

  const status = await hooks.tool.pool_status.execute({}, {})
  const slot = status.output.split("\n").find((l) => l.includes("prov/shared"))
  assert.match(slot, /load=4\/4/, `per-slot load must aggregate across processes:\n${status.output}`)
  // Mine contributed 2 explore, the sibling 1 explore + 1 implement.
  assert.match(slot, /explorex3/, `the per-base breakdown must aggregate both processes: ${slot}`)
  assert.match(slot, /implementx1/, `the per-base breakdown must aggregate both processes: ${slot}`)
  assert.match(status.output, /us6-mine \(this process\): 2 claim\(s\)/, `this process must be listed:\n${status.output}`)
  assert.match(status.output, /sibling: 2 claim\(s\)/, `every sibling must be listed:\n${status.output}`)
  assert.match(status.output, /4 claim\(s\) in flight across 2 process\(es\)/)
  await hooks.dispose()
})

test("[US-6] a cooling model is listed with its reason and remaining time", async () => {
  const slots = [
    { model: "prov/cooling", weight: 1 },
    { model: "prov/fine", weight: 1 },
  ]
  const clock = fakeClock()
  const { hooks } = await bootPool(slots, "us6-cooling")
  await emit(hooks, "message.updated", {
    info: { role: "assistant", providerID: "prov", modelID: "cooling", error: { message: "Quota exceeded for this key" } },
  })
  clock.advance(30_000)

  const status = await hooks.tool.pool_status.execute({}, {})
  const line = status.output.split("\n").find((l) => l.includes("prov/cooling"))
  assert.match(line, /COOLING \d+s/, `the remaining cooldown must be shown: ${line}`)
  assert.match(line, /quota/i, `the reason must be shown: ${line}`)
  assert.match(status.output, /cooling: prov\/cooling for \d+s/, `the summary must name it:\n${status.output}`)
  await hooks.dispose()
})

test("[US-6] a claim file older than the dead-file threshold is pruned, not counted", async () => {
  const slots = [{ model: "prov/shared", weight: 4 }]
  const dir = scratch()
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us6-stale", dir, models: { slots } })
  const cfg = configFor(slots.map((s) => s.model))
  await hooks.config(cfg)
  await burst(hooks, cfg, 1)

  // A dead process's file: fresh content, ancient mtime.
  const stale = join(dir, "claims.ghost.json")
  writeFileSync(stale, JSON.stringify({ g: { v: "explore", k: 1, m: "prov/shared", t: Date.now() } }))
  const ancient = new Date(Date.now() - 3 * 60 * 60 * 1000)
  utimesSync(stale, ancient, ancient)

  const status = await hooks.tool.pool_status.execute({}, {})
  assert.doesNotMatch(status.output, /ghost/, `a dead process must not appear:\n${status.output}`)
  assert.ok(!existsSync(stale), "the dead file must be pruned from disk, not merely ignored")
  assert.match(status.output, /load=1\/4/, `only the live claim counts:\n${status.output}`)
  await hooks.dispose()
})

test("[US-6] the slot the next spawn would take is marked, including when it is at its ceiling", async () => {
  const slots = [
    { model: "prov/a", weight: 1 },
    { model: "prov/b", weight: 1 },
  ]
  const { hooks, cfg } = await bootPool(slots, "us6-next")
  await burst(hooks, cfg, 2)

  // Both slots are at their ceiling, so the next spawn is an overflow decision.
  const status = await hooks.tool.pool_status.execute({}, {})
  const marked = status.output.split("\n").filter((l) => l.includes("<- next"))
  assert.equal(marked.length, 1, `exactly one slot may be marked as next:\n${status.output}`)
  assert.match(marked[0], /FULL/, `a slot at its ceiling is still the one the next spawn takes:\n${marked[0]}`)

  // And the mark is not decoration: the next real spawn lands on that slot.
  const markedIndex = Number(/slot (\d)/.exec(marked[0])[1])
  const { routed } = await spawn(hooks, cfg, { callID: "next", sessionID: "next" })
  assert.equal(routed, `explore-${markedIndex}`, `the mark must predict the routing: marked slot ${markedIndex}, routed ${routed}`)

  // With room again, the mark moves to the slot that actually has capacity.
  const { hooks: fresh, cfg: freshCfg } = await bootPool(slots, "us6-next-open")
  const open = await fresh.tool.pool_status.execute({}, {})
  assert.match(open.output.split("\n").find((l) => l.includes("<- next")), /prov\/a/, `an idle pool marks slot 1:\n${open.output}`)
  assert.doesNotMatch(open.output.split("\n").find((l) => l.includes("<- next")), /FULL/, "an idle slot is not at its ceiling")
  await hooks.dispose()
  await fresh.dispose()
})

// ---------------------------------------------------------------------------
// US-7 — any model is a valid slot, and the pool restricts nothing of the
// user's own.
//
// `provider.<name>.whitelist` is an ALLOWLIST in opencode, not a shopping list:
// a model the whitelist does not name is deleted from the provider, and a
// provider left with no models is deleted outright. An ABSENT whitelist is the
// open form -- every model the provider offers survives. So the only correct
// thing for the pool to do is append to a whitelist the user actually wrote and
// otherwise keep its hands off, because writing one where there was none
// silently deletes every model of theirs the pool does not name.
//
// ---------------------------------------------------------------------------

test("[US-7] a paid model is accepted as a slot and routed to, with no free-tier filter", async () => {
  // Cost is the user's decision. A preset of frontier models must be as valid
  // as the shipped free one.
  const slots = [
    { model: "anthropic/claude-opus-4-1", weight: 2 },
    { model: "openai/gpt-5", weight: 1 },
  ]
  const { hooks, cfg } = await bootPool(slots, "us7-paid")
  const routed = await burst(hooks, cfg, 3)
  assert.equal(routed[0], "explore-1")
  assert.equal(cfg.agent["explore-1"].model, "anthropic/claude-opus-4-1", "the paid model must be bound verbatim")
  assert.equal(cfg.agent["explore-2"].model, "openai/gpt-5")
  assert.match(routed.join(","), /explore-[12]/, `paid slots must still route: ${routed}`)
  await hooks.dispose()
})

test("[US-7] a vendor-prefixed id splits on the first slash only, tail preserved", async () => {
  const model = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"
  const { hooks, cfg } = await bootPool([{ model, weight: 1 }], "us7-vendor")
  await burst(hooks, cfg, 1)

  // The provider is everything before the FIRST slash; the model id is the rest,
  // vendor segment included. A plain split("/") would whitelist "nvidia" alone
  // and opencode would resolve the slot to no model at all.
  assert.deepEqual(cfg.provider.openrouter.whitelist, ["nvidia/nemotron-3-ultra-550b-a55b:free"], `whitelist: ${JSON.stringify(cfg.provider)}`)
  assert.equal(cfg.agent["explore-1"].model, model)
  await hooks.dispose()
})

test("[US-7] more slots than the pool allows are dropped with a warning naming the cap", async () => {
  const slots = [
    { model: "cap/one", weight: 1 },
    { model: "cap/two", weight: 1 },
    { model: "cap/three", weight: 1 },
    { model: "cap/four", weight: 1 },
    { model: "cap/five", weight: 1 },
    { model: "cap/six", weight: 1 },
  ]
  const { hooks, cfg, stub } = await bootPool(slots, "us7-cap")
  const warnings = stub.text().filter((line) => line.startsWith("warn"))
  const capWarning = warnings.find((line) => line.includes("capped at") && /4/.test(line))
  assert.ok(capWarning, `the surplus must be dropped with a warning naming the cap:\n${warnings.join("\n")}`)
  assert.match(capWarning, /cap\/five|cap\/six/, "the dropped entry must be named")
  assert.ok(!cfg.agent["explore-5"], "no fifth variant exists, so routing to it would fail")
  assert.ok(cfg.agent["explore-4"], "the first four slots must survive")

  // And routing never reaches for the dropped ones.
  const routed = await burst(hooks, cfg, 4)
  for (const variant of routed) assert.match(variant, /^explore-[1-4]$/, `got ${variant}`)
  await hooks.dispose()
})

test("[US-7] the shipped preset's slots are all routable and all whitelisted on their provider", async () => {
  const models = presetModels()
  const { hooks, cfg } = await bootPool(models.map((model, i) => ({ model, weight: i + 1 })), "us7-shipped")
  for (const model of models) {
    const slash = model.indexOf("/")
    const provider = cfg.provider[model.slice(0, slash)]
    assert.ok(provider, `provider ${model.slice(0, slash)} must be configured`)
    assert.ok(provider.whitelist.includes(model.slice(slash + 1)), `${model} must be whitelisted, got ${JSON.stringify(provider.whitelist)}`)
  }
  await hooks.dispose()
})

// The regression: the pool used to charge a missing whitelist as if it were an
// empty one and create it anyway. A user who installed LaCode with an open
// provider lost every non-pool model on every provider the pool touched, with
// nothing in the config to show for it. Asserting "the pool models are present"
// cannot see this bug -- the old code satisfied that too -- so every test here
// asks about the KEY, not its contents.

test("[US-7] a provider configured with no whitelist is left with none: creating one would delete every model the user runs on it", async () => {
  const cfg = { provider: { someprovider: {} }, agent: {}, command: {} }
  const { hooks } = await bootConfig([{ model: "someprovider/slot-model", weight: 1 }], cfg, "us7-open-provider")

  const entry = cfg.provider.someprovider
  assert.ok(!("whitelist" in entry), `an absent whitelist must stay absent, got ${JSON.stringify(entry)}`)
  assert.equal(entry.whitelist, undefined, `nothing may stand in for the key either, got ${JSON.stringify(entry)}`)
  // Not a failure mode: an absent whitelist is precisely what makes the slot
  // resolvable, so the pool still works over the provider it did not restrict.
  assert.equal(cfg.agent["explore-1"].model, "someprovider/slot-model", "the slot must still bind over an open provider")
  await hooks.dispose()
})

test("[US-7] a provider the pool does not route to is never given a whitelist either", async () => {
  const cfg = { provider: { someprovider: {}, unrelated: {} }, agent: {}, command: {} }
  const { hooks } = await bootConfig([{ model: "someprovider/slot-model", weight: 1 }], cfg, "us7-untouched")

  assert.ok(!("whitelist" in cfg.provider.unrelated), `a provider the pool never names must be untouched, got ${JSON.stringify(cfg.provider.unrelated)}`)
  assert.deepEqual(Object.keys(cfg.provider.unrelated), [], "and nothing else about it may change either")
  assert.ok(!("whitelist" in cfg.provider.someprovider), `the pool's own provider stays open too, got ${JSON.stringify(cfg.provider.someprovider)}`)
  await hooks.dispose()
})

test("[US-7] a whitelist the user did write is extended, never replaced: the slot models are appended and their entries kept", async () => {
  // The other half of the contract. A whitelist the user wrote IS a restriction,
  // and opencode deletes any model it does not name -- so the pool models have
  // to go in or the slots resolve to nothing. Removal of the whole mutation
  // would "fix" the open-provider bug by breaking this user instead.
  const cfg = { provider: { someprovider: { whitelist: ["theirs", "and-theirs-too"] } }, agent: {}, command: {} }
  const { hooks } = await bootConfig(
    [
      { model: "someprovider/slot-a", weight: 2 },
      { model: "someprovider/slot-b", weight: 1 },
    ],
    cfg,
    "us7-existing",
  )

  assert.deepEqual(
    cfg.provider.someprovider.whitelist,
    ["theirs", "and-theirs-too", "slot-a", "slot-b"],
    `the user's entries must survive in order, got ${JSON.stringify(cfg.provider.someprovider.whitelist)}`,
  )
  await hooks.dispose()
})

test("[US-7] no provider is ever left holding an empty whitelist, which opencode reads as delete this provider", async () => {
  // An empty allowlist matches no model at all, so opencode drops the provider
  // whole. This is the invariant over every provider in the config, asserted
  // from one boot that covers every shape at once: open, restricted, and one
  // the pool never names.
  const cfg = {
    provider: {
      opened: {},
      restricted: { whitelist: ["theirs"] },
      unrelated: {},
    },
    agent: {},
    command: {},
  }
  const { hooks } = await bootConfig([{ model: "opened/slot-model", weight: 1 }], cfg, "us7-no-empty")

  for (const [name, entry] of Object.entries(cfg.provider)) {
    assert.ok(entry.whitelist === undefined || entry.whitelist.length > 0, `provider ${name} must not end up with an empty whitelist: ${JSON.stringify(entry)}`)
  }
  // And every provider ends up exactly as its shape dictates: the restricted one
  // is never named by a slot, so it is not touched; the slot's own provider stays
  // open, and the model still binds.
  assert.deepEqual(cfg.provider.restricted.whitelist, ["theirs"], "a whitelist on an untouched provider must be left alone")
  assert.ok(!("whitelist" in cfg.provider.opened), `the slot's own provider stays open, got ${JSON.stringify(cfg.provider.opened)}`)
  assert.equal(cfg.agent["explore-1"].model, "opened/slot-model")
  await hooks.dispose()
})