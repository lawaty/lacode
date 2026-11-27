// Contract tests for the shared notification-adapter primitives.
//
// These are the small, offline pieces extracted out of src/tunnel/index.ts:
// process execution, desktop capability probes and sound playback. Nothing
// here reaches a desktop daemon, a speaker or the network -- commands are
// harmless `sh -c` exits, probes use an injected exec seam, and the sound
// channel is decided against a temporary PATH of recording stubs.

import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { exec, have } = await import(join(ROOT, "src", "lib", "notify-adapter", "exec.ts"))
const {
  sessionBusEnv,
  supportsNotifyAction,
  supportsNotifyIdFd,
  resetNotifyActionSupport,
  resetNotifyIdFdSupport,
} = await import(
  join(ROOT, "src", "lib", "notify-adapter", "probe.ts")
)
const { soundChannel, playSound } = await import(join(ROOT, "src", "lib", "notify-adapter", "sound.ts"))
const { isNotificationId, closeCorrelationKey } = await import(join(ROOT, "src", "lib", "notify-adapter", "ids.ts"))
const { freedesktopAdapter } = await import(join(ROOT, "src", "lib", "notify-adapter", "adapters", "freedesktop.ts"))
const { windowsToastAdapter } = await import(join(ROOT, "src", "lib", "notify-adapter", "adapters", "windows-toast.ts"))
const { osascriptAdapter, terminalNotifierAdapter, DARWIN_SCRIPT, DARWIN_ARGV_MARKER } = await import(
  join(ROOT, "src", "lib", "notify-adapter", "adapters", "macos.ts"),
)
const { noneAdapter, NO_CHANNEL } = await import(join(ROOT, "src", "lib", "notify-adapter", "adapters", "none.ts"))
const { adapterChain, selectAdapter } = await import(join(ROOT, "src", "lib", "notify-adapter", "registry.ts"))
const { notificationIdFile } = await import(join(ROOT, "src", "lib", "notify.ts"))
const { localChannel, sendLocal, describe } = await import(join(ROOT, "src", "tunnel", "index.ts"))
const { describeNotify } = await import(join(ROOT, "src", "lib", "notify-adapter", "doctor.ts"))
const {
  ICONS,
  SOUNDS,
  normalizeUrgency,
  normalizeIcon,
  normalizeSound,
  safeText,
  safeTitle,
  safeMessage,
  presentCorrelationKey,
} = await import(join(ROOT, "src", "lib", "notify-adapter", "text.ts"))

// ---------------------------------------------------------------------------
// exec: a child process becomes data, never an exception
// ---------------------------------------------------------------------------

test("exec maps a successful command to ok without throwing", () => {
  const result = exec("sh", ["-c", "exit 0"])
  assert.equal(result.ok, true)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  assert.equal(result.detail, undefined)
})

test("exec maps a non-zero exit to ok:false without throwing", () => {
  const result = exec("sh", ["-c", "exit 3"])
  assert.equal(result.ok, false)
  assert.equal(result.detail, undefined)
})

test("exec reports a missing binary as a result, not a throw", () => {
  const result = exec("lacode-adapter-no-such-command", [])
  assert.equal(result.ok, false)
  assert.equal(typeof result.detail, "string")
})

test("exec merges env over the inherited environment", () => {
  const result = exec("sh", ["-c", 'printf "%s" "$LACODE_ADAPTER_TEST"'], {
    env: { LACODE_ADAPTER_TEST: "yes" },
  })
  assert.equal(result.ok, true)
  assert.equal(result.stdout, "yes")
})

// ---------------------------------------------------------------------------
// have: the sh command -v probe, with an injectable exec seam
// ---------------------------------------------------------------------------

test("have uses the sh command -v probe and accepts an exec seam", () => {
  const calls = []
  const fake = (command, args) => {
    calls.push([command, args])
    return { ok: true, stdout: "", stderr: "" }
  }
  assert.equal(have("paplay", fake), true)
  assert.deepEqual(calls[0], ["sh", ["-c", "command -v paplay"]])

  const missing = () => ({ ok: false, stdout: "", stderr: "" })
  assert.equal(have("paplay", missing), false)
})

test("have on win32 calls where and never sh", () => {
  const calls = []
  const fake = (command, args) => {
    calls.push([command, args])
    return { ok: true, stdout: "", stderr: "" }
  }
  assert.equal(have("powershell.exe", fake, "win32"), true)
  assert.deepEqual(calls, [["where", ["powershell.exe"]]])
  assert.ok(!calls.some((c) => c[0] === "sh"), "must not call sh on win32")

  const calls2 = []
  const fake2 = (command, args) => {
    calls2.push([command, args])
    return { ok: false, stdout: "", stderr: "" }
  }
  assert.equal(have("powershell.exe", fake2, "win32"), false)
  assert.deepEqual(calls2, [["where", ["powershell.exe"]]])
  assert.ok(!calls2.some((c) => c[0] === "sh"), "must not call sh on win32")
})

test("have on linux still uses sh command -v", () => {
  const calls = []
  const fake = (command, args) => {
    calls.push([command, args])
    return { ok: true, stdout: "", stderr: "" }
  }
  assert.equal(have("notify-send", fake, "linux"), true)
  assert.deepEqual(calls[0], ["sh", ["-c", "command -v notify-send"]])
})

// ---------------------------------------------------------------------------
// sessionBusEnv: the session bus address, or the per-user fallback
// ---------------------------------------------------------------------------

test("sessionBusEnv is empty when the bus address is already set", () => {
  const previous = process.env.DBUS_SESSION_BUS_ADDRESS
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/already-set-bus"
  try {
    assert.deepEqual(sessionBusEnv(), {})
  } finally {
    if (previous === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
    else process.env.DBUS_SESSION_BUS_ADDRESS = previous
  }
})

test("sessionBusEnv falls back to /run/user/<uid>/bus when unset", () => {
  const previous = process.env.DBUS_SESSION_BUS_ADDRESS
  delete process.env.DBUS_SESSION_BUS_ADDRESS
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    if (uid === undefined) assert.deepEqual(sessionBusEnv(), {})
    else assert.deepEqual(sessionBusEnv(), { DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` })
  } finally {
    if (previous === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
    else process.env.DBUS_SESSION_BUS_ADDRESS = previous
  }
})

// ---------------------------------------------------------------------------
// supportsNotifyIdFd / supportsNotifyAction: one probe, memoized, resettable
// ---------------------------------------------------------------------------

test("supportsNotifyIdFd probes once and reset clears the memo", () => {
  const calls = []
  const withFd = (command, args, options) => {
    calls.push([command, args, options])
    return { ok: true, stdout: "--id-fd=FD", stderr: "", detail: undefined }
  }
  resetNotifyIdFdSupport()
  assert.equal(supportsNotifyIdFd(withFd), true)
  assert.equal(supportsNotifyIdFd(withFd), true)
  assert.equal(calls.length, 1, "the probe must run once for the life of the process")
  assert.deepEqual(calls[0], ["notify-send", ["--help"], { timeout: 2000 }])

  resetNotifyIdFdSupport()
  const withoutFd = () => ({ ok: true, stdout: "--print-id", stderr: "", detail: undefined })
  assert.equal(supportsNotifyIdFd(withoutFd), false, "reset must let the next probe answer afresh")
})

test("supportsNotifyIdFd reads stderr as well as stdout", () => {
  resetNotifyIdFdSupport()
  const onStderr = () => ({ ok: true, stdout: "", stderr: "  --id-fd=FD  ", detail: undefined })
  assert.equal(supportsNotifyIdFd(onStderr), true)
  resetNotifyIdFdSupport()
})

test("supportsNotifyAction probes once and reset clears the memo", () => {
  const calls = []
  const withAction = (command, args, options) => {
    calls.push([command, args, options])
    return { ok: true, stdout: "--action=ACTION:...", stderr: "", detail: undefined }
  }
  resetNotifyActionSupport()
  assert.equal(supportsNotifyAction(withAction), true)
  assert.equal(supportsNotifyAction(withAction), true)
  assert.equal(calls.length, 1, "the probe must run once for the life of the process")
  assert.deepEqual(calls[0], ["notify-send", ["--help"], { timeout: 2000 }])

  resetNotifyActionSupport()
  const withoutAction = () => ({ ok: true, stdout: "--id-fd=FD", stderr: "", detail: undefined })
  assert.equal(supportsNotifyAction(withoutAction), false, "reset must let the next probe answer afresh")
})

test("supportsNotifyAction reads stderr as well as stdout", () => {
  resetNotifyActionSupport()
  const onStderr = () => ({ ok: true, stdout: "", stderr: "  --action=ACTION  ", detail: undefined })
  assert.equal(supportsNotifyAction(onStderr), true)
  resetNotifyActionSupport()
})

// ---------------------------------------------------------------------------
// soundChannel: platform first, installed binaries second, never a guess
// ---------------------------------------------------------------------------

/** Replace PATH with a temp dir holding only the named stubs plus `sh`. */
const withPath = (names, fn) => {
  const bin = mkdtempSync(join(tmpdir(), "lacode-adapter-path-"))
  for (const name of names) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  }
  // `command -v` is a shell builtin, so the probe needs a shell to run in.
  symlinkSync("/bin/sh", join(bin, "sh"))
  const previous = process.env.PATH
  process.env.PATH = bin
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    rmSync(bin, { recursive: true, force: true })
  }
}

test("soundChannel picks afplay on darwin when present", () => {
  withPath(["afplay"], () => {
    assert.equal(soundChannel("darwin"), "afplay")
  })
})

test("soundChannel picks the first available linux player in order", () => {
  withPath(["paplay", "aplay", "pw-play"], () => {
    assert.equal(soundChannel("linux"), "paplay")
  })
  withPath(["aplay", "pw-play"], () => {
    assert.equal(soundChannel("linux"), "aplay")
  })
  withPath(["pw-play"], () => {
    assert.equal(soundChannel("linux"), "pw-play")
  })
})

test("soundChannel is none when no player is installed", () => {
  withPath([], () => {
    assert.equal(soundChannel("linux"), "none")
    assert.equal(soundChannel("darwin"), "none")
    assert.equal(soundChannel("win32"), "none")
  })
})

test("[US-43] soundChannel on win32 uses where probe and returns powershell-sound or none", () => {
  const calls = []
  const fakeExec = (command, args) => {
    calls.push([command, args])
    return { ok: true, stdout: "", stderr: "" }
  }
  assert.equal(soundChannel("win32", fakeExec), "powershell-sound")
  assert.deepEqual(calls, [["where", ["powershell.exe"]]])
  assert.ok(!calls.some((c) => c[0] === "sh"), "win32 soundChannel must not use sh")

  const calls2 = []
  const fakeExec2 = (command, args) => {
    calls2.push([command, args])
    return { ok: false, stdout: "", stderr: "" }
  }
  assert.equal(soundChannel("win32", fakeExec2), "none")
  assert.deepEqual(calls2, [["where", ["powershell.exe"]]])
  assert.ok(!calls2.some((c) => c[0] === "sh"), "win32 soundChannel must not use sh")
})

test("[US-43] playSound on win32 spawns powershell.exe with a detached PlaySync script", async () => {
  const bin = mkdtempSync(join(tmpdir(), "lacode-win-sound-"))
  const log = join(bin, "powershell.log")
  writeFileSync(
    join(bin, "powershell.exe"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(log)}; done\nexit 0\n`,
    { mode: 0o755 },
  )
  // soundChannel() probes with `where` on win32; provide a stub so the test
  // works on Linux where `where` is not installed.
  writeFileSync(
    join(bin, "where"),
    `#!/bin/sh\nfor cmd in "$@"; do\n  p=$(command -v "$cmd" 2>/dev/null)\n  if [ -n "$p" ]; then echo "$p"; exit 0; fi\ndone\nexit 1\n`,
    { mode: 0o755 },
  )
  const previous = process.env.PATH
  process.env.PATH = `${bin}${previous ? `:${previous}` : ""}`
  try {
    playSound("done", "win32")
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !existsSync(log)) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(existsSync(log), "powershell.exe stub should have been invoked")
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean)
    assert.deepEqual(lines.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"])
    const script = lines[3] ?? ""
    assert.match(script, /System\.Media\.SoundPlayer|System\.Media\.SystemSounds/, "script should play sound")
    assert.match(script, /sounds[\\/]+done\.wav|System\.Media\.SystemSounds::Asterisk\.Play\(\)/)
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    rmSync(bin, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// ids: notification-id validation and close-by-correlation-key
// ---------------------------------------------------------------------------

test("isNotificationId accepts only a bare decimal integer", () => {
  assert.equal(isNotificationId("42"), true)
  for (const bad of ["", "4a", "-1", "4.2", " 42"]) {
    assert.equal(isNotificationId(bad), false, `${JSON.stringify(bad)} must not be an id`)
  }
})

test("closeCorrelationKey on a missing file returns true and does nothing", () => {
  const state = mkdtempSync(join(tmpdir(), "lacode-adapter-close-missing-"))
  const previous = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = join(state, "never-created")
  try {
    assert.equal(closeCorrelationKey("ses_missing"), true)
    // A missing id file is "nothing was raised", not a failure -- and the
    // closer must not create a state directory just to look for one.
    assert.equal(existsSync(process.env.LACODE_NOTIFY_DIR), false)
  } finally {
    if (previous === undefined) delete process.env.LACODE_NOTIFY_DIR
    else process.env.LACODE_NOTIFY_DIR = previous
    rmSync(state, { recursive: true, force: true })
  }
})

test("closeCorrelationKey falls back from gdbus to dbus-send with the exact argv", () => {
  // gdbus fails, dbus-send succeeds. Both must receive the exact
  // CloseNotification argv, and the consumed id file must be deleted. The
  // stubs are real executables on a private PATH; nothing reaches a bus.
  const bin = mkdtempSync(join(tmpdir(), "lacode-adapter-close-bin-"))
  const state = mkdtempSync(join(tmpdir(), "lacode-adapter-close-state-"))
  const gdbusLog = join(bin, "gdbus.log")
  const dbusSendLog = join(bin, "dbus-send.log")
  writeFileSync(
    join(bin, "gdbus"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(gdbusLog)}; done\nexit 1\n`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(bin, "dbus-send"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(dbusSendLog)}; done\nexit 0\n`,
    { mode: 0o755 },
  )
  const argvOf = (log) => {
    if (!existsSync(log)) return []
    const parts = readFileSync(log, "utf8").split("\0")
    if (parts[parts.length - 1] === "") parts.pop()
    return parts
  }
  const idFile = join(state, "ses_abc123.ids")
  writeFileSync(idFile, "42\n")
  const saved = { PATH: process.env.PATH, LACODE_NOTIFY_DIR: process.env.LACODE_NOTIFY_DIR, DBUS: process.env.DBUS_SESSION_BUS_ADDRESS }
  process.env.PATH = bin
  process.env.LACODE_NOTIFY_DIR = state
  // A bus address in the environment makes sessionBusEnv() return {}, so the
  // close never tries to synthesize a /run/user/<uid> address.
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/lacode-adapter-no-bus"
  try {
    assert.equal(closeCorrelationKey("ses_abc123"), true)
    assert.deepEqual(argvOf(gdbusLog), [
      "call", "--session",
      "--dest", "org.freedesktop.Notifications",
      "--object-path", "/org/freedesktop/Notifications",
      "--method", "org.freedesktop.Notifications.CloseNotification",
      "42",
    ])
    assert.deepEqual(argvOf(dbusSendLog), [
      "--session",
      "--dest=org.freedesktop.Notifications",
      "--type=method_call",
      "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications.CloseNotification",
      "uint32:42",
    ])
    assert.equal(existsSync(idFile), false, "the consumed id file must be deleted")
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH
    else process.env.PATH = saved.PATH
    if (saved.LACODE_NOTIFY_DIR === undefined) delete process.env.LACODE_NOTIFY_DIR
    else process.env.LACODE_NOTIFY_DIR = saved.LACODE_NOTIFY_DIR
    if (saved.DBUS === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
    else process.env.DBUS_SESSION_BUS_ADDRESS = saved.DBUS
    rmSync(bin, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// text: whitelists, normalization and sanitizing shared with the transport
// ---------------------------------------------------------------------------

test("ICONS and SOUNDS keep their exact members and order", () => {
  assert.deepEqual([...ICONS], [
    "utilities-terminal",
    "dialog-information",
    "dialog-error",
    "dialog-warning",
    "system-run",
    "emblem-default",
  ])
  assert.deepEqual([...SOUNDS], ["none", "done", "question", "permission", "error"])
})

test("normalizeUrgency collapses unknown and empty values to normal", () => {
  for (const raw of [undefined, "", "bogus", "LOW"]) {
    assert.equal(normalizeUrgency(raw), "normal", `${JSON.stringify(raw)} must collapse to normal`)
  }
  for (const raw of ["low", "normal", "critical"]) {
    assert.equal(normalizeUrgency(raw), raw, `${raw} must pass through`)
  }
})

test("normalizeIcon collapses off-whitelist values to the default icon", () => {
  for (const raw of [undefined, "", "bogus"]) {
    assert.equal(normalizeIcon(raw), "utilities-terminal", `${JSON.stringify(raw)} must collapse to the default`)
  }
  assert.equal(normalizeIcon("dialog-error"), "dialog-error")
})

test("normalizeSound collapses off-whitelist values to none", () => {
  for (const raw of [undefined, "", "bogus"]) {
    assert.equal(normalizeSound(raw), "none", `${JSON.stringify(raw)} must collapse to none`)
  }
  assert.equal(normalizeSound("done"), "done")
})

test("safeText strips control characters, collapses whitespace and truncates", () => {
  assert.equal(safeText("a\u0007b\nc", "fallback", 120), "a b c")
  assert.equal(safeText("   ", "fallback", 120), "fallback")
  assert.equal(safeText("x".repeat(10), "fallback", 5), "xxxx…")
})

test("safeTitle and safeMessage preserve the current sanitizing behavior", () => {
  assert.equal(safeTitle("Fix\u0007 the \u001b[31mredirect\u0000"), "Fix the [31mredirect")
  assert.equal(safeTitle(undefined), "LaCode")
  assert.equal(safeMessage(undefined), "")
  assert.equal(safeMessage("x".repeat(500)).length, 400)
  assert.equal(safeMessage("x".repeat(500)).slice(-1), "…")
})

test("presentCorrelationKey returns undefined for empty and control-only keys", () => {
  for (const raw of [undefined, "", "\u0000\u0007\n"]) {
    assert.equal(presentCorrelationKey(raw), undefined, `${JSON.stringify(raw)} must carry no key`)
  }
  assert.equal(presentCorrelationKey("ses_abc123"), "ses_abc123")
})

// ---------------------------------------------------------------------------
// freedesktopAdapter: golden argv + id-fd contract
// ---------------------------------------------------------------------------

test("freedesktopAdapter.notify plain non-trackable has exact argv", () => {
  const calls = []
  const fakeExec = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    return { ok: true, stdout: "", stderr: "" }
  }
  const result = freedesktopAdapter.notify(
    { title: "T", message: "M", urgency: "normal", icon: "utilities-terminal" },
    { exec: fakeExec, platform: "linux" },
  )
  assert.equal(result.ok, true)
  assert.equal(result.channel, "notify-send")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, "notify-send")
  assert.deepEqual(calls[0].args, [
    "T",
    "M",
    "--app-name=LaCode",
    "--urgency=normal",
    "--icon=utilities-terminal",
    "--expire-time=0",
  ])
  assert.equal(calls[0].options.extraFd, undefined)
})

test("freedesktopAdapter.probe reports availability from injected exec", () => {
  const yes = () => ({ ok: true, stdout: "", stderr: "" })
  const no = () => ({ ok: false, stdout: "", stderr: "" })
  assert.deepEqual(freedesktopAdapter.probe({ exec: yes }), { available: true })
  assert.deepEqual(freedesktopAdapter.probe({ exec: no }), { available: false })
})

test("freedesktopAdapter.probe uses where on win32 and sh on linux", () => {
  const winCalls = []
  const winFake = (command, args) => {
    winCalls.push([command, args])
    return { ok: true, stdout: "", stderr: "" }
  }
  assert.deepEqual(freedesktopAdapter.probe({ platform: "win32", exec: winFake }), { available: true })
  assert.ok(winCalls.some((c) => c[0] === "where"), "win32 probe must use where")
  assert.ok(!winCalls.some((c) => c[0] === "sh"), "win32 probe must not use sh")

  const linCalls = []
  const linFake = (command, args) => {
    linCalls.push([command, args])
    return { ok: false, stdout: "", stderr: "" }
  }
  assert.deepEqual(freedesktopAdapter.probe({ platform: "linux", exec: linFake }), { available: false })
  assert.ok(linCalls.some((c) => c[0] === "sh"), "linux probe must use sh")
  assert.ok(!linCalls.some((c) => c[0] === "where"), "linux probe must not use where")
})

test("freedesktopAdapter.close on a missing key returns true", () => {
  const state = mkdtempSync(join(tmpdir(), "lacode-fd-close-missing-"))
  const previous = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = join(state, "never-created")
  try {
    assert.equal(freedesktopAdapter.close({ kind: "key", key: "ses_missing" }, {}), true)
    assert.equal(existsSync(process.env.LACODE_NOTIFY_DIR), false)
  } finally {
    if (previous === undefined) delete process.env.LACODE_NOTIFY_DIR
    else process.env.LACODE_NOTIFY_DIR = previous
    rmSync(state, { recursive: true, force: true })
  }
})

test("freedesktopAdapter.notify actionable trackable fallback uses --print-id", () => {
  resetNotifyIdFdSupport()
  resetNotifyActionSupport()
  const state = mkdtempSync(join(tmpdir(), "lacode-fd-fallback-"))
  const previous = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = state
  try {
    const calls = []
    const fakeExec = (command, args, options) => {
      calls.push({ command, args: [...args], options })
      if (args.includes("--help")) {
        return { ok: true, stdout: "--print-id\n--action=ACTION:...", stderr: "", detail: undefined }
      }
      return { ok: true, stdout: "42\nonce\n", stderr: "", detail: undefined }
    }
    const result = freedesktopAdapter.notify(
      { title: "T", message: "M", urgency: "normal", icon: "utilities-terminal", requestID: "req_1", correlationKey: "ses_fallback" },
      { exec: fakeExec, platform: "linux" },
    )
    assert.equal(result.ok, true)
    assert.equal(result.action, "once")
    const mainCall = calls.find((c) => !c.args.includes("--help"))
    assert.ok(mainCall)
    assert.deepEqual(mainCall.args, [
      "T",
      "M",
      "--app-name=LaCode",
      "--urgency=normal",
      "--icon=utilities-terminal",
      "--expire-time=0",
      "--print-id",
      "--action=once=Allow once",
      "--action=always=Always allow",
      "--action=reject=Deny",
    ])
    assert.equal(mainCall.options.timeout, 600000)
    const ids = readFileSync(notificationIdFile("ses_fallback"), "utf8")
    assert.equal(ids, "42\n")
  } finally {
    if (previous === undefined) delete process.env.LACODE_NOTIFY_DIR
    else process.env.LACODE_NOTIFY_DIR = previous
    rmSync(state, { recursive: true, force: true })
    resetNotifyIdFdSupport()
    resetNotifyActionSupport()
  }
})

test("freedesktopAdapter.notify degrades when notify-send --help lacks --action (still sends plain notice)", () => {
  resetNotifyIdFdSupport()
  resetNotifyActionSupport()
  const state = mkdtempSync(join(tmpdir(), "lacode-fd-noaction-"))
  const previous = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = state
  try {
    const calls = []
    const fakeExec = (command, args, options) => {
      calls.push({ command, args: [...args], options })
      if (args.includes("--help")) {
        // Has --id-fd/--print-id style support fields but NO --action
        return { ok: true, stdout: "--print-id\n--expire-time=TIME", stderr: "", detail: undefined }
      }
      return { ok: true, stdout: "42\n", stderr: "", detail: undefined }
    }
    const result = freedesktopAdapter.notify(
      { title: "T", message: "M", urgency: "normal", icon: "utilities-terminal", requestID: "req_1", correlationKey: "ses_noaction" },
      { exec: fakeExec, platform: "linux" },
    )
    assert.equal(result.ok, true)
    assert.equal(result.action, undefined)
    const mainCall = calls.find((c) => !c.args.includes("--help"))
    assert.ok(mainCall)
    // No --action args
    assert.ok(!mainCall.args.some((a) => String(a).startsWith("--action=")), "must not include --action args")
    // Normal argv kept
    assert.deepEqual(mainCall.args, [
      "T",
      "M",
      "--app-name=LaCode",
      "--urgency=normal",
      "--icon=utilities-terminal",
      "--expire-time=0",
      "--print-id",
    ])
    // Plain notice must not block for 10 minutes
    assert.equal(mainCall.options.timeout, 5000)
    const ids = readFileSync(notificationIdFile("ses_noaction"), "utf8")
    assert.equal(ids, "42\n")
  } finally {
    if (previous === undefined) delete process.env.LACODE_NOTIFY_DIR
    else process.env.LACODE_NOTIFY_DIR = previous
    rmSync(state, { recursive: true, force: true })
    resetNotifyIdFdSupport()
    resetNotifyActionSupport()
  }
})

test("freedesktopAdapter.notify with --action present sets actionable timeout and actions", () => {
  resetNotifyIdFdSupport()
  resetNotifyActionSupport()
  const state = mkdtempSync(join(tmpdir(), "lacode-fd-withaction-"))
  const previous = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = state
  try {
    const calls = []
    const fakeExec = (command, args, options) => {
      calls.push({ command, args: [...args], options })
      if (args.includes("--help")) {
        return { ok: true, stdout: "--action=ACTION:...\n--print-id", stderr: "", detail: undefined }
      }
      return { ok: true, stdout: "7\nalways\n", stderr: "", detail: undefined }
    }
    const result = freedesktopAdapter.notify(
      { title: "T", message: "M", urgency: "normal", icon: "utilities-terminal", requestID: "req_1", correlationKey: "ses_withaction" },
      { exec: fakeExec, platform: "linux" },
    )
    assert.equal(result.ok, true)
    assert.equal(result.action, "always")
    const mainCall = calls.find((c) => !c.args.includes("--help"))
    assert.ok(mainCall)
    assert.ok(mainCall.args.includes("--action=once=Allow once"))
    assert.ok(mainCall.args.includes("--action=always=Always allow"))
    assert.ok(mainCall.args.includes("--action=reject=Deny"))
    assert.equal(mainCall.options.timeout, 600000)
  } finally {
    if (previous === undefined) delete process.env.LACODE_NOTIFY_DIR
    else process.env.LACODE_NOTIFY_DIR = previous
    rmSync(state, { recursive: true, force: true })
    resetNotifyIdFdSupport()
    resetNotifyActionSupport()
  }
})

test("freedesktopAdapter.notify id-fd trackable writes id and does not throw", () => {
  resetNotifyIdFdSupport()
  const state = mkdtempSync(join(tmpdir(), "lacode-fd-idfd-"))
  const previous = process.env.LACODE_NOTIFY_DIR
  process.env.LACODE_NOTIFY_DIR = state
  try {
    const calls = []
    const fakeExec = (command, args, options) => {
      calls.push({ command, args: [...args], options })
      if (args.includes("--help")) {
        return { ok: true, stdout: "--id-fd=FD", stderr: "", detail: undefined }
      }
      if (options && options.extraFd !== undefined) {
        writeFileSync(options.extraFd, "42\n")
      }
      return { ok: true, stdout: "", stderr: "", detail: undefined }
    }
    let thrown = null
    let result
    try {
      result = freedesktopAdapter.notify(
        { title: "T", message: "M", urgency: "normal", icon: "utilities-terminal", requestID: "req_1", correlationKey: "ses_idfd" },
        { exec: fakeExec, platform: "linux" },
      )
    } catch (e) {
      thrown = e
    }
    assert.equal(thrown, null)
    assert.equal(result.ok, true)
    const mainCall = calls.find((c) => !c.args.includes("--help"))
    assert.ok(mainCall)
    assert.ok(!mainCall.args.includes("--print-id"), "id-fd path must not use --print-id")
    assert.ok(mainCall.args.includes("--id-fd=3"), "must use --id-fd=3")
    const ids = readFileSync(notificationIdFile("ses_idfd"), "utf8")
    assert.equal(ids, "42\n")
  } finally {
    if (previous === undefined) delete process.env.LACODE_NOTIFY_DIR
    else process.env.LACODE_NOTIFY_DIR = previous
    rmSync(state, { recursive: true, force: true })
    resetNotifyIdFdSupport()
  }
})

// ---------------------------------------------------------------------------
// windows-toastAdapter: PowerShell 5.1 toast, title/body never in argv
// ---------------------------------------------------------------------------

/** Read the temp XML path a script passes to ReadAllText, unescaping '' -> '. */
const xmlPathOf = (script) => {
  const match = script.match(/ReadAllText\('(.*)'\)/)
  assert.ok(match, `script must read the XML file via ReadAllText: ${script}`)
  return match[1].replace(/''/g, "'")
}

test("windowsToastAdapter.id and capabilities", () => {
  assert.equal(windowsToastAdapter.id, "powershell-toast")
  const caps = windowsToastAdapter.capabilities()
  assert.deepEqual(Object.values(caps), [false, false, false, false, false, false, false, false, false])
})

test("[US-43] windowsToastAdapter.probe uses where powershell.exe on win32", () => {
  const calls = []
  const fake = (command, args) => {
    calls.push([command, args])
    return { ok: true, stdout: "", stderr: "" }
  }
  assert.deepEqual(windowsToastAdapter.probe({ platform: "win32", exec: fake }), { available: true })
  assert.deepEqual(calls, [["where", ["powershell.exe"]]])
  assert.ok(!calls.some((c) => c[0] === "sh"), "win32 probe must not use sh")

  const calls2 = []
  const fake2 = (command, args) => {
    calls2.push([command, args])
    return { ok: false, stdout: "", stderr: "" }
  }
  assert.deepEqual(windowsToastAdapter.probe({ platform: "win32", exec: fake2 }), { available: false })
  assert.deepEqual(calls2, [["where", ["powershell.exe"]]])
})

test("windowsToastAdapter.close returns false", () => {
  assert.equal(windowsToastAdapter.close({ kind: "key", key: "ses_any" }, {}), false)
})

test("[US-43] windowsToastAdapter.notify golden: powershell.exe, title/body never in argv, XML on disk", () => {
  const calls = []
  let lastScript = ""
  let capturedXml = ""
  let capturedPath = ""
  const fakeExec = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    lastScript = args[args.length - 1] ?? ""
    // Read the XML during the call, before the adapter deletes the temp dir.
    capturedPath = xmlPathOf(lastScript)
    capturedXml = readFileSync(capturedPath, "utf8")
    return { ok: true, stdout: "", stderr: "" }
  }
  const title = "Fix the login"
  const body = "Task finished & done <ok>"
  const result = windowsToastAdapter.notify({ title, message: body, urgency: "critical" }, { exec: fakeExec, platform: "win32" })
  assert.equal(result.ok, true)
  assert.equal(result.detail, undefined)
  assert.equal(result.channel, "powershell-toast")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, "powershell.exe")
  assert.deepEqual(calls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"])
  assert.equal(typeof calls[0].args[3], "string")
  assert.ok(calls[0].args[3].includes("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}"), "script must carry the PowerShell AUMID")
  assert.ok(calls[0].args[3].includes("CreateToastNotifier"), "script must create the toast notifier")
  // Title and body must never appear in any argv element.
  for (const arg of calls[0].args) {
    assert.ok(!arg.includes(title), `title must not be in argv: ${JSON.stringify(arg)}`)
    assert.ok(!arg.includes(body), `body must not be in argv: ${JSON.stringify(arg)}`)
  }
  assert.ok(capturedPath.includes("lacode-toast-"), `parsed path must be the temp XML: ${capturedPath}`)
  // The XML carries the escaped title/body and the critical duration.
  assert.ok(capturedXml.includes('<text>Fix the login</text>'), `xml must carry the title: ${capturedXml}`)
  assert.ok(
    capturedXml.includes("<text>Task finished &amp; done &lt;ok&gt;</text>"),
    `xml must carry the escaped body: ${capturedXml}`,
  )
  assert.ok(capturedXml.includes('duration="long"'), `critical urgency must be long: ${capturedXml}`)
  assert.deepEqual(calls[0].options, { timeout: 5000 }, "no env passthrough when ctx.env is absent")
})

test("[US-43] windowsToastAdapter.notify passes ctx.env through and uses short duration for normal urgency", () => {
  const calls = []
  let capturedXml = ""
  const fakeExec = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    // Read the XML during the call, before the adapter deletes the temp dir.
    capturedXml = readFileSync(xmlPathOf(args[args.length - 1] ?? ""), "utf8")
    return { ok: true, stdout: "", stderr: "" }
  }
  const result = windowsToastAdapter.notify(
    { title: "T", message: "M", urgency: "normal" },
    { exec: fakeExec, platform: "win32", env: { LACODE_TOAST_TEST: "yes" } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.channel, "powershell-toast")
  assert.equal(calls[0].options.env.LACODE_TOAST_TEST, "yes", "ctx.env must be passed to exec")
  assert.ok(capturedXml.includes('duration="short"'), `normal urgency must be short: ${capturedXml}`)
})

test("[US-43] windowsToastAdapter.notify cleans up the temp XML", () => {
  let xmlPath = ""
  const fakeExec = (command, args) => {
    xmlPath = xmlPathOf(args[args.length - 1] ?? "")
    return { ok: true, stdout: "", stderr: "" }
  }
  windowsToastAdapter.notify({ title: "T", message: "M" }, { exec: fakeExec, platform: "win32" })
  assert.equal(existsSync(xmlPath), false, "the temp XML must be deleted after the call")
  assert.equal(existsSync(dirname(xmlPath)), false, "the temp dir must be deleted after the call")
})

test("[US-43] windowsToastAdapter.notify maps exec failure to ok:false without throwing", () => {
  const fakeExec = () => ({ ok: false, stdout: "", stderr: "boom" })
  let thrown = null
  let result
  try {
    result = windowsToastAdapter.notify({ title: "T", message: "M" }, { exec: fakeExec, platform: "win32" })
  } catch (error) {
    thrown = error
  }
  assert.equal(thrown, null)
  assert.deepEqual(result, { ok: false, detail: "boom", channel: "powershell-toast" })
})

test("[US-43] windowsToastAdapter.notify maps an exec throw to ok:false without throwing", () => {
  const boom = () => {
    throw new Error("powershell is wedged")
  }
  const result = windowsToastAdapter.notify({ title: "T", message: "M" }, { exec: boom, platform: "win32" })
  assert.equal(result.ok, false)
  assert.equal(result.channel, "powershell-toast")
  assert.match(result.detail ?? "", /powershell is wedged/)
})

// ---------------------------------------------------------------------------
// macOS adapters: golden argv, probe, close, never throw
// ---------------------------------------------------------------------------

test("osascriptAdapter.notify has exact 5-element argv and no linux-only flags", () => {
  const calls = []
  const fakeExec = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    return { ok: true, stdout: "", stderr: "" }
  }
  const result = osascriptAdapter.notify({ title: "T", message: "M" }, { exec: fakeExec, platform: "darwin" })
  assert.equal(result.ok, true)
  assert.equal(result.channel, "osascript")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, "osascript")
  assert.deepEqual(calls[0].args, ["-e", DARWIN_SCRIPT, DARWIN_ARGV_MARKER, "T", "M"])
  assert.equal(calls[0].args.length, 5)
  assert.ok(!calls[0].args.some((a) => a.includes("--action")), "osascript must not pass --action")
  assert.ok(!calls[0].args.some((a) => a.includes("--print-id") || a.includes("--id-fd")), "osascript must not pass --print-id/--id-fd")
  assert.deepEqual(calls[0].options, { timeout: 5000 })
})

test("terminalNotifierAdapter.notify has exact argv and no linux-only flags", () => {
  const calls = []
  const fakeExec = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    return { ok: true, stdout: "", stderr: "" }
  }
  const result = terminalNotifierAdapter.notify(
    { title: "T", message: "M", urgency: "critical" },
    { exec: fakeExec, platform: "darwin" },
  )
  assert.equal(result.ok, true)
  assert.equal(result.channel, "terminal-notifier")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, "terminal-notifier")
  assert.deepEqual(calls[0].args, ["-title", "T", "-message", "M", "-appName", "LaCode", "-priority", "critical"])
  assert.ok(!calls[0].args.some((a) => a.includes("--action")), "terminal-notifier must not pass --action")
  assert.ok(!calls[0].args.some((a) => a.includes("--print-id") || a.includes("--id-fd")), "terminal-notifier must not pass --print-id/--id-fd")
  assert.deepEqual(calls[0].options, { timeout: 5000 })
})

test("macOS adapters probe reports availability from injected exec", () => {
  const yes = () => ({ ok: true, stdout: "", stderr: "" })
  const no = () => ({ ok: false, stdout: "", stderr: "" })
  assert.deepEqual(osascriptAdapter.probe({ exec: yes }), { available: true })
  assert.deepEqual(osascriptAdapter.probe({ exec: no }), { available: false })
  assert.deepEqual(terminalNotifierAdapter.probe({ exec: yes }), { available: true })
  assert.deepEqual(terminalNotifierAdapter.probe({ exec: no }), { available: false })
})

test("macOS adapters close returns false", () => {
  assert.equal(osascriptAdapter.close({ kind: "key", key: "ses_any" }, {}), false)
  assert.equal(terminalNotifierAdapter.close({ kind: "key", key: "ses_any" }, {}), false)
})

test("macOS adapters notify maps exec throw to ok:false result", () => {
  const boom = () => {
    throw new Error("boom")
  }
  const o = osascriptAdapter.notify({ title: "T", message: "M" }, { exec: boom })
  assert.equal(o.ok, false)
  assert.equal(o.channel, "osascript")
  assert.match(o.detail ?? "", /boom/)
  const t = terminalNotifierAdapter.notify({ title: "T", message: "M" }, { exec: boom })
  assert.equal(t.ok, false)
  assert.equal(t.channel, "terminal-notifier")
  assert.match(t.detail ?? "", /boom/)
})

// ---------------------------------------------------------------------------
// registry: adapterChain order
// ---------------------------------------------------------------------------

test("adapterChain(darwin) returns osascript, terminal-notifier, none in that order", () => {
  const chain = adapterChain("darwin", {})
  assert.deepEqual(chain.map((a) => a.id), ["osascript", "terminal-notifier", "none"])
})

test("adapterChain(linux) returns freedesktop, none", () => {
  assert.deepEqual(adapterChain("linux", {}).map((a) => a.id), ["notify-send", "none"])
})

test("[US-43] adapterChain(win32) returns powershell-toast, freedesktop, none", () => {
  assert.deepEqual(adapterChain("win32", {}).map((a) => a.id), ["powershell-toast", "notify-send", "none"])
})

// ---------------------------------------------------------------------------
// registry: selectAdapter auto selection with injected exec
// ---------------------------------------------------------------------------

const execHas = (...names) => (command, args) => {
  if (command === "sh" && args[0] === "-c") {
    const probe = String(args[1] ?? "")
    return { ok: names.some((n) => probe.includes(`command -v ${n}`)), stdout: "", stderr: "" }
  }
  return { ok: true, stdout: "", stderr: "" }
}

test("selectAdapter on darwin picks osascript when osascript is available", () => {
  const selected = selectAdapter({ platform: "darwin", env: {}, exec: execHas("osascript", "terminal-notifier") })
  assert.equal(selected.adapter.id, "osascript")
})

test("selectAdapter on darwin picks terminal-notifier when only terminal-notifier is available", () => {
  const selected = selectAdapter({ platform: "darwin", env: {}, exec: execHas("terminal-notifier") })
  assert.equal(selected.adapter.id, "terminal-notifier")
})

test("selectAdapter on darwin falls back to none when neither osascript nor terminal-notifier is available", () => {
  const selected = selectAdapter({ platform: "darwin", env: {}, exec: execHas() })
  assert.equal(selected.adapter.id, "none")
})

test("selectAdapter on linux with notify-send absent falls back to none", () => {
  const selected = selectAdapter({ platform: "linux", env: {}, exec: execHas() })
  assert.equal(selected.adapter.id, "none")
})

// ---------------------------------------------------------------------------
// registry: selectAdapter on win32 with an injected `where`
// ---------------------------------------------------------------------------

/** Answer `where <command>` for exactly the named commands on win32. */
const execHasWin = (...names) => (command, args) => {
  if (command === "where") {
    return { ok: names.includes(args[0] ?? ""), stdout: "", stderr: "" }
  }
  return { ok: true, stdout: "", stderr: "" }
}

test("[US-43] selectAdapter on win32 picks powershell-toast when where powershell.exe succeeds", () => {
  const selected = selectAdapter({ platform: "win32", env: {}, exec: execHasWin("powershell.exe", "notify-send") })
  assert.equal(selected.adapter.id, "powershell-toast")
})

test("[US-43] selectAdapter on win32 falls back to notify-send when powershell is absent", () => {
  const selected = selectAdapter({ platform: "win32", env: {}, exec: execHasWin("notify-send") })
  assert.equal(selected.adapter.id, "notify-send")
})

test("[US-43] selectAdapter on win32 falls back to none when both are absent", () => {
  const selected = selectAdapter({ platform: "win32", env: {}, exec: execHasWin() })
  assert.equal(selected.adapter.id, "none")
})

// ---------------------------------------------------------------------------
// registry: LACODE_NOTIFY_ADAPTER override
// ---------------------------------------------------------------------------

test("LACODE_NOTIFY_ADAPTER=none selects none even when notify-send is available", () => {
  const selected = selectAdapter({
    platform: "linux",
    env: { LACODE_NOTIFY_ADAPTER: "none" },
    exec: execHas("notify-send"),
  })
  assert.equal(selected.adapter.id, "none")
})

test("unknown LACODE_NOTIFY_ADAPTER falls back to auto and emits warning/reason", () => {
  const warnings = []
  const originalWrite = process.stderr.write
  process.stderr.write = ((chunk, ...rest) => {
    warnings.push(String(chunk))
    if (typeof rest[rest.length - 1] === "function") rest[rest.length - 1]()
    return true
  })
  try {
    const selected = selectAdapter({
      platform: "linux",
      env: { LACODE_NOTIFY_ADAPTER: "bogus-adapter" },
      exec: execHas("notify-send"),
    })
    assert.equal(selected.adapter.id, "notify-send")
    assert.match(String(selected.reason ?? ""), /unknown.*bogus-adapter|bogus-adapter.*unknown/i)
    assert.ok(warnings.some((w) => /unknown.*LACODE_NOTIFY_ADAPTER.*bogus-adapter/i.test(w)))
  } finally {
    process.stderr.write = originalWrite
  }
})

// ---------------------------------------------------------------------------
// noneAdapter: exact detail strings
// ---------------------------------------------------------------------------

test("noneAdapter.notify returns exact linux/darwin detail strings and generic win32 fallback", () => {
  assert.deepEqual(noneAdapter.notify({ title: "T" }, { platform: "linux" }), {
    ok: false,
    detail: "notify-send is not installed",
    channel: "none",
  })
  assert.deepEqual(noneAdapter.notify({ title: "T" }, { platform: "darwin" }), {
    ok: false,
    detail: "neither osascript nor terminal-notifier is installed",
    channel: "none",
  })
  assert.deepEqual(noneAdapter.notify({ title: "T" }, { platform: "win32" }), {
    ok: false,
    detail: "no local notification channel on win32",
    channel: "none",
  })
  assert.equal(NO_CHANNEL.linux, "notify-send is not installed")
  assert.equal(NO_CHANNEL.darwin, "neither osascript nor terminal-notifier is installed")
})

// ---------------------------------------------------------------------------
// tunnel dispatch: localChannel/sendLocal use the adapter registry
// ---------------------------------------------------------------------------

test("localChannel uses PATH-probed registry selection", () => {
  withPath(["notify-send"], () => {
    assert.equal(localChannel("linux"), "notify-send")
  })
  withPath([], () => {
    assert.equal(localChannel("linux"), "none")
  })
  withPath(["osascript"], () => {
    assert.equal(localChannel("darwin"), "osascript")
  })
  withPath(["terminal-notifier"], () => {
    assert.equal(localChannel("darwin"), "terminal-notifier")
  })
  withPath([], () => {
    assert.equal(localChannel("darwin"), "none")
  })
})

// ---------------------------------------------------------------------------
// doctor: describeNotify / describe report adapter diagnostics
// ---------------------------------------------------------------------------

test("describeNotify on linux with notify-send available reports adapter and chain", () => {
  withPath(["notify-send", "paplay"], () => {
    const prevAdapter = process.env.LACODE_NOTIFY_ADAPTER
    const prevDir = process.env.LACODE_NOTIFY_DIR
    delete process.env.LACODE_NOTIFY_ADAPTER
    process.env.LACODE_NOTIFY_DIR = "/tmp/lacode-notify-doctor-test"
    try {
      const info = describeNotify({ platform: "linux" })
      assert.equal(info.adapter, "notify-send")
      assert.match(info.adapterChain, /notify-send=available/)
      assert.match(info.adapterChain, /none=available/)
      assert.match(info.capabilities, /actions/)
      assert.equal(info.sound, soundChannel("linux"))
      assert.ok(typeof info.stateDir === "string" && info.stateDir.length > 0)
    } finally {
      if (prevAdapter === undefined) delete process.env.LACODE_NOTIFY_ADAPTER
      else process.env.LACODE_NOTIFY_ADAPTER = prevAdapter
      if (prevDir === undefined) delete process.env.LACODE_NOTIFY_DIR
      else process.env.LACODE_NOTIFY_DIR = prevDir
    }
  })
})

test("describeNotify honors LACODE_NOTIFY_ADAPTER=none", () => {
  withPath(["notify-send"], () => {
    const prev = process.env.LACODE_NOTIFY_ADAPTER
    process.env.LACODE_NOTIFY_ADAPTER = "none"
    try {
      const info = describeNotify({ platform: "linux" })
      assert.equal(info.adapter, "none")
    } finally {
      if (prev === undefined) delete process.env.LACODE_NOTIFY_ADAPTER
      else process.env.LACODE_NOTIFY_ADAPTER = prev
    }
  })
})

test("describe() includes the new adapter key and keeps channel/notifySend", () => {
  withPath(["notify-send"], () => {
    const info = describe({}, "linux")
    assert.ok(Object.prototype.hasOwnProperty.call(info, "adapter"))
    assert.ok(Object.prototype.hasOwnProperty.call(info, "channel"))
    assert.ok(Object.prototype.hasOwnProperty.call(info, "notifySend"))
  })
})

test("LACODE_NOTIFY_ADAPTER=none overrides localChannel and sendLocal", () => {
  const prev = process.env.LACODE_NOTIFY_ADAPTER
  const notifyLog = mkdtempSync(join(tmpdir(), "lacode-adapter-none-log-"))
  const logFile = join(notifyLog, "notify-send.log")
  const bin = mkdtempSync(join(tmpdir(), "lacode-adapter-none-bin-"))
  writeFileSync(
    join(bin, "notify-send"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(logFile)}\nexit 0\n`,
    { mode: 0o755 },
  )
  symlinkSync("/bin/sh", join(bin, "sh"))
  const prevPath = process.env.PATH
  process.env.PATH = bin
  process.env.LACODE_NOTIFY_ADAPTER = "none"
  try {
    assert.equal(localChannel("linux"), "none")
    const result = sendLocal({ title: "T", message: "M", urgency: "normal", icon: "utilities-terminal" }, "linux")
    assert.deepEqual(result, {
      ok: false,
      detail: "notify-send is not installed",
      transport: "local",
    })
    assert.equal(existsSync(logFile), false, "sendLocal must not spawn notify-send when adapter override is none")
  } finally {
    if (prev === undefined) delete process.env.LACODE_NOTIFY_ADAPTER
    else process.env.LACODE_NOTIFY_ADAPTER = prev
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    rmSync(bin, { recursive: true, force: true })
    rmSync(notifyLog, { recursive: true, force: true })
  }
})
