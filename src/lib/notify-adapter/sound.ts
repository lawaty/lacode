// Sound playback for the notification adapter layer.
//
// The sound plays where the notification is delivered -- the desktop end of
// the hop, not the headless host that asked for it. It is additive: a missing
// player or a missing asset changes nothing about the notification's result.
//
// This module is pure: it imports nothing from `src/tunnel` or `src/plugins`.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { PACKAGE_ROOT } from "../package-root.ts"
import { exec, have } from "./exec.ts"
import type { ExecSeam } from "./types.ts"

/** The sound player binary. One entry, so the channel IS the command. */
const SOUND_BINARY = {
  afplay: "afplay",
  paplay: "paplay",
  aplay: "aplay",
  "pw-play": "pw-play",
} as const

export type SoundChannel = keyof typeof SOUND_BINARY | "powershell-sound" | "none"

/** Which sound player to use here. */
export function soundChannel(
  platform: string = process.platform,
  execFn: ExecSeam = exec,
): SoundChannel {
  if (platform === "darwin") {
    return have(SOUND_BINARY.afplay, execFn, platform as NodeJS.Platform) ? "afplay" : "none"
  }
  if (platform === "win32") {
    return have("powershell.exe", execFn, platform as NodeJS.Platform) ? "powershell-sound" : "none"
  }
  for (const cmd of [SOUND_BINARY.paplay, SOUND_BINARY.aplay, SOUND_BINARY["pw-play"]]) {
    if (have(cmd, execFn, platform as NodeJS.Platform)) return cmd as SoundChannel
  }
  return "none"
}

const SYSTEM_SOUND: Record<string, string> = {
  error: "[System.Media.SystemSounds]::Hand.Play()",
  question: "[System.Media.SystemSounds]::Question.Play()",
  permission: "[System.Media.SystemSounds]::Question.Play()",
  done: "[System.Media.SystemSounds]::Asterisk.Play()",
}

/**
 * Play one alert sound, if a player and the asset are available. Silent on
 * every failure path: a missing player, a missing asset or a player that
 * cannot start never changes the notification's result.
 *
 * `sound` is a whitelisted name -- `sendLocal` normalizes the sender's value
 * before calling here, so the asset path is never built from untrusted text.
 * The child is detached + unref'd so it can outlive the sender (e.g.
 * `lacode receive`, which exits as soon as the notification is delivered).
 */
export function playSound(sound: string, platform: string = process.platform): void {
  if (sound === "none") return
  try {
    const channel = soundChannel(platform)
    if (channel === "none") return
    if (platform === "win32" && channel === "powershell-sound") {
      const path = join(PACKAGE_ROOT, "sounds", `${sound}.wav`)
      const script = existsSync(path)
        ? `(New-Object System.Media.SoundPlayer '${path.replace(/'/g, "''")}').PlaySync()`
        : SYSTEM_SOUND[sound]
      if (!script) return
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      })
      child.on("error", () => {})
      child.unref()
      return
    }
    const path = join(PACKAGE_ROOT, "sounds", `${sound}.wav`)
    if (!existsSync(path)) return
    const child = spawn(channel, [path], { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Never throw: sound playback must not affect notification delivery.
  }
}
