#!/usr/bin/env node
// Offline checks for the shell scripts in bin/. These are the load-bearing
// pieces of oc-sync -- a silently broken default flag or a stray else turns a
// sync into a no-op that reports success -- so they are asserted rather than
// eyeballed.
//
// No network, no running server: every check is either a syntax parse, a static
// assertion on the source, or a run of the script against a temp HOME and a temp
// host list.

import { execFileSync, spawn, spawnSync } from "node:child_process"
import { test as nodeTest } from "node:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, chmodSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const BIN = path.join(REPO, "bin")

let passed = 0
let skipped = 0
const failures = []

/**
 * `check(name, fn)` runs the body; `check(name, fn, { skip })` records a skip
 * with a reason instead.
 *
 * A skip is only ever correct when the thing under test cannot exist on this
 * machine -- not when it is inconvenient. Every skip below names a specific,
 * checkable cause, so "it was skipped" is never mistaken for "it passed".
 *
 * The body runs HERE, once, and the outcome is then MIRRORED into node's test
 * runner as a named subtest. This suite predates node:test and keeps its own
 * harness, so without the mirror `node --test tests/` counted the whole file
 * as ONE test: a regression in any of these checks was invisible in the
 * runner's output, and the suite's pass count said nothing about how much was
 * actually checked. The mirror runs nothing twice -- it only reports what this
 * harness already decided.
 */
const check = (name, fn, options = {}) => {
  if (typeof options.skip === "string" && options.skip) {
    skipped++
    console.log(`SKIP: ${name} -- ${options.skip}`)
    nodeTest(name, { skip: options.skip }, () => {})
    return
  }
  try {
    fn()
    passed++
    nodeTest(name, () => {})
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    nodeTest(name, () => { throw new Error(error.message) })
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const read = (name) => readFileSync(path.join(BIN, name), "utf8")

// ---------------------------------------------------------------------------
// Platform capability, probed rather than assumed.
//
// These scripts drive a Linux SERVER over ssh and a Linux DESKTOP tunnel, so
// several checks below are Linux-only by design. Whether a check can run is a
// question about THIS machine's bash and its PATH, not about its OS label: a
// macOS box with a Homebrew bash 5 on PATH can run the same things a Linux box
// can, and a Debian container on an old base image cannot. Probing means the
// skips land where the real cause is.
// ---------------------------------------------------------------------------

const bashVersion = (() => {
  const result = spawnSync("bash", ["-c", 'printf "%s" "$BASH_VERSION"'], { encoding: "utf8" })
  return (result.stdout || "").trim()
})()

const bashMajor = Number(bashVersion.split(".")[0]) || 0

/**
 * True when `timeout` -- GNU coreutils, absent from macOS -- is on the PATH the
 * child will see. bin/oc-sync wraps every ssh and rsync in it, so without it
 * the run cannot work; the preflight is what now says so.
 */
const hasTimeout = () => spawnSync("sh", ["-c", "command -v timeout"], { encoding: "utf8" }).status === 0

/** Is a command on the PATH the child will see? Probed, never assumed. */
const hasCommand = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0

/**
 * A PATH with one binary removed, rather than a PATH that merely happens to
 * lack something.
 *
 * Two properties make this the right instrument for "what happens on a machine
 * without X". It REPLACES rather than prepends, so nothing leaks in from the
 * real PATH and the absence is real; and it keeps everything else -- bash, awk,
 * ssh -- so the child dies of the cause under test and not of a missing
 * interpreter, which would make a check pass for the wrong reason.
 *
 * A command that is not installed anywhere on the PATH is left alone: the
 * condition under test already holds.
 */
const pathWithout = (command) => {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  const created = [mkdtempSync(path.join(tmpdir(), "ocsync-path-"))]
  const kept = dirs
    .map((dir) => {
      if (!existsSync(path.join(dir, command))) return dir
      const next = mkdtempSync(path.join(tmpdir(), "ocsync-passthrough-"))
      created.push(next)
      for (const entry of readdirSync(dir)) {
        if (entry === command) continue
        try { symlinkSync(path.join(dir, entry), path.join(next, entry)) } catch { /* not a symlink target */ }
      }
      return next
    })
    .filter(Boolean)
  // `scratch` is every directory this made, including the pass-through ones:
  // a helper that made a temp directory per PATH entry and returned only one of
  // them would leave the rest behind on every call.
  return { PATH: [created[0], ...kept].join(path.delimiter), scratch: () => created.forEach((d) => rmSync(d, { recursive: true, force: true })) }
}

/** Why a check that runs bin/oc-sync cannot run here, or "" if it can. */
const NO_OC_SYNC = [
  bashMajor < 4
    ? `bin/oc-sync needs bash 4.0+ (mapfile, declare -A) and this PATH's bash is ${bashVersion || "unknown"}`
    : "",
  // `timeout` is GNU coreutils and macOS ships BSD userland. bin/oc-sync's own
  // preflight refuses to run without it, so a check that expects the run to
  // proceed would be asserting the failure instead of the behaviour.
  !hasTimeout() ? "bin/oc-sync needs GNU coreutils' timeout, which this PATH does not have" : "",
].filter(Boolean).join("; ")

/**
 * Why the checks that run the tunnel preflight's REMOTE half cannot run here,
 * or "" if they can.
 *
 * The remote script finds the holder of the port with `ss`, and the stand-in
 * listener that plays the remote's sshd is written in python (or netcat, if
 * there is no python). Both are probed rather than assumed.
 */
const NO_REMOTE_PROBE = [
  !hasCommand("ss") ? "the remote script finds its listener with ss, and this PATH has no ss" : "",
  !hasCommand("python3") && !hasCommand("nc")
    ? "the stand-in listener for the remote's sshd needs python3 or nc, and this PATH has neither"
    : "",
].filter(Boolean).join("; ")

// Every run of oc-sync from this file must be hermetic.
//
// With no OC_SYNC_ENV_FILE the script sources the personal
// ~/.config/opencode/.env, and that file carries the real OC_HOSTS. The checks
// below that only mean to exercise flag parsing would then deploy to actual
// machines: `--scripts-only --no-config` with OC_HOSTS="" got past the (now
// overridden) empty host list, walked two real hosts and rsynced `oc` to them,
// and the check passed because it only asserts that no flag was rejected.
// Pointing OC_SYNC_ENV_FILE at a path that does not exist is what makes
// "OC_HOSTS='' means no hosts" true again.
const hermeticEnv = (extra = {}) => ({
  ...process.env,
  OC_SYNC_ENV_FILE: path.join(tmpdir(), "nonexistent-ocsync-env"),
  ...extra,
})

// ---------------------------------------------------------------------------
// Syntax
//
// `bash -n` only PARSES, so this passes under bash 3.2 -- macOS's version --
// for every script here, including the ones whose bodies use bash 4 builtins.
// That is worth knowing rather than assuming: this check is a syntax gate, not a
// runtime one, and the runtime gate is the preflight check further down.
// ---------------------------------------------------------------------------

for (const script of ["oc", "oc-notify", "oc-sync", "oc-notify-receiver", "oc-tunnel-preflight"]) {
  check(`syntax: ${script}`, () => {
    const result = spawnSync("bash", ["-n", path.join(BIN, script)], { encoding: "utf8" })
    assert(result.status === 0, `bash -n failed: ${result.stderr}`)
  })
}

// ---------------------------------------------------------------------------
// --with-config is the default
//
// The regression this guards: plain `oc-sync` synced only `oc`, so a change to
// AGENTS.md stayed on this machine while hosts ran the old rules. Fixing
// AGENTS.md and then running oc-sync without a flag appeared to work and moved
// nothing.
// ---------------------------------------------------------------------------

check("oc-sync defaults to --with-config", () => {
  const src = read("oc-sync")
  assert(/^WITH_CONFIG=1$/m.test(src), "WITH_CONFIG should initialise to 1")
  assert(!/^WITH_CONFIG=0$/m.test(src), "WITH_CONFIG should not initialise to 0")
})

check("oc-sync still offers a scripts-only opt-out", () => {
  const src = read("oc-sync")
  assert(/--scripts-only\|--no-config\)\s+WITH_CONFIG=0/.test(src), "the opt-out must set WITH_CONFIG=0")
})

check("oc-sync scripts-only actually disables config", () => {
  // Run the parser with a bogus host list so it exits before doing any work,
  // and confirm the flag pair is still accepted rather than rejected as unknown.
  // It must also actually stop at the empty host list: this check once ran for
  // 23 seconds against two real machines, because the personal .env supplied
  // OC_HOSTS and overrode the empty one, and it still "passed" on the flag
  // assertion alone. Asserting the guard keeps that from being invisible.
  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--scripts-only", "--no-config"], {
    encoding: "utf8",
    env: hermeticEnv({ OC_HOSTS: "", OC_HOSTS_FILE: path.join(tmpdir(), "nonexistent-oc-hosts") }),
  })
  const output = (result.stdout || "") + (result.stderr || "")
  assert(!/unknown option/.test(output), `--scripts-only/--no-config rejected: ${output.trim()}`)
  assert(/no hosts configured/.test(output),
    `an empty host list must stop the run before any ssh or rsync: ${output.trim()}`)
}, { skip: NO_OC_SYNC })

check("oc-sync rejects an unknown flag", () => {
  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--bogus-flag"], {
    encoding: "utf8",
    env: hermeticEnv(),
  })
  assert(result.status === 2, `expected exit 2 for an unknown flag, got ${result.status}`)
})

// ---------------------------------------------------------------------------
// The repo and the config dir are two trees
//
// The regression: this repo used to BE the opencode config dir, so
// CONFIG_DIR defaulted to $REPO_DIR and every path in the sync set was a
// repo path. They were split — the package lives in the repo, the personal
// config (opencode.jsonc, AGENTS.md, commands/, rules/) lives beside it — and
// plain `oc-sync --with-config` then died on `opencode.jsonc not found` while
// `bin/oc` was synced from a directory that no longer had one.
// ---------------------------------------------------------------------------

const resolveConfigDir = (home) => execFileSync("bash", ["-c",
  'eval "$(grep -E \'^CONFIG_DIR=\' "$1")"; printf "%s" "$CONFIG_DIR"', "_", path.join(BIN, "oc-sync"),
], { encoding: "utf8", env: { ...process.env, HOME: home, OC_SYNC_CONFIG_DIR: undefined } })

check("the config dir defaults to the personal config, not to the repo", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-cfgdir-"))
  try {
    const resolved = resolveConfigDir(home)
    assert(resolved === path.join(home, ".config", "opencode"),
      `CONFIG_DIR should resolve under $HOME/.config/opencode, got ${resolved}`)
    assert(resolved !== REPO, `CONFIG_DIR must not default to the repo (${REPO})`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

check("OC_SYNC_CONFIG_DIR still overrides the config dir", () => {
  // A path that exists on every platform this suite runs on: tmpdir() rather
  // than a literal /tmp, which on macOS is a symlink to /private/tmp and would
  // still compare equal here but is not the temp root the rest of the suite uses.
  const elsewhere = path.join(tmpdir(), "somewhere-else")
  const out = execFileSync("bash", ["-c",
    'eval "$(grep -E \'^CONFIG_DIR=\' "$1")"; printf "%s" "$CONFIG_DIR"', "_", path.join(BIN, "oc-sync"),
  ], { encoding: "utf8", env: { ...process.env, OC_SYNC_CONFIG_DIR: elsewhere } })
  assert(out === elsewhere, `the override must win, got ${out}`)
})

check("every synced item is read from the tree that owns it", () => {
  // Static, because the personal config tree is not part of this repository. A
  // path pointed at the wrong one is silent: rsync reports the failure, but only
  // after the host has been reached and the earlier items have already landed.
  const src = read("oc-sync")
  const fromRepo = ['$REPO_DIR/bin/$SCRIPT', '$REPO_DIR/src/', '$REPO_DIR/presets/', '$REPO_DIR/plugins/']
  const fromConfig = [
    '$CONFIG_DIR/opencode.jsonc', '$CONFIG_DIR/AGENTS.md', '$CONFIG_DIR/$DIR',
    '$CONFIG_DIR/.opencode/prompts', '$CONFIG_DIR/.opencode/prompts/',
  ]
  for (const needle of fromRepo) {
    assert(src.includes(needle), `the repo owns this and it must be sourced there: ${needle}`)
  }
  for (const needle of fromConfig) {
    assert(src.includes(needle), `the config dir owns this and it must be sourced there: ${needle}`)
  }
  // The inverse, which is how the regression presents: a package path read out
  // of the config dir, where it does not exist.
  for (const stale of ['$CONFIG_DIR/bin/', '$CONFIG_DIR/src', '$CONFIG_DIR/presets', '$CONFIG_DIR/plugins']) {
    assert(!src.includes(stale), `nothing may be read out of the config dir that lives in the repo: ${stale}`)
  }
  // .opencode/ carries a package.json, a lockfile and tens of megabytes of
  // node_modules in both trees, so only prompts/ may be pushed.
  assert(!/push "\.opencode\/" /.test(src), "the whole .opencode/ must not be pushed, only .opencode/prompts/")
})

check("the host list still comes from .env, found in the config dir", () => {
  // Same split, same class of bug: .env is host-specific, so it moved with the
  // rest of the personal config. Pointed at the repo it finds nothing and the
  // script falls through to the legacy ~/.oc-hosts list -- which still works,
  // so the drift is invisible until the two disagree.
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-envfile-"))
  try {
    const script = path.join(home, "probe.sh")
    mkdirSync(path.join(home, "repo", "bin"), { recursive: true })
    writeFileSync(path.join(home, "repo", "bin", "oc-sync"), read("oc-sync"))
    writeFileSync(script, 'REPO_DIR="$1"\n' +
      read("oc-sync").split("\n").slice(
        read("oc-sync").split("\n").findIndex((l) => l.startsWith("ENV_FILE_DEFAULT=")),
        read("oc-sync").split("\n").findIndex((l) => l.startsWith("fi")) + 1,
      ).join("\n") + '\nprintf "%s" "$ENV_FILE"\n')
    // The config dir's .env exists, the repo's does not: the config dir wins.
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    writeFileSync(path.join(home, ".config", "opencode", ".env"), "OC_HOSTS=\"\"\n")
    const withConfig = execFileSync("bash", [script, path.join(home, "repo")], {
      encoding: "utf8", env: { ...process.env, HOME: home, OC_SYNC_ENV_FILE: undefined },
    })
    assert(withConfig === path.join(home, ".config", "opencode", ".env"),
      `expected the config dir's .env, got ${withConfig}`)
    // With neither present, the repo path is still the fallback, so an older
    // checkout that keeps .env beside the script is not silently ignored.
    rmSync(path.join(home, ".config", "opencode", ".env"))
    const fallback = execFileSync("bash", [script, path.join(home, "repo")], {
      encoding: "utf8", env: { ...process.env, HOME: home, OC_SYNC_ENV_FILE: undefined },
    })
    assert(fallback === path.join(home, "repo", ".env"),
      `expected the repo .env as the fallback, got ${fallback}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// oc: notification wiring
// ---------------------------------------------------------------------------

check("oc builds no remote notify-send command string", () => {
  // The old bug: a command string containing `id -u` was built on the host and
  // executed locally, so a root host produced /run/user/0/bus, which does not
  // exist on the desktop. The notification vanished with no error.
  const src = read("oc")
  const inSendNotify = src.slice(src.indexOf("send_notify()"), src.indexOf("# oc-notify reuses"))
  assert(!/notify-send "?\\?/.test(inSendNotify) || !/DISPLAY=/.test(inSendNotify),
    "send_notify must not hand a display/dbus command string to a remote shell")
  assert(!/\bid -u\b/.test(inSendNotify), "send_notify must not expand id -u remotely")
})

check("oc sends the notification as ONE newline-delimited argument, not as argv", () => {
  // The old four-argument hop looked right and delivered nothing: ssh
  // concatenates everything after the host into a single command string, and
  // the forced command is started with NO positional parameters, so
  // "$title" "$msg" "$urgency" "$icon" arrived as one space-joined blob the
  // receiver could not split -- four defaults, and an empty popup.
  const src = read("oc")
  const hop = src.slice(src.indexOf("if [[ -n \"${SSH_CLIENT"), src.indexOf("else\n    # Local"))
  assert(/local payload=/.test(hop), "the hop should assemble a single payload variable")
  assert(/payload="\$\{title\}"\$'\\n'/.test(hop), "the payload should join the fields with newlines")
  assert(/-- "\$payload"/.test(hop), "the hop should pass exactly that one argument after --")
  assert(!/"\$title" "\$msg"/.test(hop), "the hop must no longer pass four separate arguments")
})

check("the hop payload strips the delimiter from the fields it joins on", () => {
  // Newline is the delimiter, so a title or message carrying one would forge
  // extra fields. The payload is only self-delimiting if both are stripped
  // first -- this is the property that makes the single-argument form safe.
  const src = read("oc")
  const body = src.slice(src.indexOf("send_notify()"), src.indexOf("# oc-notify reuses"))
  assert(/title="\$\{title\/\/\[\[:cntrl:\]\]\/ \}"/.test(body), "the title must lose control characters before the payload is built")
  assert(/msg="\$\{msg\/\/\[\[:cntrl:\]\]\/ \}"/.test(body), "the message must lose control characters too")
})

check("oc uses the dedicated tunnel key, never a personal key", () => {
  const src = read("oc")
  assert(/oc_notify/.test(src), "oc should reference the dedicated tunnel key")
  assert(!/id_ed25519|id_rsa|id_ecdsa/.test(src), "oc must not reference personal keys")
})

check("oc's failure message names the real cause", () => {
  // Every line here was a real cause of silence. The wording used to point at
  // ~/.ssh/config, which is no longer where the tunnel lives -- so the advice
  // sent people to the wrong file while the actual fault was a systemd unit.
  const src = read("oc")
  assert(/systemctl --user status oc-tunnel@/.test(src), "should point at the tunnel unit on the desktop")
  assert(/remote\.env/.test(src), "should mention the per-host marker file that carries the port and user")
  assert(/oc-sync/.test(src), "should say which command repairs it")
  // Stale advice is worse than none: it is confidently wrong.
  assert(!/RemoteForward/.test(src.replace(/^\s*#.*$/gm, "")), "the RemoteForward era advice must be gone")
})

check("the hop resolves the desktop user from a marker file, not just the env", () => {
  // Regression: OC_LOCAL_USER is exported from .bashrc/.profile, which covers an
  // interactive ssh and nothing else. The notify plugin invokes oc-notify as a
  // detached child of an already-running server, so the variable was unset and
  // the fallback was `id -un` == root -- the hop died with
  // "root@localhost: Permission denied (publickey,password)" and, because the
  // receiver is a forced command, said nothing useful about why.
  const src = read("oc")
  assert(/read_notify_env|remote\.env/.test(src), "should read a marker file that needs no shell to source")
  assert(!/LOCAL_USER="\$\{OC_LOCAL_USER:-\$\(id -un\)\}"/.test(src),
    "must not fall back to id -un: on these hosts that is root, which is never the desktop user")
  assert(/OC_LOCAL_USER is unset/.test(src),
    "an unresolvable username should say which variable is missing, not guess")
})

check("the tunnel port is resolved per host, from the same marker file", () => {
  // Each host now gets its own listener port, so a context that cannot see the
  // rc files must still learn its own port. Falling back to the old global 10022
  // would point at another host's tunnel, or at nothing.
  const src = read("oc")
  assert(/read_notify_env OC_TUNNEL_PORT/.test(src), "the port should come from the marker file too")
})

check("oc no longer notifies on start, and does not duplicate the finished case", () => {
  // A start notification interrupts to say nothing: no result, no title, nothing
  // to act on. The success case belongs to the plugin, which knows the session
  // name and whether work actually finished -- `oc` exiting 0 only means the
  // process ended.
  const src = read("oc")
  // Comments are excluded: the file explains why the start notification is gone,
  // and the check is about behaviour, not about the absence of a phrase.
  const code = src.replace(/^\s*#.*$/gm, "")
  assert(!/Starting session/.test(code), "no notification should fire before opencode runs")
  assert(!/send_notify "OpenCode" "Session finished"/.test(code),
    "the finished notification would duplicate the plugin's, without a session name")
  // The failure case stays: a crash is something the plugin never observed.
  assert(/Session exited with code/.test(src), "a nonzero exit is still worth a critical notification")
})

check("warn() exists for multi-line diagnostics", () => {
  // The three causes are reported as separate lines, so the once-only guard must
  // not suppress them all after the first call.
  const src = read("oc")
  assert(/^warn\(\) \{/m.test(src), "a plain warn helper is needed for follow-up lines")
})

check("oc is idempotent about the tunnel key being absent", () => {
  // A missing key must produce a warning, never a hard failure: the session has
  // to start regardless.
  const src = read("oc")
  assert(/warn_once "no tunnel key at/.test(src), "missing key should warn")
  assert(/warn_once/.test(src), "warn_once should exist")
})

check("oc passes opencode's exit code through", () => {
  const src = read("oc")
  assert(/"\$OPENCODE_BIN" "\$@"/.test(src), "oc should run the resolved binary with the original args")
  const tail = src.slice(src.indexOf("EXIT_CODE=$?"))
  assert(/exit \$EXIT_CODE/.test(tail), "oc should exit with opencode's code")
})

check("oc finds opencode outside an interactive shell", () => {
  // The regression: opencode lives in ~/.opencode/bin, added to PATH by .bashrc.
  // `oc` from tmux or a detached session found nothing and exited 127, while an
  // interactive shell worked. So the lookup must not rely on PATH alone.
  const src = read("oc")
  assert(/resolve_opencode/.test(src), "oc should resolve the binary explicitly")
  assert(/\.opencode\/bin\/opencode/.test(src), "should check the ~/.opencode/bin install location")
  const resolve = src.slice(src.indexOf("resolve_opencode()"), src.indexOf("OPENCODE_BIN="))
  assert(/command -v opencode/.test(resolve), "should still prefer PATH when it works")
})

check("oc reports a missing binary instead of exiting silently", () => {
  const src = read("oc")
  assert(/cannot find the opencode binary/.test(src), "should explain a missing binary")
  assert(/OPENCODE_BIN="\$\(resolve_opencode\)"/.test(src), "should bail when resolution fails")
})

check("oc-notify does not start opencode", () => {
  const src = read("oc-notify")
  assert(/OC_NOTIFY_ONLY=1 exec/.test(src), "oc-notify should delegate via OC_NOTIFY_ONLY")
  assert(!/\bopencode\b\s+"\$@"/.test(src.replace(/^#.*$/gm, "")), "oc-notify must not call opencode directly")
})

// ---------------------------------------------------------------------------
// oc-notify-receiver: what the tunnel key is allowed to do
// ---------------------------------------------------------------------------

check("receiver reads the payload from SSH_ORIGINAL_COMMAND, never from $1..$4", () => {
  // The bug this pins: an authorized_keys forced command is started with no
  // arguments of its own, so "$1" is always empty and every field fell back to
  // its default -- an empty popup on the desktop with nothing in the logs.
  //
  // Deliberately NOT pinned to `mapfile`. This used to assert the literal text
  // "mapfile -t fields", which made it a test about one implementation of
  // "split on newlines" rather than about the split. That is how the script
  // could sit on a bash-4 builtin while every desktop it was installed on ran
  // bash 3.2 -- macOS ships 3.2, and there `mapfile` is "command not found",
  // `fields` stays unset, and all four fields silently fall back to their
  // defaults. The assertion below is the property that actually matters: the
  // payload is read from the environment, and split on newlines only.
  const src = read("oc-notify-receiver")
  assert(/SSH_ORIGINAL_COMMAND/.test(src), "the receiver should read the payload from the environment")
  assert(!/\$\{1:-/.test(src) && !/\$\{2:-/.test(src), "it must not read positional parameters: ssh passes none")
  // Newline-only splitting, whichever way it is spelled. `readarray` is bash's
  // other name for `mapfile` and has the same floor.
  assert(
    /mapfile\s+-t/.test(src) || /readarray\s+-t/.test(src) || /while\s+IFS=\s*read\s+-r/.test(src),
    "it must split the payload on newlines only -- never on whitespace, or a message with spaces is shredded",
  )
})

check("receiver actually splits the payload, on this machine's bash", () => {
  // The behavioural counterpart to the assertion above, and the one that would
  // have caught the bash-3.2 failure: it EXECUTES the receiver with a payload
  // that defeats word splitting (spaces, a glob character, a shell metacharacter)
  // and reads back what notify-send was handed.
  //
  // This is a source-shape test's blind spot. Every assertion above passed with
  // `mapfile` in the file while the script raised a blank "LaCode" popup on
  // every macOS desktop, because "the file mentions mapfile" is not "mapfile
  // ran". Stubbing notify-send keeps it offline and deterministic; the split
  // logic is plain bash, so it behaves identically wherever it runs.
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-recv-"))
  const stub = path.join(home, "notify-send")
  const log = path.join(home, "argv.log")
  writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(log)}; done\nexit 0\n`)
  chmodSync(stub, 0o755)

  const body = "Step 3 of 7 failed: tests/*.spec.ts > 'should retry'"
  try {
    const result = spawnSync("bash", [path.join(BIN, "oc-notify-receiver")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${home}${path.delimiter}${process.env.PATH}`,
        HOME: home,
        SSH_ORIGINAL_COMMAND: `A Title\n${body}\ncritical\ndialog-error`,
      },
    })
    assert(result.status === 0, `the receiver must exit 0 with a stub notifier: ${result.stderr}`)
    assert(!/command not found/.test(result.stderr), `a builtin was missing: ${result.stderr.trim()}`)
    const argv = readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0)
    assert(argv[0] === "A Title", `title must survive verbatim, got ${JSON.stringify(argv)}`)
    // The whole point: word splitting would turn this into six arguments, and
    // globbing would have eaten the `*` even if it had not.
    assert(argv[1] === body, `the body must arrive as ONE argument, got ${JSON.stringify(argv)}`)
    // The app name: the popup's header IS the notification's app name, and
    // notify-send reports its own name ("notify-send") when none is given, so
    // every send has to name LaCode itself.
    assert(argv[2] === "--app-name=LaCode", `the popup must be raised under LaCode's name, got ${JSON.stringify(argv)}`)
    assert(argv[3] === "--urgency=critical", `urgency must survive, got ${JSON.stringify(argv)}`)
    assert(argv[4] === "--icon=dialog-error", `icon must survive, got ${JSON.stringify(argv)}`)
    // --expire-time=0 is the freedesktop "never expire" timeout: the popup waits
    // for the user to close it instead of being taken away by the desktop's own
    // timer, and a notice the user missed is no notice. It is the last argument,
    // and nothing else is added after it.
    assert(argv[5] === "--expire-time=0", `the notification must never be auto-dismissed, got ${JSON.stringify(argv)}`)
    assert(argv.length === 6, `the never-expire flag must be the last argument, got ${JSON.stringify(argv)}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

check("receiver never evaluates the payload, and says why", () => {
  // $SSH_ORIGINAL_COMMAND is attacker-controlled and this runs as the desktop
  // user. The comment is load-bearing: without it the next reader "simplifies"
  // the parse back into an eval and reopens remote code execution on the local
  // desktop session.
  const src = read("oc-notify-receiver")
  const code = src.replace(/^\s*#.*$/gm, "").replace(/^\s*$/gm, "")
  assert(!/eval /.test(code), "the receiver must not eval the payload")
  assert(!/sh -c /.test(code), "the receiver must not hand the payload to a shell")
  assert(/NEVER `eval/.test(src), "the reason must be written down where a reader will hit it")
  assert(/ATTACKER-CONTROLLED/.test(src), "the comment must name the threat")
})

check("receiver validates urgency against a whitelist", () => {
  const src = read("oc-notify-receiver")
  assert(/case "\$URGENCY" in/.test(src), "urgency should be case-checked")
  assert(/low\|normal\|critical/.test(src), "urgency whitelist should list the valid values")
})

check("receiver validates the icon against a whitelist", () => {
  // The icon is the one value interpolated into a notify-send call, so it is the
  // one that must not be attacker-controlled.
  const src = read("oc-notify-receiver")
  assert(/case "\$ICON" in/.test(src), "icon should be case-checked")
})

check("receiver uses notify-send with quoted arguments", () => {
  const src = read("oc-notify-receiver")
  assert(/exec notify-send "\$TITLE" "\$MSG"/.test(src), "title and message must be quoted")
})

check("a notification is never auto-dismissed: the receiver asks for no expiry", () => {
  // --expire-time=0 is the freedesktop "never expire" timeout. Without it the
  // desktop daemon's own timer dismisses the popup, and a notice the user
  // missed is no notice.
  const src = read("oc-notify-receiver")
  assert(/exec notify-send "\$TITLE" "\$MSG" --app-name=LaCode --urgency="\$URGENCY" --icon="\$ICON" --expire-time=0/.test(src),
    "the receiver must pass --expire-time=0 to notify-send")
})

check("a notification is never auto-dismissed: oc asks for no expiry", () => {
  // The local branch of send_notify must carry the same never-expire flag the
  // receiver does: a notification raised on this host stays until the user
  // closes it too.
  const src = read("oc")
  assert(/notify-send "\$title" "\$msg" --app-name=LaCode --urgency="\$urgency" --icon="\$icon" --expire-time=0/.test(src),
    "the local branch must pass --expire-time=0 to notify-send")
})

check("every notify-send call names the app, so the popup does not claim to be 'notify-send'", () => {
  // The popup's header IS the notification's app name, and notify-send reports
  // its OWN name when none is given -- so a send that does not name LaCode
  // raises a popup that claims to be from a program the user never ran.
  //
  // Both scripts, every call site: the flag is a property of the popup, not of
  // one branch of it, and a call that forgets it is a popup with the wrong
  // header and nothing else to show it.
  for (const script of ["oc", "oc-notify-receiver"]) {
    const src = read(script)
    // Comments are stripped first, and only a real invocation is matched: a
    // line that hands two quoted variables to notify-send. `command -v
    // notify-send` is not a send.
    const code = src.replace(/^\s*#.*$/gm, "")
    const calls = code.match(/notify-send "\$[A-Za-z_]+" "\$[A-Za-z_]+"[^\n]*/g) || []
    assert(calls.length > 0, `${script} must call notify-send`)
    for (const call of calls) {
      assert(/--app-name=LaCode/.test(call), `every notify-send call in ${script} must name the app: ${call}`)
    }
  }
})

check("receiver fails cleanly, with a way out, where notify-send does not exist", () => {
  // The macOS case, and the reason the receiver is Linux-only BY DESIGN rather
  // than by accident. A Mac has no notify-send, and this script is the desktop
  // half of a tunnel whose persistence is a systemd --user unit, so there is no
  // macOS reading of the hop to port.
  //
  // What is testable, and what this pins, is that the refusal is HONEST: a
  // non-zero exit and a message that names both what is missing and what to use
  // instead. A bare "command not found" from a forced command over ssh reaches
  // nobody, which is how a broken desktop half presents as a working one.
  //
  // Hermetic rather than platform-gated: `pathWithout` removes notify-send
  // from the PATH this child sees, which is exactly the state a Mac is in, on
  // any machine. On a machine that never had one the PATH is simply returned
  // unchanged and the same assertion holds.
  const stripped = pathWithout("notify-send")
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-nonotify-"))
  try {
    const result = spawnSync("bash", [path.join(BIN, "oc-notify-receiver")], {
      encoding: "utf8",
      env: {
        PATH: stripped.PATH,
        HOME: home,
        SSH_ORIGINAL_COMMAND: "A Title\nA body\ncritical\ndialog-error",
      },
    })
    const output = (result.stdout || "") + (result.stderr || "")
    assert(result.status === 127, `expected the conventional "not found" status 127, got ${result.status}: ${output.trim()}`)
    assert(/notify-send/.test(output), `the missing channel must be named: ${output.trim()}`)
    // The way out, not just the wall.
    assert(/lacode notify/.test(output), `the message must point at the portable path: ${output.trim()}`)
  } finally {
    stripped.scratch()
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The helper: raising a popup, and taking it back down
// ---------------------------------------------------------------------------
//
// A popup lives on the desktop, and only the desktop knows the id the
// notification daemon gave it. So the helper that RAISES the popup records that
// id under the notification's correlation key, and the helper that is asked to
// CLOSE it reads the file back, closes every id in it over the session bus, and
// deletes the file.
//
// Both run here for real, with the notifier and the session bus stubbed on a
// PATH of their own: a real binary, a real argv, a real exit status. Nothing
// reaches a desktop, a network or a session bus, and nothing is written outside
// a temp directory.

/**
 * A stub PATH with the notifier and the session bus stubbed out.
 *
 * `notify-send` prints the id the daemon would have assigned, but ONLY when it
 * is asked for one with `--print-id`: that id is the only handle on the popup,
 * and a notifier that printed it unasked would put a number where an answer
 * belongs. `gdbus` records the notification ids it was asked to close.
 */
const stubDesktop = (dir, { notifyId = "42" } = {}) => {
  const notifyLog = path.join(dir, "notify-send.log")
  const gdbusLog = path.join(dir, "gdbus.log")
  writeFileSync(
    path.join(dir, "notify-send"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(notifyLog)}; done\n` +
      `for a in "$@"; do if [ "$a" = "--print-id" ]; then printf '%s\\n' ${JSON.stringify(notifyId)}; break; fi; done\n` +
      `exit 0\n`,
  )
  writeFileSync(
    path.join(dir, "gdbus"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(gdbusLog)}; done\nexit 0\n`,
  )
  chmodSync(path.join(dir, "notify-send"), 0o755)
  chmodSync(path.join(dir, "gdbus"), 0o755)
  const argvOf = (log) => {
    if (!existsSync(log)) return []
    const parts = readFileSync(log, "utf8").split("\0")
    if (parts[parts.length - 1] === "") parts.pop()
    return parts
  }
  return {
    notifyArgv: () => argvOf(notifyLog),
    closedIds: () => argvOf(gdbusLog).filter((arg) => /^\d+$/.test(arg)),
  }
}

/** The env a helper run needs to be hermetic: no tunnel, no real HOME. */
const helperEnv = (dir, state, extra = {}) => ({
  PATH: `${dir}${path.delimiter}${process.env.PATH}`,
  HOME: dir,
  LACODE_NOTIFY_DIR: state,
  ...extra,
})

check("the helper records the notification id under its correlation key", () => {
  // Without an id there is no handle on the popup, so a later close request
  // could never find it. The id is asked for, recorded next to the key, and
  // kept OFF stdout: stdout is the answer channel, and the answer is the
  // action the user clicked.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-notify-id-"))
  const state = mkdtempSync(path.join(tmpdir(), "ocsync-notify-state-"))
  try {
    const desktop = stubDesktop(dir)
    const result = spawnSync(
      "bash",
      [path.join(BIN, "oc-notify"), "opencode — Deploy", "Task finished", "normal", "utilities-terminal"],
      { encoding: "utf8", env: helperEnv(dir, state, { LACODE_NOTIFY_SESSION: "ses_abc123" }) },
    )

    assert(result.status === 0, `the notification must succeed: ${result.stderr}`)
    assert(desktop.notifyArgv().includes("--print-id"),
      `the notifier must be asked for the id: ${JSON.stringify(desktop.notifyArgv())}`)
    const ids = readFileSync(path.join(state, "ses_abc123.ids"), "utf8")
    assert(ids === "42\n", `the id must be recorded under the correlation key: ${JSON.stringify(ids)}`)
    assert(!result.stdout.includes("42"), `the id must never reach stdout: ${JSON.stringify(result.stdout)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

check("the helper closes a session's popups when it is asked to, and sends nothing", () => {
  // A close request is not a notification. It takes the popups down, spends the
  // id file, sends nothing at all and exits 0 -- a dismissal that raised a
  // popup of its own would be worse than no dismissal.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-notify-close-"))
  const state = mkdtempSync(path.join(tmpdir(), "ocsync-notify-state-"))
  try {
    const desktop = stubDesktop(dir)
    writeFileSync(path.join(state, "ses_abc123.ids"), "42\n43\n")
    const result = spawnSync(
      "bash",
      [path.join(BIN, "oc-notify"), "opencode", "", "normal", "utilities-terminal"],
      { encoding: "utf8", env: helperEnv(dir, state, { LACODE_NOTIFY_CLOSE: "ses_abc123" }) },
    )

    assert(result.status === 0, `a close request must succeed: ${result.stderr}`)
    assert(JSON.stringify(desktop.closedIds()) === JSON.stringify(["42", "43"]),
      `every recorded id must be closed: ${JSON.stringify(desktop.closedIds())}`)
    assert(!existsSync(path.join(state, "ses_abc123.ids")), "the id file must be spent once its ids are closed")
    assert(desktop.notifyArgv().length === 0, `a close request must send no notification: ${JSON.stringify(desktop.notifyArgv())}`)
    assert((result.stdout || "") === "", `a close request must print nothing: ${JSON.stringify(result.stdout)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// oc-sync: tunnel provisioning
// ---------------------------------------------------------------------------

check("oc-sync provisions a dedicated key, not the personal one", () => {
  const src = read("oc-sync")
  // The path lives in a variable beside the function; the function body only
  // refers to it. Check both, or the assertion passes vacuously.
  assert(/^TUNNEL_KEY="\$HOME\/\.ssh\/oc_notify"$/m.test(src), "TUNNEL_KEY should be ~/.ssh/oc_notify")
  assert(/^RECEIVER="\$HOME\/\.local\/bin\/oc-notify-receiver"$/m.test(src),
    "RECEIVER should be the local notifier")
  assert(!/id_ed25519\.pub|id_rsa\.pub|id_ecdsa\.pub/.test(src),
    "must not read personal public keys into authorized_keys")
  assert(!/cat "\$HOME\/\.ssh\/id_/.test(src), "must not inline a personal key into the tunnel entry")
})

check("oc-sync restricts the tunnel key to a forced command", () => {
  const src = read("oc-sync")
  const fn = src.slice(src.indexOf("setup_tunnel_auth()"), src.indexOf("setup_tunnel_auth\nTUNNEL_AUTH_FAILED"))
  assert(/restrict,command=/.test(fn), "authorized_keys entry must carry restrict + command=")
  assert(/already restricted/.test(fn), "the entry must be detected, not appended blindly on every run")
})

check("oc-sync ships the tunnel key to the host", () => {
  const src = read("oc-sync")
  assert(/oc_notify.*~?\/\.ssh\/oc_notify/.test(src) || /"\$TUNNEL_KEY" "\$\{HOST\}:~\/\.ssh\/oc_notify"/.test(src),
    "the private key must be pushed to the host")
  assert(/chmod 600 ~\/\.ssh\/oc_notify/.test(src), "the pushed key must be mode 600 on the host")
})

check("oc-sync's own ssh calls never claim the tunnel port", () => {
  // oc-sync makes a dozen ssh calls per host. With RemoteForward configured, each
  // one competes for port 10022 and prints "remote port forwarding failed" --
  // and a half-claimed listener can block the one session that needs the tunnel.
  const src = read("oc-sync")
  assert(!/-e "ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=15"/.test(src),
    "every ssh invocation should pass ClearAllForwardings=yes")
  const plain = src.match(/-e "ssh[^"]*"/g) || []
  for (const spec of plain) {
    assert(/ClearAllForwardings=yes/.test(spec), `rsync ssh spec missing the flag: ${spec}`)
  }
  assert((src.match(/SSH_BASE=\(ssh -n "\$\{SSH_SSH_OPTS\[@\]\}"\)/) || []).length === 1,
    "SSH_BASE should use the shared opts array")
})

check("oc-sync installs a supervised tunnel unit per host", () => {
  // Regression: the RemoteForward in ~/.ssh/config belongs to whichever session
  // logged in first and only exists while that session lives. Observed on
  // dev-host: the session started at 13:54, the tunnel's owner at 15:19, so
  // five finished tasks notified a port that did not exist yet.
  const src = read("oc-sync")
  assert(/systemd\/user/.test(src), "units should be user units, not system ones")
  assert(/ExecStart=.*ssh -N/.test(src), "the unit should hold a forward with ssh -N")
  assert(/Restart=always/.test(src), "a dropped connection must come back on its own")
  assert(/enable-linger/.test(src), "the tunnel must survive logout, or it depends on a login again")
  // -o RemoteForward=<port> localhost:22 is parsed by ssh as option plus
  // hostname, so it fails with "Could not resolve hostname localhost:22".
  assert(/-R \$port:localhost:22/.test(src), "the forward should use -R, not a split -o value")
  assert(!/-o RemoteForward=\$port localhost:22/.test(src), "that -o form does not parse")
})

check("each host gets its own tunnel port, derived stably from its name", () => {
  // Two hosts sharing one port means only one of them can ever notify.
  const src = read("oc-sync")
  assert(/host_tunnel_port/.test(src), "ports should be derived per host")
  const fn = src.slice(src.indexOf("host_tunnel_port()"), src.indexOf("assert_ports_unique()"))
  // It must not depend on a counter that changes between runs, or a host's
  // cached OC_TUNNEL_PORT would point at a different host's listener. The port is
  // a pure function of the host name.
  assert(!/\bfor\b.*HOSTS/.test(fn), "the port must not depend on the host list order")
  assert(/port_hash/.test(fn), "the port should come from a name-derived hash")

  // Two hosts on one port is fatal and quiet: the loser's unit crash-loops on
  // ExitOnForwardFailure, so only one of them can ever notify.
  assert(/assert_ports_unique/.test(src), "collisions should be checked before any unit is written")
  assert(/exit 1/.test(src.slice(src.indexOf("assert_ports_unique()"), src.indexOf("install_tunnel_unit()"))),
    "a collision should stop the run, not warn and continue")
})

check("the collision guard actually fires", () => {
  // Executed, not pattern-matched: an "ab"/"ba" pair really does collide, and a
  // guard that never triggers is indistinguishable from one that is not wired up.
  const src = read("oc-sync")
  const fns = src.slice(src.indexOf("host_tunnel_port()"), src.indexOf("assert_ports_unique()"))
    + src.slice(src.indexOf("assert_ports_unique()"), src.indexOf("install_tunnel_unit()"))
  // exit 1 is the expected outcome for the collision case, so the probe reports
  // through stdout and exits 0 either way.
  const probe = `
TUNNEL_BASE_PORT=10022
${fns}
ok() { echo "ok:$*"; }
warn() { echo "warn:$*"; }
bad() { echo "err:$*"; }
ONLY_HOST=""
HOSTS=(ab ba)
( assert_ports_unique ) && echo "collide=passed" || echo "collide=stopped"
HOSTS=(ab cd)
( assert_ports_unique ) && echo "distinct=passed" || echo "distinct=stopped"
exit 0
`
  const out = execFileSync("bash", ["-c", probe], { encoding: "utf8" })
  assert(/collide=stopped/.test(out), `a real collision must stop the run: ${out}`)
  assert(/claimed by both/.test(out), `and must say which two hosts: ${out}`)
  assert(/distinct=passed/.test(out), `distinct hosts must pass: ${out}`)
}, { skip: NO_OC_SYNC })

check("oc-sync removes the RemoteForward that used to race the unit", () => {
  // Left in place, the config line wins the port on every login and then drops
  // the tunnel the moment that terminal closes -- which is the original bug.
  const src = read("oc-sync")
  assert(/drop_config_remoteforward/.test(src), "the config lines should be removed")
  assert(/ocsync-backup/.test(src), "editing a file outside the repo needs a backup to be recoverable")
})

check("oc-sync's env marker is written with an absolute path and read back", () => {
  // Shipped bug: ENV_PATH was "~/.config/opencode/remote.env" inside double
  // quotes, so the shell created a literal directory named "~" on both hosts and
  // the run still printed success. The redirect returning 0 proves nothing.
  //
  // What is actually under test is the SHAPE of the path, not its directory: it
  // must expand $HOME and must never carry a quoted tilde. The directory itself
  // is deliberately not pinned here — this line runs inside the <<'REMOTE'
  // heredoc, so it names the REMOTE host's opencode config dir, which is the
  // consumer's layout and does not move when this repository does.
  const src = read("oc-sync")
  assert(/ENV_PATH="\$HOME\//.test(src), "the path must expand $HOME, not a quoted tilde")
  assert(!/ENV_PATH="~/.test(src), "a quoted ~ is not expanded by the shell and creates a literal ~ directory")
  assert(/ENV_PATH="\$HOME\/[^"]*remote\.env"/.test(src), "the marker must still be named remote.env under $HOME")
  assert(/grep -q "\^export OC_LOCAL_USER="/.test(src), "the file must be verified after writing")

  // It is a REMOTE-side path: it must stay inside the heredoc piped to the host,
  // so a change to this repo's own location can never move it.
  const heredoc = src.indexOf("<<'REMOTE'")
  assert(heredoc !== -1, "oc-sync must still pipe a script to the remote host")
  assert(heredoc < src.indexOf('ENV_PATH="$HOME/'), "ENV_PATH must be inside the remote heredoc")
})

check("oc-notify propagates a failed delivery as its exit status", () => {
  // Regression: this branch ended in `|| true; exit 0`, so plugins/notify.ts had no
  // signal at all -- it logged "notified" on every delivery, which is how five
  // notifications were reported as sent while nothing reached the desktop.
  const src = read("oc")
  const branch = src.slice(src.indexOf('if [[ -n "${OC_NOTIFY_ONLY:-}" ]]'), src.indexOf("resolve_opencode()"))
  assert(/exit \$\?/.test(branch), "oc-notify must exit with send_notify's status")
  assert(!/\|\| true/.test(branch), "the failure must not be swallowed here")
  // The wrapper's own crash path keeps its old contract: a notification failure
  // never changes opencode's exit code.
  const wrapper = src.slice(src.indexOf("resolve_opencode()"))
  assert(/Session exited with code/.test(wrapper.replace(/^\s*#.*$/gm, "")),
    "a nonzero opencode exit is still notified")
})

check("oc-sync repairs a stale authorized_keys receiver path", () => {
  // A receiver that moved leaves hosts holding a key that cannot authenticate,
  // so notifications fail with a permission error. The entry must be rewritten.
  const src = read("oc-sync")
  assert(/re-pointed a stale tunnel key entry/.test(src), "should detect and rewrite a stale entry")
  assert(/grep -v "oc-notify tunnel auth"/.test(src), "should drop the old line before rewriting")
})

check("oc-sync syncs oc-notify alongside oc", () => {
  const src = read("oc-sync")
  assert(/for SCRIPT in oc oc-notify/.test(src), "both scripts should be pushed")
})

check("a tunnel-key failure is a warning, not a host failure", () => {
  // Losing the key must not stop the config sync: the config is what keeps the
  // context protocol current, and notifications are repairable.
  const src = read("oc-sync")
  assert(/warn "could not send the tunnel key/.test(src), "key push failure should warn")
  assert(!/FAILED\+=.*could not send the tunnel key/.test(src), "key push failure must not mark the host failed")
})

// ---------------------------------------------------------------------------
// End to end, offline: oc-sync against a fake host
// ---------------------------------------------------------------------------

check("dry run writes nothing and reports no failure", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-home-"))
  const envFile = path.join(home, ".env")
  mkdirSync(path.join(home, ".ssh"), { recursive: true })
  writeFileSync(path.join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA test\n")
  // An empty host list: the script must exit before touching anything, which is
  // what lets the provisioning block run in isolation.
  writeFileSync(envFile, 'OC_HOSTS=""\n')

  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, OC_SYNC_ENV_FILE: envFile },
  })
  const output = (result.stdout || "") + (result.stderr || "")
  try {
    assert(/no hosts configured/.test(output), `expected the empty-host guard, got: ${output.trim()}`)
    assert(/dry run: nothing was written/.test(output) || !/rsync/.test(output), "dry run must not transfer")
    assert(!existsSync(path.join(home, ".ssh", "oc_notify")),
      "dry run must not generate the tunnel key")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, { skip: NO_OC_SYNC })

check("--help exits 0 and prints usage", () => {
  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--help"], {
    encoding: "utf8",
    env: hermeticEnv(),
  })
  assert(result.status === 0, `--help exited ${result.status}`)
  assert(/--scripts-only/.test(result.stdout), "help should document the opt-out")
})

// ---------------------------------------------------------------------------
// The preflight: bin/oc-sync is Linux-only, and says so instead of guessing
//
// These run EVERYWHERE, on macOS and Linux alike, and deliberately so: the
// condition being tested is a missing dependency, and one can be produced
// hermetically by taking `timeout` off the PATH. That makes them the checks
// that actually hold the portable-skip honest -- if the preflight regressed to
// running anyway, these would fail on the machine that most needs them.
// ---------------------------------------------------------------------------

check("oc-sync refuses to run without GNU timeout, and names what is missing", () => {
  // The failure this replaces. Under bash 3.2 the host list is read with
  // `mapfile`; that builtin does not exist, the array comes back empty, and the
  // script reported "Error: no hosts configured." -- a confident wrong answer
  // that sends the reader to edit .env while the real cause is the interpreter
  // in front of them.
  const stripped = pathWithout("timeout")
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-"))
  try {
    const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--dry-run"], {
      encoding: "utf8",
      env: hermeticEnv({ PATH: stripped.PATH, HOME: home, OC_HOSTS: "a-host", OC_HOSTS_FILE: "/nonexistent" }),
    })
    const output = (result.stdout || "") + (result.stderr || "")
    assert(result.status === 1, `expected exit 1 from the preflight, got ${result.status}: ${output.trim()}`)
    assert(/timeout/.test(output), `the missing dependency must be named: ${output.trim()}`)
    assert(!/no hosts configured/.test(output),
      `the misleading "no hosts configured" diagnosis must not come back: ${output.trim()}`)
    // A way forward, not just a wall. Which way depends on the machine: on a Mac
    // there is nothing to install and the answer is a different command, while on
    // a Linux box that is merely short of coreutils the answer is `apt install`.
    // Pinning either one would have made this check fail on the platform whose
    // case it was written for.
    assert(/coreutils|lacode notify/.test(output), `the message must offer a way forward: ${output.trim()}`)
  } finally {
    stripped.scratch()
    rmSync(home, { recursive: true, force: true })
  }
})

check("oc-sync's preflight runs AFTER argument parsing, so --help and bad flags still behave", () => {
  // Otherwise the preflight would swallow the two answers a user needs most on
  // the machine where it fires: what does this do, and is my flag right.
  const stripped = pathWithout("timeout")
  try {
    const help = spawnSync("bash", [path.join(BIN, "oc-sync"), "--help"], {
      encoding: "utf8",
      env: hermeticEnv({ PATH: stripped.PATH }),
    })
    assert(help.status === 0, `--help must still exit 0, got ${help.status}: ${help.stderr}`)
    assert(/--scripts-only/.test(help.stdout), "help must still print usage")

    const bogus = spawnSync("bash", [path.join(BIN, "oc-sync"), "--bogus-flag"], {
      encoding: "utf8",
      env: hermeticEnv({ PATH: stripped.PATH }),
    })
    assert(bogus.status === 2, `an unknown flag must still exit 2, got ${bogus.status}`)
    assert(/unknown option/.test(bogus.stderr), `and must still say so: ${bogus.stderr.trim()}`)
  } finally {
    stripped.scratch()
  }
})

// ---------------------------------------------------------------------------
// oc-tunnel-preflight: the tunnel unit's ExecStartPre
//
// The unit's ExecStartPre frees a tunnel port that a DEAD session still holds
// on the remote. The desktop's ssh connection is gone -- its address changed,
// or the machine slept -- but the remote's sshd keeps the port bound until its
// own TCP keepalive notices, which takes hours. The unit then fails forever
// with "remote port forwarding failed for listen port PORT", and every
// notification from that host dies silently.
//
// Three properties have to hold at once, and each is checked on its own:
//
//   1. IT NEVER FAILS. A preflight that exits non-zero is a unit that does not
//      start, which is worse than the stale port it was meant to clear.
//   2. IT ASKS THE REMOTE THE RIGHT QUESTION. The remote script is fed to ssh
//      on stdin, so that text IS the contract: it has to probe the listener,
//      not guess at it.
//   3. IT ONLY KILLS AN sshd. Anything else on that port belongs to somebody
//      else.
//
// The remote half is tested by extracting the script the preflight sends and
// running it HERE, against a stand-in listener: no network, and the ssh call
// itself is a stub that records what it was given.
// ---------------------------------------------------------------------------

const PREFLIGHT = path.join(BIN, "oc-tunnel-preflight")

/**
 * The remote-side script the preflight feeds to ssh on stdin.
 *
 * It is a heredoc in the source, so it is read out of the file rather than
 * restated here: a copy in the test would keep passing after the script
 * changed, and the script is the whole contract with the remote.
 */
const remoteScript = () => {
  const src = read("oc-tunnel-preflight")
  const marker = "<<'REMOTE'\n"
  const start = src.indexOf(marker)
  assert(start !== -1, "the preflight must feed the remote script to ssh on stdin")
  const from = start + marker.length
  const end = src.indexOf("\nREMOTE\n", from)
  assert(end !== -1, "the remote script must be closed by its REMOTE terminator")
  return src.slice(from, end)
}

/**
 * An `ssh` stub that records how it was called.
 *
 * The preflight must never open a real connection, so `ssh` on the PATH is a
 * script that writes its argv and its stdin to files. The stdin file holds
 * the remote script exactly as the preflight sent it; the argv file holds the
 * options and arguments it sent it with.
 */
const sshStub = (dir, { status = 0, say = "" } = {}) => {
  const argvFile = path.join(dir, "ssh-argv")
  const stdinFile = path.join(dir, "ssh-stdin")
  const stub = path.join(dir, "ssh")
  const lines = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
    `cat > ${JSON.stringify(stdinFile)}`,
  ]
  if (say) lines.push(`printf '%s\\n' ${JSON.stringify(say)}`)
  lines.push(`exit ${status}`)
  writeFileSync(stub, lines.join("\n") + "\n")
  chmodSync(stub, 0o755)
  return { argvFile, stdinFile, stub }
}

/** Run the preflight with the stubbed ssh first on the PATH. */
const runPreflight = (dir, args = []) => spawnSync("bash", [PREFLIGHT, ...args], {
  encoding: "utf8",
  env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
})

check("the tunnel preflight exits 0 and says nothing without a host and a port", () => {
  // A preflight is the unit's ExecStartPre: whatever it exits with, the unit
  // does. It must never be the reason the unit fails to start.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-noargs-"))
  try {
    const stub = sshStub(dir)
    const result = runPreflight(dir)
    assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`)
    assert(result.stdout === "", `the preflight must print nothing, got ${JSON.stringify(result.stdout)}`)
    assert(!existsSync(stub.argvFile), "ssh must not be called without a host and a port")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check("the tunnel preflight never reaches ssh with a bad host or port", () => {
  // An empty host, an empty port and a non-numeric port are all "do nothing":
  // there is no remote to ask, and a port that is not a number is not a port.
  const cases = [["", "10022"], ["a-host", ""], ["a-host", "abc"]]
  for (const [host, port] of cases) {
    const dir = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-bad-"))
    try {
      const stub = sshStub(dir)
      const result = runPreflight(dir, [host, port])
      assert(result.status === 0, `host=${host} port=${port}: expected exit 0, got ${result.status}: ${result.stderr}`)
      assert(result.stdout === "", `host=${host} port=${port}: expected no output, got ${JSON.stringify(result.stdout)}`)
      assert(!existsSync(stub.argvFile), `host=${host} port=${port}: ssh must not be called at all`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

check("the tunnel preflight survives an unreachable remote", () => {
  // ssh failing is the normal case when the remote is down or the network is
  // gone. The preflight must still succeed: the unit's own attempts are what
  // report that, and a preflight that failed would take the unit down with it.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-unreachable-"))
  try {
    const stub = sshStub(dir, { status: 255 })
    const result = runPreflight(dir, ["a-host", "10022"])
    assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`)
    assert(result.stdout === "", `the preflight must print nothing, got ${JSON.stringify(result.stdout)}`)
    assert(existsSync(stub.argvFile), "ssh must have been tried: the remote script is the whole point")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check("the tunnel preflight prints the remote's line and nothing else", () => {
  // Exactly one line, and only when a port was actually freed: the systemd
  // journal records the recovery and stays quiet the rest of the time.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-line-"))
  try {
    const freed = "oc-tunnel-preflight: freed a dead listener on port 10022"
    sshStub(dir, { say: freed })
    const result = runPreflight(dir, ["a-host", "10022"])
    assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`)
    assert(result.stdout === `${freed}\n`, `expected exactly the freed line, got ${JSON.stringify(result.stdout)}`)

    // Anything else the remote says is not the one line the preflight knows,
    // so it stays silent rather than putting noise in the journal.
    sshStub(dir, { say: "some other output" })
    const quiet = runPreflight(dir, ["a-host", "10022"])
    assert(quiet.status === 0, `expected exit 0, got ${quiet.status}: ${quiet.stderr}`)
    assert(quiet.stdout === "", `expected no output, got ${JSON.stringify(quiet.stdout)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check("the remote script probes the listener instead of guessing at it", () => {
  // The remote script is fed to ssh on stdin, so its text IS the contract.
  // Three things have to be in it:
  //   - the ss lookup that finds WHO holds the port,
  //   - the /dev/tcp probe that asks whether that holder still answers,
  //   - the /proc/<pid>/comm check that makes sure it is an sshd.
  // And the kill must sit in the NO-BANNER branch: a live forward is never
  // touched.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-script-"))
  try {
    const stub = sshStub(dir)
    const port = "54321"
    const result = runPreflight(dir, ["a-host", port])
    assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`)
    const script = readFileSync(stub.stdinFile, "utf8")
    assert(/ss -ltnpH "sport = :/.test(script), "the script must find the listener with ss")
    assert(/\/dev\/tcp/.test(script), "the script must probe the port over bash's /dev/tcp")
    assert(/\/proc\/\$pid\/comm/.test(script), "the script must read the holder's comm")
    assert(/= "sshd"/.test(script), "the script must accept only an sshd as the holder")
    assert(/SSH\*/.test(script), "the script must recognise the SSH banner")
    const banner = script.indexOf("SSH*)")
    const kill = script.indexOf('kill "$pid"')
    assert(banner !== -1 && kill > banner, "the kill must sit in the no-banner branch, never in the live one")
    assert((script.match(/kill "\$pid"/g) || []).length === 1, "there must be exactly one kill")

    // The port travels as an ARGUMENT, never as text in the script: a script
    // with the port spliced into it is a script that has to be quoted.
    assert(!script.includes(port), `the port must not be interpolated into the script: ${script}`)
    const argv = readFileSync(stub.argvFile, "utf8").split("\n").filter((line) => line.length > 0)
    assert(argv.includes(port), `the port must be passed as an argument, got ${JSON.stringify(argv)}`)
    assert(argv.includes("bash") && argv.includes("-s") && argv.includes("--"),
      `the remote script must be fed on stdin with the port after --, got ${JSON.stringify(argv)}`)
    // ClearAllForwardings=yes is not optional: without it this preflight's own
    // ssh would try to claim the tunnel port and could become the next stale
    // holder -- the failure this script exists to clear.
    assert(argv.includes("ClearAllForwardings=yes"),
      `the preflight's own ssh must clear forwardings, got ${JSON.stringify(argv)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The remote half, run here
//
// The remote script is extracted from the preflight and run on this machine
// against a stand-in listener, because that is the only way to see what it
// decides. Two things have to be arranged for that to be honest:
//
//   - The script finds its listener with `ss`, so it needs one.
//   - It only ever kills a process whose /proc/<pid>/comm is exactly "sshd",
//     because only an sshd can hold a remote-forward listener. A stand-in
//     listener is named after whatever ran it, so the production check cannot
//     pass here.
//
// The check is NOT weakened in bin/oc-tunnel-preflight. It is replaced in a
// COPY of the script, with a stub that reports "sshd", so the probe and the
// kill decision are exercised for real; and the UNMODIFIED script is what
// proves the safety property -- a listener that is not an sshd is left alone.
// ---------------------------------------------------------------------------

/**
 * The comm check the remote script makes before it will touch a pid, and the
 * stub that stands in for it in a copy of the script.
 *
 * The exact text of the production check is pinned here on purpose: if it is
 * reworded, this test says so instead of quietly testing a check that no
 * longer exists.
 */
const COMM_CHECK = `[ "$(cat "/proc/$pid/comm" 2>/dev/null)" = "sshd" ] || exit 0`
const COMM_STUB = `[ "$(printf 'sshd')" = "sshd" ] || exit 0`

const remoteScriptAsSshd = () => {
  const script = remoteScript()
  assert(script.includes(COMM_CHECK), "the remote script must check /proc/<pid>/comm before it kills anything")
  return script.split(COMM_CHECK).join(COMM_STUB)
}

/** Run a copy of the remote script here, against a local port. */
const runRemote = (dir, script, port) => {
  const file = path.join(dir, "remote.sh")
  writeFileSync(file, script)
  return spawnSync("bash", [file, String(port)], { encoding: "utf8", timeout: 30000 })
}

/** A port nothing is listening on, asked of the kernel rather than guessed. */
const freePort = () => {
  const result = spawnSync(process.execPath, ["-e",
    'const { createServer } = require("node:net"); const s = createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close() })',
  ], { encoding: "utf8" })
  const port = Number((result.stdout || "").trim())
  assert(port > 0, `could not pick a free port: ${result.stderr}`)
  return port
}

/** Is something LISTENing on that port? That is the liveness of the forward. */
const portIsListening = (port) => {
  const result = spawnSync("ss", ["-ltnH", `sport = :${port}`], { encoding: "utf8" })
  return (result.stdout || "").trim().length > 0
}

/** A synchronous sleep, so a polling wait can live inside a check body. */
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

const waitFor = (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    sleepSync(25)
  }
  return false
}

/**
 * A stand-in for the remote's sshd holding a forward.
 *
 * "banner": answers the probe with an SSH banner -- a LIVE forward.
 * "silent": accepts the connection and says nothing -- a DEAD forward, which
 * is what a session that died without releasing the port looks like.
 *
 * The listener's liveness is read back from the PORT (is it still LISTENing?)
 * rather than from a pid: the port is what the remote script acts on, and it
 * does not depend on how the listener was started.
 */
const LISTENER_PY = `import socket, sys

mode, port = sys.argv[1], int(sys.argv[2])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(16)
conns = []
while True:
    try:
        c, _ = s.accept()
    except OSError:
        break
    conns.append(c)
    try:
        c.recv(1024)
    except OSError:
        pass
    if mode == "banner":
        try:
            c.sendall(b"SSH-2.0-test\\r\\n")
        except OSError:
            pass
`

/** The same listener without python: netcat holds the connection open. */
const ncListener = (mode, port) => {
  const feed = mode === "banner" ? "(printf 'SSH-2.0-test\\r\\n'; sleep 30)" : "sleep 30"
  return `${feed} | nc -k -l 127.0.0.1 ${port}`
}

const startListener = (dir, mode) => {
  const port = freePort()
  const script = path.join(dir, `listener-${mode}.py`)
  writeFileSync(script, LISTENER_PY)
  const child = hasCommand("python3")
    ? spawn("python3", [script, mode, String(port)], { detached: true, stdio: "ignore" })
    : spawn("sh", ["-c", ncListener(mode, port)], { detached: true, stdio: "ignore" })
  // A spawn failure must not become an unhandled 'error' event.
  child.on("error", () => {})
  // The listener outlives this check on purpose; the group is killed in stop().
  child.unref()
  const up = waitFor(() => portIsListening(port), 5000)
  assert(up, `the stand-in listener never came up on port ${port}`)
  return {
    port,
    stop: () => { try { process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ } },
  }
}

check("a live forward is left alone", () => {
  // A live forward answers the probe with the desktop's sshd banner. Nothing
  // is killed, nothing is printed, and the port stays held.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-live-"))
  let listener = null
  try {
    listener = startListener(dir, "banner")
    const result = runRemote(dir, remoteScriptAsSshd(), listener.port)
    assert(!result.error, `the remote script did not run: ${result.error?.message}`)
    assert(result.status === 0, `the remote script must exit 0, got ${result.status}: ${result.stderr}`)
    assert(result.stdout === "", `a live forward must print nothing, got ${JSON.stringify(result.stdout)}`)
    assert(portIsListening(listener.port), "a live forward must be left alone: the port is still held")
  } finally {
    if (listener) listener.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, { skip: NO_REMOTE_PROBE })

check("a dead forward is cleared", () => {
  // A dead forward accepts the connection and then says nothing, because the
  // channel to the desktop is gone. That is provably a stale holder, so it is
  // killed and the freed port is reported.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-dead-"))
  let listener = null
  try {
    listener = startListener(dir, "silent")
    const result = runRemote(dir, remoteScriptAsSshd(), listener.port)
    assert(!result.error, `the remote script did not run: ${result.error?.message}`)
    assert(result.status === 0, `the remote script must exit 0, got ${result.status}: ${result.stderr}`)
    assert(result.stdout.trim() === `oc-tunnel-preflight: freed a dead listener on port ${listener.port}`,
      `the freed port must be reported, got ${JSON.stringify(result.stdout)}`)
    const gone = waitFor(() => !portIsListening(listener.port), 5000)
    assert(gone, "the stale listener must be killed: the port is still held")
  } finally {
    if (listener) listener.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, { skip: NO_REMOTE_PROBE })

check("a listener that is not an sshd is never killed", () => {
  // The safety property, and the more valuable of the two: only an sshd can
  // hold a remote-forward listener, and anything else on that port belongs to
  // somebody else. The stand-in listener is not an sshd, so the UNMODIFIED
  // script must walk away from it -- and say nothing while it does.
  const dir = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-other-"))
  let listener = null
  try {
    listener = startListener(dir, "banner")
    const result = runRemote(dir, remoteScript(), listener.port)
    assert(!result.error, `the remote script did not run: ${result.error?.message}`)
    assert(result.status === 0, `the remote script must exit 0, got ${result.status}: ${result.stderr}`)
    assert(result.stdout === "", `nothing must be printed, got ${JSON.stringify(result.stdout)}`)
    assert(portIsListening(listener.port), "a listener that is not an sshd must survive")
  } finally {
    if (listener) listener.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, { skip: NO_REMOTE_PROBE })

check("the tunnel unit runs the preflight before it claims the port", () => {
  // The order is the point: the preflight frees the port, and only then does
  // ssh try to bind it. A unit that starts ssh first loses the race it is
  // supposed to win.
  //
  // The line is rendered into the unit ONLY when the preflight is installed
  // (the check below proves that), so the order is proved by the rendered
  // unit rather than by the template -- what the template has to carry is the
  // decision, not the line.
  const src = read("oc-sync")
  assert(/preflight_line="ExecStartPre=\$PREFLIGHT \$host \$port"/.test(src),
    "the preflight must be called with the host and the port")
  assert(/^PREFLIGHT="\$HOME\/\.local\/bin\/oc-tunnel-preflight"$/m.test(src),
    "PREFLIGHT must point at the installed preflight")
  // The guard, not just the renderer: it must ask for the preflight line only
  // when the renderer wrote one. A guard that demands a line the renderer may
  // omit either rewrites the unit on every run or never converges -- and a
  // unit that names a preflight this machine does not have cannot start.
  assert(/grep -qF -- "\$preflight_line" "\$unit_file"/.test(src),
    "the rewrite guard must ask for the line the renderer wrote")
  assert(/grep -qF "ExecStartPre=" "\$unit_file" && stale=1/.test(src),
    "a unit that names a preflight this machine does not have must be rewritten")
  // A rewritten unit needs a restart, not just a reload: the RUNNING instance
  // still has the old ExecStart, so the new ExecStartPre would never run and
  // the stale port would never be freed.
  assert(/rewritten=1/.test(src), "a rewritten unit must be marked as rewritten")
  assert(/systemctl --user restart "\$unit"/.test(src), "a rewritten unit must be restarted")
})

/**
 * install_tunnel_unit, lifted out of the script.
 *
 * The function is the whole contract here -- what it renders and what it
 * considers up to date -- so it is read out of the file rather than restated
 * here: a copy in the test would keep passing after the function changed.
 */
const tunnelUnitFn = () => {
  const src = read("oc-sync")
  const start = src.indexOf("install_tunnel_unit() {")
  assert(start !== -1, "oc-sync must have an install_tunnel_unit function")
  const end = src.indexOf("\ndrop_config_remoteforward() {", start)
  assert(end !== -1, "install_tunnel_unit must end before drop_config_remoteforward")
  return src.slice(start, end)
}

/**
 * Run install_tunnel_unit against a scratch HOME.
 *
 * Three things keep it hermetic:
 *
 *   - HOME is a temp dir, and TUNNEL_UNIT_DIR is derived from it, so the real
 *     ~/.config/systemd/user is never written to.
 *   - systemctl and loginctl are STUBBED. The function enables and starts the
 *     unit, and on a developer's machine that would start a real tunnel to a
 *     fake host.
 *   - the unit is written to the scratch dir and read back from there.
 */
const runInstallTunnelUnit = (home, { preflight = false } = {}) => {
  const stubDir = path.join(home, "stub-bin")
  mkdirSync(stubDir, { recursive: true })
  for (const tool of ["systemctl", "loginctl"]) {
    const stub = path.join(stubDir, tool)
    writeFileSync(stub, "#!/bin/sh\nexit 0\n")
    chmodSync(stub, 0o755)
  }
  const preflightPath = path.join(home, ".local", "bin", "oc-tunnel-preflight")
  if (preflight) {
    mkdirSync(path.dirname(preflightPath), { recursive: true })
    writeFileSync(preflightPath, read("oc-tunnel-preflight"))
    chmodSync(preflightPath, 0o700)
  } else {
    rmSync(preflightPath, { force: true })
  }
  const probe = `
DRY_RUN=0
TUNNEL_UNIT_DIR="$HOME/.config/systemd/user"
PREFLIGHT="$HOME/.local/bin/oc-tunnel-preflight"
PREFLIGHT_SRC="$1"
ok() { echo "ok:$*"; }
bad() { echo "err:$*"; }
warn() { echo "warn:$*"; }
${tunnelUnitFn()}
install_tunnel_unit "host-a" "10022"
`
  const result = spawnSync("bash", ["-c", probe], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
  })
  const unitFile = path.join(home, ".config", "systemd", "user", "oc-tunnel@host-a.service")
  return {
    result,
    unitFile,
    unit: existsSync(unitFile) ? readFileSync(unitFile, "utf8") : "",
    preflightPath,
  }
}

check("a tunnel unit never names a preflight that is not installed", () => {
  // The bug this pins. The unit was rendered with an ExecStartPre line no
  // matter whether the preflight was there: with the file missing, systemd
  // fails the unit with 203/EXEC, and with Restart=always it then retries every
  // 10 seconds forever. That is not "no preflight" but "no tunnel" -- and
  // every notification from that host dies with it, visibly only in the
  // remote's journal, on the other side of the hop.
  //
  // So the guarantee is: the unit that gets written either names no preflight
  // at all, or names one that is really there.
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-unit-preflight-"))
  try {
    // 1. The preflight is NOT installed.
    const missing = runInstallTunnelUnit(home, { preflight: false })
    assert(missing.unit !== "",
      `the unit must be written at all: ${missing.result.stdout}${missing.result.stderr}`)
    assert(!/ExecStartPre=/.test(missing.unit),
      `a unit that names a missing preflight is dead on arrival: ${missing.unit}`)
    // The tunnel itself survives: it degrades to what it did before the
    // preflight existed -- it holds the forward, it just cannot free a stale
    // port by itself.
    assert(/^ExecStart=\/usr\/bin\/ssh .*-R 10022:localhost:22 host-a$/m.test(missing.unit),
      `the unit must still start ssh: ${missing.unit}`)
    assert(/^Restart=always$/m.test(missing.unit), `the unit must still restart itself: ${missing.unit}`)
    // And the run says so, instead of leaving the reader to find out.
    assert(/preflight/i.test(missing.result.stdout),
      `the run must report the missing preflight: ${missing.result.stdout}${missing.result.stderr}`)

    // 2. The preflight IS installed: the behaviour is exactly what it was.
    const present = runInstallTunnelUnit(home, { preflight: true })
    const line = `ExecStartPre=${path.join(home, ".local", "bin", "oc-tunnel-preflight")} host-a 10022`
    assert(present.unit.includes(`${line}\n`),
      `the unit must run the preflight with the host and the port: ${present.unit}`)
    assert(present.unit.indexOf(line) < present.unit.indexOf("ExecStart="),
      "the preflight must come before ssh claims the port")
    assert(existsSync(present.preflightPath), "the preflight the unit names must really be there")

    // 3. The preflight goes away again. The unit must not be left pointing at
    // a file that is not there -- that is the same dead unit, reached by
    // deleting one file instead of by never installing it.
    const gone = runInstallTunnelUnit(home, { preflight: false })
    assert(!/ExecStartPre=/.test(gone.unit),
      `a unit left naming a removed preflight is dead on arrival: ${gone.unit}`)
    assert(/wrote /.test(gone.result.stdout),
      `the unit must be rewritten without the preflight: ${gone.result.stdout}${gone.result.stderr}`)

    // 4. And it converges: a second run with the same state must not rewrite
    // the unit again, or every sync would restart a working tunnel.
    const again = runInstallTunnelUnit(home, { preflight: false })
    assert(/already up to date/.test(again.result.stdout),
      `the unit must converge: ${again.result.stdout}${again.result.stderr}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

check("the preflight is installed by content, and a dry run installs nothing", () => {
  // A stale copy is exactly the one that misbehaves: an older preflight does
  // not know how to probe a listener, so the port stays stuck and the tunnel
  // never comes back. Presence-only installation would never notice.
  const src = read("oc-sync")
  const start = src.indexOf("install_tunnel_preflight()")
  assert(start !== -1, "oc-sync must install the preflight")
  const fn = src.slice(start, src.indexOf("\nsetup_tunnel_auth\n", start))
  assert(/cmp -s "\$PREFLIGHT_SRC" "\$PREFLIGHT"/.test(fn),
    "the installed copy must be compared by content")
  assert(/DRY_RUN/.test(fn), "a dry run must not install anything")

  // Run the function on its own, against a temp HOME: the whole of oc-sync is
  // not run here, because it deploys to real machines.
  const home = mkdtempSync(path.join(tmpdir(), "ocsync-preflight-install-"))
  try {
    const probe = `
DRY_RUN=$1
PREFLIGHT="$HOME/.local/bin/oc-tunnel-preflight"
PREFLIGHT_SRC="$2"
ok() { echo "ok:$*"; }
bad() { echo "err:$*"; }
warn() { echo "warn:$*"; }
${fn}
install_tunnel_preflight
`
    const installed = path.join(home, ".local", "bin", "oc-tunnel-preflight")
    const dry = spawnSync("bash", ["-c", probe, "_", "1", PREFLIGHT], {
      encoding: "utf8", env: { ...process.env, HOME: home },
    })
    assert(!existsSync(installed), `a dry run must not install anything: ${dry.stdout}${dry.stderr}`)
    assert(/dry-run/.test(dry.stdout), `the dry run must say what it would do: ${dry.stdout.trim()}`)

    const real = spawnSync("bash", ["-c", probe, "_", "0", PREFLIGHT], {
      encoding: "utf8", env: { ...process.env, HOME: home },
    })
    assert(existsSync(installed), `the preflight must be installed: ${real.stdout}${real.stderr}`)
    assert(readFileSync(installed, "utf8") === readFileSync(PREFLIGHT, "utf8"),
      "the installed copy must be the repo copy, byte for byte")

    // A STALE copy is refreshed: presence alone would leave the old one there.
    writeFileSync(installed, "#!/bin/sh\n# an older preflight\n")
    const refresh = spawnSync("bash", ["-c", probe, "_", "0", PREFLIGHT], {
      encoding: "utf8", env: { ...process.env, HOME: home },
    })
    assert(readFileSync(installed, "utf8") === readFileSync(PREFLIGHT, "utf8"),
      `a stale copy must be refreshed by content: ${refresh.stdout}${refresh.stderr}`)

    // A missing SOURCE is not "nothing to do": it is the whole preflight
    // missing, and the unit would name a file that is not there. The script
    // was untracked in git, so on a fresh checkout this returned 0 SILENTLY --
    // not even the warning fired, and every host that synced from a clone got
    // a unit pointing at a file that would never exist.
    const missing = spawnSync("bash", ["-c", probe, "_", "0", path.join(home, "no-such-preflight")], {
      encoding: "utf8", env: { ...process.env, HOME: home },
    })
    assert(missing.status !== 0,
      `a missing source must be reported, not silently skipped: ${missing.stdout}${missing.stderr}`)
    assert(/oc-tunnel-preflight/.test((missing.stdout || "") + (missing.stderr || "")),
      `the missing preflight must be named: ${missing.stdout}${missing.stderr}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------

console.log(`${passed} checks passed${skipped ? `, ${skipped} skipped` : ""}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  // The exit code, not an immediate exit: the runner still has the mirrored
  // subtests to report, and each failed check should be named there too.
  process.exitCode = 1
}