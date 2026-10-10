#!/usr/bin/env node
// Offline checks for the shell scripts in bin/. These are the load-bearing
// pieces of oc-sync -- a silently broken default flag or a stray else turns a
// sync into a no-op that reports success -- so they are asserted rather than
// eyeballed.
//
// No network, no running server: every check is either a syntax parse, a static
// assertion on the source, or a run of the script against a temp HOME and a temp
// host list.

import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const BIN = path.join(REPO, "bin")

let passed = 0
const failures = []

const check = (name, fn) => {
  try {
    fn()
    passed++
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const read = (name) => readFileSync(path.join(BIN, name), "utf8")

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
// ---------------------------------------------------------------------------

for (const script of ["oc", "oc-notify", "oc-sync", "oc-notify-receiver"]) {
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
})

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
  const out = execFileSync("bash", ["-c",
    'eval "$(grep -E \'^CONFIG_DIR=\' "$1")"; printf "%s" "$CONFIG_DIR"', "_", path.join(BIN, "oc-sync"),
  ], { encoding: "utf8", env: { ...process.env, OC_SYNC_CONFIG_DIR: "/tmp/somewhere-else" } })
  assert(out === "/tmp/somewhere-else", `the override must win, got ${out}`)
})

check("every synced item is read from the tree that owns it", () => {
  // Static, because the two trees do not exist together in CI. A path pointed
  // at the wrong one is silent: rsync reports the failure, but only after the
  // host has been reached and the earlier items have already landed.
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
  const src = read("oc-notify-receiver")
  assert(/SSH_ORIGINAL_COMMAND/.test(src), "the receiver should read the payload from the environment")
  assert(/mapfile -t fields/.test(src), "it should split on newlines with mapfile, not word splitting")
  assert(!/\$\{1:-/.test(src) && !/\$\{2:-/.test(src), "it must not read positional parameters: ssh passes none")
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
})

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
})

check("--help exits 0 and prints usage", () => {
  const result = spawnSync("bash", [path.join(BIN, "oc-sync"), "--help"], {
    encoding: "utf8",
    env: hermeticEnv(),
  })
  assert(result.status === 0, `--help exited ${result.status}`)
  assert(/--scripts-only/.test(result.stdout), "help should document the opt-out")
})

// ---------------------------------------------------------------------------

console.log(`${passed} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}