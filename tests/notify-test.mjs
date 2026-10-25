import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import nodeAssert from "node:assert/strict"

const HERE = dirname(fileURLToPath(import.meta.url))
// The source of truth. plugins/notify.ts is a dev-only re-export shim so
// opencode's directory auto-discovery still finds this code in the working tree;
// the published package has one plugin, src/index.ts, and the suites test the
// factories that index.ts composes.
const PLUGIN = join(HERE, "..", "src", "plugins", "notify.ts")
const SHIM = join(HERE, "..", "plugins", "lacode.ts")
const LIB = join(HERE, "..", "src", "lib", "notify.ts")

let passed = 0
const failures = []

const check = async (name, fn) => {
  try {
    resetNotificationState()
    await fn()
    passed++
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

/**
 * A fake helper that records the notifications it was asked to deliver.
 *
 * A CLOSE REQUEST is not a notification. The real helper (`bin/oc`'s
 * `send_notify`) checks LACODE_NOTIFY_CLOSE FIRST and sends nothing at all, so
 * this fake has to do the same: a helper that recorded every invocation would
 * count every dismissal of a popup as a delivery, and the counts below would be
 * counting the wrong thing.
 */
const fakeHelper = (dir, sent = join(dir, "sent.log")) => {
  const helper = join(dir, "oc-notify")
  writeFileSync(
    helper,
    `#!/usr/bin/env bash\n[[ -n "\${LACODE_NOTIFY_CLOSE:-}" ]] && exit 0\nprintf '%s\\n' "$*" >> ${sent}\n`,
    { mode: 0o755 },
  )
  return helper
}

const {
  Notifier,
  claimCompletion,
  markCompletion,
  claimNotification,
  helperArgv,
  notifyMessage,
  questionHeadline,
  releaseCompletion,
  safeCorrelationKey,
  safeTitle,
  shouldNotify,
} = await import(LIB)
const { notifyHooks: Notify } = await import(PLUGIN)

// The plugin claims the (session, kind) pair before it raises a popup, so that
// two processes never raise the same one. The claim lives in the notification
// state directory, and a suite must not write into the developer's own data
// directory -- so it is redirected into a temp one for the length of the run.
const NOTIFY_STATE_DIR = mkdtempSync(join(tmpdir(), "lacode-notify-"))
process.env.LACODE_NOTIFY_DIR = NOTIFY_STATE_DIR

// Every check builds a fresh notifyHooks instance, and the fix gives each
// instance its own claim token. Claims are cross-process state, so one check's
// claim would otherwise be treated as a competing instance in the next check.
// Each check is an independent world: start it with no claims.
const resetNotificationState = () => {
  rmSync(NOTIFY_STATE_DIR, { recursive: true, force: true })
  mkdirSync(NOTIFY_STATE_DIR, { recursive: true })
}

// ---------------------------------------------------------------------------
// Policy: what is worth notifying about
// ---------------------------------------------------------------------------

await check("a finished root session notifies with its title", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Fix the login redirect" },
    outcome: "done",
    sawMessage: true,
  })
  assert(decision.notify, "a root session that did work should notify")
  assert(decision.title.includes("Fix the login redirect"), `title should name the session: ${decision.title}`)
  assert(decision.urgency === "normal", "success should be normal urgency")
})

await check("subagents are suppressed", () => {
  // The requirement the whole plugin exists to satisfy: one notification per
  // thing the user asked for, not one per delegated child.
  const decision = shouldNotify({
    info: { id: "child", parentID: "root", title: "explore" },
    outcome: "done",
    sawMessage: true,
  })
  assert(!decision.notify, "a subagent must not notify")
  assert(decision.reason === "subagent", `reason should say subagent, got ${decision.reason}`)
})

await check("the cartographer session is suppressed", () => {
  // context-autoupdate creates it with no parentID, so structure alone cannot
  // exclude it. Without this, every file edit would announce the map update.
  const decision = shouldNotify({
    info: { id: "cm", title: "context (auto update)" },
    outcome: "done",
    sawMessage: true,
  })
  assert(!decision.notify, "the internal cartographer must not notify")
})

await check("a compaction is not a finished task", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Long refactor", time: { compacting: 12345 } },
    outcome: "done",
    sawMessage: true,
  })
  assert(!decision.notify, "compacting is mid-conversation, not completion")
  assert(decision.reason === "compacting", `reason should say compacting, got ${decision.reason}`)
})

await check("an untouched session does not notify", () => {
  const decision = shouldNotify({ info: { id: "s1", title: "New" }, outcome: "done", sawMessage: false })
  assert(!decision.notify, "an empty session is not finished work")
})

await check("a critical notification bypasses the cooldown", async () => {
  // The cooldown stops a burst of identical "ready" notices. It must not swallow
  // a failure: a session can error moments after it went busy, while the
  // cooldown from the transition is still holding.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)
  const client = {
    logs: [],
    app: { log: async () => {} },
    session: { get: async () => ({ data: { id: "r", title: "Deploy" } }) },
  }
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  // A "ready" inside the window, then an error inside the same window.
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "r", status: { type: "busy" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "r" } } })
  await new Promise((resolve) => setTimeout(resolve, 500))
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "r", error: { message: "boom" } } } })
  await new Promise((resolve) => setTimeout(resolve, 700))

  const lines = (existsSync(sent) ? readFileSync(sent, "utf8") : "").trim().split("\n").filter(Boolean)
  assert(lines.length === 2, `expected ready + error, got ${lines.length}: ${JSON.stringify(lines)}`)
  assert(lines[1].includes("critical"), `the error should be critical: ${lines[1]}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("an error notifies at critical urgency", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Deploy run" },
    outcome: "error",
    detail: "rate limited",
  })
  assert(decision.notify, "an error should notify even without a prior turn")
  assert(decision.urgency === "critical", "an error should be critical")
  assert(notifyMessage("error", "rate limited").includes("rate limited"), "the detail should be included")
})

await check("a missing session id never notifies", () => {
  assert(!shouldNotify({ info: undefined, outcome: "done" }).notify, "no info, no notification")
  assert(!shouldNotify({ info: {}, outcome: "done" }).notify, "no id, no notification")
})

await check("the title names the workspace and the session", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Fix it", directory: "/home/me/proj" },
    outcome: "done",
    sawMessage: true,
  })
  assert(decision.notify, "a root session that did work should notify")
  assert(decision.title === "proj - Fix it", `title should be "proj - Fix it", got ${JSON.stringify(decision.title)}`)
})

await check("a session with no directory keeps the session-only title", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Fix it" },
    outcome: "done",
    sawMessage: true,
  })
  assert(decision.notify, "a root session that did work should notify")
  assert(decision.title === "Fix it", `title should have no dangling separator, got ${JSON.stringify(decision.title)}`)
})

await check("an internal session with a directory is still suppressed", () => {
  const decision = shouldNotify({
    info: { id: "cm", title: "context (auto update)", directory: "/home/me/proj" },
    outcome: "done",
    sawMessage: true,
  })
  assert(!decision.notify, "the workspace prefix must not defeat the internal-session check")
  assert(decision.reason === "internal session", `reason should say internal session, got ${decision.reason}`)
})

await check("a long title is capped and keeps the workspace prefix", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "x".repeat(200), directory: "/home/me/proj" },
    outcome: "done",
    sawMessage: true,
  })
  assert(decision.notify, "a root session that did work should notify")
  assert(decision.title.length <= 90, `title must be capped at 90 chars, got ${decision.title.length}`)
  assert(decision.title.startsWith("proj - "), `the workspace prefix must survive truncation, got ${JSON.stringify(decision.title)}`)
})

// A suspended Bluetooth sink eats the first few hundred ms, so the chime must outlast the wake.
await check("notification sounds outlast a suspended Bluetooth sink wake", async () => {
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const outcomes = ["done", "error", "permission", "question"]
  for (const outcome of outcomes) {
    const path = join(HERE, "..", "sounds", `${outcome}.wav`)
    const data = readFileSync(path)
    assert(data.subarray(0, 4).toString() === "RIFF", `${outcome}.wav must be RIFF`)
    assert(data.subarray(8, 12).toString() === "WAVE", `${outcome}.wav must be WAVE`)
    let i = 12
    let fmt = null
    let d = null
    while (i < data.length) {
      const cid = data.subarray(i, i + 4).toString()
      const clen = data.readUInt32LE(i + 4)
      if (cid === "fmt ") fmt = data.subarray(i + 8, i + 8 + clen)
      if (cid === "data") d = data.subarray(i + 8, i + 8 + clen)
      i += 8 + clen + (clen % 2)
    }
    assert(fmt && d, `${outcome}.wav must have fmt and data chunks`)
    const channels = fmt.readUInt16LE(2)
    const sampleRate = fmt.readUInt32LE(4)
    const bitsPerSample = fmt.readUInt16LE(14)
    assert(channels === 1, `${outcome}.wav must be mono`)
    assert(sampleRate === 22050, `${outcome}.wav must be 22050 Hz`)
    assert(bitsPerSample === 16, `${outcome}.wav must be 16-bit`)
    const samples = d.length / 2
    const duration = samples / sampleRate
    assert(duration >= 0.8, `${outcome}.wav duration ${duration}s must be >= 0.8 s`)
    let peak = 0
    for (let s = 0; s < samples; s++) {
      const v = Math.abs(d.readInt16LE(s * 2))
      if (v > peak) peak = v
    }
    assert(peak >= 0.8 * 32767, `${outcome}.wav peak ${peak} must be >= ${Math.floor(0.8 * 32767)}`)
  }
})

// ---------------------------------------------------------------------------
// Wording: what the reader must do, not what opencode did
// ---------------------------------------------------------------------------

await check("the two useful outcomes say what they want from you", () => {
  assert(
    notifyMessage("done") === "Task finished, waiting for your review",
    `done should name the review step, got ${JSON.stringify(notifyMessage("done"))}`,
  )
  assert(
    notifyMessage("question") === "Awaiting your response",
    `question should ask for an answer, got ${JSON.stringify(notifyMessage("question"))}`,
  )
  assert(
    !/session (finished|ended|complete)/i.test(notifyMessage("done")),
    "the session is still open; 'session finished' overstates it",
  )
})

await check("a question names itself so it can be answered without the terminal", () => {
  assert(
    notifyMessage("question", "Pick A or B?").includes("Pick A or B?"),
    "the question text should be included",
  )
})

await check("a question is normal urgency, not critical", () => {
  const decision = shouldNotify({ info: { id: "s1", title: "Deploy" }, outcome: "question" })
  assert(decision.notify, "a question should notify")
  assert(decision.urgency === "normal", `a question is routine, got ${decision.urgency}`)
})

await check("the question headline picks the first real question", () => {
  assert(questionHeadline([{ question: "Which option?" }]) === "Which option?", "plain question")
  assert(questionHeadline([{ question: "  " }, { question: "Second?" }]) === "Second?", "skips blank")
  assert(questionHeadline(undefined) === "", "no questions, no headline")
  assert(questionHeadline([{ question: "x".repeat(200) }]).length <= 70, "long questions are truncated")
})

await check("an unanswered question suppresses the redundant 'finished'", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Deploy" },
    outcome: "done",
    sawMessage: true,
    awaitingResponse: true,
  })
  assert(
    !decision.notify && decision.reason === "awaiting your response",
    `the idle after a question must not claim the task finished, got ${JSON.stringify(decision)}`,
  )
})

// ---------------------------------------------------------------------------
// Permissions: the one notification that can be answered where it sits
// ---------------------------------------------------------------------------

await check("[US-25] a permission decision carries the request id; nothing else does", () => {
  // The request id is what a reply is addressed to, so it is carried exactly
  // when the notification can act on it: a permission outcome with an id is
  // actionable, the same outcome without one is a plain notice, and no other
  // outcome ever grows the key -- a done or a question has nothing to answer.
  const actionable = shouldNotify({ info: { id: "s1", title: "Deploy" }, outcome: "permission", requestID: "p1" })
  assert(actionable.notify, "a permission prompt should notify")
  assert(
    JSON.stringify(actionable.actionable) === JSON.stringify({ requestID: "p1" }),
    `the id must be carried as actionable, got ${JSON.stringify(actionable)}`,
  )

  const plain = shouldNotify({ info: { id: "s1", title: "Deploy" }, outcome: "permission" })
  assert(plain.notify, "a permission without an id is still worth announcing")
  assert(!("actionable" in plain), `without an id there is nothing to answer: ${JSON.stringify(plain)}`)

  for (const outcome of ["done", "question", "error"]) {
    const decision = shouldNotify({
      info: { id: "s1", title: "Deploy" },
      outcome,
      ...(outcome === "done" ? { sawMessage: true } : {}),
      ...(outcome === "error" ? { detail: "boom" } : {}),
    })
    assert(decision.notify, `${outcome} should notify`)
    assert(!("actionable" in decision), `${outcome} must never carry actionable: ${JSON.stringify(decision)}`)
  }
})

// ---------------------------------------------------------------------------
// Title hygiene: session titles are user text that lands in a notification
// ---------------------------------------------------------------------------

await check("control characters are stripped from titles", () => {
  const title = safeTitle("Fix\u0007 the \u001b[31mredirect\u0000")
  // eslint-disable-next-line no-control-regex
  assert(!/[\u0000-\u001f\u007f]/.test(title), `control characters survived: ${JSON.stringify(title)}`)
  assert(title.includes("Fix the"), `text should be preserved: ${JSON.stringify(title)}`)
})

await check("long titles are truncated for the desktop", () => {
  const title = safeTitle("x".repeat(400))
  assert(title.length <= 90, `expected a cap near 90, got ${title.length}`)
  assert(title.endsWith("…"), "truncation should be visible")
})

await check("an empty or missing title still yields something usable", () => {
  assert(safeTitle(undefined) === "session", "undefined should fall back")
  assert(safeTitle("   ") === "session", "whitespace should fall back")
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

await check("cooldown suppresses a rapid second notification", () => {
  const notifier = new Notifier(5_000)
  assert(notifier.allow("s1", 1_000), "the first should be allowed")
  assert(!notifier.allow("s1", 2_000), "a second inside the window should be suppressed")
  assert(notifier.allow("s1", 7_000), "one past the window should be allowed again")
})

await check("cooldown is per session", () => {
  const notifier = new Notifier(5_000)
  assert(notifier.allow("s1", 1_000), "s1 first")
  assert(notifier.allow("s2", 1_100), "a different session is unaffected")
})

await check("the rate limiter bounds its bookkeeping", () => {
  const notifier = new Notifier(1_000)
  for (let i = 0; i < 600; i++) notifier.allow(`session-${i}`, i)
  // Old entries must be evicted rather than growing for the life of the process.
  assert(notifier.lastSentSize() <= 500, `expected eviction, size is ${notifier.lastSentSize()}`)
})

// ---------------------------------------------------------------------------
// The plugin wiring
// ---------------------------------------------------------------------------

const pluginSrc = readFileSync(PLUGIN, "utf8")

await check("the plugin module exports exactly one binding", () => {
  // opencode calls every export of every plugins/ file and uses the return value
  // as its hooks object, so a second export is a second broken plugin. Same rule
  // for the published package, which is why only src/index.ts exports a plugin
  // and every other module under src/ is a factory.
  const exports = [...pluginSrc.matchAll(/^export (?:const|function|class|default)\s+(\w+)/gm)].map((m) => m[1])
  assert(exports.length === 1, `expected 1 export, found ${exports.length}: ${exports.join(", ")}`)
  assert(exports[0] === "notifyHooks", `unexpected export name ${exports[0]}`)
})

await check("the single plugin shim re-exports the whole plugin, and nothing else", () => {
  // A plugin file must export exactly one plugin. This directory is what
  // bin/oc-sync ships to a host, where opencode auto-discovers every file in
  // plugins/ and calls every export as a plugin -- so if the shim ever grows a
  // second export, every hook dispatch in the process breaks.
  const shim = readFileSync(SHIM, "utf8")
  const bindings = [...shim.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()))
  const direct = [...shim.matchAll(/^export (?:const|function|class|default)\s+/gm)]
  assert(bindings.length === 1 && direct.length === 0,
    `a plugin file must export exactly one plugin, found ${bindings.length + direct.length}`)
  assert(bindings[0] === "LaCode", `unexpected shim export ${bindings[0]}`)
})

await check("the plugin defers to the tested tunnel helper", () => {
  // A second notification implementation in TypeScript is a second thing to get
  // wrong; oc-notify is the one already verified against both hosts.
  assert(/oc-notify/.test(pluginSrc), "should locate the oc-notify helper")
  assert(!/notify-send/.test(pluginSrc), "should not call notify-send directly")
})

await check("the plugin passes argv, not a shell string", () => {
  assert(/spawn\(helper, helperArgv\(/.test(pluginSrc), "should spawn the helper with an argv array built for its shape")
  assert(!/exec\(/.test(pluginSrc), "should not build a shell command string")
})

await check("the helper's argv matches the CLI that was found", () => {
  // oc-notify takes TITLE first; the lacode CLI takes `notify TITLE ...`. The
  // shipped bug passed the oc-notify shape to dist/lacode.js and got
  // "unknown command" -- found, spawned, and useless.
  const argv = (helper) => JSON.stringify(helperArgv(helper, "T", "M", "normal", "icon", "none"))
  assert(argv("/x/oc-notify") === JSON.stringify(["T", "M", "normal", "icon", "none"]), `oc-notify keeps TITLE first, got ${argv("/x/oc-notify")}`)
  assert(argv("/x/lacode") === JSON.stringify(["notify", "T", "M", "normal", "icon", "none"]), `the lacode CLI takes the notify subcommand, got ${argv("/x/lacode")}`)
  assert(argv("/pkg/dist/lacode.js") === JSON.stringify(["notify", "T", "M", "normal", "icon", "none"]), `dist/lacode.js is the lacode CLI, got ${argv("/pkg/dist/lacode.js")}`)
})

await check("a lacode-shaped helper wins over oc-notify and carries the sound", async () => {
  // Both candidates exist: a bash oc-notify in ~/bin, and the package's own
  // lacode CLI (dist/lacode.js, or bin/lacode in a checkout). The lacode-shaped
  // one must win -- the bash path execs bin/oc, whose OC_NOTIFY_ONLY branch
  // drops the sound name, so it can never play the outcome's sound.
  //
  // The package CLI is the real one, so the fake PATH below intercepts what it
  // would reach: node is forwarded to the real binary (and its argv recorded),
  // notify-send records the delivery instead of raising a desktop popup, and
  // paplay is a no-op so the suite stays silent.
  const dir = mkdtempSync(join(tmpdir(), "notify-helper-order-"))
  const home = join(dir, "home")
  const fakeBin = join(dir, "path")
  const ocNotifyLog = join(dir, "oc-notify.log")
  const nodeArgsLog = join(dir, "node-args.log")
  const sentLog = join(dir, "notify-send.log")
  mkdirSync(join(home, "bin"), { recursive: true })
  mkdirSync(fakeBin, { recursive: true })

  const bashHelper = join(home, "bin", "oc-notify")
  writeFileSync(bashHelper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ocNotifyLog)}\n`, { mode: 0o755 })
  writeFileSync(
    join(fakeBin, "node"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(nodeArgsLog)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  )
  writeFileSync(join(fakeBin, "notify-send"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sentLog)}\nexit 0\n`, { mode: 0o755 })
  writeFileSync(join(fakeBin, "paplay"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })

  const previous = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    OC_NOTIFY_HELPER: process.env.OC_NOTIFY_HELPER,
    LACODE_SOUND: process.env.LACODE_SOUND,
    SSH_CLIENT: process.env.SSH_CLIENT,
    SSH_TTY: process.env.SSH_TTY,
  }
  process.env.HOME = home
  process.env.PATH = `${fakeBin}${process.env.PATH ? `:${process.env.PATH}` : ""}`
  delete process.env.OC_NOTIFY_HELPER
  delete process.env.LACODE_SOUND
  delete process.env.SSH_CLIENT
  delete process.env.SSH_TTY
  try {
    const sessionID = `helper-order-${process.pid}`
    const client = {
      logs: [],
      app: { log: async () => {} },
      session: { get: async () => ({ data: { id: sessionID, title: "Helper order" } }) },
    }
    const hooks = await Notify({ client, directory: dir }, { sound: true })
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    // Scenario A: the bash helper is not the one that ran...
    const ocNotifyCalls = existsSync(ocNotifyLog) ? readFileSync(ocNotifyLog, "utf8").trim() : ""
    assert(ocNotifyCalls === "", `the bash oc-notify must lose to the lacode-shaped helper, got ${JSON.stringify(ocNotifyCalls)}`)

    // ...the package lacode CLI did, and it reached the local channel.
    const sent = existsSync(sentLog) ? readFileSync(sentLog, "utf8").trim() : ""
    assert(sent.includes("Helper order"), `the lacode-shaped helper should have delivered the notification, got ${JSON.stringify(sent)}`)

    // Scenario B: its argv carries the notify subcommand and the outcome's
    // sound name as the LAST payload field (the 5th after the subcommand).
    const args = existsSync(nodeArgsLog) ? readFileSync(nodeArgsLog, "utf8").replace(/\n$/, "").split("\n") : []
    const expected = ["notify", `${basename(dir)} - Helper order`, notifyMessage("done"), "normal", "utilities-terminal", "done"]
    assert(
      args.slice(-expected.length).join("\u0000") === expected.join("\u0000"),
      `expected the notify subcommand and sound as the last field, got ${JSON.stringify(args)}`,
    )
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

await check("the notification helper is detached", () => {
  assert(/detached: true/.test(pluginSrc), "a notification must not hold the server open")
  assert(/unref\(\)/.test(pluginSrc), "the child should be unreferenced")
})

await check("a missing helper warns once, never throws", () => {
  assert(/warnedHelper/.test(pluginSrc), "should remember that it already warned")
  assert(/no oc-notify helper found/.test(pluginSrc), "should say what is missing")
})

await check("the plugin is registered by directory, not config", async () => {
  // plugins/*.ts is auto-discovered, so no opencode.jsonc entry is needed. This
  // asserts the file is where discovery will find it.
  assert(existsSync(SHIM), "plugins/lacode.ts should exist so opencode auto-discovery finds the shim")
})

// ---------------------------------------------------------------------------
// End to end against the plugin's event handler
// ---------------------------------------------------------------------------

const makeClient = (sessions) => {
  const logs = []
  return {
    logs,
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      get: async ({ path: { id } }) => {
        const info = sessions[id]
        if (!info) return { error: { name: "NotFound" } }
        return { data: info }
      },
    },
  }
}

await check("the handler notifies for a root session and ignores a child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  // A stub helper so the handler's spawn target exists and we can observe calls.
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)
  mkdirSync(dir, { recursive: true })

  const sessions = {
    root: { id: "root", title: "Fix the login redirect" },
    child: { id: "child", parentID: "root", title: "explore" },
  }
  const client = makeClient(sessions)
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  const busy = { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } }
  await hooks.event({ event: busy })
  await hooks.event({ event: { type: "session.updated", properties: { info: sessions.root } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const lines = existsSync(sent) ? readFileSync(sent, "utf8").trim().split("\n").filter(Boolean) : []
  assert(lines.length === 1, `expected exactly one notification, got ${lines.length}: ${JSON.stringify(lines)}`)
  assert(lines[0].includes("Fix the login redirect"), `notification should name the session: ${lines[0]}`)
  assert(!lines[0].includes("explore"), "the subagent must not appear")

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

// question.asked is not in the pinned SDK's event types. The runtime emits it,
// so the handler must accept it off the wire anyway.
await check("question.asked notifies and names the question", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)

  const sessions = { root: { id: "root", title: "Fix the login redirect" } }
  const client = makeClient(sessions)
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({
    event: {
      type: "question.asked",
      properties: {
        sessionID: "root",
        questions: [{ question: "Which option should I pick?" }],
        tool: { messageID: "m1", callID: "c1" },
      },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const lines = existsSync(sent) ? readFileSync(sent, "utf8").trim().split("\n").filter(Boolean) : []
  assert(lines.length === 1, `expected one notification, got ${lines.length}: ${JSON.stringify(lines)}`)
  assert(lines[0].includes("Awaiting your response"), `wrong wording: ${lines[0]}`)
  assert(lines[0].includes("Which option should I pick?"), `the question should be named: ${lines[0]}`)
  assert(!lines[0].includes("critical"), "a question is not a failure")

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("the idle after a question does not also claim the task finished", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)

  const sessions = { root: { id: "root", title: "Deploy" } }
  const client = makeClient(sessions)
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await hooks.event({
    event: { type: "question.asked", properties: { sessionID: "root", questions: [{ question: "A or B?" }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const lines = existsSync(sent) ? readFileSync(sent, "utf8").trim().split("\n").filter(Boolean) : []
  assert(
    lines.length === 1,
    `the parked question is one blocked moment, not two notifications: ${JSON.stringify(lines)}`,
  )
  assert(!lines[0].includes("Task finished"), `nothing finished while blocked on a question: ${lines[0]}`)

  // Answering releases it: the next real completion must notify again.
  await hooks.event({ event: { type: "question.replied", properties: { sessionID: "root" } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await new Promise((resolve) => setTimeout(resolve, 5_200))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const after = readFileSync(sent, "utf8").trim().split("\n").filter(Boolean)
  assert(after.length === 2, `the completion after answering should notify, got ${JSON.stringify(after)}`)
  assert(after[1].includes("Task finished"), `expected the finished wording: ${after[1]}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a question clears when the session errors instead", async () => {
  // An error unblocks the session, so the parked-question suppression must not
  // survive it -- otherwise the next idle is judged against a stale question.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)

  const sessions = { root: { id: "root", title: "Deploy" } }
  const client = makeClient(sessions)
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await hooks.event({
    event: { type: "question.asked", properties: { sessionID: "root", questions: [{ question: "A or B?" }] } },
  })
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "root", error: { message: "boom" } } } })
  await new Promise((resolve) => setTimeout(resolve, 5_200))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const lines = readFileSync(sent, "utf8").trim().split("\n").filter(Boolean)
  // question + error only (the done that follows in the same turn is suppressed by the marker)
  assert(lines.length === 2, `question and error only (done suppressed by marker): ${JSON.stringify(lines)}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a failed delivery is logged as a failure, not as notified", async () => {
  // The bug this guards: oc-notify exits 0 even when the tunnel is unreachable,
  // and the plugin must not log "notified" regardless of the helper's exit
  // status. Five notifications would otherwise be logged as sent while nothing
  // reaches the desktop.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, "#!/usr/bin/env bash\necho 'oc: could not reach the local desktop' >&2\nexit 0\n", {
    mode: 0o755,
  })

  const client = makeClient({ root: { id: "root", title: "Remote task" } })
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 800))

  assert(
    !client.logs.some((line) => line.startsWith("info notified")),
    `a failed delivery must not be logged as notified: ${JSON.stringify(client.logs)}`,
  )
  assert(
    client.logs.some((line) => line.includes("could not reach")),
    `the helper's own diagnostic should reach the log: ${JSON.stringify(client.logs)}`,
  )

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a non-zero helper exit is a failure even with no stderr", async () => {
  // The hop's real failure is ssh exiting 255 with
  // "Permission denied (publickey,password)" -- which the tunnel's LogLevel=ERROR
  // suppresses on some paths, leaving nothing on stderr. Matching stderr text alone
  // logged that as "notified", which is how a dead tunnel looked healthy.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, "#!/usr/bin/env bash\nexit 255\n", { mode: 0o755 })

  const client = makeClient({ root: { id: "root", title: "Remote task" } })
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 800))

  assert(
    !client.logs.some((line) => line.startsWith("info notified")),
    `a silent non-zero exit must not be logged as notified: ${JSON.stringify(client.logs)}`,
  )

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a second question within the cooldown still notifies", async () => {
  // Gating questions on the cooldown strands the user: they answer the first one
  // fast, the model asks the second one a second later, and the session sits
  // parked on a prompt they were never told about. Same reasoning as the error
  // bypass -- a blocked session must not be swallowed.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)

  const client = makeClient({ root: { id: "root", title: "Deploy" } })
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  const ask = (text) =>
    hooks.event({ event: { type: "question.asked", properties: { sessionID: "root", questions: [{ question: text }] } } })

  await ask("First question?")
  await new Promise((resolve) => setTimeout(resolve, 600))
  await ask("Second question?")
  await new Promise((resolve) => setTimeout(resolve, 600))

  const lines = readFileSync(sent, "utf8").trim().split("\n").filter(Boolean)
  assert(lines.length === 2, `both questions should notify, got ${lines.length}: ${JSON.stringify(lines)}`)
  assert(lines[1].includes("Second question?"), `the second question must be named: ${lines[1]}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a rejected question stops suppressing later completions", async () => {
  // Dismissing a question rather than answering it is a real path. If `pending`
  // survives it, every later "Task finished" for that session is silently
  // dropped -- the notification stops working for that session entirely.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)

  const client = makeClient({ root: { id: "root", title: "Deploy" } })
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await hooks.event({
    event: { type: "question.asked", properties: { sessionID: "root", questions: [{ question: "A or B?" }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  await hooks.event({
    event: { type: "question.rejected", properties: { sessionID: "root", requestID: "que_1" } },
  })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await new Promise((resolve) => setTimeout(resolve, 5_200))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const lines = readFileSync(sent, "utf8").trim().split("\n").filter(Boolean)
  assert(lines.length === 2, `the completion after a rejection should notify: ${JSON.stringify(lines)}`)
  assert(lines[1].includes("Task finished"), `expected the finished wording: ${lines[1]}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("deleting a session clears its parked question and busy marker", async () => {
  // The in-process maps must not outlive the session, or a deleted session that
  // had asked a question would keep suppressing anything reusing its id.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)

  const client = makeClient({ root: { id: "root", title: "Deploy" } })
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await hooks.event({
    event: { type: "question.asked", properties: { sessionID: "root", questions: [{ question: "A or B?" }] } },
  })
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "root", title: "Deploy" } } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } })
  await new Promise((resolve) => setTimeout(resolve, 5_200))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const lines = readFileSync(sent, "utf8").trim().split("\n").filter(Boolean)
  // Exactly two notifications are raised here: the question, and the completion
  // that follows the deletion. The second one is the point of the check -- the
  // parked question was cleared, so the completion is announced instead of
  // being swallowed as "still waiting for you", and the busy marker works
  // again, so the session counts as having done work.
  //
  // The count says NOTHING about the popup record, in either direction.
  // `announce()` awaits session.get before it records the popup, so a deletion
  // that lands inside that window is lost and the popup record is created
  // afterwards: a stray record for a session that is gone. That is a known
  // trade-off in the plugin (the helper is asked to close it, and the desktop
  // has nothing to close for a session that does not exist), so this check
  // asserts the parked question and the busy marker, and neither the presence
  // nor the absence of that record.
  assert(lines.length === 2, `state must be cleared on delete: ${JSON.stringify(lines)}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("an idle event with no prior work does not notify", async () => {
  // An opened-but-unused session idles too. Without the busy marker every
  // launch of opencode would announce an empty session.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)
  const sessions = { idle: { id: "idle", title: "New" } }
  const client = makeClient(sessions)
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "idle" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const body = existsSync(sent) ? readFileSync(sent, "utf8") : ""
  assert(body === "", `expected no notification, got: ${body}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a title seen before the idle event is used as a fallback", async () => {
  // session.get can be the slower of the two; the plugin keeps the last title it
  // saw so the notification still names the session.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = fakeHelper(dir, sent)
  const client = {
    logs: [],
    app: { log: async () => {} },
    // Returns an id but no title: the fallback has to carry it.
    session: { get: async () => ({ data: { id: "r" } }) },
  }
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.updated", properties: { info: { id: "r", title: "Named by event" } } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "r", status: { type: "busy" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "r" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const body = existsSync(sent) ? readFileSync(sent, "utf8") : ""
  assert(body.includes("Named by event"), `expected the cached title, got: ${body}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("the handler swallows a session.get failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const client = {
    logs: [],
    app: { log: async () => {} },
    session: { get: async () => { throw new Error("boom") } },
  }
  const hooks = await Notify({ client, directory: dir })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "nope" } } })
  assert(true, "a failed lookup must not throw out of the handler")
  rmSync(dir, { recursive: true, force: true })
})

// The request id travels in the ENVIRONMENT, not the argv. The helper's argv is
// a published contract shared by two CLIs and every sender; the request id is
// plugin bookkeeping no other caller knows about, so it must not cost the argv
// a field -- and a notification that answers nothing must not set it at all.

await check("[US-25] the request id reaches the helper as LACODE_REQUEST_ID, and the argv is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  // Each helper records its argv NUL-separated and the request-id variable it
  // was handed, so both channels the id could travel through are observable
  // at once. Two helpers, because the plain path must be a different spawn,
  // not a second line in the same log.
  const record = (argvLog, envLog) =>
    `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > ${JSON.stringify(argvLog)}\nprintf '%s' "\${LACODE_REQUEST_ID-}" > ${JSON.stringify(envLog)}\n`
  const argvLog = join(dir, "argv.log")
  const envLog = join(dir, "env.log")
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, record(argvLog, envLog), { mode: 0o755 })
  const plainArgvLog = join(dir, "plain-argv.log")
  const plainEnvLog = join(dir, "plain-env.log")
  const plainHelper = join(dir, "oc-notify-plain")
  writeFileSync(plainHelper, record(plainArgvLog, plainEnvLog), { mode: 0o755 })

  const client = makeClient({
    root: { id: "root", title: "Deploy" },
    other: { id: "other", title: "Other work" },
  })
  const hooks = await Notify({ client, directory: dir })
  const waitFor = async (file) => {
    for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const argvOf = (file) => {
    const raw = readFileSync(file, "utf8")
    return raw.endsWith("\0") ? raw.slice(0, -1).split("\0") : raw.split("\0")
  }

  // Deterministic wording: the remote suffix depends on this process's own
  // environment, and the assertions below are byte-exact.
  const previous = {
    sound: process.env.LACODE_SOUND,
    sshClient: process.env.SSH_CLIENT,
    sshTty: process.env.SSH_TTY,
    helper: process.env.OC_NOTIFY_HELPER,
  }
  delete process.env.LACODE_SOUND
  delete process.env.SSH_CLIENT
  delete process.env.SSH_TTY
  try {
    // The actionable path: a permission with an id.
    process.env.OC_NOTIFY_HELPER = helper
    await hooks.event({
      event: { type: "permission.asked", properties: { id: "p1", sessionID: "root", permission: "bash", patterns: ["*"], metadata: { command: "ls" } } },
    })
    await waitFor(argvLog)

    assert(
      JSON.stringify(argvOf(argvLog)) === JSON.stringify([`${basename(dir)} - Deploy`, "Awaiting your permission — run `ls`", "normal", "utilities-terminal", "permission"]),
      `the argv must stay the five published fields, got ${JSON.stringify(argvOf(argvLog))}`,
    )
    assert(readFileSync(envLog, "utf8") === "p1", `the request id must travel in the environment: ${JSON.stringify(readFileSync(envLog, "utf8"))}`)

    // The plain path: a question for another session, same helper contract.
    process.env.OC_NOTIFY_HELPER = plainHelper
    await hooks.event({
      event: { type: "question.asked", properties: { sessionID: "other", questions: [{ question: "A or B?" }] } },
    })
    await waitFor(plainArgvLog)

    assert(
      JSON.stringify(argvOf(plainArgvLog)) === JSON.stringify([`${basename(dir)} - Other work`, "Awaiting your response — A or B?", "normal", "utilities-terminal", "question"]),
      `a notification that asks nothing keeps the same argv shape, got ${JSON.stringify(argvOf(plainArgvLog))}`,
    )
    assert(readFileSync(plainEnvLog, "utf8") === "", "no request id may be set for a notification that answers nothing")
  } finally {
    if (previous.sound === undefined) delete process.env.LACODE_SOUND
    else process.env.LACODE_SOUND = previous.sound
    if (previous.sshClient === undefined) delete process.env.SSH_CLIENT
    else process.env.SSH_CLIENT = previous.sshClient
    if (previous.sshTty === undefined) delete process.env.SSH_TTY
    else process.env.SSH_TTY = previous.sshTty
    if (previous.helper === undefined) delete process.env.OC_NOTIFY_HELPER
    else process.env.OC_NOTIFY_HELPER = previous.helper
    rmSync(dir, { recursive: true, force: true })
  }
})

// The two spawn bounds. Both live on the TRANSPORT, not on which notifications
// are decided: a blocked session must never be silenced, but it also must not be
// able to start an unbounded number of helper processes.
//
// Neither test injects the `deliver` seam -- that would bypass the spawn these
// bounds exist to constrain and make the test assert nothing. Both drive the real
// spawn through a fake OC_NOTIFY_HELPER and read the delivery detail back out of
// the log the failure path already writes.

// Collects the `detail` the plugin logs when a delivery does not succeed.
const collecting = () => {
  const details = []
  const client = {
    app: {
      log: async ({ body }) => {
        if (body.message === "notification failed" && body.extra?.detail) details.push(body.extra.detail)
      },
    },
    session: { get: async () => ({ data: { id: "r", title: "Deploy" } }) },
  }
  return { client, details }
}
// An unrecognized error notifies, and blocking outcomes bypass the cooldown, so
// each of these is a distinct delivery rather than a suppressed duplicate.
const fireError = (hooks, message) =>
  hooks.event({ event: { type: "session.error", properties: { sessionID: "r", error: { message } } } })

await check("the helper spawn is capped, and the cap drops only the excess", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-cap-"))
  // Slow enough that every notification is still in flight when the next arrives.
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nsleep 2\n`, { mode: 0o755 })
  const { client, details } = collecting()
  const hooks = await Notify({ client, directory: dir }, undefined, { maxInflightHelpers: 2, helperTimeoutMs: 30_000 })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "r", status: { type: "busy" } } } })
  for (const message of ["one", "two", "three", "four", "five"]) await fireError(hooks, `boom ${message}`)
  await new Promise((resolve) => setTimeout(resolve, 3500))

  const capped = details.filter((d) => d.includes("too many notification helpers in flight"))
  assert(capped.length === 3, `with a cap of 2 and five notifications, exactly three must be dropped, got ${capped.length}: ${JSON.stringify(details)}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a helper that never answers is reported as a timeout, not waited on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-timeout-"))
  const helper = join(dir, "oc-notify")
  // Far longer than the timeout under test: the point is that we do not wait.
  writeFileSync(helper, `#!/usr/bin/env bash\nsleep 30\n`, { mode: 0o755 })
  const { client, details } = collecting()
  const hooks = await Notify({ client, directory: dir }, undefined, { helperTimeoutMs: 300 })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.status", properties: { sessionID: "r", status: { type: "busy" } } } })
  await fireError(hooks, "never answers")
  await new Promise((resolve) => setTimeout(resolve, 900))

  assert(details.length === 1, `the hung helper must produce exactly one outcome, got ${details.length}: ${JSON.stringify(details)}`)
  assert(details[0].includes("timed out"), `a hung helper must be reported as a timeout, got: ${details[0]}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

rmSync(NOTIFY_STATE_DIR, { recursive: true, force: true })

console.log(`${passed} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// The cross-process claim: one winner, and only for a stale claim
// ---------------------------------------------------------------------------
//
// The claim is a file, so the guarantee is only real across processes. The race
// tests below spawn real ones; a test that calls claimNotification twice in one
// process would prove nothing about that bug, which is two processes judging
// the same stale claim at once.

const claimPath = (dir, sessionID, kind) =>
  join(dir, `claim.${safeCorrelationKey(`${sessionID}.${kind}`)}`)

const writeStaleClaim = (dir, sessionID, kind) => {
  const path = claimPath(dir, sessionID, kind)
  // A pid that cannot be running, and a timestamp older than the window: both
  // rules the claim uses to call a claim stale, independent of the clock.
  writeFileSync(path, "999999999")
  const old = new Date(Date.now() - 60_000)
  utimesSync(path, old, old)
  return path
}

const withClaimDir = async (dir, fn) => {
  const previous = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = dir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.LACODE_NOTIFY_DIR
    else process.env.LACODE_NOTIFY_DIR = previous
  }
}

// The helper is written into the test's temp dir, never checked in: the repo
// should not grow a script whose only caller is this test.
const writeClaimHelper = (dir) => {
  const helper = join(dir, "claim-helper.mjs")
  writeFileSync(
    helper,
    `import { existsSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const [library, sessionID, kind, ready, go] = process.argv.slice(2)
const { claimNotification } = await import(pathToFileURL(library).href)
writeFileSync(ready, "")
const deadline = Date.now() + 10_000
const slice = new Int32Array(new SharedArrayBuffer(4))
while (!existsSync(go)) {
  if (Date.now() > deadline) process.exit(2)
  Atomics.wait(slice, 0, 0, 1)
}
process.stdout.write(claimNotification(sessionID, kind) ? "won" : "lost")
`,
  )
  return helper
}

const startClaimer = (helper, dir, sessionID, kind, tag, go) => {
  const child = spawn(process.execPath, [helper, LIB, sessionID, kind, join(dir, `ready-${tag}`), go], {
    env: { ...process.env, LACODE_NOTIFY_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const done = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code, stdout, stderr }))
  })
  return { child, done }
}

const waitForFile = async (path, timeout = 10_000) => {
  const deadline = Date.now() + timeout
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("two processes claiming one stale notification produce exactly one winner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-claim-race-"))
  const sessionID = `race-${process.pid}-${Date.now()}`
  const kind = "done"
  const go = join(dir, "go")
  writeStaleClaim(dir, sessionID, kind)
  const helper = writeClaimHelper(dir)
  const first = startClaimer(helper, dir, sessionID, kind, "a", go)
  const second = startClaimer(helper, dir, sessionID, kind, "b", go)
  try {
    // Both processes are parked on the barrier, so they reach the takeover at
    // the same moment rather than whenever spawn happened to schedule them.
    await Promise.all([waitForFile(join(dir, "ready-a")), waitForFile(join(dir, "ready-b"))])
    writeFileSync(go, "")

    const results = await Promise.all([first.done, second.done])
    for (const result of results) {
      nodeAssert.equal(result.code, 0, `claimer failed: ${result.stderr}`)
    }
    const winners = results.filter((result) => result.stdout === "won")
    nodeAssert.equal(
      winners.length,
      1,
      `exactly one process may win the stale claim, got ${winners.length}: ${JSON.stringify(results.map((r) => r.stdout))}`,
    )
  } finally {
    first.child.kill()
    second.child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a fresh claim held by another live process is never taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-claim-fresh-"))
  const sessionID = `fresh-${process.pid}-${Date.now()}`
  const kind = "permission"
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
  try {
    await new Promise((resolve) => holder.once("spawn", resolve))
    const path = claimPath(dir, sessionID, kind)
    writeFileSync(path, String(holder.pid))

    const won = await withClaimDir(dir, () => claimNotification(sessionID, kind))
    nodeAssert.equal(won, false, "a fresh claim belongs to the other process")
    nodeAssert.equal(readFileSync(path, "utf8"), String(holder.pid), "the fresh claim must be left untouched")
  } finally {
    holder.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a stale claim is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-claim-stale-"))
  const sessionID = `stale-${process.pid}-${Date.now()}`
  const kind = "done"
  const path = writeStaleClaim(dir, sessionID, kind)
  try {
    const won = await withClaimDir(dir, () => claimNotification(sessionID, kind))
    nodeAssert.equal(won, true, "an abandoned claim must not stop the notification")
    nodeAssert.equal(readFileSync(path, "utf8"), `${process.pid}  done`, "the takeover must install the winner's pid")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The same process, two instances: the claim carries an instance token
// ---------------------------------------------------------------------------

test("claimNotification: same pid, different instance token -> second loses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-claim-instance-diff-"))
  const sessionID = `inst-diff-${process.pid}-${Date.now()}`
  const kind = "question"
  try {
    const first = await withClaimDir(dir, () => claimNotification(sessionID, kind, "token-A"))
    const second = await withClaimDir(dir, () => claimNotification(sessionID, kind, "token-B"))
    nodeAssert.equal(first, true, "the first instance must win the claim")
    nodeAssert.equal(second, false, "a claim held by another instance in this process must not be taken")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("claimNotification: same pid, same instance token -> own claim unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-claim-instance-same-"))
  const sessionID = `inst-same-${process.pid}-${Date.now()}`
  const kind = "question"
  try {
    const first = await withClaimDir(dir, () => claimNotification(sessionID, kind, "token-A"))
    const second = await withClaimDir(dir, () => claimNotification(sessionID, kind, "token-A"))
    nodeAssert.equal(first, true, "the first claim must be taken")
    nodeAssert.equal(second, true, "our own claim must never change our own behaviour")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("claimNotification: legacy two-field file, same pid -> returns true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-claim-instance-legacy-"))
  const sessionID = `inst-legacy-${process.pid}-${Date.now()}`
  const kind = "question"
  const path = claimPath(dir, sessionID, kind)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${process.pid} ${kind}`)
    const won = await withClaimDir(dir, () => claimNotification(sessionID, kind, "token-A"))
    nodeAssert.equal(won, true, "a legacy claim without a token must be treated as our own")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The per-session completion marker
// ---------------------------------------------------------------------------

test("completion: first claim wins, second loses (same or different kind)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-completion-basic-"))
  const sessionID = `basic-${process.pid}-${Date.now()}`
  try {
    const first = await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    nodeAssert.equal(first, true, "first claim should win")
    const secondSame = await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    nodeAssert.equal(secondSame, false, "second same-kind claim should lose")
    const secondDiff = await withClaimDir(dir, () => claimCompletion(sessionID, "error"))
    nodeAssert.equal(secondDiff, false, "different kind still loses: marker is per session")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("completion: release allows re-claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-completion-release-"))
  const sessionID = `release-${process.pid}-${Date.now()}`
  try {
    await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    await withClaimDir(dir, () => releaseCompletion(sessionID))
    const again = await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    nodeAssert.equal(again, true, "after release a new claim should win")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("completion: different sessions do not interfere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-completion-sessions-"))
  const a = `sa-${process.pid}-${Date.now()}`
  const b = `sb-${process.pid}-${Date.now()}`
  try {
    const r1 = await withClaimDir(dir, () => claimCompletion(a, "done"))
    const r2 = await withClaimDir(dir, () => claimCompletion(b, "done"))
    nodeAssert.equal(r1, true, "first session should claim")
    nodeAssert.equal(r2, true, "second session should claim")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("completion: a foreign dead pid marker still suppresses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-completion-foreign-"))
  const sessionID = `foreign-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `completion.${safeCorrelationKey(sessionID)}`)
    writeFileSync(path, "999999999 done\n")
    const won = await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    nodeAssert.equal(won, false, "an existing marker suppresses regardless of pid")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("completion: a missing state directory is created and the claim succeeds", async () => {
  const parent = mkdtempSync(join(tmpdir(), "lacode-completion-missing-"))
  const dir = join(parent, "nested", "state")
  const sessionID = `missing-${process.pid}-${Date.now()}`
  try {
    const won = await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    nodeAssert.equal(won, true, "claim should succeed when dir is created")
    nodeAssert.ok(existsSync(dir), "state directory should be created")
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("completion: markCompletion creates a marker when absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-completion-mark-"))
  const sessionID = `mark-${process.pid}-${Date.now()}`
  try {
    await withClaimDir(dir, () => markCompletion(sessionID, "error"))
    const claimed = await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    nodeAssert.equal(claimed, false, "a marker written by markCompletion suppresses a later claim")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("completion: markCompletion overwrites an existing marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-completion-mark-overwrite-"))
  const sessionID = `markow-${process.pid}-${Date.now()}`
  try {
    await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    await withClaimDir(dir, () => markCompletion(sessionID, "error"))
    const claimed = await withClaimDir(dir, () => claimCompletion(sessionID, "done"))
    nodeAssert.equal(claimed, false, "claim still returns false after overwrite")
    const path = join(dir, `completion.${safeCorrelationKey(sessionID)}`)
    const content = readFileSync(path, "utf8")
    nodeAssert.ok(content.includes("error"), `marker content should include error: ${content}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const writeCompletionHelper = (dir) => {
  const helper = join(dir, "completion-helper.mjs")
  writeFileSync(
    helper,
    `import { existsSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const [library, sessionID, kind, ready, go] = process.argv.slice(2)
const { claimCompletion } = await import(pathToFileURL(library).href)
writeFileSync(ready, "")
const deadline = Date.now() + 10_000
const slice = new Int32Array(new SharedArrayBuffer(4))
while (!existsSync(go)) {
  if (Date.now() > deadline) process.exit(2)
  Atomics.wait(slice, 0, 0, 1)
}
process.stdout.write(claimCompletion(sessionID, kind) ? "won" : "lost")
`,
  )
  return helper
}

test("two processes claiming one completion produce exactly one winner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lacode-completion-race-"))
  const sessionID = `race-${process.pid}-${Date.now()}`
  const kind = "done"
  const go = join(dir, "go")
  const helper = writeCompletionHelper(dir)
  const first = startClaimer(helper, dir, sessionID, kind, "a", go)
  const second = startClaimer(helper, dir, sessionID, kind, "b", go)
  try {
    await Promise.all([waitForFile(join(dir, "ready-a")), waitForFile(join(dir, "ready-b"))])
    writeFileSync(go, "")
    const results = await Promise.all([first.done, second.done])
    for (const result of results) {
      nodeAssert.equal(result.code, 0, `claimer failed: ${result.stderr}`)
    }
    const winners = results.filter((result) => result.stdout === "won")
    nodeAssert.equal(
      winners.length,
      1,
      `exactly one process may win the completion claim, got ${winners.length}: ${JSON.stringify(results.map((r) => r.stdout))}`,
    )
  } finally {
    first.child.kill()
    second.child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})