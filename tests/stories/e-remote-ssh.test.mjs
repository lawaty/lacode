// Epic E -- Remote hosts over SSH.
//
//   US-13  a notification raised on a remote host reaches the local desktop
//   US-14  the tunnel degrades safely and never blocks or throws
//   US-18  the notification content survives the hop intact
//   US-26  a local notification is delivered on macOS, not only on Linux
//
// These drive the REAL `bin/lacode` CLI as a subprocess, because the thing
// under test is a process a remote shell runs: its argv, its exit status, and
// what its stderr does or does not contain.
//
// The transports are stubbed, not faked at the module level: a temp directory
// prepended to PATH holds a `notify-send` and an `ssh` that record their argv and
// exit 0. That makes "the notification reached the desktop daemon" and "the hop
// was passed argv, not a shell string" observable without a desktop or a
// network, and without asserting on the package's private functions.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmodSync, cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { ROOT, cleanupAll, scratch, settle } from "./_harness.mjs"

test.after(cleanupAll)

const exec = promisify(execFile)
const CLI = join(ROOT, "bin", "lacode")

const onDarwin = process.platform === "darwin"

/**
 * Why a check that can only hold on the Linux notification channel is skipped
 * rather than run: the channel is chosen by platform, and `osascript`'s argv
 * carries neither `--urgency=` nor `--icon=`. The property behind those flags --
 * that an unwhitelisted urgency or icon never reaches a notifier -- is asserted
 * on every platform by the tests that read ALL channels.
 */
const SKIP_LINUX_CHANNEL = "the local notification channel here is osascript, whose argv has no --urgency=/--icon=; the whitelist itself is covered on darwin by the test that reads every channel"


/**
 * A stub transport that records its argv, one NUL-terminated record per argument.
 *
 * `ssh` plus EVERY local notification channel -- `notify-send`, `osascript` and
 * `terminal-notifier` -- are stubbed, so "did it reach the desktop" and "how did
 * it get there" become file reads on every platform.
 *
 * All three, not just notify-send, and that is load-bearing rather than
 * thoroughness. `localChannel()` picks by `process.platform` FIRST and by what
 * is installed second, so on a real Mac `osascript` is chosen and `notify-send`
 * is never invoked at all. A suite that stubbed only notify-send would therefore
 * pass on Linux and read an empty log -- and worse, would invoke the runner's
 * REAL osascript against a GUI session that is not there. The platform then
 * decides which stub fires, and `desktopArgv()` below reads whichever it was.
 *
 * NUL, not newline, is the record separator: the notification payload is ONE
 * argument containing embedded newlines, and a newline-delimited log would split
 * it back into four records and hide exactly the defect these tests exist to
 * catch. Nothing here runs a shell, evaluates an argument, or reaches a network.
 */
const CHANNELS = ["notify-send", "osascript", "terminal-notifier"]

const stubTransport = () => {
  const bin = scratch("stub-bin-")
  const sshLog = join(bin, "ssh.log")
  const channelLogs = Object.fromEntries(CHANNELS.map((name) => [name, join(bin, `${name}.log`)]))

  const recorder = (log) => `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(log)}; done\nexit 0\n`
  writeFileSync(join(bin, "ssh"), recorder(sshLog))
  for (const name of CHANNELS) writeFileSync(join(bin, name), recorder(channelLogs[name]))
  for (const name of ["ssh", ...CHANNELS]) chmodSync(join(bin, name), 0o755)

  // NUL records, dropped only at the trailing terminator: an empty notification
  // body is a real argument, and `filter(Boolean)` would silently delete
  const argv = (log) => {
    if (!existsSync(log)) return []
    const parts = readFileSync(log, "utf8").split("\0")
    if (parts[parts.length - 1] === "") parts.pop()
    return parts
  }
  return {
    bin,
    /** Per-channel argv, for the assertions that are about one channel's shape. */
    channelArgv: (name) => argv(channelLogs[name]),
    /**
     * Every argument handed to ANY desktop channel, in a fixed order.
     *
     * This is the platform-independent accessor, and it is a stronger assertion
     * than reading one log: a notification that leaked unvalidated text into a
     * channel this machine did not pick still shows up here.
     */
    desktopArgv: () => CHANNELS.flatMap((name) => argv(channelLogs[name])),
    notifyArgv: () => argv(channelLogs["notify-send"]),
    sshArgv: () => argv(sshLog),
  }
}

/**
 * Run the CLI in a hermetic environment.
 *
 * HOME points at a temp dir so no real SSH key, known_hosts, or credential can
 * be picked up; the transport stubs come first on PATH. The env is scrubbed of
 * anything inherited from the developer's shell.
 */
const lacode = async (args, { transports, env = {} } = {}) => {
  const home = scratch("cli-home-")
  const base = {
    PATH: [transports?.bin, process.env.PATH].filter(Boolean).join(":"),
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
  }
  // promisified execFile omits `code` on success, so normalise it: every
  // assertion about "exits 0" is really an assertion about this field.
  const result = await exec(process.execPath, [CLI, ...args], { env: { ...base, ...env }, timeout: 20_000 }).catch((e) => e)
  return { ...result, code: result.code ?? 0 }
}

/**
 * Run the REAL `bin/oc-notify-receiver` the way a forced command runs it.
 *
 * The stub `ssh` above stops at the client side, so on its own it can only prove
 * what the sender passed. The half where notifications were actually lost is on
 * the other side of the hop: ssh concatenates everything after the host into ONE
 * command string and starts the forced command with no positional parameters, so
 * the receiver's real contract is the $SSH_ORIGINAL_COMMAND environment
 * variable. This helper supplies exactly that, with `notify-send` stubbed on
 * PATH and read back afterwards, so "the popup on the desktop" is a file read
 * rather than an assumption.
 *
 * The receiver is LINUX-ONLY by design (it delivers through notify-send, and
 * the forward that reaches it is a systemd user unit), but stubbing the notifier
 * makes it runnable -- and assertable -- from any platform, which is why this
 * helper stubs rather than skipping on darwin. What it pins here is the parse,
 * and the parse is portable.
 */
const runReceiver = async ({ command, args = [] } = {}) => {
  const transports = stubTransport()
  const home = scratch("receiver-home-")
  const result = await exec("bash", [join(ROOT, "bin", "oc-notify-receiver"), ...args], {
    env: {
      PATH: [transports.bin, process.env.PATH].filter(Boolean).join(":"),
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      SSH_ORIGINAL_COMMAND: command,
    },
    timeout: 10_000,
  }).catch((e) => e)
  return {
    code: result.code ?? 0,
    stderr: result.stderr ?? "",
    notifyArgv: transports.notifyArgv(),
  }
}

/** A port nothing is listening on, so the hop fails immediately and locally. */
const closedPort = async () => {
  const { createServer } = await import("node:net")
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// ---------------------------------------------------------------------------
// US-13 -- the notification reaches the local desktop
// ---------------------------------------------------------------------------

test("[US-13] a notification raised on a remote host is delivered to the local desktop", async () => {
  const transports = stubTransport()
  // SSH_CLIENT is what marks the process as the far end of an ssh connection.
  const { stdout } = await lacode(["notify", "opencode — Fix the login", "Task finished", "normal", "utilities-terminal"], {
    transports,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "desktop-user", OC_TUNNEL_PORT: "10022" },
  })

  // No desktop daemon is consulted for the hop itself: the notification travels
  // over the reverse forward and lands on the local side.
  const hop = transports.sshArgv()
  assert.ok(hop.length > 0, "the notification must cross the tunnel hop")
  assert.match(stdout, /^$/, "a successful send is silent")

  // …and this is the part the old stub could not reach. The single argument the
  // sender emitted is what a real ssh would have put in $SSH_ORIGINAL_COMMAND,
  // so hand that exact string to the real receiver and read the popup back. An
  // assertion that only the CLIENT argv looked right is what let a receiver
  // reading "$1".."$4" ship: over ssh those parameters are always empty.
  const payload = hop[hop.length - 1]
  const landed = await runReceiver({ command: payload })
  assert.equal(landed.code, 0, `the receiver must succeed: ${landed.stderr}`)
  assert.equal(
    landed.notifyArgv[0],
    "opencode — Fix the login",
    `the title must arrive at the desktop intact: ${JSON.stringify(landed.notifyArgv)}`,
  )
  assert.equal(landed.notifyArgv[1], "Task finished", `the body must arrive at the desktop intact: ${JSON.stringify(landed.notifyArgv)}`)
  assert.ok(landed.notifyArgv.includes("--urgency=normal"), "the urgency must arrive too")
  assert.ok(landed.notifyArgv.includes("--icon=utilities-terminal"), "the icon must arrive too")

  // And with the tunnel down, the SAME title reaches a desktop channel locally,
  // which is what "the local desktop shows it" means in the end.
  //
  // `desktopArgv()`, not `notifyArgv()`: the local channel is chosen by platform,
  // so on a Mac this is osascript rather than notify-send, and reading one
  // channel's log would assert against a binary that machine never runs.
  const local = stubTransport()
  await lacode(["notify", "opencode — Fix the login", "Task finished", "normal", "utilities-terminal"], { transports: local })
  assert.ok(local.desktopArgv().includes("opencode — Fix the login"), `the desktop must receive it: ${JSON.stringify(local.desktopArgv())}`)
})

test("[US-13] with OC_LOCAL_HOST set the hop is a direct ssh with ControlPersist, not a reverse-forward port", async () => {
  // The caller-owned transport: one warm connection and no machinery to manage.
  const transports = stubTransport()
  const { stdout } = await lacode(["notify", "opencode — Fix the login", "Task finished", "normal", "utilities-terminal"], {
    transports,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "desktop-user", OC_LOCAL_HOST: "desktop.example" },
  })
  const hop = transports.sshArgv()
  assert.ok(hop.length > 0, "the notification must cross the hop")
  assert.equal(hop.find((a) => a.includes("@")), "desktop-user@desktop.example", `the hop must target the configured host, got ${JSON.stringify(hop)}`)
  assert.ok(hop.includes("ControlMaster=auto"), "the direct hop must multiplex through a control master")
  assert.ok(hop.some((a) => a.startsWith("ControlPersist=")), "the master must stay warm between notifications")
  assert.ok(!hop.includes("-p") && !hop.includes("localhost"), `no reverse-forward port may be used, got ${JSON.stringify(hop)}`)
  // Still exactly one argument, still newline-delimited, still readable by a receiver.
  assert.equal(hop[hop.length - 1].split("\n")[0], "opencode — Fix the login", `the payload stays one argument, got ${JSON.stringify(hop[hop.length - 1])}`)
  assert.match(stdout, /^$/, "a successful send is silent")
})

test("[US-13] the desktop user and port come from configuration, never from the remote's id -u / id -un", async () => {
  const transports = stubTransport()
  await lacode(["notify", "T", "M"], {
    transports,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "desktop-user", OC_TUNNEL_PORT: "34567" },
  })

  const hop = transports.sshArgv()
  const target = hop.find((arg) => arg.includes("@"))
  assert.equal(target, "desktop-user@localhost", `the hop must name the configured desktop user, got ${target}`)
  assert.ok(hop.includes("34567"), `the hop must use the configured port: ${JSON.stringify(hop)}`)

  // A remote account is frequently root or a build user; `id -un` there names the
  // wrong person, so the code must never consult it. With OC_LOCAL_USER unset
  // it refuses rather than guessing.
  const guessing = stubTransport()
  const result = await lacode(["notify", "T", "M"], {
    transports: guessing,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "" },
  })
  assert.equal(result.code, 0, "refusing to guess is still a successful fire-and-forget call")
  assert.deepEqual(guessing.sshArgv(), [], "without a known desktop user nothing may be sent anywhere")
  assert.match(result.stderr, /OC_LOCAL_USER is unset/, `the refusal must be explained: ${result.stderr}`)
})

test("[US-13] unvalidated urgency and icon never reach a notifier, on any platform", async () => {
  // The security half, and it is the half that must hold everywhere. The local
  // channel differs by platform, so the assertion is made against EVERY stubbed
  // channel rather than the one this machine happens to pick: a hostile value
  // that leaked into a channel we did not expect is still a leak.
  const transports = stubTransport()
  await lacode(["notify", "T", "M", "not-a-urgency; rm -rf /", "../../etc/passwd"], { transports })

  const argv = transports.desktopArgv()
  assert.ok(argv.length > 0, `something must have reached a notifier: ${JSON.stringify(argv)}`)
  for (const arg of argv) {
    assert.doesNotMatch(arg, /rm -rf|passwd|\.\.\//, `an unvalidated argument reached a notifier: ${arg}`)
  }
})

test(
  "[US-13] urgency and icon are validated against a whitelist before notify-send is invoked",
  { skip: onDarwin ? SKIP_LINUX_CHANNEL : false },
  async () => {
    // The notify-send argument SHAPE, which is Linux-only: on macOS the local
    // channel is osascript, whose argv is `-e <script> <marker> <title> <body>`
    // and carries neither `--urgency=` nor `--icon=`. The whitelist itself is
    // platform-independent and is asserted just above, against every channel.
    const transports = stubTransport()
    await lacode(["notify", "T", "M", "not-a-urgency; rm -rf /", "../../etc/passwd"], { transports })

    const argv = transports.notifyArgv()
    assert.ok(argv.includes("--urgency=normal"), `an unknown urgency must collapse to the default: ${JSON.stringify(argv)}`)
    assert.ok(argv.includes("--icon=utilities-terminal"), `an unknown icon must collapse to the default: ${JSON.stringify(argv)}`)
    // Every whitelisted icon and urgency is passed through unchanged.
    for (const [urgency, icon] of [
      ["low", "dialog-error"],
      ["critical", "dialog-warning"],
      ["normal", "emblem-default"],
    ]) {
      const pass = stubTransport()
      await lacode(["notify", "T", "M", urgency, icon], { transports: pass })
      assert.ok(pass.notifyArgv().includes(`--urgency=${urgency}`), `${urgency} must pass through`)
      assert.ok(pass.notifyArgv().includes(`--icon=${icon}`), `${icon} must pass through`)
    }
  },
)

test("[US-13] the notification crosses the hop as ONE delimited argument, never as a shell string", async () => {
  const transports = stubTransport()
  const marker = join(scratch("pwned-"), "should-not-exist")
  const payload = `$(touch ${marker})`
  await lacode(["notify", `Title ${payload}`, `Message; touch ${marker}`, "normal", "utilities-terminal"], {
    transports,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "desktop-user" },
  })

  // Exactly ONE argument follows the host, carrying all four fields. Four
  // separate arguments looked equivalent on this side and delivered nothing: ssh
  // concatenates them into a single command string for the forced command.
  const hop = transports.sshArgv()
  const after = hop.slice(hop.indexOf("--") + 1)
  assert.equal(after.length, 1, `the hop must carry a single payload argument: ${JSON.stringify(hop)}`)
  const fields = after[0].split("\n")
  assert.equal(fields.length, 5, `the payload must be newline-delimited into five fields: ${JSON.stringify(fields)}`)
  assert.ok(fields[0].includes(payload), `the payload must cross verbatim in field 1: ${JSON.stringify(fields)}`)
  assert.ok(fields[1].includes(`Message; touch ${marker}`), `field 2 must cross verbatim: ${JSON.stringify(fields)}`)
  assert.equal(fields[2], "normal")
  assert.equal(fields[3], "utilities-terminal")
  assert.equal(fields[4], "none", "a four-argument caller still gets a valid payload with sound: 'none'")
  // ...and nothing was ever executed. A second command smuggled through the hop
  // would own the local desktop, which is why the receiver parses rather than
  // evaluates.
  assert.ok(!existsSync(marker), "the payload must never be evaluated by a shell")

  // The same on the receiving side: the notifier gets args, not a command line.
  const local = stubTransport()
  await lacode(["notify", `Title ${payload}`, "M", "normal", "utilities-terminal"], { transports: local })
  assert.ok(!existsSync(marker), "the local send must not evaluate the payload either")
  assert.ok(local.desktopArgv().includes(`Title ${payload}`), "the title must reach the desktop intact")
})

test("[US-13] the hop is resolved from configuration alone, so it survives the session that started it", async () => {
  // There is no login-side-effect wiring and no per-session state: the port and
  // user are read from the environment on every call. A session that outlives
  // its terminal therefore reaches the same supervised listener, because nothing
  // about the hop is tied to the caller.
  const first = stubTransport()
  await lacode(["notify", "first", "M"], {
    transports: first,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "desktop-user", OC_TUNNEL_PORT: "22222" },
  })
  // A second, entirely separate process with no shared state and no TTY.
  const second = stubTransport()
  const result = await lacode(["notify", "second", "M"], {
    transports: second,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "desktop-user", OC_TUNNEL_PORT: "22222" },
  })

  const targetOf = (log) => log.find((arg) => arg.includes("@"))
  assert.equal(targetOf(first.sshArgv()), "desktop-user@localhost")
  assert.equal(targetOf(second.sshArgv()), "desktop-user@localhost", "a later process must reach the same listener")
  assert.ok(first.sshArgv().includes("22222") && second.sshArgv().includes("22222"), "the port is configuration, not process state")
  assert.equal(result.code, 0)
  assert.doesNotMatch(result.stderr, /tty|login|pty/i, "nothing about the hop may depend on an attached terminal")
})

// ---------------------------------------------------------------------------
// US-18 -- the content survives the hop, and stays data the whole way
// ---------------------------------------------------------------------------

test("[US-18] the forced command reads the payload from the environment, never from positional arguments", async () => {
  // The defect that shipped: ssh starts a forced command with NO positional
  // parameters ($1..$4 are always empty here), so a receiver reading them fell
  // back to four defaults and every remote notification arrived blank. Passing
  // arguments on the command line would "fix" it for anyone testing by hand and
  // change nothing in production, so the receiver must ignore them outright.
  const positional = await runReceiver({ command: "", args: ["Positional title", "Positional body", "critical", "dialog-error"] })
  assert.equal(positional.notifyArgv[0], "LaCode", `the title must come from the payload, not $1: ${JSON.stringify(positional.notifyArgv)}`)
  assert.equal(positional.notifyArgv[1], "", `the body must come from the payload, not $2: ${JSON.stringify(positional.notifyArgv)}`)
  assert.ok(!positional.notifyArgv.includes("--urgency=critical"), "the urgency must not come from $3 either")

  // …and the real path: the environment variable alone is enough.
  const delivered = await runReceiver({ command: ["From the environment", "Body", "critical", "dialog-error"].join("\n") })
  assert.deepEqual(
    delivered.notifyArgv,
    ["From the environment", "Body", "--urgency=critical", "--icon=dialog-error"],
    `the payload must drive every field: ${JSON.stringify(delivered.notifyArgv)}`,
  )
})

test("[US-18] a body with spaces, punctuation and glob characters crosses the hop intact", async () => {
  // The regression in its original form: a body was fine until it contained a
  // space, which is invisible in every assertion that only looked at the
  // sender's argv. Round-trip the real sender through the real receiver.
  const title = "opencode — deploy prod"
  const body = "Step 3 of 7 failed: tests/*.spec.ts > 'should retry' — see /tmp/log (2 of 14)"
  const transports = stubTransport()
  await lacode(["notify", title, body, "critical", "dialog-error"], {
    transports,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "desktop-user" },
  })

  const hop = transports.sshArgv()
  const landed = await runReceiver({ command: hop[hop.length - 1] })
  assert.deepEqual(
    landed.notifyArgv,
    [title, body, "--urgency=critical", "--icon=dialog-error"],
    `the notification must arrive whole, not split on whitespace: ${JSON.stringify(landed.notifyArgv)}`,
  )
})

test("[US-18] a hostile payload is parsed as data: nothing runs and no argument is added", async () => {
  // $SSH_ORIGINAL_COMMAND is whatever the remote user typed; this script runs as
  // the desktop user. The sentinel file is the proof of execution: if any part
  // of the payload were evaluated -- by eval, by `sh -c`, or by splicing it into
  // an argument list -- one `touch` would land and the desktop would be owned.
  const marker = join(scratch("owned-"), "should-not-exist")
  const hostileTitle = `Title $(touch ${marker}) \`touch ${marker}\``
  const hostileBody = `Body; touch ${marker} && touch ${marker} | cat > ${marker}`
  const landed = await runReceiver({
    command: [hostileTitle, hostileBody, `low --icon=dialog-error`, `dialog-warning`, `extra; touch ${marker}`].join("\n"),
  })

  assert.ok(!existsSync(marker), "nothing in the payload may ever be executed")
  // Exactly four arguments: the two text fields verbatim, the two flags from
  // whitelisted values. The fifth field is dropped, and the injected
  // `--icon=dialog-error` inside the urgency field is replaced, not concatenated.
  assert.deepEqual(
    landed.notifyArgv,
    [hostileTitle, hostileBody, "--urgency=normal", "--icon=dialog-warning"],
    `a hostile payload must reach notify-send as inert text: ${JSON.stringify(landed.notifyArgv)}`,
  )
  assert.equal(landed.code, 0)
})

// ---------------------------------------------------------------------------
// US-14 -- degrade safely
// ---------------------------------------------------------------------------

test("[US-14] a payload that cannot be understood degrades to a LaCode popup instead of failing", async () => {
  // Nothing may throw out of the receiver: ssh is fire-and-forget on the far
  // side and a non-zero exit would surface as "the hop failed" on the remote,
  // sending the user to debug the tunnel when the tunnel is fine.
  for (const [label, command] of [
    ["empty", ""],
    ["the old space-joined sender", "Some Title Some Message normal utilities-terminal"],
  ]) {
    const landed = await runReceiver({ command })
    assert.equal(landed.code, 0, `${label}: the receiver must exit 0, got ${landed.code}: ${landed.stderr}`)
    assert.equal(landed.notifyArgv.length, 4, `${label}: it must still pop up exactly one notification: ${JSON.stringify(landed.notifyArgv)}`)
    assert.equal(landed.notifyArgv[0], label === "empty" ? "LaCode" : "Some Title Some Message normal utilities-terminal",
      `${label}: an unreadable payload must show its own content, not an empty popup`)
  }
})

test("[US-14] an unreachable host fails without blocking or throwing out of the caller", async () => {
  // The real ssh binary, against a port nothing listens on. Everything is
  // loopback and HOME is a temp dir with no key, so this is the genuine
  // unreachable path with no outside network and no chance of a prompt.
  const port = await closedPort()
  const started = Date.now()
  const result = await lacode(["notify", "Unreachable", "M", "normal", "utilities-terminal"], {
    env: {
      SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22",
      OC_LOCAL_USER: "desktop-user",
      OC_TUNNEL_PORT: String(port),
      OC_CONNECT_TIMEOUT_MS: "1000",
      OC_NOTIFY_KEY: join(scratch("no-key-"), "absent"),
    },
  })
  const elapsed = Date.now() - started

  assert.equal(result.code, 0, `fire-and-forget must exit 0 whatever happens:\n${result.stderr}`)
  assert.match(result.stderr, /not delivered/i, `the failure must be reported on stderr: ${result.stderr}`)
  assert.match(result.stderr, /remote/, `the transport must be named: ${result.stderr}`)
  assert.equal(result.stdout, "", `nothing may be written to stdout on a failed hop: ${result.stdout}`)
  // Bounded: a sleeping laptop must not be able to hold an agent open. The
  // budget is generous (15s against a 1s connect timeout) but real, because a
  // hang here is the failure the story is about.
  assert.ok(elapsed < 15_000, `the hop must be time-bounded, took ${elapsed}ms`)
})

test("[US-14] a failing hop never produces a desktop notification on the remote host", async () => {
  // The remote has no desktop session. If the fallback ever became a direct
  // notify-send, a notification raised here would die on a headless box -- the
  // exact failure the tunnel exists to prevent. A stub ssh that fails models a
  // hop that is down without needing a network.
  const transports = stubTransport()
  writeFileSync(join(transports.bin, "ssh"), `#!/bin/sh\necho 'ssh: connect to host localhost: Connection refused' >&2\nexit 255\n`)
  chmodSync(join(transports.bin, "ssh"), 0o755)

  const result = await lacode(["notify", "Headless", "M"], {
    transports,
    env: {
      SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22",
      OC_LOCAL_USER: "desktop-user",
      OC_CONNECT_TIMEOUT_MS: "1000",
    },
  })
  assert.deepEqual(transports.desktopArgv(), [], "a remote hop must never fall back to the remote host's own desktop, on any channel")
  assert.equal(result.code, 0, "a failed hop is still a successful fire-and-forget call")
  assert.match(result.stderr, /Connection refused/, `ssh's own diagnostic must reach the operator: ${result.stderr}`)
})

test("[US-14] a missing notify helper warns once and the plugin keeps working", async () => {
  // The machine under test has NO helper anywhere: no OC_NOTIFY_HELPER, an empty
  // HOME, and a package directory with none of the candidates findHelper looks
  // for — no bin/oc-notify (author-local, never published) and no dist/lacode.js
  // (built here, since this fixture copies the sources only). That is what the
  // warning exists for, and it is why the fixture reproduces the shape rather
  // than simulating it.
  const installed = scratch("installed-pkg-")
  cpSync(join(ROOT, "src"), join(installed, "src"), { recursive: true })
  cpSync(join(ROOT, "presets"), join(installed, "presets"), { recursive: true })
  cpSync(join(ROOT, "package.json"), join(installed, "package.json"))
  assert.ok(!existsSync(join(installed, "bin", "oc-notify")), "control: the published files list has no oc-notify")
  assert.ok(!existsSync(join(installed, "dist", "lacode.js")), "control: this fixture has no built CLI either")

  const { notifyHooks } = await import(join(installed, "src", "plugins", "notify.ts"))
  const home = scratch("no-home-")
  const previous = { HOME: process.env.HOME, helper: process.env.OC_NOTIFY_HELPER }
  process.env.HOME = home
  delete process.env.OC_NOTIFY_HELPER
  const lines = []
  const client = {
    app: { log: async ({ body }) => void lines.push(`${body.level} ${body.message}`) },
    session: { get: async ({ path: p }) => ({ data: { id: p.id, title: "Work" } }) },
  }
  try {
    const hooks = await notifyHooks({ client, directory: installed })
    for (let i = 0; i < 3; i++) {
      await hooks.event({ event: { type: "session.status", properties: { sessionID: `s${i}`, status: { type: "busy" } } } })
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: `s${i}` } } })
    }
    await settle(80)
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
    if (previous.helper !== undefined) process.env.OC_NOTIFY_HELPER = previous.helper
  }

  const warnings = lines.filter((line) => line.startsWith("warn") && /oc-notify helper/i.test(line))
  assert.equal(warnings.length, 1, `the missing helper must be warned about once, not once per notification:\n${lines.join("\n")}`)
  assert.match(warnings[0], /oc-sync/, `the warning must say how to fix it: ${warnings[0]}`)
  // Every event was still handled. A lost notification is reported honestly as
  // "notification failed" -- that is the design -- but nothing may be THROWN, and
  // the one-line warning must not be repeated per notification.
  assert.equal(lines.filter((line) => /handler failed|notify failed/.test(line)).length, 0, `no handler may throw:\n${lines.join("\n")}`)
  assert.equal(lines.filter((line) => line === "error notification failed").length, 3, "each lost notification is still accounted for")
})

test("[US-14] every ssh call clears its forwardings so it cannot compete for the tunnel port", async () => {
  // Without this, a RemoteForward in ~/.ssh/config half-claims the listener and
  // silently starves the one session that needed it.
  for (const args of [
    ["forward", "somehost", "--", "true"],
    ["notify", "T", "M"],
  ]) {
    const transports = stubTransport()
    await lacode(args, {
      transports,
      env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "desktop-user", OC_NOTIFY_KEY: join(scratch("k-"), "absent") },
    })
    const hop = transports.sshArgv()
    assert.ok(hop.length > 0, `${args[0]} must make an ssh call`)
    assert.ok(hop.includes("ClearAllForwardings=yes"), `${args[0]} must clear forwardings on its own call: ${JSON.stringify(hop)}`)
    // And the hop is non-interactive, so it can never block on a password prompt.
    assert.ok(hop.includes("BatchMode=yes"), `${args[0]} must not be able to prompt for credentials`)
  }
})

test("[US-14] an argument that is not whitelisted is rejected rather than forwarded", async () => {
  // Platform-independent, and asserted against every channel: whether this
  // machine picks notify-send, osascript or terminal-notifier, the unvalidated
  // urgency and icon are replaced rather than forwarded, and `$(id)` never
  // becomes an argument a notifier will act on.
  const transports = stubTransport()
  const hostile = "--hint=ignore;$(id)"
  await lacode(["notify", "T", "M", hostile, hostile], { transports })
  const argv = transports.desktopArgv()
  assert.ok(argv.length > 0, `the notification must still be delivered: ${JSON.stringify(argv)}`)
  assert.deepEqual(argv.filter((a) => a.includes("id)") || a.includes("hint=ignore")), [], `nothing unvalidated may reach a notifier: ${JSON.stringify(argv)}`)
})

test("[US-14] doctor reports what the environment resolves to without failing when nothing is configured", async () => {
  // Diagnostics are never a gate: a user with no tunnel configured must still
  // get a useful report and a zero exit.
  const transports = stubTransport()
  const bare = await lacode(["doctor"], { transports })
  assert.equal(bare.code, 0)
  assert.match(bare.stdout, /running\s+local/)

  const remote = await lacode(["doctor"], {
    transports,
    env: { SSH_CLIENT: "10.0.0.1 51000 10.0.0.2 22", OC_LOCAL_USER: "" },
  })
  assert.equal(remote.code, 0, "doctor must never fail")
  assert.match(remote.stdout, /running\s+remote/)
  assert.match(remote.stdout, /OC_LOCAL_USER is unset/, "doctor must say what is missing")
})

const { describe: describeEnv, localChannel, safeMessage, safeTitle, sendLocal, soundChannel } =
  await import(join(ROOT, "src", "tunnel", "index.ts"))

/**
 * Stub notifiers on the PATH of THIS process, for the duration of one callback.
 *
 * The CLI-driven tests above shell out to `bin/lacode`, which means they can only
 * ever exercise the channel the machine running them would pick -- so on a Linux
 * box they can never reach the macOS path at all. `sendLocal` and `describe` take
 * the platform as an argument precisely so that is not a dead end: the other
 * platform becomes a parameter instead of a different computer.
 *
 * It is the same seam as above, one process nearer: real binaries on a real PATH,
 * recording a real argv. Nothing here reaches a desktop, a network, or AppleScript.
 *
 * The PATH is REPLACED, not prepended, and carries only the stubs plus `sh` and
 * `sleep`. That matters: this machine has a real `notify-send` in /usr/bin, so a
 * prepended temp directory cannot express "no notifier is installed" at all, and
 * "the channel degrades when nothing is there" would quietly test nothing.
 */
const withStubs = (names, fn) => {
  const bin = scratch("stub-bin-")
  const logs = {}
  for (const name of names) {
    const log = join(bin, `${name}.log`)
    logs[name] = log
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(log)}; done\nexit 0\n`,
    )
    chmodSync(join(bin, name), 0o755)
  }
  // `command -v` is a shell builtin, so these two are all the PATH needs beyond
  // the stubs themselves: one to run the probe, one to stand in for a wedged
  // notifier that never returns.
  symlinkSync("/bin/sh", join(bin, "sh"))
  symlinkSync("/bin/sleep", join(bin, "sleep"))

  const previous = process.env.PATH
  process.env.PATH = bin
  const argvOf = (name) => {
    const log = logs[name]
    if (!log || !existsSync(log)) return []
    const parts = readFileSync(log, "utf8").split("\0")
    if (parts[parts.length - 1] === "") parts.pop()
    return parts
  }
  try {
    return fn({ bin, argv: argvOf })
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

/**
 * These two cases need a Mac that is missing a binary the OS ships, which a
 * machine that IS that Mac cannot fake by editing PATH.
 */
const REASON = "cannot simulate a Mac without osascript by editing the PATH of a Mac"

const REQUEST = {
  title: "opencode — Fix the login",
  message: "Task finished",
  urgency: "critical",
  icon: "dialog-error",
}

test("[US-26] on macOS the text is passed to osascript as arguments, never spliced into the script", () => {
  // notify-send is stubbed too, and must stay untouched: on a Mac the old code
  // reached for it, found nothing, and returned "not delivered" -- or, on a box
  // that did have one, popped up through a Linux binary instead of the Mac's.
  withStubs(["osascript", "notify-send", "terminal-notifier"], ({ argv }) => {
    const result = sendLocal(REQUEST, "darwin")

    assert.equal(result.ok, true, `the send must succeed: ${result.detail}`)
    assert.deepEqual(argv("notify-send"), [], "notify-send must not be invoked on macOS")
    assert.deepEqual(argv("terminal-notifier"), [], "osascript ships with macOS, so terminal-notifier is not the first choice")

    const sent = argv("osascript")
    assert.equal(sent.length, 5, `osascript gets -e, the script, and the two values: ${JSON.stringify(sent)}`)
    assert.equal(sent[0], "-e")
    // The script is a constant. The notification is not in it -- that is the whole
    // of the safety claim, and asserting it here is what makes it a claim.
    assert.ok(sent[1].includes("on run argv"), `the values must arrive through argv: ${sent[1]}`)
    assert.ok(sent[1].includes("item 3 of argv") && sent[1].includes("item 2 of argv"), sent[1])
    assert.ok(!sent[1].includes(REQUEST.title) && !sent[1].includes(REQUEST.message), `no notification text may be interpolated into AppleScript: ${sent[1]}`)
    // Past a fixed marker, so the user's own text can never be the argument that
    // ends osascript's option parsing and be eaten as a flag.
    assert.equal(sent[2], "lacode", `argv item 1 must be the constant marker: ${JSON.stringify(sent)}`)
    assert.deepEqual(sent.slice(3), [safeTitle(REQUEST.title), safeMessage(REQUEST.message)], `the values must arrive intact: ${JSON.stringify(sent)}`)
  })
})

test("[US-26] a title and body full of quotes and shell metacharacters reach osascript as inert data", () => {
  // Both fields are attacker-influenced text: a session title, a file path, a
  // command line. The sentinel is the proof of execution, exactly as it is for
  // the receiver in US-18 -- there is no AppleScript interpreter here to run a
  // payload, so what matters is that nothing can reach one.
  const marker = join(scratch("osascript-pwned-"), "should-not-exist")
  const hostileTitle = `Title "; touch ${marker}`
  const hostileBody = `Body "; touch ${marker}; $(touch ${marker}) ` + "`touch " + marker + "`" + ` & 'quoted' & | cat > ${marker}`

  withStubs(["osascript"], ({ argv }) => {
    const result = sendLocal({ title: hostileTitle, message: hostileBody }, "darwin")

    assert.equal(result.ok, true, `the send must succeed: ${result.detail}`)
    assert.ok(!existsSync(marker), "nothing in a notification may ever be executed")
    // Byte-for-byte. `safeText` strips control characters and collapses
    // whitespace, but nothing else: what the user is shown is what was sent.
    const sent = argv("osascript")
    assert.deepEqual(
      sent.slice(3),
      [safeTitle(hostileTitle), safeMessage(hostileBody)],
      `the hostile text must reach osascript as data: ${JSON.stringify(sent)}`,
    )
    assert.ok(sent[3].includes(";") && sent[3].includes('"'), "the metacharacters must be present, not stripped")
    assert.equal(sent[1].includes(hostileTitle) || sent[1].includes(hostileBody), false, "the script must not contain the payload")
  })
})

test("[US-26] macOS falls back to terminal-notifier only when osascript is absent", { skip: onDarwin ? REASON : false }, () => {
  withStubs(["terminal-notifier"], ({ argv }) => {
    const result = sendLocal(REQUEST, "darwin")
    assert.equal(result.ok, true, `the send must succeed: ${result.detail}`)
    assert.deepEqual(argv("osascript"), [], "no osascript on PATH means osascript cannot be the channel")
    assert.deepEqual(
      argv("terminal-notifier"),
      ["-title", safeTitle(REQUEST.title), "-message", safeMessage(REQUEST.message), "-appName", "LaCode", "-priority", "critical"],
      `terminal-notifier gets values as its own arguments: ${JSON.stringify(argv("terminal-notifier"))}`,
    )
  })

  // Both installed: osascript wins, because it is the one macOS ships with and
  // asking for a brew package is not something a notification may depend on.
  withStubs(["osascript", "terminal-notifier"], ({ argv }) => {
    assert.equal(sendLocal(REQUEST, "darwin").ok, true)
    assert.ok(argv("osascript").length > 0, "osascript is the primary channel")
    assert.deepEqual(argv("terminal-notifier"), [], "the fallback is a fallback")
  })
})

test("[US-26] a Mac with no notifier degrades to a reported failure, and never hangs", { skip: onDarwin ? REASON : false }, () => {
  withStubs([], () => {
    const started = Date.now()
    const result = sendLocal(REQUEST, "darwin")
    const elapsed = Date.now() - started

    // The silent-failure parity: the same shape Linux already returns for a
    // missing notify-send -- a result, not an exception -- so the fire-and-forget
    // caller still exits 0.
    assert.equal(result.ok, false)
    assert.equal(result.transport, "local")
    assert.match(result.detail, /osascript/, `the detail must name what is missing: ${result.detail}`)
    assert.ok(elapsed < 5_000, `a missing notifier must be reported at once, took ${elapsed}ms`)
  })

  // A notifier that never returns must be killed, not waited on: an agent must
  // not go down because a desktop notification server hung.
  withStubs(["osascript"], ({ bin, argv }) => {
    writeFileSync(join(bin, "osascript"), `#!/bin/sh\nsleep 120\n`)
    chmodSync(join(bin, "osascript"), 0o755)

    const started = Date.now()
    const result = sendLocal(REQUEST, "darwin")
    const elapsed = Date.now() - started
    assert.equal(result.ok, false, "a wedged notifier is a failed delivery, not a thrown error")
    assert.ok(elapsed < 15_000, `the send must be time-bounded, took ${elapsed}ms`)
    assert.deepEqual(argv("osascript"), [], "the stub records nothing: it never got as far as running")
  })
})

test("[US-26] Linux still delivers through notify-send, argument for argument unchanged", () => {
  withStubs(["osascript", "notify-send", "terminal-notifier"], ({ argv }) => {
    const result = sendLocal(REQUEST, "linux")

    assert.equal(result.ok, true, `the send must succeed: ${result.detail}`)
    assert.deepEqual(
      argv("notify-send"),
      ["opencode — Fix the login", "Task finished", "--urgency=critical", "--icon=dialog-error"],
      `the Linux call must be exactly what it always was: ${JSON.stringify(argv("notify-send"))}`,
    )
    assert.deepEqual(argv("osascript"), [], "macOS must not change what Linux does")
    assert.deepEqual(argv("terminal-notifier"), [], "macOS must not change what Linux does")
  })

  // ...and the default, with no platform argument, is still this machine's.
  //
  // Written against `localChannel()` rather than against notify-send's argv,
  // because the claim here is "the default is whatever THIS machine picks" and
  // that is not notify-send on a Mac. Pinning the literal Linux call here would
  // have made this test fail on a Mac for being on a Mac -- the
  // exact shape of bug this whole change exists to remove. The byte-exact Linux
  // call is pinned above and in the `sendLocal(REQUEST, "linux")` case, where it
  // belongs.
  withStubs(["notify-send", "osascript", "terminal-notifier"], ({ argv }) => {
    sendLocal(REQUEST)
    const expected = localChannel()
    assert.notEqual(expected, "none", `this machine must resolve to a channel; a test runner with no notifier proves nothing`)
    for (const channel of ["notify-send", "osascript", "terminal-notifier"]) {
      if (channel === expected) continue
      assert.deepEqual(argv(channel), [], `only ${expected} may run here, but ${channel} did: ${JSON.stringify(argv(channel))}`)
    }
    // Whatever the channel is, the title is an argument to it -- never spliced
    // into a command line.
    assert.ok(argv(expected).includes(REQUEST.title), `${expected} must have received the title as an argument: ${JSON.stringify(argv(expected))}`)
  })
})

test("[US-26] doctor names the channel this platform would use, not a binary it would not", () => {
  withStubs(["osascript", "notify-send", "terminal-notifier"], () => {
    const mac = describeEnv({}, "darwin")
    assert.equal(mac.channel, "osascript", "a Mac with osascript says so")
    assert.equal(localChannel("darwin"), "osascript")

    // The old report answered a different question: it said whether the Linux
    // binary existed, which on a Mac is true or false for no reason a caller
    // could act on, and left "will my notification appear?" unanswered.
    assert.equal(mac.notifySend, true, "notifySend still means what it always meant: the binary is installed")
    assert.notEqual(mac.channel, "none")

    assert.equal(describeEnv({}, "linux").channel, "notify-send")
    assert.equal(localChannel("linux"), "notify-send")
  })

  withStubs(["notify-send"], () => {
    // macOS is ADDED to the channels, not substituted for one. Every other
    // platform keeps notify-send whether or not it calls itself linux, because
    // restricting the new code to `platform === "linux"` would have silently
    // switched off delivery for anyone running notify-send from a non-libnotify
    // package on a FreeBSD or a WSL-less Unix.
    assert.equal(localChannel("sunos"), "notify-send")
    assert.equal(localChannel("win32"), "notify-send")
  })

  withStubs([], () => {
    // No notifier for this platform at all: the honest answer is "none", and it
    // is one doctor can print rather than a silent delivery failure.
    assert.equal(localChannel("darwin"), "none")
    assert.equal(describeEnv({}, "darwin").channel, "none")
    assert.equal(localChannel("win32"), "none", "with nothing installed, any platform reports none rather than guessing")
  })
})

// US-29 -- notification sound. The four outcomes each name a bundled WAV, and
// the sound is played HERE, on the machine that renders the notification, which
// is the only place a tone can be heard: a remote opencode host has no speakers.
// These drive sendLocal directly, because the player is spawned detached and the
// thing under test is which FILE it was handed, not what a notifier did with it.

/** Every player `soundChannel` may pick, so the assertion is not machine-bound. */
const PLAYERS = ["paplay", "aplay", "pw-play", "afplay"]

/**
 * Run `fn` with PATH holding only `names`, each a stub recording its argv.
 *
 * Its own helper rather than `withStubs`, because that one restores PATH in a
 * `finally` around a non-awaited `fn`: fine for a synchronous notifier, wrong
 * here, because the sound player is spawned detached and is still writing its
 * log after `sendLocal` has already returned. Awaiting the body keeps PATH
 * installed until the log it waits for actually exists.
 */
const withStubsAwaited = async (names, fn) => {
  const bin = scratch("sound-")
  const logs = {}
  for (const name of names) {
    const log = join(bin, `${name}.log`)
    logs[name] = log
    writeFileSync(join(bin, name), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(log)}; done\nexit 0\n`)
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
  /** The detached spawn writes its log on a later tick than sendLocal returns. */
  const waitFor = async (name) => {
    for (let i = 0; i < 50 && argvOf(name).length === 0; i++) await settle()
    return argvOf(name)
  }

  const previous = process.env.PATH
  process.env.PATH = bin
  try {
    await fn({ argv: argvOf, waitFor })
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

test("[US-29] the sound is handed to the player as a bundled asset that exists", async () => {
  await withStubsAwaited([...PLAYERS, "notify-send"], async ({ argv, waitFor }) => {
    const channel = soundChannel()
    assert.notEqual(channel, "none", "a player stub is on PATH, so one must be picked")

    sendLocal({ title: "opencode", message: "Task finished", sound: "done" })
    const played = await waitFor(channel)

    assert.equal(played.length, 1, `the player is given the file and nothing else: ${JSON.stringify(played)}`)
    assert.ok(existsSync(played[0]), `the sound must be a real asset, not a name or a path built from the wire: ${played[0]}`)
    assert.match(played[0], /sounds[/\\]done\.wav$/, `the name must resolve to that outcome's own asset: ${played[0]}`)
  })
})

test("[US-29] a sound name off the whitelist plays nothing and is never a path", async () => {
  // The sender is the untrusted side of the hop. A name that is not one of the
  // five must resolve to silence, because anything else turns the tunnel into a
  // way to make the receiver open an arbitrary file.
  await withStubsAwaited([...PLAYERS, "notify-send"], async ({ argv, waitFor }) => {
    const channel = soundChannel()
    assert.notEqual(channel, "none")

    for (const hostile of ["noisy", "../../../../etc/passwd", "/etc/passwd", "done.wav"]) {
      sendLocal({ title: "opencode", message: "Task finished", sound: hostile })
      await waitFor(channel)
      assert.deepEqual(argv(channel), [], `an unlisted name must play nothing, not ${hostile}`)
    }

    // And the notification itself is unaffected: audio is additive, never a gate.
    assert.equal(sendLocal({ title: "opencode", message: "m", sound: "noisy" }).ok, true)
  })
})

test("[US-29] the sound still plays on a desktop with no notification channel at all", async () => {
  // No notifier stub is installed, so localChannel reports "none" and sendLocal
  // takes its early return. That desktop is precisely where the tone is the only
  // alert there is, so the sound must not be skipped along with the popup.
  await withStubsAwaited(PLAYERS, async ({ argv, waitFor }) => {
    assert.equal(localChannel(), "none", "this case is only meaningful with no notifier installed")

    const channel = soundChannel()
    assert.notEqual(channel, "none")

    const result = sendLocal({ title: "opencode", message: "Task finished", sound: "error" })
    const played = await waitFor(channel)

    assert.equal(result.ok, false, "the popup is still reported as undelivered -- the sound does not fake a success")
    assert.equal(played.length, 1, `the sound must still play: ${JSON.stringify(played)}`)
    assert.match(played[0], /sounds[/\\]error\.wav$/)
  })
})
