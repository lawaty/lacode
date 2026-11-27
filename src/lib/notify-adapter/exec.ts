// The one process primitive the notification adapter layer shares.
//
// Every desktop probe, close and delivery goes through `exec`: it turns a
// child process into data (`ExecResult`) and never throws, so a missing binary,
// a timeout or a wedged daemon is a result the caller can degrade on rather
// than an exception that can take down the thing that tried to notify.
//
// This module is pure: it imports nothing from `src/tunnel` or `src/plugins`.

import { spawnSync } from "node:child_process"
import type { ExecOptions, ExecResult, ExecSeam } from "./types.ts"

/**
 * Run a command to completion and report what happened. Never throws.
 *
 * `env` is merged over the inherited environment (absent means "inherit
 * unchanged"). `extraFd`, when given, is passed as the 4th stdio slot (fd 3 in
 * the child): notify-send uses it with `--id-fd=3` to report the notification
 * id before it blocks waiting for the user. When absent the stdio is exactly
 * what it has always been.
 */
export const exec = (command: string, args: string[], options: ExecOptions = {}): ExecResult => {
  const { timeout, env, extraFd } = options
  try {
    const result = spawnSync(command, args, {
      timeout,
      encoding: "utf8",
      stdio: extraFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", extraFd],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: (result.stderr ?? "").trim(),
      // spawnSync reports a timeout as a null status and an ETIMEDOUT error; both
      // are "did not arrive", not "crashed", and neither may throw.
      detail: result.error ? String((result.error as NodeJS.ErrnoException).code ?? result.error.message) : undefined,
    }
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", detail: String(error) }
  }
}

/**
 * Whether a command is on the PATH. Windows uses `where`; other platforms keep
 * the `sh -c 'command -v …'` probe. `execFn` is a seam so a test can answer
 * without a real shell, and the default is the real `exec` above.
 */
export const have = (
  command: string,
  execFn: ExecSeam = exec,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  try {
    if (platform === "win32") {
      return execFn("where", [command], { timeout: 2000 }).ok
    }
    return execFn("sh", ["-c", `command -v ${command}`], { timeout: 2000 }).ok
  } catch {
    return false
  }
}
