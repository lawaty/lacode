// Desktop delivery for notices that are not tied to a session: pool re-admission
// and anything else the user must see even when no agent session is involved.
//
// Kept out of src/lib/notify.ts, which is pure policy and testable without a
// process. This module owns the one impure step: finding the helper and spawning
// it fire-and-forget.
//
// The helper decides the transport (local notify-send or the ssh tunnel), and
// both helper paths hard-code --expire-time=0, so the notice stays on the
// desktop until the user closes it.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { helperArgv, notificationStateDir, safeCorrelationKey } from "./notify.ts"
import { PACKAGE_ROOT } from "./package-root.ts"

// Several opencode processes share one pool and one cooldown file, so the same
// recovery is seen by every process that watches it. A claim file makes exactly
// one of them speak. It is a TTL, not a lock: after the window another recovery
// for the same model may speak again, and a crashed process cannot silence the
// model forever. Throttle repeat rate-limit-reset notices per model to 30 minutes.
const NOTICE_CLAIM_MS = 30 * 60_000

/**
 * Whether this process should be the one to announce `key`.
 *
 * First writer wins. A fresh claim from any process suppresses the others; a
 * stale one is replaced. Failures other than "someone else claimed it" fail open
 * -- a duplicate popup is better than a recovery nobody hears about.
 */
export const claimDesktopNotice = (key: string): boolean => {
  const dir = join(notificationStateDir(), "pool-ready")
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return true
  }
  const file = join(dir, safeCorrelationKey(key))
  try {
    if (Date.now() - statSync(file).mtimeMs < NOTICE_CLAIM_MS) return false
    unlinkSync(file)
  } catch {
    // No claim yet, or it could not be cleared: try to create ours below.
  }
  try {
    writeFileSync(file, `${process.pid} ${Date.now()}`, { flag: "wx" })
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "EEXIST"
  }
}

export type DesktopNotice = {
  urgency?: "low" | "normal" | "critical"
  icon?: string
  sound?: string
}

// Where the notification helper lives, in order:
//   1. OC_NOTIFY_HELPER -- an explicit override, so a user can point at their own
//   2. ~/bin/lacode -- what a hand-made install of the CLI puts on PATH
//   3. dist/lacode.js -- the BUILT cli, which is all an npm install ships
//   4. the package's own bin/lacode -- the author's checkout
//   5. ~/bin/oc-notify -- the bash helper, kept only as a last-resort fallback
//   6. the package's own bin/oc-notify -- the author's checkout
// Candidates are anchored on PACKAGE_ROOT rather than on this module's own
// directory, because bundling moves this file from src/lib/ to dist/ and a
// relative hop would resolve outside the package.
export const findNotifyHelper = (): string | undefined => {
  const home = process.env.HOME ?? ""
  const candidates = [
    process.env.OC_NOTIFY_HELPER,
    join(home, "bin", "lacode"),
    join(PACKAGE_ROOT, "dist", "lacode.js"),
    join(PACKAGE_ROOT, "bin", "lacode"),
    join(home, "bin", "oc-notify"),
    join(PACKAGE_ROOT, "bin", "oc-notify"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

/**
 * Show one desktop notice that stays until the user closes it.
 *
 * Fire-and-forget: the helper is detached and unref'd, so a sleeping desktop or a
 * missing notification daemon can never hold the server open. Returns whether a
 * helper was found and spawned; a delivery failure is not an error the caller can
 * do anything about.
 */
export const notifyDesktop = (title: string, message: string, notice: DesktopNotice = {}): boolean => {
  try {
    const helper = findNotifyHelper()
    if (!helper) return false
    const argv = helperArgv(helper, title, message, notice.urgency ?? "normal", notice.icon ?? "utilities-terminal", notice.sound ?? "none")
    const child = spawn(helper, argv, { stdio: "ignore", detached: true, env: process.env })
    child.unref()
    return true
  } catch {
    return false
  }
}
