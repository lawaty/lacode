// Epic B — Provider resilience.
//
//   US-4  a rate limit moves work to another provider instead of failing
//   US-5  weights express preference between models
//   US-6  live pool visibility (the pool_status tool)
//   US-7  a paid model is just another slot
//   US-31 a limit that hangs is killed, and the retry lands on a slot that answers
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
  const { stubOptions = {}, ...rest } = options
  const stub = stubInput(stubOptions)
  const dir = scratch()
  const hooks = await bootLaCode(stub, { id, dir, models: { slots }, ...rest })
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

/** The sessions the pool asked the server to abort, via the abort URL it POSTs. */
const stubFetch = () => {
  const aborted = []
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const match = /\/session\/([^/]+)\/abort/.exec(String(url))
    if (match) aborted.push(match[1])
    return new Response("true", { status: 200 })
  }
  return { aborted, restore: () => { globalThis.fetch = real } }
}

/**
 * Route one spawn and bind it to a child session, exactly as opencode does:
 * the task hook claims a slot, then session.created binds the child to it.
 * Without the bind the claim has no target, and a limit signal naming that
 * session would have nothing to cool and nothing to abort.
 */
const spawnChild = async (hooks, cfg, { callID, sessionID = "parent", childID }) => {
  const routed = await spawn(hooks, cfg, { subagent: "explore", callID, sessionID })
  await emit(hooks, "session.created", { info: { id: childID, parentID: sessionID } })
  return routed
}

/** The models the status view reports as cooling, read off its summary line. */
const coolingModels = async (hooks) => {
  const status = await hooks.tool.pool_status.execute({}, {})
  const line = status.output.split("\n").find((l) => /^(unavailable\/)?cooling: /.test(l))
  if (!line) return []
  return line.replace(/^(unavailable\/)?cooling: /, "").split(", ").map((entry) => entry.split(" for ")[0])
}

// ---------------------------------------------------------------------------
// US-4 — failover
// ---------------------------------------------------------------------------

test("[US-4] a rate-limit-shaped error marks the model cooling and writes a cooldown file", async () => {
  const clock = fakeClock()
  const { dir, hooks, models, stub } = await bootPool([{ model: "prov/one", weight: 2 }], "us4-strike")

  // Deliberately NOT the top-level `data.message` shape: the plugin must read
  // the error text under responseBody, which is what a gateway actually sends.
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

test("[US-4] when every model is cooling the pool still routes instead of refusing", async () => {
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
  // WHICH slot the degraded pick takes is the next test's business.
  const routed = await burst(hooks, cfg, 2)
  for (const variant of routed) {
    assert.match(variant, /^explore-[1-9]$/, `the pool must degrade, not refuse: got ${variant}`)
  }
  await hooks.dispose()
})

test("[US-4] when every model is cooling the spawn lands on the least-loaded slot, not on the busier one", async () => {
  // The degraded pick is a LEAST-LOADED pick, not an arbitrary one. Two slots
  // carrying different load make the difference visible: the emptier one has to
  // take the spawn. "Some slot" and "the first slot in declaration order" both
  // satisfy a check that only asks whether the spawn went anywhere -- so the load
  // has to be made unequal first, or the choice is invisible.
  const slots = [
    { model: "prov/busy", weight: 3 },
    { model: "prov/light", weight: 1 },
  ]
  const { hooks, cfg, models } = await bootPool(slots, "us4-least-loaded")

  // Unequal load first: the heavy slot holds three claims, the light one one.
  const routed = await burst(hooks, cfg, 4)
  assert.deepEqual(routed, ["explore-1", "explore-1", "explore-1", "explore-2"], `the load must be where the weights put it, got ${routed}`)

  const loadOf = async (model) => {
    const status = await hooks.tool.pool_status.execute({}, {})
    const line = status.output.split("\n").find((l) => /^\s*slot \d/.test(l) && l.includes(model))
    return Number(/load=(\d+)\//.exec(line)[1])
  }
  assert.equal(await loadOf("prov/busy"), 3, "the heavy slot must hold three claims")
  assert.equal(await loadOf("prov/light"), 1, "the light slot must hold one claim")

  // Now every model is cooling, so the ordered fill can pick nothing at all.
  for (const model of models) {
    const [provider, id] = [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)]
    await emit(hooks, "message.updated", {
      info: { role: "assistant", providerID: provider, modelID: id, error: { message: "usage limit reached" } },
    })
  }

  const degraded = await spawn(hooks, cfg, { callID: "degraded", sessionID: "degraded" })
  assert.equal(degraded.routed, "explore-2", `the degraded pick must be the least-loaded slot, got ${degraded.routed}`)
  assert.equal(degraded.model, "prov/light", `the least-loaded slot's model must be the one used, got ${degraded.model}`)
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

// A gateway that cannot serve the request right now -- a 5xx, a queue budget, a
// stalled request aborted on timeout -- is transient, not a limit. It must take
// the same short, flat cooldown as "Endpoint is unavailable" and never the
// escalating strike path, or a congested model stays benched long after the
// outage has passed. The recogniser must treat a 5xx as transient, not only
// limit text and 429, so a real 503 cannot fall straight through and bench nothing.

test("[US-4] a gateway 503 carrying a queue-budget message benches the model flat, and it is selectable again after the cooldown", async () => {
  const clock = fakeClock()
  const slots = [
    { model: "prov/gateway", weight: 1 },
    { model: "prov/other", weight: 1 },
  ]
  const { dir, hooks, cfg, models } = await bootPool(slots, "us4-gateway-503")

  // The real message captured from the pool: a 503 whose body is a queue budget,
  // not a rate limit. The recogniser must judge the queue-budget message, not
  // return merely because status 503 != 429.
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "gateway",
      error: {
        name: "APIError",
        data: {
          statusCode: 503,
          responseBody:
            "[503]: Request exceeded queue budget maxWaitMs=30000ms for gemini/gemini-3.1-flash-lite — queue budget does not bound execution (executionMaxWaitMs=600000ms)",
        },
      },
    },
  })

  const strike = JSON.parse(readFileSync(limitFile(dir, models[0]), "utf8"))
  assert.equal(strike.reason, "endpoint-unavailable", `a gateway 5xx must take the flat path, got ${strike.reason}`)
  assert.equal(strike.strikes, 1, `the flat path must not escalate, got strike ${strike.strikes}`)
  assert.equal(Math.round((strike.until - clock.now()) / 1000), 60, `the flat cooldown must be the short one, got ${Math.round((strike.until - clock.now()) / 1000)}s`)

  // While it is benched, routing avoids it.
  const { routed } = await spawn(hooks, cfg, { callID: "during", sessionID: "during" })
  assert.equal(routed, "explore-2", `a benched gateway must not be picked, got ${routed}`)

  // The flat window is transient: once it lapses the model is selectable again.
  clock.advance(61_000)
  const status = await hooks.tool.pool_status.execute({}, {})
  assert.doesNotMatch(status.output, /COOLING/, `the model must be selectable again after the flat cooldown:\n${status.output}`)
  await hooks.dispose()
})

test("[US-4] a TimeoutError with no status code benches the model flat", async () => {
  const clock = fakeClock()
  const { dir, hooks, models } = await bootPool([{ model: "prov/stalled", weight: 1 }], "us4-timeout")

  // A stalled request surfaces as a DOMException with no statusCode at all, so
  // the status check cannot see it and no limit pattern matches it.
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "stalled",
      error: { name: "TimeoutError", message: "The operation was aborted due to timeout" },
    },
  })

  const strike = JSON.parse(readFileSync(limitFile(dir, models[0]), "utf8"))
  assert.equal(strike.reason, "endpoint-unavailable", `a timeout must take the flat path, got ${strike.reason}`)
  assert.equal(strike.strikes, 1, `a timeout must not escalate, got strike ${strike.strikes}`)
  assert.equal(Math.round((strike.until - clock.now()) / 1000), 60, `a timeout must cool flat, got ${Math.round((strike.until - clock.now()) / 1000)}s`)
  await hooks.dispose()
})

test("[US-4] a gateway 502 or 504 benches the model flat", async () => {
  const clock = fakeClock()
  const slots = [
    { model: "prov/bad502", weight: 1 },
    { model: "prov/bad504", weight: 1 },
  ]
  const { dir, hooks, models } = await bootPool(slots, "us4-5xx")

  for (const [i, statusCode] of [502, 504].entries()) {
    const [provider, modelID] = [models[i].slice(0, models[i].indexOf("/")), models[i].slice(models[i].indexOf("/") + 1)]
    await emit(hooks, "message.updated", {
      info: {
        role: "assistant",
        providerID: provider,
        modelID,
        error: { name: "APIError", data: { statusCode, responseBody: `[${statusCode}] gateway error` } },
      },
    })
    const strike = JSON.parse(readFileSync(limitFile(dir, models[i]), "utf8"))
    assert.equal(strike.reason, "endpoint-unavailable", `a ${statusCode} must take the flat path, got ${strike.reason}`)
    assert.equal(strike.strikes, 1, `a ${statusCode} must not escalate, got strike ${strike.strikes}`)
    assert.equal(Math.round((strike.until - clock.now()) / 1000), 60, `a ${statusCode} must cool flat, got ${Math.round((strike.until - clock.now()) / 1000)}s`)
  }
  await hooks.dispose()
})

test("[US-4] a 429 still escalates through recordStrike and never takes the flat path", async () => {
  // The regression guard: the new transient handling must not swallow a real
  // limit. A 429 keeps its escalating strike backoff, which the flat path never
  // produces.
  const clock = fakeClock()
  const { dir, hooks, models } = await bootPool([{ model: "prov/limited", weight: 1 }], "us4-429-guard")

  const error = { name: "APIError", data: { statusCode: 429, responseBody: "Rate limit reached for requests" } }
  await emit(hooks, "message.updated", { info: { role: "assistant", providerID: "prov", modelID: "limited", error } })
  const first = JSON.parse(readFileSync(limitFile(dir, models[0]), "utf8"))
  assert.notEqual(first.reason, "endpoint-unavailable", `a 429 must not take the flat path, got ${first.reason}`)
  assert.match(first.reason, /rate-limit|quota|usage/i, `the limit reason must be recorded, got ${first.reason}`)
  assert.equal(first.strikes, 1, `the first 429 is strike 1, got ${first.strikes}`)

  // A repeat after the first window lapses must escalate, which the flat path
  // never does.
  clock.advance(first.until - clock.now() + 1000)
  await emit(hooks, "message.updated", { info: { role: "assistant", providerID: "prov", modelID: "limited", error } })
  const second = JSON.parse(readFileSync(limitFile(dir, models[0]), "utf8"))
  assert.equal(second.strikes, 2, `a repeat 429 must escalate to strike 2, got ${second.strikes}`)
  assert.ok(second.until > first.until, `the escalated cooldown must be longer (got ${first.until} then ${second.until})`)
  await hooks.dispose()
})

test("[US-4] an unrelated benign error benches nothing", async () => {
  const { dir, hooks } = await bootPool([{ model: "prov/fine", weight: 1 }], "us4-benign")

  await emit(hooks, "message.updated", {
    info: { role: "assistant", providerID: "prov", modelID: "fine", error: { name: "Error", message: "tool call failed: file not found" } },
  })

  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith("limit.")),
    [],
    `a benign error must bench nothing, got ${readdirSync(dir).join(", ")}`,
  )
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-5 — weighted preference
// ---------------------------------------------------------------------------

test("[US-5] pass 1 fills a heavy slot to its weight, and a light one still takes its own", async () => {
  // Ordered fill, not highest-weight-first. Pass 1 walks the slots in declaration
  // order and fills each to its weight, so weights [3,1] give slot 1 three
  // spawns before slot 2 takes its one. The absolute cap (twice the weight) is
  // pass 2's budget and does not change that order.
  const { hooks, cfg } = await bootPool(
    [
      { model: "prov/heavy", weight: 3 },
      { model: "prov/light", weight: 1 },
    ],
    "us5-pass-shape",
  )
  const routed = await burst(hooks, cfg, 4)
  assert.deepEqual(routed, ["explore-1", "explore-1", "explore-1", "explore-2"], `got ${routed}`)
  await hooks.dispose()
})

test("[US-5] ordered fill walks the slots in declaration order, so a light slot ahead of a heavier one is served first", async () => {
  // The rule is declaration order: pass 1 fills each slot to its weight in order,
  // so weights [1,2] serve slot 1 first and slot 2 the two after it.
  // Weight-as-priority would answer 2,2,1 here instead.
  const { hooks, cfg } = await bootPool(
    [
      { model: "prov/one", weight: 1 },
      { model: "prov/two", weight: 2 },
    ],
    "us5-pass-order",
  )
  const routed = await burst(hooks, cfg, 3)
  assert.deepEqual(routed, ["explore-1", "explore-2", "explore-2"], `got ${routed}`)
  await hooks.dispose()
})

test("[US-5] past every weight, pass 2 fills the slots again before overflow", async () => {
  const { hooks, cfg } = await bootPool(
    [
      { model: "prov/a", weight: 1 },
      { model: "prov/b", weight: 1 },
    ],
    "us5-overflow",
  )
  const routed = await burst(hooks, cfg, 3)
  assert.deepEqual(routed.slice(0, 2), ["explore-1", "explore-2"], `pass 1 first, got ${routed}`)
  // Third: both are at their weight but under their absolute cap, so pass 2
  // reopens the slots in declaration order rather than overflowing.
  assert.match(routed[2], /^explore-[12]$/, `pass 2 must still route, got ${routed[2]}`)
  assert.notEqual(routed[2], routed[1], "pass 2 must reopen the slots in declaration order, not pile on the last one")
  await hooks.dispose()
})

test("[US-5] a slot at its absolute cap is skipped and the pass continues to the next slot", async () => {
  // Both passes walk the slots in declaration order. A slot at its absolute cap
  // (twice its weight) is skipped in both, so the pass continues to the next
  // slot with room instead of stalling on the capped one. This pool's OWN claims
  // cannot create that asymmetry -- they fill every slot evenly -- so it comes
  // from a second process, which is how a slot really reaches its cap in a busy
  // pool: another opencode holding claims on that model.
  const slots = [
    { model: "prov/full", weight: 1 },
    { model: "prov/room", weight: 2 },
  ]
  const { hooks, cfg, dir } = await bootPool(slots, "us5-skip-full-slot")

  // A sibling opencode process holds two claims on the first slot. Its absolute
  // cap is twice its weight (2 x 1 = 2), so that slot is at its cap; the second
  // one still has room.
  writeFileSync(
    join(dir, "claims.sibling.json"),
    JSON.stringify({
      "peer:1": { v: "explore", k: 1, m: "prov/full", t: Date.now() },
      "peer:2": { v: "explore", k: 1, m: "prov/full", t: Date.now() },
    }),
  )

  // The pass opens on the capped slot. It must be skipped, not served.
  const { routed } = await spawn(hooks, cfg, { callID: "skip", sessionID: "skip" })
  assert.equal(routed, "explore-2", `a slot at its absolute cap must be skipped, got ${routed}`)

  // And it keeps filling the next slot rather than stalling on the capped one.
  const next = await spawn(hooks, cfg, { callID: "next", sessionID: "next" })
  assert.equal(next.routed, "explore-2", `the pass must continue past the capped slot, got ${next.routed}`)
  await hooks.dispose()
})

test("[US-5] equal weights fill pass 1 then pass 2 in declaration order", async () => {
  const slots = ["prov/a", "prov/b", "prov/c"].map((model) => ({ model, weight: 1 }))
  const { hooks, cfg } = await bootPool(slots, "us5-ordered-fill")
  const routed = await burst(hooks, cfg, 6)
  assert.deepEqual(routed, ["explore-1", "explore-2", "explore-3", "explore-1", "explore-2", "explore-3"], `got ${routed}`)
  await hooks.dispose()
})

test("[US-5] no slot exceeds its weight except through overflow", async () => {
  const slots = [
    { model: "prov/heavy", weight: 3 },
    { model: "prov/mid", weight: 2 },
    { model: "prov/light", weight: 1 },
  ]
  const { hooks, cfg } = await bootPool(slots, "us5-cap-bound")
  // The pool's capacity is the sum of the weights, so driving it to exactly
  // that point leaves every slot at its weight and nothing above it.
  const ceiling = (s) => s.weight
  const capacity = slots.reduce((sum, s) => sum + ceiling(s), 0)
  await burst(hooks, cfg, capacity)

  const loadsOf = async () => {
    const status = await hooks.tool.pool_status.execute({}, {})
    return status.output
      .split("\n")
      .filter((line) => /^\s*slot \d/.test(line))
      .map((line) => {
        const [, load, limit] = /load=(\d+)\/(\d+)/.exec(line)
        return { load: Number(load), ceiling: Number(limit) }
      })
  }

  const atCapacity = await loadsOf()
  assert.equal(atCapacity.length, slots.length)
  for (const { load, ceiling: limit } of atCapacity) {
    assert.ok(load <= limit, `load ${load} must never exceed the ceiling ${limit}`)
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
    after.some((s) => s.load > s.ceiling),
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

test("[US-6] the slot the next spawn would take is marked, and with every slot at its absolute cap it is the least-loaded one", async () => {
  const slots = [
    { model: "prov/a", weight: 1 },
    { model: "prov/b", weight: 1 },
  ]
  const { hooks, cfg } = await bootPool(slots, "us6-next")
  // Fill both weight-1 slots to their DOUBLED absolute cap of 2, so both are
  // genuinely at capacity and the next spawn is an overflow decision.
  await burst(hooks, cfg, 4)

  // Both slots are at their absolute cap, so the next spawn is an overflow decision.
  const status = await hooks.tool.pool_status.execute({}, {})
  const marked = status.output.split("\n").filter((l) => l.includes("<- next"))
  assert.equal(marked.length, 1, `exactly one slot may be marked as next:\n${status.output}`)
  assert.match(marked[0], /FULL/, `with every slot at its absolute cap, the next spawn takes the least-loaded one:\n${marked[0]}`)

  // And the mark is not decoration: the next real spawn lands on that slot.
  const markedIndex = Number(/slot (\d)/.exec(marked[0])[1])
  const { routed } = await spawn(hooks, cfg, { callID: "next", sessionID: "next" })
  assert.equal(routed, `explore-${markedIndex}`, `the mark must predict the routing: marked slot ${markedIndex}, routed ${routed}`)

  // With room again, the mark moves to the slot that actually has capacity.
  const { hooks: fresh, cfg: freshCfg } = await bootPool(slots, "us6-next-open")
  const open = await fresh.tool.pool_status.execute({}, {})
  assert.match(open.output.split("\n").find((l) => l.includes("<- next")), /prov\/a/, `an idle pool marks slot 1:\n${open.output}`)
  assert.doesNotMatch(open.output.split("\n").find((l) => l.includes("<- next")), /FULL/, "an idle slot is not at its absolute cap")
  await hooks.dispose()
  await fresh.dispose()
})

test("[US-6] a slot at its absolute cap is not marked as the slot the next spawn would take", async () => {
  // The status view previews the next pick, so the mark must be the slot ordered
  // fill would really use. A slot at its absolute cap is skipped by both passes,
  // so the mark belongs to the slot that still has room -- pointing it at the
  // full slot would send the reader looking at the wrong one.
  const slots = [
    { model: "prov/full", weight: 1 },
    { model: "prov/room", weight: 2 },
  ]
  const { hooks, cfg } = await bootPool(slots, "us6-next-not-full")

  // Two claims: the weight-1 slot is FULL at one claim, and the weight-2 slot has
  // one more of room.
  await burst(hooks, cfg, 2)

  const status = await hooks.tool.pool_status.execute({}, {})
  const slotLine = (model) => status.output.split("\n").find((l) => /^\s*slot \d/.test(l) && l.includes(model))
  const full = slotLine("prov/full")
  const room = slotLine("prov/room")

  assert.match(full, /load=1\/1 FULL/, `the full slot must be shown as full:\n${status.output}`)
  assert.doesNotMatch(full, /<- next/, `a slot at its absolute cap must not be marked as the next one:\n${status.output}`)
  assert.match(room, /load=1\/2/, `the other slot must still have room:\n${status.output}`)
  assert.match(room, /<- next/, `the mark must be on the slot that still has room:\n${status.output}`)
  assert.doesNotMatch(room, /FULL/, `the marked slot must not be the full one:\n${status.output}`)
  await hooks.dispose()
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

test("[US-7] every slot in a long file is kept: there is no slot cap", async () => {
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
  assert.ok(!warnings.some((line) => line.includes("capped")), `no slot may be dropped:\n${warnings.join("\n")}`)
  for (let i = 1; i <= slots.length; i++) assert.ok(cfg.agent[`explore-${i}`], `variant explore-${i} must exist`)

  // And routing reaches every one of them.
  const routed = await burst(hooks, cfg, slots.length)
  assert.deepEqual(routed, slots.map((_, i) => `explore-${i + 1}`), `got ${routed}`)
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

// The regression guard: the pool must not charge a missing whitelist as if it
// were an empty one and create it anyway. Creating one would delete every
// non-pool model on every provider the pool touched, with nothing in the config
// to show for it. Asserting "the pool models are present" cannot see this bug
// -- creating an empty whitelist satisfies that too -- so every test here asks
// about the KEY, not its contents.

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

// ---------------------------------------------------------------------------
// US-31 — a limit that hangs is killed, and the retry lands on a slot that
// answers.
//
// A limit does not fail the task, it HANGS it: the provider accepts the
// request and then says nothing, opencode keeps retrying the refused model,
// and the claim it is holding is never released. So the pool has to end that
// wait itself -- cool what the signal is evidence about, abort the session it
// is about, and let the caller's retry land on a slot that answers.
//
// The signal arrives in two shapes, and both are handled here: a retry STATUS
// opencode reports for a session, and an assistant ERROR carrying the
// provider's own words. What decides the SCOPE is what the signal names: a
// provider named in the status benches that whole provider, and a limit that
// names nobody benches only the model the session was running on -- that is
// the one the refusal is evidence about.
//
// A third case is a signal that is limit-SHAPED but is not a limit: the
// provider is briefly DOWN rather than out of allowance. That lifts on its
// own, so it must not bench a healthy model for the quota window -- one short
// flat window says "not right now", while the quota curve says "gone for the
// day". The wait still ends: only the abort stops opencode looping on it.
// ---------------------------------------------------------------------------

test("[US-31] a retry status that names no provider cools the model the session is running on", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { dir, hooks, cfg } = await bootPool(slots, "us31-model-cooling")

  // The session that reports the limit is running on prov/one.
  const first = await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-limit" })
  assert.equal(first.model, "prov/one", `control: the session must run on prov/one, got ${first.model}`)

  // A retry status that names NO provider: the message is the whole signal.
  await emit(hooks, "session.status", {
    sessionID: "child-limit",
    status: { type: "retry", message: "limit reached" },
  })

  const file = limitFile(dir, "prov/one")
  assert.ok(existsSync(file), `a cooldown file must be written for the model, got: ${readdirSync(dir).join(", ")}`)
  const strike = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(strike.model, "prov/one", `the cooldown must be for the model the session runs on, got ${strike.model}`)
  assert.ok(strike.until > clock.now(), `the cooldown must be in the future, got ${strike.until} vs ${clock.now()}`)
  assert.deepEqual(await coolingModels(hooks), ["prov/one"], `only the refused model may cool, got ${JSON.stringify(await coolingModels(hooks))}`)

  // And the slot on ANOTHER provider is untouched: a limit that names no
  // provider says nothing about the provider next door.
  assert.ok(!existsSync(limitFile(dir, "other/two")), `no other provider's model may be cooled, got: ${readdirSync(dir).join(", ")}`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] a limit that hangs is aborted and its claim released", async () => {
  const net = stubFetch()
  const { dir, hooks, cfg } = await bootPool([{ model: "prov/one", weight: 2 }], "us31-abort")

  await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-hang" })

  // The provider took the request and then went quiet: the status reports the
  // limit and the session never answers again.
  await emit(hooks, "session.status", {
    sessionID: "child-hang",
    status: { type: "retry", message: "limit reached" },
  })

  assert.deepEqual(net.aborted, ["child-hang"], `the hanging session must be aborted, got ${JSON.stringify(net.aborted)}`)
  // The claim goes with it, so the slot is not held by a task that will never
  // answer.
  const claims = readFileSync(join(dir, "claims.us31-abort.json"), "utf8")
  assert.equal(claims, "{}", `the claim must be released, got ${claims}`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] the retry after a limit lands on a slot that is not on cooldown", async () => {
  const net = stubFetch()
  // Weights 2 and 1, so ordered fill would return to prov/one for the next
  // spawn while it is still under its weight. Only the cooldown can move the
  // retry off it: with equal weights the retry would land on the other slot
  // anyway, and the cooldown would prove nothing.
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { dir, hooks, cfg } = await bootPool(slots, "us31-reroute")

  const first = await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-first" })
  assert.equal(first.model, "prov/one", `control: the first spawn must land on prov/one, got ${first.model}`)

  await emit(hooks, "session.status", {
    sessionID: "child-first",
    status: { type: "retry", message: "limit reached" },
  })
  assert.ok(existsSync(limitFile(dir, "prov/one")), `prov/one must be cooling, got: ${readdirSync(dir).join(", ")}`)

  // The caller's retry. Ordered fill would have offered prov/one again.
  const retry = await spawn(hooks, cfg, { subagent: "explore", callID: "c2", sessionID: "parent-2" })
  assert.notEqual(retry.routed, first.routed, `the retry must leave the cooled slot, got ${retry.routed}`)
  assert.notEqual(retry.model, first.model, `the retry must not use the cooled model ${first.model}, got ${retry.model}`)
  assert.equal(retry.model, "other/two", `the retry must land on the slot that answers, got ${retry.model}`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] a limit that names its provider cools every slot on that provider and no other", async () => {
  const net = stubFetch()
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "prov/two", weight: 1 },
    { model: "other/three", weight: 1 },
  ]
  const { dir, hooks, cfg } = await bootPool(slots, "us31-provider")

  await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-provider" })

  // The provider names ITSELF, so the refusal is evidence about the whole
  // provider and every one of its slots is benched.
  await emit(hooks, "session.status", {
    sessionID: "child-provider",
    status: { type: "retry", message: "limit reached", action: { reason: "free_tier_limit", provider: "prov" } },
  })

  assert.ok(existsSync(limitFile(dir, "prov/one")), `prov/one must be cooled, got: ${readdirSync(dir).join(", ")}`)
  assert.ok(existsSync(limitFile(dir, "prov/two")), `prov/two must be cooled, got: ${readdirSync(dir).join(", ")}`)
  assert.ok(!existsSync(limitFile(dir, "other/three")), `a slot on another provider must not be cooled, got: ${readdirSync(dir).join(", ")}`)
  assert.deepEqual(
    (await coolingModels(hooks)).sort(),
    ["prov/one", "prov/two"],
    `only the named provider's slots may cool, got ${JSON.stringify(await coolingModels(hooks))}`,
  )

  net.restore()
  await hooks.dispose()
})

test("[US-31] an error that says the limit was reached cools the model and aborts the session", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { dir, hooks, cfg } = await bootPool([{ model: "prov/one", weight: 2 }], "us31-error")

  await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-error" })

  // No status code at all: the provider's own phrasing is the whole signal,
  // and it says "limit reached".
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "one",
      sessionID: "child-error",
      error: { name: "AI_APICallError", data: { responseBody: "limit reached" } },
    },
  })

  const file = limitFile(dir, "prov/one")
  assert.ok(existsSync(file), `a cooldown file must be written, got: ${readdirSync(dir).join(", ")}`)
  const strike = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(strike.model, "prov/one", `the model must be the one cooled, got ${strike.model}`)
  assert.ok(strike.until > clock.now(), `the cooldown must be in the future, got ${strike.until} vs ${clock.now()}`)
  // The task already in flight on it is not benched with it: it is aborted, so
  // the caller re-routes now instead of waiting out the hang.
  assert.deepEqual(net.aborted, ["child-error"], `the in-flight session must be aborted, got ${JSON.stringify(net.aborted)}`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] a context limit is not a quota, so nothing is cooled and nothing is aborted", async () => {
  const net = stubFetch()
  const { dir, hooks, cfg } = await bootPool([{ model: "prov/one", weight: 2 }], "us31-context")

  await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-context" })

  // The prompt was too long. That is the user's own request, not the
  // provider's allowance, so the model stays usable for routing and the task
  // keeps running.
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "one",
      sessionID: "child-context",
      error: { name: "AI_APICallError", data: { responseBody: "context limit reached" } },
    },
  })

  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith("limit.")),
    [],
    `a context limit must cool nothing, got ${readdirSync(dir).join(", ")}`,
  )
  assert.deepEqual(await coolingModels(hooks), [], `the model must not be cooling, got ${JSON.stringify(await coolingModels(hooks))}`)
  assert.deepEqual(net.aborted, [], `a context limit must not abort the session, got ${JSON.stringify(net.aborted)}`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] a transient outage is cooled flat, not for the quota window", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  // Weights 2 and 1, so ordered fill would return to prov/one for the next
  // spawn -- the same shape as the reroute test above, so only a cooldown can
  // move the retry off it.
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { dir, hooks, cfg } = await bootPool(slots, "us31-outage")

  // The session that reports the outage is running on prov/one.
  const first = await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-outage" })
  assert.equal(first.model, "prov/one", `control: the session must run on prov/one, got ${first.model}`)

  // An OUTAGE, not a quota: the provider is down rather than out of allowance.
  // The status carries no `action` block at all, so no provider is named and
  // the fault is left to the message alone.
  await emit(hooks, "session.status", {
    sessionID: "child-outage",
    status: { type: "retry", message: "Endpoint is unavailable" },
  })

  const file = limitFile(dir, "prov/one")
  assert.ok(existsSync(file), `a cooldown file must be written, got: ${readdirSync(dir).join(", ")}`)
  const strike = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(strike.reason, "endpoint-unavailable", `an outage must be filed under its own reason, got ${strike.reason}`)

  // The window is FLAT: one short cooldown, never the escalating quota curve.
  // A quota -- "limit reached" -- would have been 900000ms (15 minutes).
  const window = strike.until - clock.now()
  assert.ok(window <= 61_000, `the outage window must be flat (the quota window would have been 900000ms), got ${window}ms`)
  assert.ok(window < 900_000, `an outage must not take the quota window, got ${window}ms`)

  // The wait still ends: a retry status means opencode is LOOPING on a refused
  // model, and only the abort stops that. The transient fault changes the
  // WINDOW, not the wait.
  assert.deepEqual(net.aborted, ["child-outage"], `the session must still be aborted, got ${JSON.stringify(net.aborted)}`)

  // And the model really is cooling -- flatly, not on a quota bench.
  assert.deepEqual(await coolingModels(hooks), ["prov/one"], `the model must be cooling, got ${JSON.stringify(await coolingModels(hooks))}`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] an outage does not escalate the next quota window", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  // Weights 2 and 1, exactly as the existing US-31 tests do.
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { dir, hooks, cfg } = await bootPool(slots, "us31-outage-no-escalate")

  // Route one spawn and bind a child session to the claim.
  const first = await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-outage" })
  assert.equal(first.model, "prov/one", `control: the session must run on prov/one, got ${first.model}`)

  // Emit the OUTAGE: no `action` key.
  await emit(hooks, "session.status", {
    sessionID: "child-outage",
    status: { type: "retry", message: "Endpoint is unavailable" },
  })

  // Route ONE MORE spawn through spawn() — this calls the pool's snapshot(),
  // which calls readLimits() and RE-READS the cooldown files from disk. This
  // proves the on-disk outage record cannot resurrect the strike.
  await spawn(hooks, cfg, { subagent: "explore", callID: "c2", sessionID: "parent2" })

  // Emit a REAL limit error for the SAME model (prov/one).
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "one",
      sessionID: "child-outage",
      error: { name: "AI_APICallError", data: { responseBody: "limit reached" } },
    },
  })

  const file = limitFile(dir, "prov/one")
  assert.ok(existsSync(file), `a cooldown file must exist for prov/one, got: ${readdirSync(dir).join(", ")}`)
  const strike = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(strike.reason, "limit-reached", `the real limit must take over; expected reason "limit-reached", got ${strike.reason}`)
  assert.equal(strike.strikes, 1, `after an outage the next real failure must be strike 1, NOT 2; got strikes=${strike.strikes}`)
  const window = strike.until - clock.now()
  assert.equal(window, 900_000, `the first-strike quota window must be 900000ms (an escalated strike would have been 1800000ms), got ${window}ms`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] an outage that names its provider is not a strike either, so the next real limit is strike 1", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  // Weights 2 and 1, exactly as the outage test above.
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { dir, hooks, cfg } = await bootPool(slots, "us31-outage-provider-no-escalate")

  // The session that reports the outage is running on prov/one.
  const first = await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-outage-provider" })
  assert.equal(first.model, "prov/one", `control: the session must run on prov/one, got ${first.model}`)

  // An OUTAGE that NAMES ITS PROVIDER: the status carries the provider, so the
  // fault is provider-wide and takes the coolProvider() path rather than the
  // per-model one. This is the path that must file the outage under its own
  // reason, not as a strike: every slot on the provider must be cooled through
  // coolProvider(), not recordStrike().
  await emit(hooks, "session.status", {
    sessionID: "child-outage-provider",
    status: { type: "retry", message: "Endpoint is unavailable", action: { provider: "prov" } },
  })

  const outage = JSON.parse(readFileSync(limitFile(dir, "prov/one"), "utf8"))
  assert.equal(outage.reason, "endpoint-unavailable", `an outage must be filed under its own reason, got ${outage.reason}`)
  const outageWindow = outage.until - clock.now()
  assert.ok(outageWindow <= 61_000, `the outage window must be flat (the quota window would have been 900000ms), got ${outageWindow}ms`)

  // NO spawn in between, on purpose. A routed spawn would rebuild the strike
  // memory from disk (readLimits skips the outage record), and that would
  // MASK an outage that had wrongly been filed as a strike. The in-memory
  // memory has to be clean on its own.
  //
  // Then a REAL limit on the same model.
  await emit(hooks, "message.updated", {
    info: {
      role: "assistant",
      providerID: "prov",
      modelID: "one",
      sessionID: "child-outage-provider",
      error: { name: "AI_APICallError", data: { responseBody: "limit reached" } },
    },
  })

  const strike = JSON.parse(readFileSync(limitFile(dir, "prov/one"), "utf8"))
  assert.equal(strike.reason, "limit-reached", `the real limit must take over; expected reason "limit-reached", got ${strike.reason}`)
  assert.equal(strike.strikes, 1, `an outage must never count as a strike, so the real limit is strike 1, NOT 2; got strikes=${strike.strikes}`)
  const window = strike.until - clock.now()
  assert.equal(window, 900_000, `the first-strike quota window must be 900000ms (an escalated strike would have been 1800000ms), got ${window}ms`)

  net.restore()
  await hooks.dispose()
})


test("[US-31] a terminal limit reported as session.error cools the model and aborts the session", async () => {
  // opencode's terminal path is `session.error` plus an idle status — there is
  // no retry status and no message.updated for a limit it stops retrying.
  const clock = fakeClock()
  const net = stubFetch()
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { dir, hooks, cfg } = await bootPool(slots, "us31-session-error")

  const first = await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-session-error" })
  assert.equal(first.model, "prov/one", `control: the session must run on prov/one, got ${first.model}`)

  await emit(hooks, "session.error", {
    sessionID: "child-session-error",
    error: { name: "APIError", data: { statusCode: 429, responseBody: "limit reached" } },
  })

  const file = limitFile(dir, "prov/one")
  assert.ok(existsSync(file), `a cooldown file must be written for prov/one, got: ${readdirSync(dir).join(", ")}`)
  const strike = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(strike.reason, "limit-reached", `the reason must be "limit-reached", got ${strike.reason}`)
  assert.equal(strike.strikes, 1, `the first terminal limit is strike 1, got ${strike.strikes}`)
  assert.ok(strike.until > clock.now(), `the cooldown must be in the future, got ${strike.until} vs ${clock.now()}`)
  assert.deepEqual(net.aborted, ["child-session-error"], `the session must be aborted, got ${JSON.stringify(net.aborted)}`)

  const claims = readFileSync(join(dir, "claims.us31-session-error.json"), "utf8")
  assert.equal(claims, "{}", `the claim must be released, got ${claims}`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] a terminal limit on a session the pool never bound is logged and aborts nothing", async () => {
  const net = stubFetch()
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { dir, hooks, cfg } = await bootPool(slots, "us31-session-error-unbound")

  await spawnChild(hooks, cfg, { callID: "c1", sessionID: "parent", childID: "child-real" })

  const before = net.aborted.length
  await emit(hooks, "session.error", {
    sessionID: "some-other-session",
    error: { name: "APIError", data: { statusCode: 429, responseBody: "Rate limit exceeded" } },
  })

  // The plugin sees every session in the process, including the user's own and
  // other processes'; a pooled child is bound at session.created before any
  // request, so a claim-less session is not ours to kill.
  assert.equal(net.aborted.length, before, `no abort may be recorded for an unbound session, got ${JSON.stringify(net.aborted)}`)

  const claims = readFileSync(join(dir, "claims.us31-session-error-unbound.json"), "utf8")
  assert.notEqual(claims, "{}", `the in-flight claim must survive, got ${claims}`)
  assert.match(claims, /child-real/, `the real claim must still be in flight, got ${claims}`)

  net.restore()
  await hooks.dispose()
})

test("[US-31] a terminal limit on an unbound pooled child is identified, cooled, and aborted", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { dir, hooks, cfg, stub } = await bootPool(slots, "us31b-unbound-pooled", {
    stubOptions: {
      sessions: {
        "orphan-child": { parentID: "parent" },
      },
      sessionMessages: {
        "orphan-child": [
          { info: { role: "user", agent: "implement-1", model: { providerID: "prov", modelID: "one" } } },
        ],
      },
    },
  })

  await emit(hooks, "session.error", {
    sessionID: "orphan-child",
    error: { name: "APIError", data: { statusCode: 429, responseBody: "Rate limit exceeded" } },
  })

  const file = limitFile(dir, "prov/one")
  assert.ok(existsSync(file), `a cooldown file must be written for prov/one, got: ${readdirSync(dir).join(", ")}`)
  const strike = JSON.parse(readFileSync(file, "utf8"))
  assert.ok(strike.reason)
  assert.equal(strike.strikes, 1)
  assert.deepEqual(net.aborted, ["orphan-child"], `the session must be aborted, got ${JSON.stringify(net.aborted)}`)
  assert.ok(
    stub.text().some((line) => line.includes("implement-1") && line.includes("prov/one")),
    `the log must name the pooled agent/model:\n${stub.text().join("\n")}`,
  )

  // root session left alone
  const before = net.aborted.length
  await emit(hooks, "session.error", {
    sessionID: "root-session",
    error: { name: "APIError", data: { statusCode: 429, responseBody: "Rate limit exceeded" } },
  })
  assert.equal(net.aborted.length, before)

  // non-pooled agent left alone
  const before2 = net.aborted.length
  // Need to set up session info for non-pooled
  stub.client.session.get = async ({ path: p }) => {
    if (p.id === "nonpooled-child") return { data: { parentID: "parent" } }
    if (p.id === "root-session") return { data: {} }
    if (p.id === "orphan-child") return { data: { parentID: "parent" } }
    return { data: undefined }
  }
  stub.client.session.messages = async ({ path: p }) => {
    if (p.id === "orphan-child") return { data: [{ info: { role: "user", agent: "implement-1", model: { providerID: "prov", modelID: "one" } } }] }
    if (p.id === "nonpooled-child") return { data: [{ info: { role: "user", agent: "general", model: { providerID: "prov", modelID: "one" } } }] }
    return { data: [] }
  }
  await emit(hooks, "session.error", {
    sessionID: "nonpooled-child",
    error: { name: "APIError", data: { statusCode: 429, responseBody: "Rate limit exceeded" } },
  })
  assert.equal(net.aborted.length, before2)

  net.restore()
  await hooks.dispose()
})
