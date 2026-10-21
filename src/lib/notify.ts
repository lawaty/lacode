// Notification policy for plugins/notify.ts: which session transitions are worth
// a desktop notification, and what it should say.
//
// This is lib/, not plugins/, for the same reason lib/writer-rule.ts is: opencode
// treats every export of a file in plugins/ as a plugin and calls it with the
// plugin input, then uses the return value as its hooks object. A plain helper
// exported from there is invoked with the wrong arguments and poisons the hook
// registry, which stops the process starting.
//
// Everything here is pure so the policy can be tested without a running server.

import { isLimitText } from "./pool.ts"

const INTERNAL_TITLE_PREFIXES = [
  // context-autoupdate spawns the cartographer through the session API, with no
  // parentID, so it looks exactly like a root session going idle. Notifying for
  // it would announce the cartographer's own bookkeeping as a finished task.
  "context (auto",
]

// The four things worth interrupting someone for. Wording is deliberately about
// what *they* must do, not about what opencode did: a notification is only
// actionable if the reader can tell, in one line, whether they are the bottleneck.
//
// "Finished" is deliberately not "session finished". The session is still open --
// this is the agent handing control back, and saying "session ended" implies the
// work is over and the conversation closed, which is neither true nor useful.
//
// `permission` is kept separate from `question` rather than folded into it: the
// two are answered in different places and mean different things. "Awaiting your
// response" on a directory-access prompt tells the user nothing about what they
// are being asked to hand over.
export const NOTIFY_OUTCOMES = ["done", "question", "permission", "error"] as const
export type Outcome = (typeof NOTIFY_OUTCOMES)[number]

export const notifyMessage = (outcome: Outcome, detail?: string) => {
  if (outcome === "error") return detail ? `Failed — ${detail}` : "Failed"
  // The question's own text is appended when known. It is the difference between a
  // notification you must open a terminal to act on and one you can answer from
  // the notification itself, which is the whole reason to interrupt someone.
  if (outcome === "question") return detail ? `Awaiting your response — ${detail}` : "Awaiting your response"
  if (outcome === "permission") return detail ? `Awaiting your permission — ${detail}` : "Awaiting your permission"
  return "Task finished, waiting for your review"
}

/**
 * The argv the notification helper expects.
 *
 * The two helper CLIs do not share a shape: `oc-notify` takes TITLE first, the
 * `lacode` CLI takes a `notify` subcommand before it. Passing one shape to the
 * other is an immediate "unknown command" -- the helper is found, spawned, and
 * delivers nothing, which is the worst failure mode for a notification.
 *
 * Lives in lib/, not plugins/: opencode calls every export of a plugins/ file as
 * a plugin, so a second binding there poisons the hook registry (see the header).
 *
 * Both shapes take the same trailing fields, in the payload's own order: TITLE,
 * MESSAGE, URGENCY, ICON, SOUND.
 */
export const helperArgv = (helper: string, title: string, message: string, urgency: string, icon: string, sound: string): string[] => {
  const name = helper.split(/[\\/]/).pop() ?? ""
  return name === "lacode" || name === "lacode.js" ? ["notify", title, message, urgency, icon, sound] : [title, message, urgency, icon, sound]
}

/**
 * The replies opencode accepts for a permission request. "reject" is deny --
 * that is the server's word for it, not ours.
 */
export const PERMISSION_REPLIES = ["once", "always", "reject"] as const
export type PermissionReply = (typeof PERMISSION_REPLIES)[number]

/**
 * The environment variable the request id travels in. It is not an argument:
 * the helper's argv is a published contract, and the request id is not the
 * user-facing part of a notification.
 */
export const REQUEST_ID_ENV = "LACODE_REQUEST_ID"

// ---------------------------------------------------------------------------
// Terminal errors: what the notification says, and whether it says anything
// ---------------------------------------------------------------------------

// JSON.stringify throws on circular structures and answers `undefined` for
// values with no JSON form. Both are ordinary here, so serializing is
// best-effort too: an unserializable error simply has no text to match against.
const safeStringify = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value) ?? undefined
  } catch {
    return undefined
  }
}

// A message read out of a serialized object is a JSON string literal's body
// (`{"message":"a \"b\""}`), so it is decoded rather than unescaped by hand.
const decodeJsonString = (escaped: string): string => {
  try {
    const decoded = JSON.parse(`"${escaped}"`)
    return typeof decoded === "string" ? decoded : ""
  } catch {
    return ""
  }
}

// Control characters and runs of whitespace make a one-line desktop summary
// unreadable, so they are collapsed exactly as a session title's are.
const cleanDetail = (raw: string): string | undefined => {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  if (!clean) return undefined
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean
}

/**
 * The short human message of an arbitrary error, or `undefined` when it carries
 * none. Shape-agnostic on purpose: providers wrap failures as
 * `{ data: { message } }`, `{ message }`, or `{ error: "..." }`, and an object
 * whose fields are all non-enumerable still has its `"message":"..."` in the
 * serialized JSON. The first readable text wins.
 */
export const errorDetail = (error: unknown): string | undefined => {
  const candidates = [
    (error as { data?: { message?: unknown } } | null | undefined)?.data?.message,
    (error as { message?: unknown } | null | undefined)?.message,
    (error as { error?: unknown } | null | undefined)?.error,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const detail = cleanDetail(candidate)
    if (detail) return detail
  }
  const serialized = safeStringify(error)
  const match = serialized ? /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(serialized) : undefined
  if (match?.[1] !== undefined) {
    const detail = cleanDetail(decodeJsonString(match[1]))
    if (detail) return detail
  }
  return undefined
}

/**
 * Whether a TERMINAL session error is one the user must hear about.
 *
 * Two classes are recognized and handled elsewhere, so notifying for them
 * would double-report something the user already has:
 *   * rate limits / quota -- the pool cools the model and the request retries
 *     (matched textually, the way pool.ts matches, because providers word
 *     these differently every quarter)
 *   * user aborts -- they pressed escape; reporting their own action back is
 *     noise
 *
 * A null error -- a session.error event with no payload -- is not a failure
 * this plugin can describe, so it stays silent too.
 */
export const isUnrecognizedError = (error: unknown): boolean => {
  if (error == null) return false
  const name = (error as { name?: unknown } | null | undefined)?.name
  if (typeof name === "string" && /abort/i.test(name)) return false
  const serialized = safeStringify(error) ?? ""
  if (/MessageAbortedError|aborted/i.test(serialized)) return false
  if (isLimitText(serialized)) return false
  return true
}

export type SessionInfo = {
  id?: string
  parentID?: string
  title?: string
  time?: { compacting?: number }
}

export type Decision =
  | { notify: true; title: string; message: string; urgency: "normal" | "critical"; actionable?: { requestID: string } }
  | { notify: false; reason: string }

// A session title is user-visible text that lands in a notification, so it is
// stripped of control characters and length-capped rather than trusted.
export const safeTitle = (raw: string | undefined, fallback = "session") => {
  if (!raw) return fallback
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  if (!clean) return fallback
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean
}

// Why a given session transition should not raise a notification.
export const shouldNotify = (input: {
  info: SessionInfo | undefined
  outcome: Outcome
  detail?: string
  // A session created but never prompted is an empty shell, not finished work.
  sawMessage?: boolean
  // An unanswered question is outstanding in this session. Suppresses the
  // redundant "finished" that the idle event raises right after a question.
  awaitingResponse?: boolean
  // The runtime's permission request id. Carried only when the notification can
  // answer the permission itself.
  requestID?: string
}): Decision => {
  const { info, outcome, detail } = input

  if (!info?.id) return { notify: false, reason: "no session info" }

  // Subagents. This is the suppression the whole design turns on: every
  // explore/implement child session idles when it finishes, and a
  // session that dispatched ten of them would otherwise announce ten "ready"
  // notifications for work the user never asked about individually.
  if (info.parentID) return { notify: false, reason: "subagent" }

  const title = safeTitle(info.title)

  if (INTERNAL_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) {
    return { notify: false, reason: "internal session" }
  }

// Compaction rewrites history and idles the session, but no task finished:
  // the user is still mid-conversation. Sending "ready for you" here would
  // train them to dismiss the notification without reading it.
  if (info.time?.compacting) return { notify: false, reason: "compacting" }

  if (outcome === "done" && input.sawMessage === false) {
    return { notify: false, reason: "no work done" }
  }

  // A session blocked on a question has already told them. The idle event that
  // follows the question would otherwise fire a second notification for the same
  // blocked moment, and "task finished" is actively wrong there -- nothing
  // finished, the task is parked waiting on them.
  if (outcome === "done" && input.awaitingResponse) {
    return { notify: false, reason: "awaiting your response" }
  }

  // A question is a request for the user, not a failure, so it is not critical:
  // critical urgency escalates to a modal on most desktops, and this is a routine
  // part of working with an agent.
  const notification = {
    notify: true,
    title: `opencode — ${title}`,
    message: notifyMessage(outcome, detail),
    urgency: outcome === "error" ? "critical" : "normal",
  } as const

  // A permission prompt is the one notification the user can answer where it is,
  // so the answer does not need a second trip to the terminal.
  if (outcome === "permission" && input.requestID) {
    return { ...notification, actionable: { requestID: input.requestID } }
  }

  return notification
}

// A question can span several entries, and the notification should name the one
// that is actually blocking. Long questions are truncated rather than wrapped:
// this is a one-line desktop summary, and the full text is in the terminal.
export const questionHeadline = (questions: Array<{ question?: string }> | undefined) => {
  const first = questions?.find((entry) => typeof entry?.question === "string" && entry.question.trim())
  if (!first?.question) return ""
  const clean = safeTitle(first.question)
  return clean.length > 70 ? `${clean.slice(0, 69)}…` : clean
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * A `permission.asked` payload as the RUNTIME emits it.
 *
 * The field names here are not the SDK's, and that is the whole point of the
 * comment. `types.gen.d.ts` declares
 *
 *     type Permission = { id, type, pattern?, sessionID, title, metadata, time }
 *
 * and the v1 Event union offers `permission.updated` on that shape. Neither is
 * what the server actually emits. Decoded from the v1.18.35 bundle:
 *
 *     SX = D.Struct({ id, sessionID, permission: D.String,
 *                     patterns: D.Array(D.String), metadata, always,
 *                     tool: D.optional(...) }).annotate({identifier:"PermissionRequest"})
 *     _5 = Q_({ type: "permission.asked", schema: SX.fields })
 *
 * So the event is `permission.asked` and the fields are `permission`/`patterns`
 * -- different names, and `pattern` is an array here, not `string | string[]`.
 * The string never appears in the binary at all; `permission.ask` is declared by
 * the pinned `Hooks` type but `trigger("permission.ask")` is never called, so a
 * handler wired to it is dead code that looks live.
 *
 * Both spellings are therefore accepted, runtime-first. `permission` is the
 * field the server sends; `type` is the SDK's, kept so a payload shaped that way
 * still produces a named notification instead of the word "undefined".
 */
export type PermissionRequest = {
  /**
   * The runtime's permission REQUEST id; it is what a reply is addressed to,
   * and it is never shown to the user.
   */
  id?: string
  sessionID?: string
  /** The RUNTIME's field: the permission kind, e.g. `external_directory`. */
  permission?: string
  /** The RUNTIME's field: always an array, even for a single pattern. */
  patterns?: string[]
  metadata?: Record<string, unknown>
  /** The stale SDK spelling. Never sent by this runtime; tolerated. */
  type?: string
  /** The stale SDK spelling: `string | string[]`, singular. */
  pattern?: string | string[]
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined)

/** The permission kind, from whichever field this payload happens to carry. */
export const permissionKind = (request: PermissionRequest) => (str(request.permission) ?? str(request.type) ?? "")

/** The requested patterns, normalized across the array/scalar spellings. */
export const permissionPatterns = (request: PermissionRequest): string[] => {
  const list = Array.isArray(request.patterns) ? request.patterns : Array.isArray(request.pattern) ? request.pattern : [request.pattern]
  return list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
}

// A pattern is a glob, and `~/Projects/foo/*` tells the user less at a glance
// than `~/Projects/foo`. Trimmed exactly the way opencode's own TUI trims it
// when it renders this prompt (`slice(0, indexOf("*")).replace(/[\\/]+$/, "")`),
// so the notification names the same directory the prompt names.
const trimGlob = (raw: string) => {
  const star = raw.indexOf("*")
  return (star === -1 ? raw : raw.slice(0, star)).replace(/[\\/]+$/, "")
}

const shortenHome = (raw: string) => {
  const home = process.env.HOME ?? ""
  return home && raw.startsWith(`${home}/`) ? `~${raw.slice(home.length)}` : raw
}

/**
 * What the notification says is being asked for.
 *
 * A notification reading only "permission" is useless -- the user has to come
 * back to find out whether the agent wants a directory or a command. So the
 * kind and the thing it applies to are both in the message, and the field
 * precedence follows opencode's own: `metadata.parentDir` / `metadata.filepath`
 * before `patterns[0]`, because the metadata holds the real directory while the
 * pattern holds the glob written over it.
 */
export const permissionHeadline = (request: PermissionRequest) => {
  const kind = permissionKind(request)
  const patterns = permissionPatterns(request)
  const metadata = request.metadata ?? {}
  const meta = (key: string) => str(metadata[key])

  const requested = shortenHome(trimGlob(meta("parentDir") ?? meta("filepath") ?? patterns[0] ?? ""))

  if (kind === "external_directory") {
    return requested ? `access external directory ${requested}` : "access an external directory"
  }

  // A command is the thing itself, not a pattern to be rendered as a glob.
  const command = meta("command")
  if (kind === "bash" || kind === "shell") {
    return command ? `run \`${safeTitle(command, "a shell command")}\`` : "run a shell command"
  }

  const label = kind || "a tool"
  if (requested) return `${label} — ${requested}`
  if (patterns.length) return `${label} — ${patterns.join(", ")}`
  return `${label} is asking for permission`
}

// Rate limit. A root session can idle more than once in quick succession (a
// queued message, a retry, an abort), and a burst of identical notifications is
// worse than none. One per session per window.
const MAX_TRACKED = 500

export class Notifier {
  private readonly lastSent = new Map<string, number>()
  // Not a constructor parameter property: this module is loaded by node's
  // type-stripping loader, which does not support the shorthand.
  private readonly windowMs: number

  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  allow(sessionID: string, now: number) {
    const previous = this.lastSent.get(sessionID)
    if (previous !== undefined && now - previous < this.windowMs) return false
    this.record(sessionID, now)
    return true
  }

  // Record without asking. Used by the error path, which must bypass the window
  // rather than be blocked by it, but still needs the timestamp refreshed.
  record(sessionID: string, now: number) {
    this.lastSent.set(sessionID, now)
    this.evict(now)
  }

  private evict(now: number) {
    if (this.lastSent.size <= MAX_TRACKED) return
    // Drop oldest-first, not oldest-that-happens-to-be-expired: a burst of
    // sessions inside one window would otherwise all be "too recent" and the map
    // would keep growing, which is the exact leak this bound exists for. Map
    // preserves insertion order, and insertion order is send order.
    let excess = this.lastSent.size - MAX_TRACKED
    for (const key of this.lastSent.keys()) {
      if (excess-- <= 0) break
      this.lastSent.delete(key)
    }
  }

  // Exposed so the eviction test can assert on it: the map is otherwise
  // unreachable from outside, which would make the bound untestable.
  lastSentSize() {
    return this.lastSent.size
  }
}