import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
// The source of truth. plugins/notify.ts is a dev-only re-export shim so
// opencode's directory auto-discovery still finds this code in the working tree;
// the published package has one plugin, src/index.ts, and the suites test the
// factories that index.ts composes.
const PLUGIN = join(HERE, "..", "src", "plugins", "notify.ts")
const SHIM = join(HERE, "..", "plugins", "notify.ts")
const LIB = join(HERE, "..", "src", "lib", "notify.ts")

let passed = 0
const failures = []

const check = async (name, fn) => {
  try {
    await fn()
    passed++
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const { Notifier, helperArgv, notifyMessage, questionHeadline, safeTitle, shouldNotify } = await import(LIB)
const { notifyHooks: Notify } = await import(PLUGIN)

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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
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

await check("the dev shim re-exports it under the plugin name, and nothing else", () => {
  // A plugin file must export exactly one plugin. The shim exists only so
  // opencode's plugins/ auto-discovery keeps working locally; if it ever grows a
  // second export, every hook dispatch in the process breaks.
  const shim = readFileSync(SHIM, "utf8")
  const bindings = [...shim.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()))
  const direct = [...shim.matchAll(/^export (?:const|function|class|default)\s+/gm)]
  assert(bindings.length === 1 && direct.length === 0,
    `a plugin file must export exactly one plugin, found ${bindings.length + direct.length}`)
  assert(bindings[0] === "Notify", `unexpected shim export ${bindings[0]}`)
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
  assert(existsSync(SHIM), "plugins/notify.ts should exist so opencode auto-discovery finds the shim")
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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })

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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })

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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })

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
  assert(lines.length === 3, `question, error, then the real completion: ${JSON.stringify(lines)}`)
  assert(lines[2].includes("Task finished"), `the last one is a real completion: ${lines[2]}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a failed delivery is logged as a failure, not as notified", async () => {
  // The bug this guards: oc-notify exits 0 even when the tunnel is unreachable,
  // and the plugin used to log "notified" regardless. Five notifications were
  // logged as sent while nothing reached the desktop.
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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })

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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })

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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })

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
  assert(lines.length === 2, `state must be cleared on delete: ${JSON.stringify(lines)}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("an idle event with no prior work does not notify", async () => {
  // An opened-but-unused session idles too. Without the busy marker every
  // launch of opencode would announce an empty session.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
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
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
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

console.log(`${passed} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}