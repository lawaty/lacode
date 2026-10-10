// Epic D -- Notifications for parallel sessions.
//
//   US-11  a desktop notification when a session finishes or errors
//   US-12  a notification when a question is asked
//
// Delivery is INJECTED. src/plugins/notify.ts takes an optional third argument,
// a `deliver` seam, and this suite supplies a recording sender. Nothing here
// spawns a helper, touches a desktop daemon, opens an SSH hop, or waits: the
// tests observe that a notification WOULD be delivered, which is the only part
// of the contract that is a decision rather than a pipe.
//
// One test deliberately does NOT use the seam (US-11, delivery failure): it
// points OC_NOTIFY_HELPER at a script that exits non-zero, so the real spawn
// path and its exit-code handling are exercised for real.

import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, cleanupAll, scratch, settle, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const { notifyHooks } = await import(join(ROOT, "src", "plugins", "notify.ts"))

/**
 * A notifier wired to a recording sender.
 *
 * `sent` is the list a real desktop would have received; `result` controls what
 * the sender reports back, so the "delivery failed vs delivered" bookkeeping is
 * observable too.
 */
const notifier = async ({ sessions = {}, result = { ok: true } } = {}) => {
  const stub = stubInput({ sessions })
  const sent = []
  const hooks = await notifyHooks(
    stub.input,
    undefined,
    {
      deliver: async (title, message, urgency) => {
        sent.push({ title, message, urgency })
        return typeof result === "function" ? result() : result
      },
    },
  )
  return { stub, sent, hooks, emit: (type, properties) => hooks.event({ event: { type, properties } }) }
}

const busy = (emit, sessionID) => emit("session.status", { sessionID, status: { type: "busy" } })
const idle = (emit, sessionID) => emit("session.idle", { sessionID })

// ---------------------------------------------------------------------------
// US-11 -- a session finishing
// ---------------------------------------------------------------------------

test("[US-11] a session that went busy and is now idle delivers a done notification", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Fix the login redirect" } } })
  await busy(emit, "s1")
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 1, `exactly one notification, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].title, /Fix the login redirect/, "the notification must name the session")
  assert.match(sent[0].message, /finished/i, "the message must say the turn is done")
  assert.equal(sent[0].urgency, "normal", "a routine completion must not escalate to a modal")
})

test("[US-11] an error is delivered and bypasses the duplicate-suppression cooldown", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Build the API" } } })
  await busy(emit, "s1")
  // Two errors inside the 5s cooldown window. A cooldown would swallow the
  // second, and a user who never learns the run failed is the exact harm.
  await emit("session.error", { sessionID: "s1" })
  await emit("session.error", { sessionID: "s1" })
  await settle()

  assert.equal(sent.length, 2, `both errors must be announced, got ${JSON.stringify(sent)}`)
  for (const notice of sent) {
    assert.match(notice.message, /Failed/i, `an error notification must say so: ${notice.message}`)
    assert.equal(notice.urgency, "critical", "a failure is the one thing worth interrupting for")
  }
})

test("[US-11] a session that never went busy delivers nothing when it idles", async () => {
  // A session that was created and immediately idled is an empty shell. Notifying
  // for it trains the user to dismiss notifications without reading them.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "scratch" } } })
  await idle(emit, "s1")
  await settle()
  assert.deepEqual(sent, [], "an empty session must not announce finished work")
})

test("[US-11] a subagent session and a cartographer session are both suppressed", async () => {
  const child = await notifier({ sessions: { c1: { id: "c1", parentID: "root", title: "explore-fast" } } })
  await busy(child.emit, "c1")
  await idle(child.emit, "c1")
  await settle()
  assert.deepEqual(child.sent, [], "a subagent going idle is not a thing the user asked for")

  // The cartographer is spawned with no parentID, so structure alone cannot
  // exclude it; it is identified by its title prefix.
  const cartographer = await notifier({ sessions: { m1: { id: "m1", title: "context-manager (auto update)" } } })
  await busy(cartographer.emit, "m1")
  await idle(cartographer.emit, "m1")
  await settle()
  assert.deepEqual(cartographer.sent, [], "the cartographer's own bookkeeping is not finished work")
})

test("[US-11] a helper that exits non-zero is reported as a failed delivery, not as sent", async () => {
  // No seam here on purpose: this drives the REAL spawn path and its exit-code
  // handling, because the bug this guards against was a log line reading
  // "notified" while nothing reached the desktop.
  const bin = scratch("failing-helper-")
  const helper = join(bin, "oc-notify")
  writeFileSync(helper, "#!/bin/sh\nexit 1\n")
  chmodSync(helper, 0o755)
  const previous = process.env.OC_NOTIFY_HELPER
  process.env.OC_NOTIFY_HELPER = helper
  try {
    const stub = stubInput({ sessions: { s1: { id: "s1", title: "Something" } } })
    const hooks = await notifyHooks(stub.input)
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    await settle(120)

    const text = stub.text()
    assert.ok(text.some((line) => line.startsWith("error notification failed")), `a failed send must not be logged as sent:\n${text.join("\n")}`)
    assert.ok(!text.some((line) => line.startsWith("info notified")), `claiming "notified" on a failed send is the bug:\n${text.join("\n")}`)
  } finally {
    if (previous === undefined) delete process.env.OC_NOTIFY_HELPER
    else process.env.OC_NOTIFY_HELPER = previous
  }
})

test("[US-11] a sender that reports failure is never recorded as a delivery", async () => {
  const { stub, sent, emit } = await notifier({
    sessions: { s1: { id: "s1", title: "Something" } },
    result: { ok: false, detail: "helper exit 1" },
  })
  await busy(emit, "s1")
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 1, "the notification was attempted")
  const text = stub.text()
  assert.ok(text.some((line) => line.startsWith("error notification failed")), `must be reported as failed:\n${text.join("\n")}`)
  assert.ok(!text.some((line) => line.startsWith("info notified")), "a failed send must never read as notified")
})

// ---------------------------------------------------------------------------
// US-12 -- a question
// ---------------------------------------------------------------------------

test("[US-12] a question delivers a notification carrying the question's own text", async () => {
  // The text is the difference between a notification you can answer from and
  // one you have to open a terminal for.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  await emit("question.asked", {
    sessionID: "s1",
    questions: [{ question: "Should the migration be reversible, or one-way?" }],
  })
  await settle()

  assert.equal(sent.length, 1, `expected exactly one question notification, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /reversible/, `the question text must be included: ${sent[0].message}`)
  assert.match(sent[0].message, /Awaiting your response/i, `the message must say why you are being interrupted`)
  assert.equal(sent[0].urgency, "normal", "a question is a request, not a failure, and must not go modal")
})

test("[US-12] the idle event after a parked question sends no duplicate finished notification", async () => {
  // Nothing finished: the task is parked waiting on the user. Saying "finished"
  // there is actively wrong, not merely redundant.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 1, `the parked session must notify once, not twice: ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /Awaiting your response/, "the only notification is the question")
})

test("[US-12] a parked question is cleared by a reply, a rejection, or an error", async () => {
  // Each of these unblocks the session. If `pending` survived any of them, every
  // later real completion for that session would be silently suppressed.
  for (const [event, label] of [
    ["question.replied", "replied"],
    ["question.rejected", "rejected"],
    ["session.error", "errored"],
  ]) {
    const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
    await settle()
    sent.length = 0

    await emit(event, { sessionID: "s1" })
    await settle()
    await idle(emit, "s1")
    await settle()

    // The criterion is that the pending entry is GONE: whatever unblocked the
    // session, the next real completion must announce itself rather than being
    // silently swallowed as "still waiting for you".
    const completions = sent.filter((notice) => /finished/i.test(notice.message))
    assert.equal(completions.length, 1, `${label}: the next real completion must notify again, got ${JSON.stringify(sent)}`)
    if (event === "session.error") {
      assert.ok(sent.some((n) => /Failed/i.test(n.message)), `${label}: the error itself must be announced, got ${JSON.stringify(sent)}`)
    }
  }
})

test("[US-12] a question and a completion inside one cooldown window are not deduplicated against each other", async () => {
  // They are different moments and different things to act on. A shared key
  // would let the second one vanish because the first one just fired.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
  await emit("question.replied", { sessionID: "s1" })
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 2, `both moments must be announced, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /Awaiting your response/)
  assert.match(sent[1].message, /finished/i, "the completion must not be swallowed by the question's cooldown")
})

test("[US-12] a session deleted mid-question stops contributing to later notifications", async () => {
  // Bounded state in a long-running server: a deleted session must not keep a
  // pending question parked forever.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
  await settle()
  await emit("session.deleted", { info: { id: "s1" } })
  sent.length = 0

  await busy(emit, "s1")
  await idle(emit, "s1")
  await settle()
  assert.equal(sent.length, 1, "the re-created session must notify on its own real work")
  assert.match(sent[0].message, /finished/i, "it must not still read as awaiting a response to the old question")
})

test("[US-11] a remote session says so in the notification, so the tunnel is expected", async () => {
  const previous = { client: process.env.SSH_CLIENT, tty: process.env.SSH_TTY }
  process.env.SSH_CLIENT = "10.0.0.1 5555 10.0.0.2 22"
  try {
    const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Remote work" } } })
    await busy(emit, "s1")
    await idle(emit, "s1")
    await settle()
    assert.equal(sent.length, 1)
    assert.match(sent[0].message, /\(remote\)/, `a remote session must be recognisable in its own notification: ${sent[0].message}`)
  } finally {
    if (previous.client === undefined) delete process.env.SSH_CLIENT
    else process.env.SSH_CLIENT = previous.client
    if (previous.tty === undefined) delete process.env.SSH_TTY
    else process.env.SSH_TTY = previous.tty
  }
})
// ---------------------------------------------------------------------------
// US-25 -- a permission prompt
// ---------------------------------------------------------------------------
//
// The payloads below are the RUNTIME's shape, verified against the v1.18.35
// bundle rather than copied from the pinned SDK:
//
//   SX = D.Struct({ id, sessionID, permission: D.String,
//                   patterns: D.Array(D.String), metadata, always, tool })
//       .annotate({identifier: "PermissionRequest"})
//
// `permission.asked`, not the SDK's `permission.updated`; `permission` and
// `patterns`, not `type` and `pattern`. A fixture written from types.gen.d.ts
// would pass these tests and produce "undefined" on a real server.

test("[US-25] a permission request delivers exactly one notification naming the type and the pattern", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("permission.asked", {
    id: "p1",
    sessionID: "s1",
    permission: "read",
    patterns: ["*.env"],
    metadata: {},
    always: ["*.env"],
  })
  await settle()

  assert.equal(sent.length, 1, `exactly one notification, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].title, /Read the config/, "the notification must name the session, as every other path does")
  assert.match(sent[0].message, /permission/i, `the message must say a permission is being asked: ${sent[0].message}`)
  assert.match(sent[0].message, /read/, `the permission type must be in the message: ${sent[0].message}`)
  assert.match(sent[0].message, /\.env/, `the pattern must be in the message: ${sent[0].message}`)
  assert.equal(sent[0].urgency, "normal", "a permission prompt is a request, not a failure, and must not go modal")
})

test("[US-25] an external_directory prompt names the directory being requested", async () => {
  // The glob is `dir/*`; the user is being asked about `dir`. opencode's own TUI
  // resolves this prompt from metadata.parentDir/filepath and trims the glob, and
  // the notification resolves it the same way -- otherwise the one thing the user
  // has to judge is the part that got elided.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Fix the login redirect" } } })
  await busy(emit, "s1")
  await emit("permission.asked", {
    id: "p2",
    sessionID: "s1",
    permission: "external_directory",
    patterns: ["/srv/shared/config/*"],
    metadata: { parentDir: "/srv/shared/config", filepath: "/srv/shared/config/app.json" },
    always: ["/srv/shared/config/*"],
  })
  await settle()

  assert.equal(sent.length, 1, `expected exactly one notification, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /external directory/i, `the message must say what kind of ask this is: ${sent[0].message}`)
  assert.match(sent[0].message, /\/srv\/shared\/config/, `the directory must be named: ${sent[0].message}`)
  assert.ok(
    !/\/\*\b/.test(sent[0].message) && !/\*`/.test(sent[0].message),
    `the trailing glob must be trimmed, the directory is the thing being asked about: ${sent[0].message}`,
  )
})

test("[US-25] a bash prompt names the command rather than a glob", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Run the suite" } } })
  await busy(emit, "s1")
  await emit("permission.asked", {
    id: "p3",
    sessionID: "s1",
    permission: "bash",
    patterns: ["*"],
    metadata: { command: "rm -rf build" },
    always: ["*"],
  })
  await settle()

  assert.equal(sent.length, 1, `expected exactly one notification, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /rm -rf build/, `the command is the thing being asked about: ${sent[0].message}`)
  assert.match(sent[0].message, /permission/i, `the message must say why you are being interrupted: ${sent[0].message}`)
})

test("[US-25] permission.replied sends no notification", async () => {
  // The user was told they were being asked. Telling them how that was resolved
  // is noise, and they were the one who resolved it.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await settle()
  assert.equal(sent.length, 1, "the prompt itself notified")

  await emit("permission.replied", { sessionID: "s1", requestID: "p1", reply: "once" })
  await settle()
  assert.equal(sent.length, 1, `the resolution must not notify again, got ${JSON.stringify(sent)}`)
})

test("[US-25] a session parked on a permission prompt sends no finished notification", async () => {
  // Nothing finished: the agent is blocked. "Task finished" here is not merely
  // redundant, it is the opposite of what happened.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Fix the login redirect" } } })
  await busy(emit, "s1")
  await emit("permission.asked", {
    id: "p1",
    sessionID: "s1",
    permission: "external_directory",
    patterns: ["/srv/shared/*"],
    metadata: { parentDir: "/srv/shared" },
  })
  await settle()
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 1, `the parked session must notify once, not twice: ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /permission/i, "the only notification is the prompt")
})

test("[US-25] a permission prompt bypasses the cooldown", async () => {
  // Two prompts inside the 5s window. The second is a second thing to answer, and
  // a cooldown that swallowed it is the silent stall this story exists to remove.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await emit("permission.asked", { id: "p2", sessionID: "s1", permission: "read", patterns: ["*.key"], metadata: {} })
  await settle()

  assert.equal(sent.length, 2, `both prompts must be announced, got ${JSON.stringify(sent)}`)
})

test("[US-25] unrelated events produce no permission notification", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("session.updated", { info: { id: "s1", title: "Read the config" } })
  await emit("message.part.updated", { part: { id: "pt1", sessionID: "s1", type: "text", text: "working" } })
  await emit("permission.replied", { sessionID: "s1", requestID: "p1", reply: "reject" })
  await emit("permission.list", { permissions: [] })
  await settle()

  assert.deepEqual(sent, [], `no event here is a permission prompt, got ${JSON.stringify(sent)}`)
})

test("[US-25] the handler cannot approve or deny: it registers no permission.ask hook and mutates nothing", async () => {
  // The security-critical property. `Hooks["permission.ask"]` takes a mutable
  // `output.status` ("ask" | "deny" | "allow"), so a handler that touched it
  // could silently grant access. The fix is structural, not defensive: the
  // notification is driven by the `permission.asked` bus EVENT, which carries no
  // output object at all, so there is nothing to perturb.
  const { hooks } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })

  assert.equal(
    hooks["permission.ask"],
    undefined,
    "no permission.ask hook may be registered: its output.status IS the permission decision, and this runtime never triggers it anyway",
  )

  // And the payload the handler was given is left byte-identical.
  const payload = {
    id: "p1",
    sessionID: "s1",
    permission: "external_directory",
    patterns: ["/srv/shared/*"],
    metadata: { parentDir: "/srv/shared" },
    always: ["/srv/shared/*"],
  }
  const before = JSON.stringify(payload)
  await hooks.event({ event: { type: "permission.asked", properties: payload } })
  await settle()
  assert.equal(JSON.stringify(payload), before, "the event payload must not be mutated")
})

test("[US-25] a deliberately perturbing handler fails the read-only assertion", async () => {
  // The guard above only means something if a handler that DOES decide fails it.
  // This is the demonstration that it bites, so the guarantee is structural
  // rather than a promise about code nobody can check.
  //
  // The read-only check, expressed once, is "this object is byte-identical to
  // how it started". A `Hooks["permission.ask"]` handler gets an
  // `{status: "ask"|"deny"|"allow"}` output and one assignment to it decides the
  // permission outright.
  const status = { status: "ask" }
  const untouched = () => {
    const after = { ...status }
    assert.deepEqual(after, { status: "ask" }, "the handler decided the permission")
  }

  // What the plugin does: nothing is handed a decision object, so nothing can
  // change it.
  const { hooks } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await hooks.event({
    event: { type: "permission.asked", properties: { id: "p1", sessionID: "s1", permission: "external_directory", patterns: ["/etc/*"] } },
  })
  await settle()
  untouched()

  // What an over-reaching handler would do, and what the same assertion says.
  status.status = "allow"
  assert.throws(untouched, /decided the permission/, "a handler that wrote output.status must be caught by this check")
})

test("[US-25] the notification goes through the injected seam, never a real desktop call", async () => {
  // `sent` is only populated because the test supplied a recorder as `deliver`.
  // With no seam the factory would spawn bin/oc-notify; nothing here may spawn
  // anything, so the test also asserts the factory exposes no hook that could.
  const stub = stubInput({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  const sent = []
  const hooks = await notifyHooks(stub.input, undefined, {
    deliver: async (title, message, urgency) => {
      sent.push({ title, message, urgency })
      return { ok: true }
    },
  })

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })
  await hooks.event({
    event: { type: "permission.asked", properties: { id: "p1", sessionID: "s1", permission: "bash", patterns: ["*"], metadata: { command: "ls" } } },
  })
  await settle()

  assert.equal(sent.length, 1, "the injected sender observed the notification")
  assert.ok(
    stub.text().some((line) => line.startsWith("info notified")),
    `the delivery is acknowledged through the same log path as every other outcome:\n${stub.text().join("\n")}`,
  )
  assert.ok(
    !stub.text().some((line) => line.includes("no oc-notify helper found")),
    "the helper lookup must never run when a seam is supplied, or this test would be touching the real transport",
  )
})
