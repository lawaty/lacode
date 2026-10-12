// Epic C -- Hang detection and auto-recovery.
//
//   US-8  a wedged subagent is detected and aborted
//   US-9  the aborted slot returns to the pool without a restart
//   US-10 hangs are surfaced, never silent
//
// No suite here sleeps for real time. A hang is defined by two elapsed
// durations (STUCK_MIN_AGE_MS, STUCK_IDLE_MS) and both are read from Date.now(),
// so the clock is injected and minutes pass in microseconds. The one place a
// real timer is unavoidable -- proving the reaper's interval fires on its own --
// uses a 40 ms interval and a 150 ms wait, justified inline.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bootLaCode, cleanupAll, configFor, emit, fakeClock, scratch, spawn, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const MIN = 60_000
// The pool's own thresholds, restated as minutes so the scenario reads clearly.
// These are production defaults; a suite that restates them here is asserting
// that the shipped numbers still match the story, which is worth catching.
const STUCK_MIN_AGE = 5 * MIN
const STUCK_IDLE = 3 * MIN

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
 */
const spawnChild = async (hooks, cfg, { callID, sessionID = "parent", childID }) => {
  await spawn(hooks, cfg, { subagent: "explore", callID, sessionID })
  await emit(hooks, "session.created", { info: { id: childID, parentID: sessionID } })
}

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
// US-9 -- capacity recovers
// ---------------------------------------------------------------------------

test("[US-9] a reaped claim's capacity is available to the next routing decision", async () => {
  const clock = fakeClock()
  const net = stubFetch()
  const { hooks, cfg } = await bootPool("us9-recover")

  // Fill the only slot to its ceiling of 2, then wedge both claims.
  await spawnChild(hooks, cfg, { callID: "a", childID: "w1" })
  await spawnChild(hooks, cfg, { callID: "b", childID: "w2" })
  const full = await hooks.tool.pool_status.execute({}, {})
  assert.match(full.output, /load=2\/2/, `control: the slot is full:\n${full.output}`)

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