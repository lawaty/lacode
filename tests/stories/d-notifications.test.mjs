// Epic D -- Notifications for parallel sessions.
//
//   US-11  a desktop notification when a session finishes or errors
//   US-12  a notification when a question is asked
//   US-25  a notification when opencode asks for permission
//   US-29  notification sounds distinguish outcomes and can be switched off
//   US-30  a popup the user is already looking past fades by itself
//
// Delivery is INJECTED. src/plugins/notify.ts takes an optional third argument,
// a `deliver` seam, and this suite supplies a recording sender. Nothing here
// spawns a helper, touches a desktop daemon, opens an SSH hop, or waits: the
// tests observe that a notification WOULD be delivered, which is the only part
// of the contract that is a decision rather than a pipe.
//
// Where the contract is about a CHANNEL rather than about a decision -- which
// buttons a notifier gets, what a missing sound player costs -- the channel is
// stubbed: the PATH is replaced with recording binaries, so the answer is read
// off the stub's argv instead of off a desktop that is not there. Nothing here
// reaches a real notifier, a real speaker or a GUI session.
//
// One test deliberately does NOT use the seam (US-11, delivery failure): it
// points OC_NOTIFY_HELPER at a script that exits non-zero, so the real spawn
// path and its exit-code handling are exercised for real.

import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, cleanupAll, fakeClock, scratch, settle, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const { notifyHooks } = await import(join(ROOT, "src", "plugins", "notify.ts"))
// The transport, for the contracts that are about a CHANNEL rather than about
// a decision: which buttons a notifier is given, and what a missing sound
// player costs. `sendLocal` takes the platform as an argument, so a Mac's
// channel is a parameter here rather than a different computer.
const { NOTIFICATION_ACTIONS, safeMessage, safeTitle, sendLocal, soundChannel } = await import(
  join(ROOT, "src", "tunnel", "index.ts")
)

/**
 * A notifier wired to a recording sender.
 *
 * `sent` is the list a real desktop would have received; `result` controls what
 * the sender reports back, so the "delivery failed vs delivered" bookkeeping is
 * observable too. The fifth argument is the permission request id (US-25),
 * present only when the notification is actionable, and the sixth is the
 * correlation key that says WHICH popup this is (US-30).
 *
 * `replies` records every call to the server's permission reply route, stubbed
 * onto the shared client, so "the permission was answered" is an assertion
 * about exact arguments rather than about a log line. `respond` replaces the
 * stub's outcome for the failure shapes (a 404, a rejection); the call is
 * recorded either way.
 *
 * `closed` records the dismissals (US-30): the `close` seam is what the plugin
 * asks the helper to do when the user works in that session's chat. It is a
 * recorder, not a spawn -- no helper, no desktop, no D-Bus.
 */
const notifier = async ({ sessions = {}, result = { ok: true }, respond } = {}) => {
  const stub = stubInput({ sessions })
  const sent = []
  const replies = []
  const closed = []
  stub.client.postSessionIdPermissionsPermissionId = async (call) => {
    replies.push(call)
    return respond ? respond(call) : { response: { status: 200 } }
  }
  const hooks = await notifyHooks(
    stub.input,
    undefined,
    {
      deliver: async (title, message, urgency, sound, requestID, sessionID) => {
        sent.push({ title, message, urgency, sound, requestID, sessionID })
        return typeof result === "function" ? result() : result
      },
      close: (sessionID) => {
        closed.push({ sessionID, at: Date.now() })
      },
    },
  )
  return { stub, sent, replies, closed, hooks, emit: (type, properties) => hooks.event({ event: { type, properties } }) }
}

const busy = (emit, sessionID) => emit("session.status", { sessionID, status: { type: "busy" } })
const idle = (emit, sessionID) => emit("session.idle", { sessionID })
// The user typed in this chat.
//
// The runtime publishes every message with its role, so a USER message is
// how it says "the user is in this session's chat". `session.status: busy` is
// a DIFFERENT signal: the runtime raises it whenever the session starts
// executing, so a retry or an automatic continuation looks exactly like it.
const typed = (emit, sessionID) =>
  emit("message.updated", { info: { id: `m_${sessionID}`, sessionID, role: "user", time: { created: Date.now() } } })

/**
 * How long a suite waits for a PERMISSION popup.
 *
 * The plugin waits a quarter of a second for a session's permission requests
 * to pile up before it raises the popup, so the popup can say how many
 * requests it covers. A suite that waits for a permission popup has to wait
 * for that too -- and every other outcome raises its popup at once, which is
 * why only the permission paths need this.
 */
const PERMISSION_SETTLE_MS = 350

/**
 * Stub desktop channels on the PATH of THIS process, for the duration of one
 * callback.
 *
 * The PATH is REPLACED, not prepended, and carries only the stubs plus `sh`.
 * That is what makes "nothing is installed here" expressible at all: this
 * machine has a real notify-send in /usr/bin, so a prepended temp directory
 * could never say "there is no notifier" -- the probe would find the real one
 * and the test would quietly prove nothing.
 *
 * Each stub records its argv, one NUL-terminated record per argument, so a
 * body containing a newline stays one argument. `prints` is what the stub
 * writes on stdout: a channel reporting an answer, the way notify-send reports
 * the name of the button that was clicked.
 *
 * The body is awaited, so the PATH is still in place while a detached sound
 * player starts up.
 */
const withStubbedChannels = async (names, fn, { prints = "" } = {}) => {
  const bin = scratch("stub-bin-")
  const logs = {}
  for (const name of names) {
    const log = join(bin, `${name}.log`)
    logs[name] = log
    const answer = prints ? `printf '%s\\n' ${JSON.stringify(prints)}\n` : ""
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(log)}; done\n${answer}exit 0\n`,
    )
    chmodSync(join(bin, name), 0o755)
  }
  // `command -v` is a shell builtin, so the probe needs a shell to run in.
  symlinkSync("/bin/sh", join(bin, "sh"))

  const argvOf = (name) => {
    const log = logs[name]
    if (!log || !existsSync(log)) return []
    const parts = readFileSync(log, "utf8").split("\0")
    if (parts[parts.length - 1] === "") parts.pop()
    return parts
  }

  const previous = process.env.PATH
  process.env.PATH = bin
  try {
    await fn({ bin, argv: argvOf })
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

/**
 * The argv a notification with NO buttons gets on the notify-send channel.
 *
 * Built from the notification itself rather than written out, so the assertion
 * is about the SHAPE -- whether a button is among the arguments -- and not
 * about the wording of a message.
 */
const plainNotifyArgv = (notice) => [
  safeTitle(notice.title),
  safeMessage(notice.message),
  "--app-name=LaCode",
  `--urgency=${notice.urgency}`,
  "--icon=utilities-terminal",
  "--expire-time=0",
]

/** The three buttons a permission popup carries, in the order they are offered. */
const PERMISSION_BUTTONS = ["--action=once=Allow once", "--action=always=Always allow", "--action=reject=Deny"]

test("[US-29] notification sounds distinguish outcomes", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Work" } } })
  await busy(emit, "s1")
  // done
  await idle(emit, "s1")
  await settle()
  // question
  await emit("question.asked", { sessionID: "s1", questions: [{ question: "Q?" }] })
  await settle()
  // permission
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*"], metadata: {} })
  // The permission popup waits a moment for the session's requests to pile up,
  // and an error clears them -- so the error waits for the popup, or it would
  // overtake the prompt it belongs to.
  await settle(PERMISSION_SETTLE_MS)
  // error
  await emit("session.error", { sessionID: "s1", error: { message: "err" } })
  await settle()

  // Asserted as a SET, not by position. The contract is that each outcome gets
  // its own tone and no two share one; the order they arrive in is the
  // cooldown's business, and pinning it here would fail for a reason that has
  // nothing to do with sound.
  const sounds = sent.map((notice) => notice.sound)
  assert.deepEqual(
    [...sounds].sort(),
    ["done", "error", "permission", "question"],
  )
})

test("[US-29] sound: false in options delivers 'none'", async () => {
  const stub = stubInput({ sessions: { s1: { id: "s1", title: "Work" } } })
  const sent = []
  // Options are the SECOND positional argument to notifyHooks
  const hooks = await notifyHooks(stub.input, { sound: false }, {
    deliver: async (title, message, urgency, sound) => {
      sent.push({ title, message, urgency, sound })
      return { ok: true }
    },
  })
  const emit = (type, properties) => hooks.event({ event: { type, properties } })
  await busy(emit, "s1")
  await idle(emit, "s1")
  await settle()
  assert.equal(sent[0].sound, "none")
})

test("[US-29] env LACODE_SOUND beats option sound: true", async () => {
  // Use try/finally to clean up env, so one test cannot leak the toggle into another.
  try {
    process.env.LACODE_SOUND = "0"
    const stub = stubInput({ sessions: { s1: { id: "s1", title: "Work" } } })
    const sent = []
    const hooks = await notifyHooks(stub.input, { sound: true }, {
      deliver: async (title, message, urgency, sound) => {
        sent.push({ title, message, urgency, sound })
        return { ok: true }
      },
    })
    const emit = (type, properties) => hooks.event({ event: { type, properties } })
    await busy(emit, "s1")
    await idle(emit, "s1")
    await settle()
    assert.equal(sent[0].sound, "none", "env LACODE_SOUND=0 should beat sound: true")
  } finally {
    delete process.env.LACODE_SOUND
  }
})

test("[US-29] various false values for LACODE_SOUND deliver 'none'", async () => {
  for (const val of ["0", "false", "off", "no", " FALSE ", "OFF"]) {
    try {
      process.env.LACODE_SOUND = val
      const stub = stubInput({ sessions: { s1: { id: "s1", title: "Work" } } })
      const sent = []
      const hooks = await notifyHooks(stub.input, {}, {
        deliver: async (title, message, urgency, sound) => {
          sent.push({ title, message, urgency, sound })
          return { ok: true }
        },
      })
      const emit = (type, properties) => hooks.event({ event: { type, properties } })
      await busy(emit, "s1")
      await idle(emit, "s1")
      await settle()
      assert.equal(sent[0].sound, "none", `value ${val} should be off`)
    } finally {
      delete process.env.LACODE_SOUND
    }
  }
})

test("[US-29] nonsense value for LACODE_SOUND is NOT read as off", async () => {
  try {
    process.env.LACODE_SOUND = "noisy"
    const stub = stubInput({ sessions: { s1: { id: "s1", title: "Work" } } })
    const sent = []
    const hooks = await notifyHooks(stub.input, {}, {
      deliver: async (title, message, urgency, sound) => {
        sent.push({ title, message, urgency, sound })
        return { ok: true }
      },
    })
    const emit = (type, properties) => hooks.event({ event: { type, properties } })
    await busy(emit, "s1")
    await idle(emit, "s1")
    await settle()
    assert.notEqual(sent[0].sound, "none", "nonsense value should not disable sound")
  } finally {
    delete process.env.LACODE_SOUND
  }
})

// The sound is played by the TRANSPORT, on the machine that renders the
// notification -- it is the only place a tone can be heard. So the contract
// here is the transport's: the sound is ADDITIVE, and a machine without an
// audio tool still gets the alert itself.

test("[US-29] a machine with no sound player still gets the notification, in full", async () => {
  // There is no player on the PATH at all, and there IS a notifier: the popup
  // is what the user is told, and a missing audio tool must never cost it.
  await withStubbedChannels(["notify-send"], async ({ argv }) => {
    assert.equal(soundChannel("linux"), "none", "this case is only meaningful with no player installed")

    const result = sendLocal(
      {
        title: "Fix the login redirect",
        message: "Task finished, waiting for your review",
        urgency: "normal",
        icon: "utilities-terminal",
        sound: "done",
      },
      "linux",
    )

    assert.equal(result.ok, true, `the notification must still be delivered: ${result.detail}`)
    assert.equal(result.detail, undefined, "a missing player is not a delivery failure")
    assert.deepEqual(
      argv("notify-send"),
      [
        "Fix the login redirect",
        "Task finished, waiting for your review",
        "--app-name=LaCode",
        "--urgency=normal",
        "--icon=utilities-terminal",
        "--expire-time=0",
      ],
      `the notification must go out with its full body: ${JSON.stringify(argv("notify-send"))}`,
    )
  })
})

test("[US-29] a sound player that cannot start costs only the sound, never the notification", async () => {
  // The player is installed and the code knows it -- and it cannot run: the
  // interpreter its shebang names does not exist, so there is no process at
  // all. The sound is skipped; the alert is not.
  await withStubbedChannels(["notify-send", "paplay"], async ({ bin, argv }) => {
    const player = join(bin, "paplay")
    writeFileSync(player, "#!/nonexistent/interpreter\n")
    chmodSync(player, 0o755)
    assert.equal(soundChannel("linux"), "paplay", "the player is installed; it simply cannot start")

    const result = sendLocal(
      {
        title: "Fix the login redirect",
        message: "Task finished, waiting for your review",
        urgency: "normal",
        icon: "utilities-terminal",
        sound: "done",
      },
      "linux",
    )

    assert.equal(result.ok, true, `the notification must still be delivered: ${result.detail}`)
    assert.deepEqual(
      argv("notify-send"),
      [
        "Fix the login redirect",
        "Task finished, waiting for your review",
        "--app-name=LaCode",
        "--urgency=normal",
        "--icon=utilities-terminal",
        "--expire-time=0",
      ],
      `the notification must go out with its full body: ${JSON.stringify(argv("notify-send"))}`,
    )
    // And the sound was skipped, not half-played: the player never ran.
    assert.deepEqual(argv("paplay"), [], `a player that cannot start must not have run: ${JSON.stringify(argv("paplay"))}`)
  })
})

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
  // The error payload is unrecognized, so each one notifies; a recognized rate
  // limit or an abort would stay silent by design.
  await emit("session.error", { sessionID: "s1", error: { message: "boom" } })
  await emit("session.error", { sessionID: "s1", error: { message: "boom" } })
  await settle()

  assert.equal(sent.length, 2, `both errors must be announced, got ${JSON.stringify(sent)}`)
  for (const notice of sent) {
    assert.match(notice.message, /Failed/i, `an error notification must say so: ${notice.message}`)
    assert.equal(notice.urgency, "critical", "a failure is the one thing worth interrupting for")
  }
})

test("[US-11] an unrecognized terminal error notifies and carries the error's own message", async () => {
  // The error's text is the difference between a notification that names the
  // failure and one that only says something went wrong.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Deploy the API" } } })
  await busy(emit, "s1")
  await emit("session.error", { sessionID: "s1", error: { message: "socket hang up after 30s" } })
  await settle()

  assert.equal(sent.length, 1, `exactly one notification, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /Failed/i, `an error notification must say so: ${sent[0].message}`)
  assert.match(sent[0].message, /socket hang up after 30s/, `the error's own text must be carried: ${sent[0].message}`)
  assert.equal(sent[0].urgency, "critical", "a failure is the one thing worth interrupting for")
})

test("[US-11] a recognized rate-limit error does not notify", async () => {
  // The pool owns rate limits: it cools the model and the request retries. A
  // second notification would report something already handled.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Deploy the API" } } })
  await busy(emit, "s1")
  await emit("session.error", { sessionID: "s1", error: { message: "Rate limit exceeded, retry in 30s" } })
  await settle()

  assert.deepEqual(sent, [], `a recognized rate limit must not notify, got ${JSON.stringify(sent)}`)
})

test("[US-11] a user abort does not notify", async () => {
  // The user pressed escape; they already know. Telling them what they did is
  // noise, and a failure popup for it would train them to dismiss popups.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Deploy the API" } } })
  await busy(emit, "s1")
  await emit("session.error", { sessionID: "s1", error: { name: "MessageAbortedError", message: "The message was aborted" } })
  await settle()

  assert.deepEqual(sent, [], `an abort is the user's own action, got ${JSON.stringify(sent)}`)
})

test("[US-11] a session error carrying no error payload stays silent", async () => {
  // The event without an error object is not a failure this plugin can
  // describe; announcing "Failed" with no reason would be noise.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Deploy the API" } } })
  await busy(emit, "s1")
  await emit("session.error", { sessionID: "s1" })
  await settle()

  assert.deepEqual(sent, [], `an error with no payload must not notify, got ${JSON.stringify(sent)}`)
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
  const child = await notifier({ sessions: { c1: { id: "c1", parentID: "root", title: "explore" } } })
  await busy(child.emit, "c1")
  await idle(child.emit, "c1")
  await settle()
  assert.deepEqual(child.sent, [], "a subagent going idle is not a thing the user asked for")

  // The cartographer is spawned with no parentID, so structure alone cannot
  // exclude it; it is identified by its title prefix.
  const cartographer = await notifier({ sessions: { m1: { id: "m1", title: "context (auto update)" } } })
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

test("[US-11] a lacode-shaped helper is invoked with the notify subcommand", async () => {
  // The helper's argv is not universal. The shipped bug handed dist/lacode.js
  // the oc-notify shape and the CLI answered "unknown command" -- a notifier
  // that existed, was spawned, and delivered nothing.
  const bin = scratch("lacode-helper-")
  const argsFile = join(bin, "args.log")
  const helper = join(bin, "lacode")
  writeFileSync(helper, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${argsFile}\n`)
  chmodSync(helper, 0o755)
  const previous = process.env.OC_NOTIFY_HELPER
  process.env.OC_NOTIFY_HELPER = helper
  try {
    const stub = stubInput({ sessions: { s1: { id: "s1", title: "Something" } } })
    const hooks = await notifyHooks(stub.input)
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    await settle(120)
    const args = readFileSync(argsFile, "utf8").split("\n").filter(Boolean)
    assert.equal(args[0], "notify", `a lacode helper must be called as 'lacode notify ...', got ${JSON.stringify(args)}`)
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

    // Only the error iteration carries a payload, and it must be an
    // unrecognized one: a recognized error would stay silent by design, and
    // the assertion below is that THIS error is announced.
    await emit(event, event === "session.error" ? { sessionID: "s1", error: { message: "boom" } } : { sessionID: "s1" })
    await settle()
    await idle(emit, "s1")
    await settle()

    // The criterion is that the pending entry is GONE: whatever unblocked the
    // session, the next real completion must announce itself rather than being
    // silently swallowed as "still waiting for you".
    const completions = sent.filter((notice) => /finished/i.test(notice.message))
    // A terminal error claims the per-turn completion marker, so the idle that
    // follows it in the same turn stays quiet; only the error is announced.
    const expectedCompletions = event === "session.error" ? 0 : 1
    assert.equal(completions.length, expectedCompletions, `${label}: completion count, got ${JSON.stringify(sent)}`)
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
  await settle(PERMISSION_SETTLE_MS)

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
  await settle(PERMISSION_SETTLE_MS)

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
  await settle(PERMISSION_SETTLE_MS)

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
  await settle(PERMISSION_SETTLE_MS)
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
  await settle(PERMISSION_SETTLE_MS)
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 1, `the parked session must notify once, not twice: ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /permission/i, "the only notification is the prompt")
})

test("[US-25] a permission prompt bypasses the cooldown", async () => {
  // Two prompts inside the 5s window. The second one is NOT a second popup:
  // the popup that is up covers it, and the click answers both -- one popup
  // for one batch is the whole point.
  //
  // What the cooldown must never do is swallow the NEXT prompt of the same
  // session: a block the user was never told about is the silent stall this
  // story exists to remove.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await emit("permission.asked", { id: "p2", sessionID: "s1", permission: "read", patterns: ["*.key"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)

  assert.equal(sent.length, 1, `the batch is one popup, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /2 requests/, `the popup must say how many requests it covers: ${sent[0].message}`)

  // The batch is answered, and the session asks again inside the cooldown
  // window. That is a NEW block, and it must be announced.
  await emit("permission.replied", { sessionID: "s1", requestID: "p1", reply: "once" })
  await emit("permission.replied", { sessionID: "s1", requestID: "p2", reply: "once" })
  await emit("permission.asked", { id: "p3", sessionID: "s1", permission: "read", patterns: ["*.secret"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)

  assert.equal(sent.length, 2, `the next prompt must be announced inside the window, got ${JSON.stringify(sent)}`)
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
    deliver: async (title, message, urgency, sound) => {
      sent.push({ title, message, urgency, sound })
      return { ok: true }
    },
  })

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })
  await hooks.event({
    event: { type: "permission.asked", properties: { id: "p1", sessionID: "s1", permission: "bash", patterns: ["*"], metadata: { command: "ls" } } },
  })
  await settle(PERMISSION_SETTLE_MS)

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

// The answerable half of US-25. The notification carries the permission's
// request id, the transport turns a click into that id's answer, and the
// plugin forwards the clicked name -- opencode's own reply value, so no
// translation -- through the server's reply route. Everything below drives
// the seam, so a "click" is simply the sender reporting an action.

test("[US-25] a permission notification carries the request id for the transport to act on", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)

  assert.equal(sent.length, 1, `exactly one notification, got ${JSON.stringify(sent)}`)
  assert.equal(sent[0].requestID, "p1", `the seam's fifth argument must be the request id: ${JSON.stringify(sent[0])}`)
})

test("[US-25] a permission event with no id delivers a notice that answers nothing", async () => {
  // The id is what a reply is addressed to. Without one there is nothing to
  // answer, so the popup must be a plain notice -- and the reply route must
  // never be touched, because an addressless reply can only land somewhere.
  const { sent, emit, replies } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("permission.asked", { sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)

  assert.equal(sent.length, 1, `the prompt itself must still notify, got ${JSON.stringify(sent)}`)
  assert.equal(sent[0].requestID, undefined, `no id, no request id on the seam: ${JSON.stringify(sent[0])}`)
  assert.deepEqual(replies, [], `the reply route must not be called: ${JSON.stringify(replies)}`)
})

test("[US-25] clicking a button answers the permission exactly once, addressed to the request id", async () => {
  // The clicked name is already one of opencode's reply values, so the body
  // must be EXACTLY what was clicked -- no mapping, no wrapping. And the
  // reply is addressed by the request id the event carried, which is the
  // only thing the server can match an answer against.
  for (const action of ["once", "always", "reject"]) {
    const { sent, emit, replies } = await notifier({
      sessions: { s1: { id: "s1", title: "Read the config" } },
      result: { ok: true, action },
    })
    await busy(emit, "s1")
    await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
    await settle(PERMISSION_SETTLE_MS)

    assert.equal(sent.length, 1, `${action}: the notification was delivered, got ${JSON.stringify(sent)}`)
    assert.deepEqual(
      replies,
      [{ path: { id: "s1", permissionID: "p1" }, body: { response: action } }],
      `${action}: exactly one reply, with the clicked name as the response: ${JSON.stringify(replies)}`,
    )
  }
})

test("[US-25] an action that is not a permission reply is ignored, never forwarded", async () => {
  // The action is the transport's raw stdout -- untrusted text. Only the
  // server's own vocabulary may reach the reply route; anything else would
  // let a noisy hop answer a permission with a word nobody clicked.
  const { emit, replies } = await notifier({
    sessions: { s1: { id: "s1", title: "Read the config" } },
    result: { ok: true, action: "maybe" },
  })
  await busy(emit, "s1")
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)

  assert.deepEqual(replies, [], `an unrecognised name must never reach the server: ${JSON.stringify(replies)}`)
})

test("[US-25] dismissing the popup answers nothing and still reports the delivery", async () => {
  // Empty stdout is the dismissed popup: a delivery, not an answer. The
  // permission stays exactly as it was, and the notification is still
  // accounted for as delivered -- the user was told, which is what the
  // notification was for.
  const { stub, sent, emit, replies } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)

  assert.equal(sent.length, 1, `the popup was raised, got ${JSON.stringify(sent)}`)
  assert.deepEqual(replies, [], `a dismissal must not answer anything: ${JSON.stringify(replies)}`)
  assert.ok(
    stub.text().some((line) => line.startsWith("info notified")),
    `the delivery must still be reported as delivered:\n${stub.text().join("\n")}`,
  )
})

test("[US-25] a non-permission outcome never answers anything", async () => {
  // The reply route exists for permissions. A done notification has no
  // request id to answer with, so even a sender that reports an action must
  // not be able to turn a completion into a permission reply.
  const { emit, replies } = await notifier({
    sessions: { s1: { id: "s1", title: "Read the config" } },
    result: { ok: true, action: "once" },
  })
  await busy(emit, "s1")
  await idle(emit, "s1")
  await settle()

  assert.deepEqual(replies, [], `a done notification must never touch the reply route: ${JSON.stringify(replies)}`)
})

test("[US-25] a permission already answered elsewhere is not a failure", async () => {
  // The terminal answered first; the click arrives late. The 404 that comes
  // back is the good outcome -- the permission IS answered -- whichever
  // shape it arrives in: a resolved response or a rejected error carrying
  // the status. Neither may be logged as a failure, and nothing may throw
  // out of the event handler.
  for (const [label, respond] of [
    ["a resolved 404", async () => ({ response: { status: 404 } })],
    [
      "a rejected 404",
      async () => {
        const error = new Error("HTTP 404")
        error.response = { status: 404 }
        throw error
      },
    ],
  ]) {
    const { stub, emit, replies } = await notifier({
      sessions: { s1: { id: "s1", title: "Read the config" } },
      result: { ok: true, action: "once" },
      respond,
    })
    await busy(emit, "s1")
    await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
    await settle(PERMISSION_SETTLE_MS)

    assert.equal(replies.length, 1, `${label}: the reply route was still addressed: ${JSON.stringify(replies)}`)
    const text = stub.text()
    assert.ok(text.some((line) => line.includes("permission already answered")), `${label}: the outcome must be named:\n${text.join("\n")}`)
    assert.ok(!text.some((line) => line.startsWith("warn permission reply failed")), `${label}: a 404 is not a failure:\n${text.join("\n")}`)
    assert.ok(!text.some((line) => line.startsWith("error")), `${label}: nothing may be logged as an error:\n${text.join("\n")}`)
    assert.ok(!text.some((line) => /handler failed|notify failed/.test(line)), `${label}: nothing may throw out of the handler:\n${text.join("\n")}`)
  }
})

test("[US-25] a stale click for a permission the server does not have is a no-op, not an answer", async () => {
  // The request was withdrawn or answered while the popup sat there. The
  // click must not crash anything -- the next prompt must still notify and
  // answer normally -- and it must not be recorded as an answer: no log
  // line may claim the response was delivered, because it was not.
  const { stub, sent, emit, replies } = await notifier({
    sessions: { s1: { id: "s1", title: "Read the config" } },
    result: { ok: true, action: "once" },
    respond: async () => ({ response: { status: 404 } }),
  })
  await busy(emit, "s1")
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)

  assert.equal(replies.length, 1, `the stale click still reached the reply route: ${JSON.stringify(replies)}`)
  const answered = stub.lines.filter((line) => line.extra?.response === "once")
  assert.deepEqual(answered, [], `the stale click must not be recorded as an answer: ${JSON.stringify(stub.lines)}`)
  assert.ok(
    stub.text().some((line) => line.includes("permission already answered")),
    `the no-op must be said in plain words:\n${stub.text().join("\n")}`,
  )
  assert.ok(!stub.text().some((line) => /handler failed|notify failed/.test(line)), `nothing may crash:\n${stub.text().join("\n")}`)

  // And the plugin is unharmed: the next prompt notifies and answers as ever.
  await emit("permission.asked", { id: "p2", sessionID: "s1", permission: "read", patterns: ["*.key"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)
  assert.equal(sent.length, 2, `the next prompt must still notify, got ${JSON.stringify(sent)}`)
  assert.deepEqual(
    replies[1],
    { path: { id: "s1", permissionID: "p2" }, body: { response: "once" } },
    `the next click must answer its own request id: ${JSON.stringify(replies)}`,
  )
})

// ---------------------------------------------------------------------------
// US-25 -- which buttons a notifier is given
// ---------------------------------------------------------------------------
//
// The buttons are a property of the CHANNEL, not of the notification alone:
// `notify-send --action=` is the only way to offer one, so a Mac -- whose
// channel is osascript or terminal-notifier, neither of which has actions --
// gets a plain notice, and the answer still has to be given in the terminal.
//
// So these two tests read the notifier's argv, on the channel the platform
// would really pick, with the notification the plugin really raised.

test("[US-25] a permission prompt on a macOS desktop is a plain notice with no buttons", async () => {
  // The prompt the plugin raises, captured at the seam.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
  await busy(emit, "s1")
  await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)

  assert.equal(sent.length, 1, `the prompt must notify: ${JSON.stringify(sent)}`)
  const prompt = sent[0]
  assert.equal(prompt.requestID, "p1", "the prompt carries the id a click would be answered against")

  // Every stub answers "once" -- as if the user had clicked Allow once. A
  // channel with buttons can report that back; a channel without them cannot.
  await withStubbedChannels(
    ["osascript", "notify-send", "terminal-notifier"],
    async ({ argv }) => {
      const request = {
        title: prompt.title,
        message: prompt.message,
        urgency: prompt.urgency,
        sound: prompt.sound,
        requestID: prompt.requestID,
      }

      const mac = sendLocal(request, "darwin")
      assert.equal(mac.ok, true, `the macOS send must succeed: ${mac.detail}`)

      // notify-send must not run on a Mac, and terminal-notifier is only the
      // fallback for a Mac without osascript.
      assert.deepEqual(argv("notify-send"), [], "notify-send must not be invoked on macOS")
      assert.deepEqual(argv("terminal-notifier"), [], "osascript ships with macOS, so the fallback must not be the channel")

      // The macOS argv is EXACTLY the script and the two values: five entries,
      // with no room for a button among them.
      const macArgv = argv("osascript")
      assert.equal(macArgv.length, 5, `osascript gets -e, the script, and the two values: ${JSON.stringify(macArgv)}`)
      assert.equal(macArgv[0], "-e")
      assert.equal(macArgv[2], "lacode", `the constant marker comes first: ${JSON.stringify(macArgv)}`)
      assert.deepEqual(
        macArgv.slice(3),
        [safeTitle(prompt.title), safeMessage(prompt.message)],
        `the prompt itself must arrive whole: ${JSON.stringify(macArgv)}`,
      )
      assert.deepEqual(
        macArgv.filter((arg) => arg.startsWith("--action=")),
        [],
        `a macOS popup carries no buttons: ${JSON.stringify(macArgv)}`,
      )
      const labels = NOTIFICATION_ACTIONS.map(([, label]) => label)
      assert.ok(
        !macArgv.some((arg) => labels.includes(arg)),
        `no action list may reach a macOS popup: ${JSON.stringify(macArgv)}`,
      )
      assert.ok(
        !labels.some((label) => macArgv[1].includes(label)),
        `the script must not carry the buttons either: ${macArgv[1]}`,
      )

      // And the answer still has to be given in the terminal: a channel with no
      // buttons reports no answer, even when it says something.
      assert.equal(mac.action, undefined, `a macOS popup must not report an answer: ${JSON.stringify(mac)}`)

      // The SAME notification on the channel that CAN offer buttons carries
      // them, and the click comes back.
      const linux = sendLocal(request, "linux")
      assert.equal(linux.ok, true, `the Linux send must succeed: ${linux.detail}`)
      assert.deepEqual(
        argv("notify-send").filter((arg) => arg.startsWith("--action=")),
        PERMISSION_BUTTONS,
        `the Linux popup must carry the three buttons: ${JSON.stringify(argv("notify-send"))}`,
      )
      assert.equal(linux.action, "once", `the clicked button must come back: ${JSON.stringify(linux)}`)
    },
    { prints: "once" },
  )
})

test("[US-25] a question notification carries no buttons, because a question is not a permission", async () => {
  // The question, as the plugin raises it.
  const asked = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(asked.emit, "s1")
  await asked.emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
  await settle()
  assert.equal(asked.sent.length, 1, `the question must notify: ${JSON.stringify(asked.sent)}`)
  const question = asked.sent[0]
  assert.equal(question.requestID, undefined, "a question carries no request id, so there is nothing for a button to answer")

  // The permission, as the plugin raises it.
  const prompted = await notifier({ sessions: { s2: { id: "s2", title: "Read the config" } } })
  await busy(prompted.emit, "s2")
  await prompted.emit("permission.asked", { id: "p1", sessionID: "s2", permission: "read", patterns: ["*.env"], metadata: {} })
  await settle(PERMISSION_SETTLE_MS)
  assert.equal(prompted.sent.length, 1, `the prompt must notify: ${JSON.stringify(prompted.sent)}`)
  const permission = prompted.sent[0]
  assert.equal(permission.requestID, "p1", "a permission carries the id its click is answered against")

  // ONE channel, two notifications: the difference between them is the
  // buttons, and nothing else.
  await withStubbedChannels(
    ["notify-send"],
    async ({ argv }) => {
      const askedResult = sendLocal(
        { title: question.title, message: question.message, urgency: question.urgency, sound: question.sound },
        "linux",
      )
      assert.equal(askedResult.ok, true, `the question must still be delivered: ${askedResult.detail}`)
      const questionArgv = argv("notify-send")
      assert.deepEqual(
        questionArgv,
        plainNotifyArgv(question),
        `a question popup must carry no buttons: ${JSON.stringify(questionArgv)}`,
      )
      assert.deepEqual(
        questionArgv.filter((arg) => arg.startsWith("--action=")),
        [],
        `a question popup must carry no buttons: ${JSON.stringify(questionArgv)}`,
      )
      assert.equal(askedResult.action, undefined, "a question answers nothing")

      // The permission, on the SAME channel: three buttons, and an answer.
      const promptedResult = sendLocal(
        {
          title: permission.title,
          message: permission.message,
          urgency: permission.urgency,
          sound: permission.sound,
          requestID: permission.requestID,
        },
        "linux",
      )
      assert.equal(promptedResult.ok, true, `the prompt must be delivered: ${promptedResult.detail}`)
      // The stub's log is append-only, so the permission's own arguments are
      // the ones that came after the question's.
      assert.deepEqual(
        argv("notify-send").slice(questionArgv.length),
        [...plainNotifyArgv(permission), ...PERMISSION_BUTTONS],
        `a permission popup must carry the three buttons: ${JSON.stringify(argv("notify-send"))}`,
      )
      assert.equal(promptedResult.action, "once", `the clicked button must come back: ${JSON.stringify(promptedResult)}`)
    },
    { prints: "once" },
  )
})

// ---------------------------------------------------------------------------
// US-30 -- a popup the user is already looking past fades by itself
// ---------------------------------------------------------------------------
//
// The plugin never closes a popup itself: it asks the HELPER to close it,
// because the popup lives on the desktop and only the desktop knows the
// notification id the daemon gave it. The `close` seam is that request, so
// these tests observe a dismissal with no desktop, no helper and no D-Bus.
//
// The five-second floor is on the POPUP's own life, not on the moment the user
// answered: the popup hides at max(now, raisedAt + 5s). One test below measures
// that floor against the real clock, because it is a promise about what the
// user sees. The rest use a fake clock, which is what makes "this popup has
// already been up for more than five seconds" expressible without a
// five-second wait in every case.

/**
 * Run a body with a fake clock installed, and take the clock away again.
 *
 * The dismissal is a real timer, so a fake `Date.now` is what makes the
 * five-second rule testable at all. It is restored when the body returns, so
 * one test can never hand the next one a frozen clock.
 */
const withClock = async (body) => {
  const clock = fakeClock()
  try {
    return await body(clock)
  } finally {
    clock.restore()
  }
}

/** Real elapsed milliseconds. `Date.now` is faked in some of these tests. */
const realMs = (from) => Number(process.hrtime.bigint() - from) / 1e6

test("[US-30] answering a permission in the TUI closes that session's popup", async () => {
  await withClock(async (clock) => {
    const { sent, closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
    await busy(emit, "s1")
    await emit("permission.asked", {
      id: "p1",
      sessionID: "s1",
      permission: "read",
      patterns: ["*.env"],
      metadata: {},
    })
    await settle(PERMISSION_SETTLE_MS)
    assert.equal(sent.length, 1, `the prompt itself notified, got ${JSON.stringify(sent)}`)
    assert.equal(sent[0].sessionID, "s1", `the notification must carry the session it belongs to: ${JSON.stringify(sent[0])}`)
    assert.deepEqual(closed, [], "nothing is closed while the user is elsewhere")

    // The popup has been up for longer than its five seconds.
    clock.advance(6_000)
    await emit("permission.replied", { sessionID: "s1", requestID: "p1", reply: "once" })
    await settle(50)

    assert.deepEqual(
      closed.map((entry) => entry.sessionID),
      ["s1"],
      `the popup the user just dealt with must fade by itself: ${JSON.stringify(closed)}`,
    )
  })
})

test("[US-30] answering a question in the TUI closes that session's popup", async () => {
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
    await settle()
    assert.deepEqual(closed, [], "nothing is closed while the user is elsewhere")

    clock.advance(6_000)
    await emit("question.replied", { sessionID: "s1" })
    await settle(50)

    assert.deepEqual(
      closed.map((entry) => entry.sessionID),
      ["s1"],
      `the popup the user just answered must fade by itself: ${JSON.stringify(closed)}`,
    )
  })
})

test("[US-30] dismissing a question in the TUI closes that session's popup", async () => {
  // Dropping the question is the user acting on it too: the popup said
  // "awaiting your response", and there is no response any more.
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
    await settle()

    clock.advance(6_000)
    await emit("question.rejected", { sessionID: "s1", requestID: "que_1" })
    await settle(50)

    assert.deepEqual(
      closed.map((entry) => entry.sessionID),
      ["s1"],
      `the popup must fade when the question is dropped too: ${JSON.stringify(closed)}`,
    )
  })
})

test("[US-30] typing in the chat closes that session's popup", async () => {
  // Typing is a USER MESSAGE, and that is how the runtime says it: the
  // message carries its role. `session.status: busy` is NOT the same
  // signal -- the runtime raises it whenever the session starts executing,
  // so a retry or an automatic continuation would look like the user typing
  // and would close a popup nobody had read.
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
    await settle()
    assert.deepEqual(closed, [], "nothing is closed while the user is elsewhere")

    clock.advance(6_000)
    await typed(emit, "s1")
    await settle(50)

    assert.deepEqual(
      closed.map((entry) => entry.sessionID),
      ["s1"],
      `typing in the chat must fade that chat's popup: ${JSON.stringify(closed)}`,
    )
  })
})

test("[US-30] a session going busy on its own never closes a popup", async () => {
  // The regression this story's signal has to survive.
  //
  // `session.status: busy` is the runtime's "the session started executing":
  // a retry, a resumption, an automatic continuation -- none of which the
  // user did. It is NOT "the user typed". So it must not dismiss anything:
  // the popup has been up for longer than its five seconds, which means a
  // dismissal would be immediate, and a notice the user never read is no
  // notice at all.
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
    await settle()
    assert.deepEqual(closed, [], "nothing is closed while the user is elsewhere")

    // The popup has been up for longer than its five seconds, so anything
    // that armed a dismissal would close it now.
    clock.advance(6_000)
    await busy(emit, "s1")
    await settle(100)

    assert.deepEqual(
      closed,
      [],
      `a busy transition is the machine working, not the user: ${JSON.stringify(closed)}`,
    )
  })
})

test("[US-30] a popup is never closed before it has been readable for five seconds", async () => {
  // The real clock, and the real five seconds: the floor is a promise about
  // what the user sees, so it is measured in the user's own time.
  const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  // The popup goes up inside this announce, so this is the earliest moment it
  // could have been raised: the floor is measured from the earliest, never from
  // a moment that flatters the implementation.
  const raisedAt = Date.now()
  await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
  await settle()
  // The user answers the question straight away.
  await emit("question.replied", { sessionID: "s1" })
  const interactedAt = Date.now()
  assert.ok(interactedAt - raisedAt < 5_000, "control: the user answered before the floor had passed")

  await settle(1_000)
  assert.deepEqual(closed, [], "a popup that was just raised must not be taken away: a notice nobody could read is no notice")

  await settle(4_800)
  assert.equal(closed.length, 1, `the popup must fade once the user has worked in the chat: ${JSON.stringify(closed)}`)
  const elapsed = closed[0].at - raisedAt
  assert.ok(elapsed >= 5_000, `the popup must stay up for five seconds, it was closed after ${elapsed}ms`)
})

test("[US-30] a popup the user works in after five seconds fades at once", async () => {
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
    await settle()

    // The popup has been up for longer than its five seconds, so there is
    // nothing left to wait for.
    clock.advance(6_000)
    const started = process.hrtime.bigint()
    await emit("question.replied", { sessionID: "s1" })
    await settle(50)

    assert.equal(closed.length, 1, `the popup must fade: ${JSON.stringify(closed)}`)
    const elapsed = realMs(started)
    assert.ok(elapsed < 1_000, `a popup that has had its five seconds must fade at once, it took ${elapsed}ms`)
  })
})

test("[US-30] working in one session's chat leaves another session's popup alone", async () => {
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({
      sessions: { s1: { id: "s1", title: "One" }, s2: { id: "s2", title: "Two" } },
    })
    await busy(emit, "s1")
    await idle(emit, "s1")
    await settle()
    await busy(emit, "s2")
    await idle(emit, "s2")
    await settle()
    assert.deepEqual(closed, [], "two popups are up, and neither has been touched")

    clock.advance(6_000)
    await emit("question.replied", { sessionID: "s1" })
    await settle(50)

    assert.deepEqual(
      closed.map((entry) => entry.sessionID),
      ["s1"],
      `a notification belongs to its session: ${JSON.stringify(closed)}`,
    )
  })
})

test("[US-30] a session with no popup is never closed", async () => {
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    clock.advance(6_000)
    await emit("question.replied", { sessionID: "s1" })
    await busy(emit, "s1")
    await settle(50)

    assert.deepEqual(closed, [], "there is no popup to take down, so nothing may be asked to close one")
  })
})

test("[US-30] a popup nobody works in stays until the user closes it", async () => {
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await idle(emit, "s1")
    await settle()

    // A long time passes, and the user never touches that chat.
    clock.advance(60 * 60 * 1_000)
    await settle(100)

    assert.deepEqual(closed, [], "a popup nobody worked in waits for the X button, exactly as before")
  })
})

test("[US-30] closing a permission popup answers nothing", async () => {
  // The permission was already answered in the terminal. The dismissal takes
  // the popup down and answers nothing: a fade is not an answer, and the
  // plugin never picks one.
  await withClock(async (clock) => {
    const { closed, emit, replies } = await notifier({ sessions: { s1: { id: "s1", title: "Read the config" } } })
    await busy(emit, "s1")
    await emit("permission.asked", { id: "p1", sessionID: "s1", permission: "read", patterns: ["*.env"], metadata: {} })
    await settle(PERMISSION_SETTLE_MS)

    clock.advance(6_000)
    await emit("permission.replied", { sessionID: "s1", requestID: "p1", reply: "once" })
    await settle(50)

    assert.deepEqual(
      closed.map((entry) => entry.sessionID),
      ["s1"],
      `the popup must be taken down: ${JSON.stringify(closed)}`,
    )
    assert.deepEqual(replies, [], `a dismissal answers nothing: ${JSON.stringify(replies)}`)
  })
})

test("[US-30] a deleted session's pending dismissal is cancelled", async () => {
  await withClock(async (clock) => {
    const { closed, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
    await settle()

    clock.advance(6_000)
    await emit("question.replied", { sessionID: "s1" })
    // The session is gone before the dismissal fires.
    await emit("session.deleted", { info: { id: "s1" } })
    await settle(100)

    assert.deepEqual(closed, [], "a dismissal for a session that is gone closes nothing")
  })
})

test("[US-11] a repeated idle after the cooldown raises one popup", async () => {
  await withClock(async (clock) => {
    const { sent, emit } = await notifier({ sessions: { "r1": { id: "r1", title: "Work" } } })
    await busy(emit, "r1")
    await idle(emit, "r1")
    await settle()
    assert.equal(sent.length, 1, `first idle must raise one popup, got ${JSON.stringify(sent)}`)
    clock.advance(6000)
    await idle(emit, "r1")
    await settle()
    assert.equal(sent.length, 1, `a repeated idle must not raise a second popup, got ${JSON.stringify(sent)}`)
  })
})

test("[US-11] a new turn gets its own popup", async () => {
  await withClock(async (clock) => {
    const { sent, emit } = await notifier({ sessions: { "n1": { id: "n1", title: "Work" } } })
    await busy(emit, "n1")
    await idle(emit, "n1")
    await settle()
    assert.equal(sent.length, 1, `first turn must raise one popup, got ${JSON.stringify(sent)}`)
    clock.advance(6000)
    await busy(emit, "n1")
    await idle(emit, "n1")
    await settle()
    assert.equal(sent.length, 2, `a new turn must raise its own popup, got ${JSON.stringify(sent)}`)
  })
})

test("[US-11] an error and the idle that follows it raise one popup, not two", async () => {
  await withClock(async (clock) => {
    const { sent, emit } = await notifier({ sessions: { "e1": { id: "e1", title: "Work" } } })
    await busy(emit, "e1")
    await emit("session.error", { sessionID: "e1", error: { message: "boom" } })
    await settle()
    assert.equal(sent.length, 1, `the error must raise one popup, got ${JSON.stringify(sent)}`)
    assert.match(sent[0].message, /Failed/i, `the popup must be the error, got ${JSON.stringify(sent)}`)
    clock.advance(6000)
    await idle(emit, "e1")
    await settle()
    assert.equal(sent.length, 1, `the following idle must not raise a second popup, got ${JSON.stringify(sent)}`)
  })
})

test("[US-11] two notify instances in one process do not both raise it", async () => {
  const A = await notifier({ sessions: { "t1": { id: "t1", title: "Work" } } })
  const B = await notifier({ sessions: { "t1": { id: "t1", title: "Work" } } })
  await busy(A.emit, "t1")
  await busy(B.emit, "t1")
  await idle(A.emit, "t1")
  await settle()
  await idle(B.emit, "t1")
  await settle()
  assert.equal(A.sent.length + B.sent.length, 1, `only one instance may raise it, got A=${A.sent.length} B=${B.sent.length}`)
})
