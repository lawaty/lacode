// US-5 -- a slot variant named by hand is COERCED to its base, not refused.
//
// Naming a variant is how a caller would try to choose the provider and skip
// the ordered fill, so the gate must not leave the hand-named slot in place. It
// is rewritten to the bare base before routing: the variant is the OUTPUT of
// routing, and the pool owns the slot choice. These tests pin the coercion and
// the properties it must not break: the spawn is routed to a real slot, exactly
// one claim is taken for the right base, repeated hand-named spawns still fill
// in order, and agents that merely LOOK like a variant are left alone.

import { test } from "node:test"
import assert from "node:assert/strict"
import { bootLaCode, cleanupAll, configFor, PRESET, scratch, stubInput } from "./_harness.mjs"
import * as pool from "../../src/lib/pool.ts"

test.after(cleanupAll)

const POOL = { slots: [{ model: "gate/a", weight: 3 }, { model: "gate/b", weight: 2 }] }

const boot = async (id) => {
  const stub = stubInput()
  const dir = scratch()
  const hooks = await bootLaCode(stub, { id, dir, models: POOL })
  const cfg = configFor(["gate/a", "gate/b"])
  await hooks.config(cfg)
  // The plugin's state is a Symbol.for global keyed by id + dir + model source,
  // so this is the very state the hooks use and the test can read the claim a
  // spawn just took.
  const state = pool.state({ id, dir, modelsFile: PRESET, models: POOL })
  return {
    hooks,
    cfg,
    state,
    lines: stub.lines,
    /** Route a spawn, reporting a refusal rather than throwing it. */
    async trySpawn(subagent, callID) {
      const out = { args: { subagent_type: subagent, prompt: "x" } }
      try {
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s", callID }, out)
        return { ok: true, agent: out.args.subagent_type }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
    claim: (callID) => state.own.get(pool.claimKey("s", callID)),
    status: async () => (await hooks.tool.pool_status.execute({}, {})).output,
    text: () => stub.text().join("\n"),
  }
}

// opencode's own two filters for the "Available agent types" block that goes
// into the system prompt, modelled exactly as the runtime does it:
//
//   1. drop every agent whose `mode` is "primary"
//   2. drop every agent the CALLING agent's task permission denies
//
// `hidden` is NOT one of them. That flag is honoured by the TUI, the @-mention
// pickers, the "agent not found" message and default-agent resolution -- and by
// nothing else. A variant that is hidden but still a subagent is therefore
// listed to the model under its own name, and the model copies that name
// straight into its next spawn, where the pool now coerces it.
//
// Permission patterns compile to anchored regexes (* -> .*) and the LAST match
// wins; a name that matches no rule is "ask", not "deny".
const wildcard = (input, pattern) =>
  new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "s",
  ).test(input)

const taskAction = (caller, name) => {
  let action
  for (const [pattern, value] of Object.entries(caller?.permission?.task ?? {})) {
    if (wildcard(name, pattern)) action = value
  }
  return action
}

/** The agent names the model is shown, as opencode would compute them. */
const listedTo = (cfg, callerName) =>
  Object.entries(cfg.agent ?? {})
    .filter(([, def]) => def.mode !== "primary")
    .filter(([name]) => taskAction(cfg.agent?.[callerName], name) !== "deny")
    .map(([name]) => name)

test("[US-5] a hand-named slot variant is coerced to its base and routed by the pool", async () => {
  const t = await boot("gate-coerce")
  const cases = [
    ["explore-1", "explore"],
    ["explore-2", "explore"],
    ["implement-1", "implement"],
    ["context-2", "context"],
  ]
  for (const [variant, base] of cases) {
    const callID = `c-${variant}`
    const r = await t.trySpawn(variant, callID)
    assert.equal(r.ok, true, `${variant} must be coerced, not thrown: ${r.message ?? ""}`)
    assert.match(
      r.agent,
      new RegExp(`^${base}-[1-${pool.MAX_SLOTS}]$`),
      `${variant} must be routed to a real ${base} slot, got ${r.agent}`,
    )
    assert.ok(t.cfg.agent?.[r.agent], `${r.agent} must exist in the config, so it is a real pool slot`)
    // The routed slot is bound to a declared pool model, not left as the
    // hand-named variant.
    assert.ok(
      ["gate/a", "gate/b"].includes(t.cfg.agent[r.agent].model),
      `${r.agent} must be bound to a declared pool model, got ${t.cfg.agent[r.agent].model}`,
    )
    // Exactly one claim, for the base, on a real slot.
    const claim = t.claim(callID)
    assert.ok(claim, `${variant}: the routed spawn must take a claim`)
    assert.equal(claim.v, base, `${variant}: the claim must be for the base "${base}", not "${claim.v}"`)
    assert.ok(
      Number.isInteger(claim.k) && claim.k >= 1 && claim.k <= pool.MAX_SLOTS,
      `${variant}: claim slot ${claim.k} is not a valid pool slot`,
    )
  }
  assert.equal(t.state.own.size, cases.length, `one claim per routed spawn, got ${t.state.own.size}`)
  await t.hooks.dispose()
})

test("[US-5] repeating a hand-named variant fills slots in order", async () => {
  const t = await boot("gate-order")
  const routed = []
  for (let i = 1; i <= 5; i++) {
    const r = await t.trySpawn("explore-1", `rr${i}`)
    assert.equal(r.ok, true, `a coerced spawn must route: ${r.message ?? ""}`)
    routed.push(r.agent)
  }
  // Weights 3 and 2 make pass 1 fill slot 1 to 3 and slot 2 to 2. Naming the
  // same variant five times must still follow that ordered fill instead of
  // pinning one provider.
  assert.deepEqual(routed, ["explore-1", "explore-1", "explore-1", "explore-2", "explore-2"], `got ${routed}`)
  assert.equal(new Set(routed).size, 2, `a hand-named variant must not pin one slot: ${routed}`)
  const claims = routed.map((_, i) => t.claim(`rr${i + 1}`))
  assert.deepEqual(claims.map((claim) => claim.v), Array(5).fill("explore"), "every claim must be for the bare base")
  assert.deepEqual(claims.map((claim) => claim.k), [1, 1, 1, 2, 2], "the claims must follow the ordered fill's slots")
  await t.hooks.dispose()
})

test("[US-5] a bare base still routes, and costs exactly one claim", async () => {
  const t = await boot("gate-still-routes")
  // The coercion must not swallow the plugin's OWN rewrite: if tool.execute.before
  // were re-entered on the rewritten name, every routed spawn would double-claim.
  // Five spawns across a summed ceiling of five.
  const routed = []
  for (let i = 1; i <= 5; i++) {
    const r = await t.trySpawn("explore", `r${i}`)
    assert.equal(r.ok, true, `a bare base must route: ${r.message ?? ""}`)
    routed.push(r.agent)
  }
  assert.deepEqual(routed, ["explore-1", "explore-1", "explore-1", "explore-2", "explore-2"], `got ${routed}`)
  assert.match(await t.status(), /5 claim\(s\) in flight/, `one claim per spawn, got:\n${await t.status()}`)
  await t.hooks.dispose()
})

test("[US-5] an agent that merely looks like a variant is left alone", async () => {
  const t = await boot("gate-lookalikes")
  // The coercion must match the pool's OWN variant naming, not any name with a
  // trailing number. `explorex`, `task-3` and `context-manager` are not variants.
  for (const name of ["explorex", "task-3", "context-manager", "explore-0", "expert-1"]) {
    const r = await t.trySpawn(name, `l-${name}`)
    assert.equal(r.ok, true, `${name} is not a slot variant and must pass through, got: ${r.message ?? ""}`)
    assert.equal(r.agent, name, `${name} must be left exactly as asked`)
  }
  await t.hooks.dispose()
})

test("[US-5] the coercion is logged with the base, and never with the variant", async () => {
  const t = await boot("gate-logged")
  const cases = [
    ["explore-1", "explore"],
    ["implement-3", "implement"],
    ["context-2", "context"],
  ]
  for (const [variant] of cases) await t.trySpawn(variant, `log-${variant}`)
  const rewrites = t.lines.filter(
    (line) => line.level === "warn" && /rewrote a hand-named pool slot/.test(line.message),
  )
  assert.equal(rewrites.length, cases.length, `one coercion warning per spawn, got:\n${t.text()}`)
  const log = JSON.stringify(t.lines)
  for (const [variant, base] of cases) {
    const line = rewrites.find((entry) => entry.extra?.base === base)
    assert.ok(line, `the coercion must name the base "${base}", got:\n${t.text()}`)
    assert.ok(!line.message.includes(variant), `the warning message must not repeat "${variant}": ${line.message}`)
    assert.ok(!log.includes(variant), `the captured log must not carry "${variant}", got:\n${log}`)
  }
  await t.hooks.dispose()
})

test("[US-5] a slot variant is not in the agent list the model is shown, and the bare base is", async () => {
  const t = await boot("gate-invisible")
  // The coercion is correct: naming a variant is how a caller would pick the
  // provider and skip the ordered fill. But it should almost never happen, and the
  // reason it happened constantly is a leak, not a bad caller. opencode builds
  // the system prompt's agent list from the registry without reading `hidden`,
  // so every variant was listed to the model under its own name --
  // "explore-1: Hidden pool variant explore-1" -- and the model copied those
  // names into its next spawn. The variants are the OUTPUT of routing; a model
  // that can see them will use them, and the pool will coerce every one.
  //
  // `mode: "primary"` is the only field that filter respects, and it is safe:
  // the task tool resolves an agent by name and never reads its mode.
  const listed = listedTo(t.cfg, "build")
  const variants = Object.keys(t.cfg.agent ?? {}).filter((n) => /^(explore|implement|context)-\d+$/.test(n))
  assert.ok(variants.length > 0, "the config must carry the pooled variants, or this proves nothing")
  for (const variant of variants) {
    assert.ok(!listed.includes(variant), `${variant} must not be visible to the model, but it is`)
  }
  // The bases must remain visible, or nothing can be spawned at all.
  for (const base of ["explore", "implement"]) {
    assert.ok(listed.includes(base), `${base} must stay in the agent list the model is shown`)
  }
  // And the variant must stay hidden as well: `mode` alone would put it in the
  // TUI's primary picker and the @-mention list.
  for (const variant of variants) {
    assert.equal(t.cfg.agent[variant].hidden, true, `${variant} must stay hidden for the TUI and the mention pickers`)
  }
  await t.hooks.dispose()
})
