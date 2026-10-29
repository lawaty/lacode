// Hang recovery, second pass -- the failures that let a stuck subagent outlive
// the mechanism that exists to kill it, and that let a live task lose its slot.
//
//   1. a live claim that runs past the TTL must keep its slot, or the shared
//      count under-reports and the slot is handed out again (oversubscription)
//   2. a kill that FAILS must not free the claim, or the zombie is orphaned
//      forever: the key is gone, so no later sweep can retry
//   3. a 200 carrying body "false" is a failure, not a success
//   4. a claim that never bound is not evidence the provider hung
//   5. a child created before its claim can still be bound at reap time
//
// Times are injected; nothing here sleeps for real time except the retry case,
// which needs one sweep to elapse and is driven by an explicit spawn.

import { test } from "node:test"
import assert from "node:assert/strict"
import { bootLaCode, cleanupAll, configFor, emit, fakeClock, scratch, spawn, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const MIN = 60_000
const STUCK_MIN_AGE = 5 * MIN
const STUCK_IDLE = 3 * MIN
const CLAIM_TTL = 10 * MIN

const TWO_SLOTS = { slots: [{ model: "orphan/a", weight: 2 }, { model: "orphan/b", weight: 1 }] }

const boot = async (id, options = {}) => {
  const stub = stubInput()
  const dir = scratch()
  const hooks = await bootLaCode(stub, { id, dir, models: TWO_SLOTS, ...options })
  const cfg = configFor(["orphan/a", "orphan/b"])
  await hooks.config(cfg)
  // The harness already captures every log line the plugin emits.
  const logs = () => stub.text().join("\n")
  return { hooks, cfg, logs, status: async () => (await hooks.tool.pool_status.execute({}, {})).output }
}

/** Aborts the pool asked for. `reply` decides how the server answers. */
const stubFetch = (reply = () => new Response("true", { status: 200 })) => {
  const aborted = []
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const match = /\/session\/([^/]+)\/abort/.exec(String(url))
    if (match) aborted.push(match[1])
    return reply(match?.[1])
  }
  return { aborted, restore: () => { globalThis.fetch = real } }
}

const spawnChild = async (t, { callID, sessionID = "parent", childID, agent = "explore" }) => {
  await spawn(t.hooks, t.cfg, { subagent: agent, callID, sessionID })
  await emit(t.hooks, "session.created", { info: { id: childID, parentID: sessionID } })
}
const keepAlive = (t, sessionID) => emit(t.hooks, "message.part.updated", { part: { sessionID, type: "text" } })

test("[US-9] a live claim keeps its slot past the TTL instead of being handed out twice", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const t = await boot("ttl-hold")

  await spawnChild(t, { callID: "c1", childID: "child-live-1" })
  await spawnChild(t, { callID: "c2", childID: "child-live-2" })
  assert(/load=2\/2/.test(await t.status()), `both claims should be counted, got:\n${await t.status()}`)

  // Well past the TTL, but both children keep producing output: they are alive.
  clock.advance(CLAIM_TTL + 2 * MIN)
  await keepAlive(t, "child-live-1")
  await keepAlive(t, "child-live-2")

  const status = await t.status()
  assert(/load=2\/2/.test(status), `a working task past the TTL must stay counted, got:\n${status}`)

  await spawn(t.hooks, t.cfg, { subagent: "explore", callID: "c3", sessionID: "parent" })
  const after = await t.status()
  assert(/orphan\/b/.test(after) || /slot 2/.test(after), `the full slot must push the next spawn to slot 2, got:\n${after}`)
  assert(net.aborted.length === 0, `nothing here is hung, got aborted=${JSON.stringify(net.aborted)}`)
  net.restore()
  await t.hooks.dispose()
})

test("[US-8] a kill that fails holds the claim instead of orphaning the session", async () => {
  const clock = fakeClock()
  const net = stubFetch(() => new Response("upstream exploded", { status: 500 }))
  const t = await boot("abort-fail")

  await spawnChild(t, { callID: "f1", childID: "child-zombie" })
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await spawn(t.hooks, t.cfg, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  const status = await t.status()
  assert(net.aborted.includes("child-zombie"), `the kill must be attempted, got ${JSON.stringify(net.aborted)}`)
  // Two claims are in flight: the zombie we could not kill, plus the trigger spawn
  // that drove the sweep. One would mean the zombie had been released to the pool.
  assert(/2 claim\(s\) in flight/.test(status), `a failed kill must RETAIN the claim, got:\n${status}`)
  assert(/could not abort/.test(t.logs()), `a failed kill must be reported, got:\n${t.logs()}`)
  assert(/no models cooling down/.test(status), `a kill we could not deliver must not cool the provider, got:\n${status}`)
  net.restore()
  await t.hooks.dispose()
})

test("[US-8] a 200 carrying body false is a failed kill, not a success", async () => {
  const clock = fakeClock()
  // The gateway answers 200 for an unknown session; only the body tells the truth.
  const net = stubFetch(() => new Response("false", { status: 200 }))
  const t = await boot("abort-lie")

  await spawnChild(t, { callID: "l1", childID: "child-liar" })
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await spawn(t.hooks, t.cfg, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  assert(/2 claim\(s\) in flight/.test(await t.status()), `body "false" must retain the claim, got:\n${await t.status()}`)
  assert(/server reported the session was not aborted/.test(t.logs()), `the reason must survive, got:\n${t.logs()}`)
  net.restore()
  await t.hooks.dispose()
})

test("[US-10] a claim that never bound is released without blaming the provider", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const t = await boot("unbound")

  await spawn(t.hooks, t.cfg, { subagent: "explore", callID: "u1", sessionID: "parent" })
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await spawn(t.hooks, t.cfg, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  const status = await t.status()
  // Only the trigger's own claim remains: the unbound one gave its slot back.
  assert(/1 claim\(s\) in flight/.test(status), `an unbound claim must give its slot back, got:\n${status}`)
  assert(/reaped total: 1/.test(status), `the unbound claim must be reaped, got:\n${status}`)
  assert(/no models cooling down/.test(status), `an unbound claim is not evidence the provider hung, got:\n${status}`)
  assert(net.aborted.length === 0, `there is no session to abort, got ${JSON.stringify(net.aborted)}`)
  assert(!/Infinity/.test(t.logs()), `silence must never be reported as Infinity, got:\n${t.logs()}`)
  net.restore()
  await t.hooks.dispose()
})

test("[US-8] a child created before its claim is still bound at reap time", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const t = await boot("late-bind")

  // session.created wins the race and arrives before the claim exists, so
  // bindChild has nothing to match and the claim stays unbound.
  await emit(t.hooks, "session.created", { info: { id: "child-early", parentID: "parent" } })
  await spawn(t.hooks, t.cfg, { subagent: "explore", callID: "e1", sessionID: "parent" })

  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await spawn(t.hooks, t.cfg, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  assert(net.aborted.includes("child-early"), `the late-bound child must be killed, got ${JSON.stringify(net.aborted)}`)
  net.restore()
  await t.hooks.dispose()
})