// The one-time feedback hint: copy, opt-outs and the local flag that says it
// has been shown. No telemetry, no analytics, no network request -- the only
// thing this module persists is the fact that the user has seen the note.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const ISSUES_URL = "https://github.com/lawaty/lacode/issues"
export const DISCUSSIONS_URL = "https://github.com/lawaty/lacode/discussions"

/** The user's explicit off switch, like LACODE_NO_SELFUPDATE. */
export const FEEDBACK_HINT_ENV = "LACODE_NO_FEEDBACK_HINT"

export const FEEDBACK_HINT =
  "Enjoying lacode? Bugs, ideas, or a quick note on how you use it: github.com/lawaty/lacode/issues (a ⭐ on the repo helps others find it)"

export type FeedbackState = { feedbackHintShown?: boolean }

/**
 * Where the flag lives, beside selfupdate.json. Resolved LAZILY, at call time,
 * and never cached: `homedir()` reads HOME when it is called, so a test that
 * redirects HOME gets its own file for free.
 */
export const feedbackStatePath = (): string =>
  join(homedir(), ".local", "share", "opencode", "lacode", "feedback.json")

/**
 * `undefined` means the file exists but cannot be read or is not a JSON
 * object. The caller skips the hint then, rather than risk showing it twice.
 */
export function readFeedbackState(path = feedbackStatePath()): FeedbackState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as FeedbackState
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {}
    return undefined
  }
}

/** Returns true only when the flag was durably written (`.tmp` + rename). */
export function markFeedbackHintShown(path = feedbackStatePath()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ feedbackHintShown: true }))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * Undo a tentative flag write when the toast could not be shown.
 *
 * The flag is written BEFORE the toast on purpose: a run that cannot persist
 * the fact should not show a note it will show again next time. But a toast
 * that fails (no TUI, a closed client, a rejected API call) must not consume
 * the one-time note -- that is the one failure the user would never see. The
 * previous state is restored, so a later interactive run can still show it.
 */
export function restoreFeedbackState(path = feedbackStatePath(), previous: FeedbackState = {}): void {
  try {
    if (Object.keys(previous).length === 0) {
      unlinkSync(path)
      return
    }
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(previous))
    renameSync(tmp, path)
  } catch {
    /* best effort: the flag is a convenience, not a guarantee */
  }
}

export type FeedbackHintDeps = {
  /** The plugin's own `enabled: false` switch. */
  enabled?: boolean
  /** `feedbackHint: false` in the plugin options. */
  feedbackHint?: boolean
  env?: Record<string, string | undefined>
  statePath?: string
  /** Defaults to `process.stdout.isTTY === true`. */
  interactive?: boolean
  /** The interactive sink. No sink means no hint and no flag write. */
  show?: (message: string) => Promise<void> | void
}

export type FeedbackHintResult = "shown" | "skipped" | "disabled" | "unavailable"

/**
 * Show the note at most once, and never where it could corrupt output or be
 * lost. A failed read or write is silence: the hint is not shown and nothing
 * throws.
 */
export async function maybeShowFeedbackHint(deps: FeedbackHintDeps = {}): Promise<FeedbackHintResult> {
  const env = deps.env ?? process.env
  if (deps.enabled === false || deps.feedbackHint === false) return "disabled"
  if (env[FEEDBACK_HINT_ENV] === "1") return "disabled"

  // Headless, piped and test runs leave the flag untouched, so the note can
  // still appear on a real interactive run.
  const interactive = deps.interactive ?? process.stdout.isTTY === true
  if (!interactive || env.CI || env.NODE_TEST_CONTEXT) return "unavailable"
  if (!deps.show) return "unavailable"

  const state = readFeedbackState(deps.statePath)
  if (state === undefined || state.feedbackHintShown === true) return "skipped"
  if (!markFeedbackHintShown(deps.statePath)) return "skipped"

  try {
    await deps.show(FEEDBACK_HINT)
  } catch {
    // A toast that could not be shown is not worth an error -- but it also must
    // not consume the one-time note. Put the flag back so a later run with a
    // working sink can still show it.
    restoreFeedbackState(deps.statePath, state)
    return "skipped"
  }
  return "shown"
}
