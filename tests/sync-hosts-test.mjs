// Offline suite for scripts/sync-hosts.mjs.
//
// The script talks to remote hosts only through `ssh`, so the suite puts a fake
// `ssh` executable first on PATH. It records every argv, serves a config for
// the read calls, captures the rewritten config from the write call, and plays
// it back for the verification read. The real ssh and the real hosts are never
// reached.
//
// The properties worth pinning:
//
//   * the install call names the exact version in package.json;
//   * the old file:// LaCode entry and the appended @lawaty/lacode@0.0.0 entry
//     collapse into ONE entry carrying the omniroute options;
//   * the backup is issued before the write;
//   * dry-run and no-host runs invoke ssh zero times;
//   * a host without opencode is skipped, not failed.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const SCRIPT = join(REPO, "scripts", "sync-hosts.mjs")
const PACKAGE = "@lawaty/lacode"
const VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version
const EXPECTED = `${PACKAGE}@${VERSION}`

const OMNIROUTE = {
  enabled: true,
  apiKey: "sk-test-do-not-log",
  combo: "free",
  models: ["provider/model"],
}

const FAKE_SSH = String.raw`#!/usr/bin/env node
const fs = require("fs")
const path = require("path")

const args = process.argv.slice(2)
const log = process.env.FAKE_SSH_LOG
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\n")

const command = args[args.length - 1] || ""

if (command.includes(" plugin ") && command.includes("@lawaty/lacode@")) {
  process.stdout.write(process.env.FAKE_SSH_NO_OPENCODE === "1" ? "NO_OPENCODE\n" : "INSTALLED\n")
  process.exit(0)
}

if (command.includes("HELPER_OK")) {
  process.stdout.write((process.env.FAKE_SSH_HELPER || "HELPER_OK") + "\n")
  process.exit(0)
}

if (command.includes("find") && command.includes("plugins")) {
  process.stdout.write(process.env.FAKE_SSH_PLUGINS_LISTING || "lacode.ts\nother-plugin.js\n")
  process.exit(0)
}

if (/^cat\s+>/.test(command)) {
  const body = fs.readFileSync(0, "utf8")
  const state = process.env.FAKE_SSH_STATE
  if (state) fs.writeFileSync(path.join(state, "written.jsonc"), body)
  process.exit(0)
}

if (/^cp\s+-a\s+/.test(command)) process.exit(0)

if (/^cat\s+/.test(command)) {
  const state = process.env.FAKE_SSH_STATE
  const written = state ? path.join(state, "written.jsonc") : ""
  if (written && fs.existsSync(written)) process.stdout.write(fs.readFileSync(written, "utf8"))
  else process.stdout.write(fs.readFileSync(process.env.FAKE_SSH_FIXTURE_FILE, "utf8"))
  process.exit(0)
}

process.exit(0)
`

function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "lacode-sync-hosts-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const bin = join(root, "bin")
  const home = join(root, "home")
  const state = join(root, "state")
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(state, { recursive: true })

  const fixture = options.fixture ?? {
    $schema: "https://opencode.ai/config.json",
    theme: "lacode",
    plugin: [
      ["file:///home/lawaty/Projects/lacode/dist/index.js", { omniroute: OMNIROUTE }],
      "@lawaty/lacode@0.0.0",
    ],
  }
  const fixturePath = join(root, "fixture.jsonc")
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n")

  const ssh = join(bin, "ssh")
  writeFileSync(ssh, FAKE_SSH)
  chmodSync(ssh, 0o755)

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    OC_SYNC_ENV_FILE: join(root, "missing.env"),
    OC_HOSTS_FILE: join(root, "missing.hosts"),
    FAKE_SSH_LOG: join(root, "ssh.log"),
    FAKE_SSH_STATE: state,
    FAKE_SSH_FIXTURE_FILE: fixturePath,
    FAKE_SSH_HELPER: options.helper ?? "HELPER_OK",
  }
  delete env.npm_package_version
  delete env.LACODE_SYNC
  delete env.LACODE_SYNC_DRY_RUN
  delete env.LACODE_SYNC_STRICT
  delete env.OC_HOSTS
  if (options.noOpencode) env.FAKE_SSH_NO_OPENCODE = "1"
  if (options.env) Object.assign(env, options.env)

  return { root, state, log: env.FAKE_SSH_LOG, env }
}

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: 30000,
  })
}

function calls(log) {
  if (!existsSync(log)) return []
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("sync-hosts normalizes the LaCode entries and preserves omniroute options", (t) => {
  const { state, log, env } = setup(t)
  const result = run({ ...env, OC_HOSTS: "host-a" })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /host-a: ok/)
  assert.match(result.stdout, /summary: 1 ok, 0 warn, 0 skipped, 0 failed/)

  const sshCalls = calls(log)
  const install = sshCalls.find((args) => args[args.length - 1].includes(" plugin "))
  assert.ok(install, "the install ssh call was made")
  const installCommand = install[install.length - 1]
  assert.match(installCommand, new RegExp(`"${EXPECTED}"`), installCommand)
  assert.equal(
    (installCommand.match(new RegExp(`@lawaty/lacode@[^"\\s]+`, "g")) || []).length,
    1,
    "the install command names exactly one LaCode version",
  )

  const backup = sshCalls.find((args) => args[args.length - 1].startsWith("cp -a "))
  assert.ok(backup, "the backup cp was issued")
  assert.match(backup[backup.length - 1], /\.bak-lacode-sync/)

  const writtenPath = join(state, "written.jsonc")
  assert.ok(existsSync(writtenPath), "the normalized config was written")
  const text = readFileSync(writtenPath, "utf8")
  assert.ok(text.endsWith("\n"), "the written config ends with a newline")

  const written = JSON.parse(text)
  assert.equal(written.plugin.length, 1, "exactly one plugin entry remains")
  const entry = written.plugin[0]
  assert.ok(Array.isArray(entry), "the entry keeps its options")
  assert.equal(entry[0], EXPECTED)
  assert.deepEqual(entry[1], { omniroute: OMNIROUTE }, "the omniroute options survive")
  assert.equal(written.$schema, "https://opencode.ai/config.json")
  assert.equal(written.theme, "lacode")

  const cpIndex = sshCalls.findIndex((args) => args[args.length - 1].startsWith("cp -a "))
  const writeIndex = sshCalls.findIndex((args) => /^cat\s+>/.test(args[args.length - 1]))
  assert.ok(cpIndex >= 0 && writeIndex > cpIndex, "the backup is issued before the write")

  assert.doesNotMatch(result.stdout + result.stderr, /sk-test-do-not-log/, "logs do not leak the api key")
})

test("sync-hosts dry run prints the planned commands and runs nothing", (t) => {
  const { log, env } = setup(t)
  const result = run({ ...env, OC_HOSTS: "host-a", LACODE_SYNC_DRY_RUN: "1" })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(log), false, "ssh was never invoked")
  assert.match(result.stdout, /host-a: would run/)
  assert.ok(result.stdout.includes(EXPECTED), result.stdout)
  assert.match(result.stdout, /ssh -o BatchMode=yes -o ConnectTimeout=8 host-a/)
  assert.match(result.stdout, /nothing was run/)
})

test("sync-hosts with no hosts exits 0 and says so", (t) => {
  const { log, env } = setup(t)
  const result = run({ ...env, OC_HOSTS: "" })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /no hosts configured/)
  assert.equal(existsSync(log), false, "ssh was never invoked")
})

test("sync-hosts records a host without opencode as skipped", (t) => {
  const { state, log, env } = setup(t, { noOpencode: true })
  const result = run({ ...env, OC_HOSTS: "host-a" })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /host-a: skipped \(no opencode\)/)
  assert.match(result.stdout, /summary: 0 ok, 0 warn, 1 skipped, 0 failed/)
  assert.equal(existsSync(join(state, "written.jsonc")), false, "the config was not read or written")
  assert.equal(calls(log).length, 1, "only the install call ran")
})

test("sync-hosts warns when the host helper cannot run, without failing the run", (t) => {
  const { state, log, env } = setup(t, { helper: "HELPER_UNUSABLE node=v12.22.9" })
  const result = run({ ...env, OC_HOSTS: "host-a" })

  assert.equal(result.status, 0, result.stderr)
  assert.ok(
    result.stdout.includes(
      "host-a: warn (helper cannot run: node=v12.22.9; install node>=22 or a ~/bin/lacode wrapper)",
    ),
    result.stdout,
  )
  assert.match(result.stdout, /summary: 0 ok, 1 warn, 0 skipped, 0 failed/)
  assert.ok(existsSync(join(state, "written.jsonc")), "config normalization still happened")

  const sshCalls = calls(log)
  assert.ok(
    sshCalls.some((args) => args[args.length - 1].includes("HELPER_OK")),
    "the capability check ran",
  )
})

test("sync-hosts keeps a host with a runnable helper as ok", (t) => {
  const { env } = setup(t, { helper: "HELPER_OK" })
  const result = run({ ...env, OC_HOSTS: "host-a" })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /host-a: ok/)
  assert.match(result.stdout, /summary: 1 ok, 0 warn, 0 skipped, 0 failed/)
})

test("sync-hosts disables stale lacode shims in plugins/", (t) => {
  const { log, env } = setup(t, { env: { FAKE_SSH_PLUGINS_LISTING: "lacode.ts\nother-plugin.js\n" } })
  const result = run({ ...env, OC_HOSTS: "host-a" })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /shim disabled: lacode\.ts/)

  const sshCalls = calls(log)
  const move = sshCalls.find((args) => /^mv\s+/.test(args[args.length - 1]) && args[args.length - 1].includes("lacode.ts"))
  assert.ok(move, "a move is issued for lacode.ts")
  assert.match(move[move.length - 1], /lacode-plugin-shim\.disabled-/, "the move targets the disabled backup path")

  const otherMove = sshCalls.find((args) => /^mv\s+/.test(args[args.length - 1]) && args[args.length - 1].includes("other-plugin.js"))
  assert.equal(otherMove, undefined, "the other plugin file is not moved")
})

test("sync-hosts reports no stale shim when the listing has no lacode file", (t) => {
  const { log, env } = setup(t, { env: { FAKE_SSH_PLUGINS_LISTING: "other-plugin.js\n" } })
  const result = run({ ...env, OC_HOSTS: "host-a" })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /no stale shim/)

  const sshCalls = calls(log)
  const move = sshCalls.find((args) => /^mv\s+/.test(args[args.length - 1]))
  assert.equal(move, undefined, "no move command is issued")
})
