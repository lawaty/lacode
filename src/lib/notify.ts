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

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
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

/**
 * The environment variable the correlation key travels in. It names the
 * session a popup belongs to, and it is not an argument either: the helper's
 * argv is a published contract, and the key is not the user-facing part of a
 * notification. It exists so the helper can find the popup again later and
 * close it.
 */
export const NOTIFY_SESSION_ENV = "LACODE_NOTIFY_SESSION"

/**
 * The environment variable that turns a helper run into a CLOSE request
 * instead of a notification. The value names the session whose popups are to
 * be taken down; the helper closes them and sends nothing at all.
 */
export const NOTIFY_CLOSE_ENV = "LACODE_NOTIFY_CLOSE"

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
  directory?: string
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

  const sessionTitle = safeTitle(info.title)

  if (INTERNAL_TITLE_PREFIXES.some((prefix) => sessionTitle.startsWith(prefix))) {
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
  //
  // The title is `workspace - session`. The popup's header only names the app
  // ("LaCode"), so the title has to say which project and which session the
  // notification belongs to; the workspace is the session directory's basename.
  const workspace = safeTitle(info.directory ? basename(info.directory) : "", "")
  const title = workspace ? safeTitle(`${workspace} - ${sessionTitle}`, sessionTitle) : sessionTitle
  const notification = {
    notify: true,
    title,
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

// ---------------------------------------------------------------------------
// The notification state directory, and the cross-process claim
// ---------------------------------------------------------------------------

/**
 * Where the ids of this machine's popups are kept, and where the
 * cross-process claims live.
 *
 * Resolved LAZILY, at call time, and never cached: `homedir()` reads HOME when
 * it is called, so a test that redirects HOME gets its own directory for free.
 * Computing it once at module load would pin the real one and let a suite
 * write into the developer's data directory.
 *
 * It lives in lib/ rather than in the tunnel because the plugin needs it too,
 * and `src/plugins/*` may import `src/lib/*` only. The tunnel re-exports it,
 * so its published surface does not change.
 */
export const notificationStateDir = (): string =>
  process.env.LACODE_NOTIFY_DIR ?? join(homedir(), ".local", "share", "opencode", "lacode", "notify")

/**
 * The name a correlation key is stored under.
 *
 * This rule is a CONTRACT with the bash side (`bin/oc`, `bin/oc-notify-receiver`):
 * every character outside `[A-Za-z0-9._-]` becomes `_`, and the name is
 * truncated to 64 characters. Both sides have to produce the identical name,
 * or the closer looks in a different file than the raiser wrote.
 */
export const safeCorrelationKey = (correlationKey: string): string =>
  correlationKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)

/** The file that holds the notification ids of one correlation key. */
export const notificationIdFile = (correlationKey: string): string =>
  join(notificationStateDir(), `${safeCorrelationKey(correlationKey)}.ids`)

// ---------------------------------------------------------------------------
// The cross-process claim
// ---------------------------------------------------------------------------
//
// WHY THE CLAIM EXISTS
//
// opencode publishes its events through a shared store, so EVERY opencode
// process on the machine that has this plugin loaded sees the same event: the
// same `session.idle`, the same `permission.asked`. The plugin's cooldown is
// per PROCESS, so it never caught that -- two processes, one event, two
// identical popups, seconds apart. The user saw the same thing twice and had
// no way of telling why.
//
// The claim is the one-winner file that says "this process is the one raising
// it". It lives in the notification state directory, so every process on the
// machine can see it, and it is taken with an EXCLUSIVE create -- the house
// pattern for a one-winner file (`src/lib/selfupdate.ts`'s `acquireLock`).
//
// The window is five seconds: the same window as the plugin's own cooldown.
// The claim is the cross-process twin of that cooldown, so it can never
// swallow a notification the cooldown would have allowed.

/** How long a claim is held for. The plugin's own cooldown window. */
const CLAIM_WINDOW_MS = 5_000

/**
 * Signal-0 liveness probe: true if `pid` is running. EPERM means alive but not
 * ours to signal.
 *
 * The same rule as `src/lib/pool.ts`'s `isPidAlive`, which is not exported
 * there; these three lines are the house rule for "is that pid still running".
 */
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The file that holds the claim of one (session, kind) pair.
 *
 * The key is the session id and the kind, run through the same sanitising
 * rule the id files use, so the name can never point outside the state
 * directory.
 */
const claimFile = (sessionID: string, kind: string): string =>
  join(notificationStateDir(), `claim.${safeCorrelationKey(`${sessionID}.${kind}`)}`)

/**
 * Take the claim for one (session, kind) pair, and say whether this process
 * won it.
 *
 * True means "you may notify". False means "another process is raising this
 * right now, keep quiet".
 *
 * The rules, in order:
 *   * the claim does not exist -> take it, with an exclusive create
 *   * the claim holds OUR pid -> it is our own claim, and our own claim never
 *     changes our own behaviour: the in-process cooldown is the only gate
 *   * the claim holds another LIVE pid and is younger than the window ->
 *     another process is raising this right now -> do not notify
 *   * anything else -> the claim is stale (its holder is gone, or it outlived
 *     the window) -> take it over under a takeover lock, after re-reading it
 *
 * The takeover is a compare-and-swap, not "unlink, then create": two processes
 * can judge the same stale claim at once, and an unconditional unlink lets the
 * slower one delete the fresh claim the faster one just created. The lock makes
 * exactly one process the unlinker, and the re-read under it refuses to touch a
 * claim that stopped being stale in the meantime.
 *
 * Nothing here throws. A claim that cannot be taken or read degrades to
 * "notify": a duplicate popup is better than a silent stall.
 */
export const claimNotification = (sessionID: string, kind: string): boolean => {
  const path = claimFile(sessionID, kind)
  try {
    mkdirSync(notificationStateDir(), { recursive: true })
  } catch {
    // No state directory means no claim. Notify anyway: the duplicate popup is
    // better than the stall.
    return true
  }

  /** "taken" is ours, "held" is somebody else's, "impossible" is nobody's. */
  const take = (): "taken" | "held" | "impossible" => {
    try {
      const fd = openSync(path, "wx")
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      return "taken"
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST" ? "held" : "impossible"
    }
  }

  const first = take()
  if (first !== "held") {
    // "taken" is ours. "impossible" means the claim could not be taken at all
    // -- a read-only directory, a full disk -- so notify: the same rule as
    // above.
    return true
  }

  /**
   * What the claim at `path` is, relative to this process.
   *
   * "gone" and "unknown" are different failures: a vanished file can still be
   * taken with an exclusive create, while an unreadable one cannot be judged
   * and must not stop a notification.
   */
  const judge = (): "ours" | "held" | "stale" | "gone" | "unknown" => {
    let raw: string
    try {
      raw = readFileSync(path, "utf8").trim()
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown"
    }

    let holder: number | undefined
    // The exclusive create and the write that fills it are two steps, and a
    // reader can land between them. An empty claim is a claim IN PROGRESS, not
    // an abandoned one.
    const empty = raw === ""
    if (!empty) {
      const parsed = Number.parseInt(raw, 10)
      holder = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }

    // Our own claim. It must never change our own behaviour.
    if (holder === process.pid) return "ours"

    let age = Number.POSITIVE_INFINITY
    try {
      age = Date.now() - statSync(path).mtimeMs
    } catch {
      return "gone"
    }

    if (empty && age < CLAIM_WINDOW_MS) {
      // A claim whose holder is still writing its pid: it is being raised right
      // now, by somebody.
      return "held"
    }
    if (holder !== undefined && isPidAlive(holder) && age < CLAIM_WINDOW_MS) {
      // Another live process is raising this right now.
      return "held"
    }

    // The holder is gone, or the claim outlived the window.
    return "stale"
  }

  const judged = judge()
  if (judged === "ours") return true
  if (judged === "held") return false
  if (judged === "unknown") return true
  // Gone between the exclusive create and the read: the exclusive create below
  // is still a one-winner election.
  if (judged === "gone") return take() !== "held"

  // Stale. The unlink must be a compare-and-swap, not an unconditional delete:
  // a second process may have judged the same claim stale and replaced it with
  // its own fresh claim in the meantime. The exclusive takeover lock makes one
  // process the only unlinking candidate, and the claim is judged AGAIN inside
  // it, so a fresh claim is never mistaken for the stale one.
  const lockPath = `${path}.takeover`
  const takeOver = (): (() => void) | undefined => {
    const create = (): (() => void) | undefined => {
      try {
        const fd = openSync(lockPath, "wx")
        try {
          writeSync(fd, String(process.pid))
        } finally {
          closeSync(fd)
        }
        return () => {
          try {
            unlinkSync(lockPath)
          } catch {
            // Already gone.
          }
        }
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EEXIST" ? undefined : () => {}
      }
    }

    const release = create()
    if (release !== undefined) return release

    // A lock is held only across a few synchronous filesystem calls, so one
    // that outlives the claim window -- or whose holder is gone -- belongs to a
    // process that died mid-takeover. Reclaim it once.
    let lockHolder: number | undefined
    let lockAge = Number.POSITIVE_INFINITY
    try {
      const parsed = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10)
      lockHolder = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
      lockAge = Date.now() - statSync(lockPath).mtimeMs
    } catch {
      // The lock vanished while we looked at it.
      return create()
    }
    // An empty lock is the exclusive create's own in-progress window, exactly
    // like an empty claim: young and unreadable means somebody is taking over,
    // not that the lock is abandoned.
    if (lockAge < CLAIM_WINDOW_MS && (lockHolder === undefined || isPidAlive(lockHolder))) {
      return undefined
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // Another process reclaimed it first.
      return undefined
    }
    return create()
  }

  const release = takeOver()
  // No lock means another process owns the takeover: stay quiet.
  if (release === undefined) return false

  try {
    const current = judge()
    if (current === "ours") return true
    if (current === "held") return false
    if (current === "unknown") return true
    // Still stale under the lock, or gone. Only this process can unlink it.
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
    // The create either succeeds (we notify) or loses to a process that saw
    // the claim gone and took it that way (we do not). Anything else -- a state
    // directory that cannot be written -- degrades to notifying.
    return take() !== "held"
  } finally {
    release()
  }
}

/**
 * Give the claim of one (session, kind) pair back.
 *
 * The file is removed ONLY while it still holds this process's pid: a claim
 * another process has since taken must never be removed by the previous
 * holder. A file that is gone, unreadable, or held by somebody else is left
 * exactly as it is.
 */
export const releaseNotificationClaim = (sessionID: string, kind: string): void => {
  const path = claimFile(sessionID, kind)
  try {
    const parsed = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return
    if (parsed !== process.pid) return
    unlinkSync(path)
  } catch {
    // Gone, or unreadable: there is nothing of ours to release.
  }
}

// ---------------------------------------------------------------------------
// The per-session completion marker
// ---------------------------------------------------------------------------

const completionFile = (sessionID: string): string =>
  join(notificationStateDir(), `completion.${safeCorrelationKey(sessionID)}`)

/**
 * One terminal popup per idle period, across processes. This is a marker, not
 * a lock: an existing file means a done/error popup was already raised for this
 * session, whatever pid it names and however old it is. The plugin deletes it
 * when the session goes busy (a new turn) or is deleted.
 */
export const claimCompletion = (sessionID: string, kind: string): boolean => {
  const path = completionFile(sessionID)
  try {
    mkdirSync(notificationStateDir(), { recursive: true })
    const fd = openSync(path, "wx")
    try {
      writeFileSync(fd, `${process.pid} ${kind}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    // Cannot take or read the marker: a duplicate popup beats a silent stall.
    return true
  }
}

/** Delete the completion marker for a session. Safe if absent; ignores errors. */
export const releaseCompletion = (sessionID: string): void => {
  try {
    unlinkSync(completionFile(sessionID))
  } catch {
    // already gone, or the state dir is not writable
  }
}

/**
 * Record that a terminal popup was announced for this session without gating
 * the caller. An error always announces, but it must still keep the done that
 * follows it in the same turn quiet, so it overwrites any marker left by an
 * earlier outcome.
 */
export const markCompletion = (sessionID: string, kind: string): void => {
  try {
    mkdirSync(notificationStateDir(), { recursive: true })
    const path = completionFile(sessionID)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${process.pid} ${kind}\n`)
    renameSync(tmp, path)
  } catch {
    // The marker is an optimisation; failing to write it must not block the popup.
  }
}
