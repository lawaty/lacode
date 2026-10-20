// US-5 -- a slot variant named by hand cannot be used to reach a provider
// without asking the pool.
//
// This is the hole the counting behaviour left open: naming a variant skips the
// rotation AND the ceiling, so the damage is not that one slot takes an extra
// turn, it is that a slot bounded at twice its weight takes without limit. These
// tests pin the refusal, and pin the properties it must not break on the way:
// bare bases still route, a routed spawn still costs exactly one claim, and
// agents that merely LOOK like a variant are left alone.

import { test } from "node:test"
import assert from "node:assert/strict"
import { bootLaCode, cleanupAll, configFor, scratch, spawn, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const POOL = { slots: [{ model: "gate/a", weight: 3 }, { model: "gate/b", weight: 2 }] }

const boot = async (id) => {
  const stub = stubInput()
  const dir = scratch()
  const hooks = await bootLaCode(stub, { id, dir, models: POOL })
  const cfg = configFor(["gate/a", "gate/b"])
  await hooks.config(cfg)
  return {
    hooks,
    cfg,
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
// straight into its next spawn, where the pool refuses it.
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

test("[US-5] a hand-named slot variant is refused, and the refusal names the bare base", async () => {
  const t = await boot("gate-refuse")
  for (const variant of ["explore-1", "explore-2", "implement-1", "context-2"]) {
    const r = await t.trySpawn(variant, `c-${variant}`)
    assert.equal(r.ok, false, `${variant} must be refused`)
    assert.match(r.message, /cannot be spawned by name/, `${variant}: ${r.message}`)
    assert.match(r.message, /Spawn "(explore|implement|context)"/, `${variant} must point at the bare base, got: ${r.message}`)
  }
  await t.hooks.dispose()
})

test("[US-5] a refused variant leaves no claim behind, so the ceiling is untouched", async () => {
  const t = await boot("gate-no-claim")
  // Six refusals against a weight-3 slot whose ceiling is now 6 (twice the weight).
  // Before the refusal this recorded the claims anyway: the ceiling was counted and
  // then ignored.
  for (let i = 1; i <= 6; i++) await t.trySpawn("explore-1", `n${i}`)
  const status = await t.status()
  assert.match(status, /0 claim\(s\) in flight/, `a refused spawn must claim nothing, got:\n${status}`)
  assert.match(status, /gate\/a\s+load=0\/6/, `the slot must be untouched, got:\n${status}`)
  await t.hooks.dispose()
})

test("[US-5] a bare base still routes, and costs exactly one claim", async () => {
  const t = await boot("gate-still-routes")
  // The refusal must not swallow the plugin's OWN rewrite: if tool.execute.before
  // were re-entered on the rewritten name, every routed spawn would double-claim
  // or refuse itself. Five spawns across a summed ceiling of five.
  const routed = []
  for (let i = 1; i <= 5; i++) {
    const r = await t.trySpawn("explore", `r${i}`)
    assert.equal(r.ok, true, `a bare base must route, not be refused: ${r.message ?? ""}`)
    routed.push(r.agent)
  }
  assert.deepEqual(routed, ["explore-1", "explore-1", "explore-1", "explore-2", "explore-2"], `got ${routed}`)
  assert.match(await t.status(), /5 claim\(s\) in flight/, `one claim per spawn, got:\n${await t.status()}`)
  await t.hooks.dispose()
})

test("[US-5] an agent that merely looks like a variant is left alone", async () => {
  const t = await boot("gate-lookalikes")
  // The refusal must match the pool's OWN variant naming, not any name with a
  // trailing number. `explorex`, `task-3` and `context-manager` are not variants.
  for (const name of ["explorex", "task-3", "context-manager", "explore-0", "expert-1"]) {
    const r = await t.trySpawn(name, `l-${name}`)
    assert.equal(r.ok, true, `${name} is not a slot variant and must pass through, got: ${r.message ?? ""}`)
    assert.equal(r.agent, name, `${name} must be left exactly as asked`)
  }
  await t.hooks.dispose()
})

test("[US-5] the refusal is logged, so a blocked spawn is never silent", async () => {
  const t = await boot("gate-logged")
  await t.trySpawn("implement-1", "log-1")
  assert.match(t.text(), /refused manual spawn of a pool slot variant/, `got:\n${t.text()}`)
  await t.hooks.dispose()
})

test("[US-5] the refusal does not name the variant it refused", async () => {
  const t = await boot("gate-no-name")
  // The refusal is the TOOL RESULT the model reads at the moment it chooses
  // what to spawn next. If it repeats the name the model just used, the
  // refusal is the thing that TEACHES the name -- and a model that can see a
  // list of slot names will copy them straight back, which is how the pool
  // ended up refusing most of its spawns. Naming the BASE is enough to be
  // actionable, because the base is what the model should type.
  for (const variant of ["explore-1", "implement-3", "context-2"]) {
    const r = await t.trySpawn(variant, `n-${variant}`)
    assert.equal(r.ok, false, `${variant} must be refused`)
    assert.ok(!r.message.includes(variant), `the refusal must not repeat "${variant}": ${r.message}`)
    assert.match(r.message, /Spawn "(explore|implement|context)"/, `the refusal must point at the bare base: ${r.message}`)
  }
  const log = t.text()
  for (const variant of ["explore-1", "implement-3", "context-2"]) {
    assert.ok(!log.includes(variant), `the log must not carry "${variant}", got:\n${log}`)
  }
  await t.hooks.dispose()
})

test("[US-5] a slot variant is not in the agent list the model is shown, and the bare base is", async () => {
  const t = await boot("gate-invisible")
  // The refusal above is CORRECT: naming a variant is how a caller would pick
  // the provider and skip the rotation. But it should almost never happen, and
  // the reason it happened constantly is a leak, not a bad caller. opencode
  // builds the system prompt's agent list from the registry without reading
  // `hidden`, so every variant was listed to the model under its own name --
  // "explore-1: Hidden pool variant explore-1" -- and the model copied those
  // names into its next spawn. The variants are the OUTPUT of routing; a model
  // that can see them will use them, and the pool will refuse every one.
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
