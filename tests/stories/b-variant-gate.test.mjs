// US-5 -- a slot variant named by hand cannot be used to reach a provider
// without asking the pool.
//
// This is the hole the counting behaviour left open: naming a variant skips the
// rotation AND the ceiling, so the damage is not that one slot takes an extra
// turn, it is that a slot bounded at three concurrent claims takes six. These
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
  // Six refusals against a weight-3 slot. Before the refusal this produced
  // load=6/3: the ceiling was recorded and then ignored.
  for (let i = 1; i <= 6; i++) await t.trySpawn("explore-1", `n${i}`)
  const status = await t.status()
  assert.match(status, /0 claim\(s\) in flight/, `a refused spawn must claim nothing, got:\n${status}`)
  assert.match(status, /gate\/a\s+load=0\/3/, `the slot must be untouched, got:\n${status}`)
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
  assert.match(t.text(), /refused manual spawn of slot variant implement-1/, `got:\n${t.text()}`)
  await t.hooks.dispose()
})