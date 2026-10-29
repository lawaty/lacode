// Epic C -- Hang detection and auto-recovery.
//
//   US-8  a wedged subagent is detected and aborted
//   US-9  the aborted slot returns to the pool without a restart
//   US-10 hangs are surfaced, never silent
//   US-31 a stall with no limit signal is killed, cooled and re-routed
//
// No suite here sleeps for real time. A hang is defined by two elapsed
// durations (STUCK_MIN_AGE_MS, STUCK_IDLE_MS) and both are read from Date.now(),
// so the clock is injected and minutes pass in microseconds. The one place a
// real timer is unavoidable -- proving the reaper's interval fires on its own --
// uses a 40 ms interval and a 150 ms wait, justified inline.
//
// A third duration bounds the whole thing: MAX_CLAIM_AGE_MS. The other two are
// silence-based, and silence is resettable by any message event, so a task that
// hangs while still trickling output resets the clock every time it emits and can
// therefore never be condemned -- it outlives the mechanism meant to kill it. The
// tests below pin both halves of the replacement rule: chatty and past the
// ceiling is killed, chatty and under it is not.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as pool from "../../src/lib/pool.ts"
import { bootLaCode, cleanupAll, configFor, emit, fakeClock, scratch, spawn, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const MIN = 60_000
// The pool's own thresholds, restated as minutes so the scenario reads clearly.
// These are production defaults; a suite that restates them here is asserting
// that the shipped numbers still match the story, which is worth catching.
const STUCK_MIN_AGE = 5 * MIN
const STUCK_IDLE = 3 * MIN
const MAX_CLAIM_AGE = 30 * MIN

const bootPool = async (id, options = {}) => {
  const stub = stubInput()
  const dir = scratch()
  const hooks = await bootLaCode(stub, { id, dir, models: { slots: [{ model: "hang/model", weight: 2 }] }, ...options })
  const cfg = configFor(["hang/model"])
  await hooks.config(cfg)
  return { stub, dir, hooks, cfg }
}

/** Aborts the pool asked the server for, via the abort URL it POSTs. */
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
 * Without the bind, the claim has no target and can never be judged idle.
 *
 * The routing decision is returned: a test that wants to know WHICH slot the
 * work went to needs it, and reading it back off the log would be a guess.
 */
const spawnChild = async (hooks, cfg, { callID, sessionID = "parent", childID }) => {
  const routed = await spawn(hooks, cfg, { subagent: "explore", callID, sessionID })
  await emit(hooks, "session.created", { info: { id: childID, parentID: sessionID } })
  return routed
}

/**
 * A config whose variant agents EXIST, so the config hook binds the pool's
 * models to them and a routing decision can be read back as a model and not
 * only as a slot name. The pool numbers its slots by position, so the Nth
 * model is slot N.
 */
const configWithVariants = (models) => {
  const cfg = configFor(models)
  cfg.agent = {}
  models.forEach((_, index) => {
    for (const base of pool.BASES) cfg.agent[pool.agentFor(base, index + 1)] = {}
  })
  return cfg
}

/** The cooldown file a model is benched under, in the pool's own naming. */
const limitFile = (dir, model) => join(dir, `limit.${model.replace(/[^a-zA-Z0-9._-]/g, "__")}.json`)

/**
 * One message event for a child session. That is the whole of "proof of life":
 * it resets the silence clock, and it is the reason a hung-but-chatty task used
 * to be unkillable. The ceiling tests below use it to make the child look, at
 * every sweep, like the healthiest task in the pool.
 */
const keepAlive = (hooks, sessionID) => emit(hooks, "message.part.updated", { part: { sessionID, type: "text" } })

// ---------------------------------------------------------------------------
// US-8 -- detection and abort
// ---------------------------------------------------------------------------

test("[US-8] a claim past its TTL with no activity is aborted when the reaper sweeps", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us8-reap")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-wedged" })
  assert.equal(net.aborted.length, 0, "a fresh claim is not a hang")

  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  // Any pooled spawn sweeps before it routes, so the reaper needs no timer.
  await spawn(hooks, { agent: {} }, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  assert.deepEqual(net.aborted, ["child-wedged"], `the wedged session must be aborted, got ${JSON.stringify(net.aborted)}`)
  net.restore()
  await hooks.dispose()
})

test("[US-8] the reaper sweeps on its own interval, not only when work arrives", async () => {
  // The one real timer in the suite. reapMs=40 keeps it at 40ms and the wait is
  // 150ms: long enough for three ticks on a loaded machine, short enough that the
  // suite stays fast. Nothing here waits 30 seconds to prove a 30s interval.
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us8-timer", { reapMs: 40 })

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-lonely" })
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.deepEqual(net.aborted, ["child-lonely"], `the timer must sweep unattended, got ${JSON.stringify(net.aborted)}`)
  net.restore()
  await hooks.dispose()
})

test("[US-8] a young and active claim is left alone", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us8-alive")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-busy" })
  clock.advance(STUCK_IDLE * 2)
  // Still producing output: message traffic is proof of life.
  await emit(hooks, "message.part.updated", { part: { sessionID: "child-busy", type: "text" } })
  await spawn(hooks, { agent: {} }, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  assert.deepEqual(net.aborted, [], "a working subagent must never be killed")
  net.restore()
  await hooks.dispose()
})

test("[US-8] a claim too young to be hung is left alone even when silent", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us8-young")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-new" })
  clock.advance(STUCK_MIN_AGE - MIN) // silent, but not old enough to be a hang
  await spawn(hooks, { agent: {} }, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  assert.deepEqual(net.aborted, [], "age alone must not condemn a young claim")
  net.restore()
  await hooks.dispose()
})

test("[US-8] a swept claim raises the reaped total and is named in a greppable log line", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks, stub } = await bootPool("us8-count")

  const before = await hooks.tool.pool_status.execute({}, {})
  assert.match(before.output, /reaped total: 0/, `control: nothing reaped yet:\n${before.output}`)

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-gone" })
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await spawn(hooks, { agent: {} }, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  const after = await hooks.tool.pool_status.execute({}, {})
  assert.match(after.output, /reaped total: 1/, `the reaped count must increase:\n${after.output}`)
  assert.ok(
    stub.text().some((line) => /^warn hung \S+ on hang\/model after \d+s/.test(line)),
    `a greppable line must name the hang:\n${stub.text().join("\n")}`,
  )
  net.restore()
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-8 -- the ceiling, which is what condemns a task that is never silent
// ---------------------------------------------------------------------------

test("[US-8] a claim that keeps emitting output is still reaped once it outlives the ceiling", async () => {
  // The bug this exists for. Every 60s the child emits something, so the silence
  // clock is reset 31 times and never once reaches STUCK_IDLE: at every sweep
  // this task looks exactly like the "working subagent must never be killed"
  // case above. Observed live, a claim's silence fell from 122.5s to 3.2s on one
  // stray delta and the kill slid out three more minutes. Silence is resettable,
  // so it cannot be the only bound; MAX_CLAIM_AGE_MS is.
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us8-overran")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-endless" })
  for (let minute = 1; minute <= MAX_CLAIM_AGE / MIN + 1; minute++) {
    clock.advance(MIN)
    await keepAlive(hooks, "child-endless")
    // Control, one minute short of the ceiling: nothing has condemned it yet.
    if (minute === MAX_CLAIM_AGE / MIN - 1) {
      await spawn(hooks, { agent: {} }, { subagent: "explore", callID: `under-${minute}`, sessionID: `under-${minute}` })
      assert.deepEqual(net.aborted, [], `a chatty claim under the ceiling must live, got ${JSON.stringify(net.aborted)}`)
      await hooks["tool.execute.after"]({ tool: "task", sessionID: `under-${minute}`, callID: `under-${minute}` }, {})
    }
  }

  await spawn(hooks, { agent: {} }, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  assert.deepEqual(
    net.aborted,
    ["child-endless"],
    `a task past the ceiling must be killed however much it talks, got ${JSON.stringify(net.aborted)}`,
  )
  net.restore()
  await hooks.dispose()
})

test("[US-8] a chatty claim under the ceiling keeps its slot for as long as it takes", async () => {
  // The other half, and the one that must not be broken by fixing the first: the
  // ceiling is a bound on LIFE, not a new deadline. A task that is young enough
  // and demonstrably alive is untouched however much it emits.
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us8-under-ceiling")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-prolific" })
  for (let minute = 1; minute < MAX_CLAIM_AGE / MIN; minute++) {
    clock.advance(MIN)
    await keepAlive(hooks, "child-prolific")
  }
  // 29 minutes old and never silent for three: a sweep must pass it by.
  await spawn(hooks, { agent: {} }, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  assert.deepEqual(net.aborted, [], `a working subagent must not be killed for being busy, got ${JSON.stringify(net.aborted)}`)
  const reaped = await hooks.tool.pool_status.execute({}, {})
  assert.match(reaped.output, /hung past \d+min with \d+min silence: 0/, `a busy task is not hung:\n${reaped.output}`)

  // Releasing the sweep trigger leaves only the claim that survived, which is the
  // claim under test -- if the ceiling had taken it, the pool would be empty.
  await hooks["tool.execute.after"]({ tool: "task", sessionID: "trigger", callID: "trigger" }, {})
  const after = await hooks.tool.pool_status.execute({}, {})
  assert.match(after.output, /1 claim\(s\) in flight/, `the working task must still hold its claim:\n${after.output}`)
  net.restore()
  await hooks.dispose()
})

test("[US-8] findStuck names the fault it condemned on: overran at the ceiling, hung on silence", async () => {
  // The unit behind the wording above, asserted directly so a caller cannot
  // regress into guessing. findStuck takes `now`, so no clock is faked at all.
  const s = pool.state({ id: "us8-reason", dir: scratch("lacode-reason-") })
  const t0 = 1_700_000_000_000
  const now = t0 + MAX_CLAIM_AGE + MIN

  // Past the ceiling, and seen talking a moment ago: silence cannot condemn it,
  // so if it is condemned at all it can only be for outliving the ceiling.
  s.own.set("overran", { v: "explore", k: 1, m: "hang/model", t: t0, g: "child-overran" })
  s.activity.set("child-overran", now)
  // Inside the ceiling but silent for exactly STUCK_IDLE: the ordinary hang.
  s.own.set("hung", { v: "explore", k: 1, m: "hang/model", t: now - STUCK_MIN_AGE - MIN, g: "child-hung" })
  s.activity.set("child-hung", now - STUCK_IDLE)
  // Inside the ceiling, young enough to be under STUCK_MIN_AGE, and silent: not
  // a hang, and nowhere near the ceiling.
  s.own.set("young", { v: "explore", k: 1, m: "hang/model", t: now - MIN, g: "child-young" })
  s.activity.set("child-young", now - STUCK_IDLE)

  const stuck = pool.findStuck(s, now)
  const reasons = Object.fromEntries(stuck.map((entry) => [entry.key, entry.reason]))

  assert.deepEqual(reasons, { overran: "overran", hung: "hung" }, `each fault must be named:\n${JSON.stringify(stuck)}`)
  assert.ok(!("young" in reasons), `age alone must still not condemn a young claim, got ${JSON.stringify(stuck)}`)
  // And the ceiling is checked FIRST, so a claim that is both old and silent is
  // reported for what actually stopped it rather than for the stale clue.
  assert.deepEqual(pool.findStuck(s, now + MIN).map((e) => e.reason), ["overran", "hung"], `reasons must not drift:\n${JSON.stringify(stuck)}`)
})

test("[US-9] the per-session maps are pruned, so a long-running server stays bounded", async () => {
  // The leak this exists for: `activity` and `children` were written on every
  // message event and every session.created and never removed, so a server
  // accumulated one entry per session it had ever seen for the life of the process.
  // pruneSessions() (called by the reaper and by snapshot) must drop the dead ones
  // while keeping everything a live claim still needs.
  const s = pool.state({ id: "prune-sessions", dir: scratch("lacode-prune-") })
  const now = Date.now()
  const staleActivity = now - 20 * MIN // past CLAIM_TTL (10m)
  const staleChild = now - 40 * MIN // past CHILD_MEMORY (30m)

  // A live claim's target keeps its activity however old the last event was.
  s.own.set("live", { v: "explore", k: 1, m: "hang/model", t: now, g: "child-live" })
  s.activity.set("child-live", staleActivity)
  // No live claim points at this one: dead weight, to be dropped.
  s.activity.set("child-orphan", staleActivity)

  s.children.set("parent-live", [{ id: "child-live", t: now }])
  s.children.set("parent-stale", [{ id: "child-stale", t: staleChild }])

  pool.pruneSessions(s)

  assert.ok(s.activity.has("child-live"), "a live claim's target must be kept")
  assert.ok(!s.activity.has("child-orphan"), "an activity entry nothing references must be dropped")
  assert.ok(s.children.has("parent-live"), "a parent with a recent child must be kept")
  assert.ok(!s.children.has("parent-stale"), "a parent with only expired children must be dropped")
})

// ---------------------------------------------------------------------------
// US-9 -- capacity recovers
// ---------------------------------------------------------------------------

test("[US-9] a reaped claim's capacity is available to the next routing decision", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks, cfg } = await bootPool("us9-recover")

  // Fill the only slot to its doubled ceiling of 4, then wedge both claims.
  await spawnChild(hooks, cfg, { callID: "a", childID: "w1" })
  await spawnChild(hooks, cfg, { callID: "b", childID: "w2" })
  const full = await hooks.tool.pool_status.execute({}, {})
  assert.match(full.output, /load=2\/2/, `control: the slot is filling:\n${full.output}`)

  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await spawn(hooks, cfg, { subagent: "explore", callID: "trigger", sessionID: "trigger" })
  // Release the sweep trigger itself, so what remains on the slot is only
  // whatever failed to be reaped.
  await hooks["tool.execute.after"]({ tool: "task", sessionID: "trigger", callID: "trigger" }, {})

  const after = await hooks.tool.pool_status.execute({}, {})
  assert.match(after.output, /load=0\/2/, `both wedged claims must be gone in the same process:\n${after.output}`)
  assert.match(after.output, /\[idle[;\]]/, `the slot must carry nothing:\n${after.output}`)
  assert.match(after.output, /0 claim\(s\) in flight/, `the slot must be free again:\n${after.output}`)

  // And routing still works with no restart, no manual step. The model is
  // cooled by the hang, and the pool must degrade to routing anyway.
  const { routed } = await spawn(hooks, cfg, { callID: "next", sessionID: "next" })
  assert.equal(routed, "explore-1", "routing must resume immediately after a sweep")
  net.restore()
  await hooks.dispose()
})

test("[US-9] a claim file whose process is gone is pruned as dead and its capacity returned", async () => {
  const { dir, hooks } = await bootPool("us9-dead")
  const dead = join(dir, "claims.dead-process.json")
  writeFileSync(
    dead,
    JSON.stringify({ x: { v: "explore", k: 1, m: "hang/model", t: Date.now() } }),
  )
  const ancient = new Date(Date.now() - 3 * 60 * 60 * 1000)
  utimesSync(dead, ancient, ancient)

  const status = await hooks.tool.pool_status.execute({}, {})
  assert.ok(!existsSync(dead), "a dead process's claim file must be pruned from disk")
  assert.doesNotMatch(status.output, /dead-process/, `dead capacity must not be counted:\n${status.output}`)
  assert.match(status.output, /0 claim\(s\) in flight/, `the slot must be free again:\n${status.output}`)
  await hooks.dispose()
})

test("[US-9] an orphaned temporary claim file is cleaned up rather than counted", async () => {
  const { dir, hooks } = await bootPool("us9-orphan")
  const orphan = join(dir, "claims.interrupted.json.tmp")
  writeFileSync(orphan, '{"partial":true}')
  const old = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(orphan, old, old)

  await hooks.tool.pool_status.execute({}, {})
  assert.ok(!existsSync(orphan), "a half-written claim file must be removed, not read")

  // A fresh orphan belongs to a write in flight and is left alone; the point is
  // that neither one is ever counted as load.
  const fresh = join(dir, "claims.inflight.json.tmp")
  writeFileSync(fresh, '{"partial":true}')
  const status = await hooks.tool.pool_status.execute({}, {})
  assert.match(status.output, /0 claim\(s\) in flight/, `a .tmp is never load:\n${status.output}`)
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp.json")), `no .tmp may be parsed as a claim: ${readdirSync(dir)}`)
  await hooks.dispose()
})

test("[US-9] routing resumes after a sweep with no restart and no manual intervention", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks, cfg } = await bootPool("us9-resume")

  await spawnChild(hooks, cfg, { callID: "a", childID: "stuck" })
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await spawn(hooks, cfg, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  // No dispose, no re-boot: the same hooks object keeps routing.
  const routed = []
  for (let i = 0; i < 3; i++) {
    routed.push((await spawn(hooks, cfg, { subagent: "implement", callID: `r${i}`, sessionID: `r${i}` })).routed)
  }
  for (const variant of routed) assert.match(variant, /^implement-1$/, `routing must resume: ${routed}`)
  net.restore()
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-10 -- surfaced, not silent
// ---------------------------------------------------------------------------

test("[US-10] the reaper log names the reaped session and why it was reaped", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks, stub } = await bootPool("us10-log")
  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "victim" })
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  await spawn(hooks, { agent: {} }, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  const line = stub.text().find((l) => l.startsWith("warn hung"))
  assert.ok(line, `the hang must be logged, not silent:\n${stub.text().join("\n")}`)
  assert.match(line, /victim/, `the session must be named: ${line}`)
  assert.match(line, /aborted session victim/, `the abort must be reported: ${line}`)
  // The reason, in the words an operator would grep for.
  assert.match(line, /with \d+s of silence/, `the reason must be stated: ${line}`)
  assert.match(line, /^warn hung \S+ on hang\/model after \d+s/, `the model and elapsed time must be stated: ${line}`)
  net.restore()
  await hooks.dispose()
})

test("[US-10] a claim killed at the ceiling is reported as 'overran', never as a hang", async () => {
  // The same line has to mean two different things depending on which fault
  // stopped the task, because the operator reads it to find out why their agent
  // disappeared. Calling a ceiling kill a "hang" would claim the task had gone
  // silent -- the precise opposite of why it died, and the one thing an operator
  // would go looking for is the silence that never happened.
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks, stub } = await bootPool("us10-overran")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "victim-overran" })
  for (let minute = 1; minute <= MAX_CLAIM_AGE / MIN + 1; minute++) {
    clock.advance(MIN)
    await keepAlive(hooks, "victim-overran")
  }
  await spawn(hooks, { agent: {} }, { subagent: "explore", callID: "trigger", sessionID: "trigger" })

  const killed = stub.text().filter((l) => l.includes("aborted session"))
  assert.equal(killed.length, 1, `exactly one reaped session:\n${stub.text().join("\n")}`)
  assert.match(
    killed[0],
    /^warn overran explore on hang\/model after \d+s; aborted session victim-overran$/,
    `the ceiling must be named in the line:\n${killed[0]}`,
  )
  assert.doesNotMatch(killed[0], /silence/, `a task killed while it was still talking must not be reported as silent: ${killed[0]}`)
  assert.ok(
    !stub.text().some((l) => l.startsWith("warn hung ")),
    `the ceiling must not borrow the hang wording:\n${stub.text().join("\n")}`,
  )
  // The model is cooled exactly as for a hang -- an overrun still tells you
  // something about the slot it was on, so the behaviour is deliberately shared.
  const status = await hooks.tool.pool_status.execute({}, {})
  assert.match(status.output, /cooling:.*hang\/model/, `an overrun must cool like a hang:\n${status.output}`)
  net.restore()
  await hooks.dispose()
})

test("[US-10] pool_status reports an overran claim the reaper would condemn, not a healthy one", async () => {
  // The bug this pins: pool_status recomputed the hang condition inline and knew
  // nothing about the ceiling, so a claim 40 minutes old and still emitting was
  // reported as not-hung while the reaper was about to kill it. The status must
  // judge a claim with the reaper's own rule, not a restatement of it.
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us10-status-overran")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-chatty" })
  for (let minute = 1; minute <= MAX_CLAIM_AGE / MIN + 1; minute++) {
    clock.advance(MIN)
    await keepAlive(hooks, "child-chatty")
  }

  // Status only: no sweep has run, so the claim is still held and the status is
  // the only thing that can report it. It must not call this healthy.
  const status = await hooks.tool.pool_status.execute({}, {})
  assert.match(status.output, /overran past 30min: 1 \(auto-aborted\)/, `the status must agree with the reaper:\n${status.output}`)
  assert.match(status.output, /hung past 5min with 3min silence: 0/, `an overrun is not a hang:\n${status.output}`)
  net.restore()
  await hooks.dispose()
})

test("[US-10] pool_status still reports a silent, aged claim with the hung wording", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us10-status-hung")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-silent" })
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)

  const status = await hooks.tool.pool_status.execute({}, {})
  assert.match(status.output, /hung past 5min with 3min silence: 1 \(auto-aborted\)/, `the existing hung wording must survive:\n${status.output}`)
  assert.match(status.output, /overran past 30min: 0 \(auto-aborted\)/, `a silent claim under the ceiling is not overran:\n${status.output}`)
  net.restore()
  await hooks.dispose()
})

test("[US-10] pool_status reports a young, active claim as not hung", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks } = await bootPool("us10-status-alive")

  await spawnChild(hooks, { agent: {} }, { callID: "c1", childID: "child-busy" })
  clock.advance(2 * MIN)
  await keepAlive(hooks, "child-busy")

  const status = await hooks.tool.pool_status.execute({}, {})
  assert.match(status.output, /hung past 5min with 3min silence: 0/, `a working claim is not hung:\n${status.output}`)
  assert.match(status.output, /overran past 30min: 0/, `a young claim is not overran:\n${status.output}`)
  net.restore()
  await hooks.dispose()
})

test("[US-10] arming the reaper is recorded once, with its interval", async () => {
  const { hooks, stub } = await bootPool("us10-armed", { reapMs: 45_000 })
  const armed = stub.text().filter((line) => line.includes("reaper armed"))
  assert.equal(armed.length, 1, `exactly one armed line, got:\n${stub.text().join("\n")}`)
  assert.match(armed[0], /^info reaper armed: every 45s/, `the interval must be stated: ${armed[0]}`)
  // And it states what it will actually do, so the thresholds are greppable too.
  assert.match(armed[0], /older than 5m/, `the age threshold must be stated: ${armed[0]}`)
  assert.match(armed[0], /silent 3m/, `the silence threshold must be stated: ${armed[0]}`)
  await hooks.dispose()
})

test("[US-10] a failure inside the sweep is reported through the app log and never thrown out of the hook", async () => {
  const { hooks, stub } = await bootPool("us10-fail")
  // The clock is the injectable seam, so it is also the injection point. The
  // sweep reads Date.now() once for its own bookkeeping before the try and then
  // again inside findStuck; failing from the second read on puts the throw
  // inside the handler this criterion is actually about.
  const real = Date.now
  let calls = 0
  Date.now = () => {
    calls++
    if (calls >= 2) throw new Error("clock exploded")
    return real()
  }
  try {
    const out = { args: { subagent_type: "explore", prompt: "x" } }
    // The hook must RESOLVE. A rejection here would take down opencode's hook
    // dispatch, which is the failure mode the criterion forbids.
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "s", callID: "c" }, out)
  } finally {
    Date.now = real
  }
  const text = stub.text()
  assert.ok(
    text.some((line) => line.startsWith("error reaper failed:") && line.includes("clock exploded")),
    `the internal failure must be reported through the app log, not swallowed:\n${text.join("\n")}`,
  )
  await hooks.dispose()
})

test("[US-10] a failure before the sweep's try block still never escapes the hook", async () => {
  // The reaper stamps its last-sweep time before entering its try. A throw there
  // rejects reapStuck rather than being caught by the reaper's own handler, so
  // the guarantee that matters is the one the CALLER provides: the hook resolves
  // and the failure reaches the log.
  const { hooks, stub } = await bootPool("us10-preamble")
  const real = Date.now
  Date.now = () => {
    throw new Error("clock exploded early")
  }
  try {
    const out = { args: { subagent_type: "explore", prompt: "x" } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "s", callID: "c" }, out)
  } finally {
    Date.now = real
  }
  assert.ok(
    stub.text().some((line) => line.startsWith("error") && line.includes("clock exploded early")),
    `the failure must reach the app log:\n${stub.text().join("\n")}`,
  )
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-31 -- a stall with no limit signal at all
// ---------------------------------------------------------------------------

test("[US-31] a session that stalls with no limit signal is killed, cooled and re-routed", async () => {
  // The Epic C half of US-31. A provider that has run out of allowance does not
  // always say so: sometimes it accepts the request and then says nothing, and
  // opencode keeps retrying the refused model. No error, no limit status, no log
  // line -- so the limit paths have nothing to act on and only the watchdog can
  // end the wait. It has to end it itself: abort the session, cool the model,
  // and let the next spawn land on a slot that still answers.
  //
  // Two slots on DIFFERENT providers, so cooling one model cannot bench the
  // other. prov/one carries weight 2, which makes the rotation's run [1,1,2]:
  // the turn after the first spawn comes BACK to prov/one, so only the
  // cooldown can move the retry off it. With equal weights the retry would
  // land on the other slot anyway, and the cooldown would prove nothing.
  const clock = fakeClock()
  const net = stubFetch()
  const slots = [
    { model: "prov/one", weight: 2 },
    { model: "other/two", weight: 1 },
  ]
  const { hooks, dir, stub } = await bootPool("us31-silent", { reapMs: 40, models: { slots } })
  const cfg = configWithVariants(slots.map((s) => s.model))
  await hooks.config(cfg)

  // The spawn that wedges: routed to prov/one, and bound to a child session so
  // the reaper has a session to aim at.
  const first = await spawnChild(hooks, cfg, { callID: "c1", childID: "child-silent" })
  assert.equal(first.model, "prov/one", `control: the first spawn must land on prov/one, got ${first.model}`)

  // No limit signal ever arrives: the provider simply stops answering. The
  // claim is now older than STUCK_MIN_AGE and silent for longer than
  // STUCK_IDLE, which is the whole condemn rule.
  clock.advance(STUCK_MIN_AGE + STUCK_IDLE + MIN)
  // The one real timer in the suite: reapMs=40, and a 150ms wait is long
  // enough for the reaper to sweep on its own.
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.deepEqual(
    net.aborted,
    ["child-silent"],
    `the silent session must be aborted, got ${JSON.stringify(net.aborted)}`,
  )
  // Silence is the fault here: the reaper must report it as a hang, and name
  // the model it benched.
  assert.ok(
    stub.text().some((line) => /^warn hung explore on prov\/one after \d+s with \d+s of silence/.test(line)),
    `the stall must be reported as silence on the model:\n${stub.text().join("\n")}`,
  )

  // The model is cooled, so the cooldown file is written and the slot benched.
  const cooled = limitFile(dir, "prov/one")
  assert.ok(existsSync(cooled), `a cooldown file must be written, got: ${readdirSync(dir).join(", ")}`)

  // And the retry lands on the OTHER slot: the rotation's next turn was
  // prov/one again, so only the cooldown moved it.
  const retry = await spawn(hooks, cfg, { subagent: "explore", callID: "next", sessionID: "next" })
  assert.notEqual(retry.routed, first.routed, `the retry must leave the cooled slot, got ${retry.routed}`)
  assert.notEqual(retry.model, first.model, `the retry must not use the cooled model ${first.model}, got ${retry.model}`)
  net.restore()
  await hooks.dispose()
})
