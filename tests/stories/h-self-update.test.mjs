// Epic F (US-27) — the package keeps itself current.
//
// Offline by construction: the registry is a fake `fetch`, the installer is a
// fake `spawn`, the clock is injected, and every path is a temp dir. Nothing
// here touches npm, the network, or a real opencode cache.
//
// The CLI (`lacode update`) and the plugin factory have no injection seam, so
// they are exercised the way a user meets them -- as a PROCESS -- with exactly
// two things faked: the registry (a preload module that replaces the global
// `fetch`) and the installer (a stand-in `opencode` binary on a PATH that
// holds nothing else). See the harness further down.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { dirname, join } from "node:path"
import * as esbuild from "esbuild"
import { PACKAGE_NAME } from "../../src/lib/package-root.ts"
import {
  acquireLock,
  CHECK_INTERVAL_MS,
  checkForUpdate,
  compareSemver,
  fetchLatest,
  isDue,
  maybeSelfUpdate,
  readInstalledVersion,
  readState,
  refreshCache,
  resolveCacheRoot,
  resolveOpencodeBin,
  writeState,
} from "../../src/lib/selfupdate.ts"
import { ROOT, cleanupAll, scratch } from "./_harness.mjs"

// `node --test` sets NODE_TEST_CONTEXT, and the updater correctly stands down
// when it sees it so the suite never touches the registry. These tests drive the
// check directly and need the real paths, so clear it here; the guard itself is
// asserted explicitly further down.
delete process.env.NODE_TEST_CONTEXT

const NOW = 1_700_000_000_000
const NEW = "0.2.0"
const OLD = "0.1.6"

/** A fake opencode cache install: <root>/node_modules/@lawaty/lacode<pkg.json>. */
const makeCache = (version = OLD) => {
  const cacheRoot = scratch("lacode-cache-")
  const packageRoot = join(cacheRoot, "node_modules", "@lawaty", "lacode")
  const write = (v) => {
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: v }))
    writeFileSync(join(cacheRoot, "package.json"), JSON.stringify({ dependencies: { [PACKAGE_NAME]: v } }))
  }
  write(version)
  return { cacheRoot, packageRoot, write }
}

const fakeFetch = (version) => async () => ({ ok: true, json: async () => ({ version }) })
const offlineFetch = async () => {
  throw new Error("ENOTFOUND registry.npmjs.org")
}

/** Fails loudly if the installer is invoked at all — for "must not install" cases. */
const mustNotSpawn = () => {
  throw new Error("the installer must not run in this case")
}

/** A fake installer that "publishes" `version` into the cache, then exits 0. */
const fakeSpawn = (cacheRoot, version, { exit = 0 } = {}) => {
  // A relative cacheRoot would resolve to the repo itself: refuse it outright.
  if (!cacheRoot) throw new Error("fakeSpawn requires a real cache root")
  return (..._args) => {
    if (exit === 0) {
      const fresh = join(cacheRoot, "node_modules", "@lawaty", "lacode")
      mkdirSync(fresh, { recursive: true })
      writeFileSync(join(fresh, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }))
      writeFileSync(join(cacheRoot, "package.json"), JSON.stringify({ dependencies: { [PACKAGE_NAME]: version } }))
    }
    const handlers = {}
    const child = {
      on(event, cb) {
        handlers[event] = cb
        if (event === "exit") queueMicrotask(() => cb(exit))
        return child
      },
      kill() {},
    }
    return child
  }
}

test("[US-27] a lock orphaned by a process that exited mid-install is reclaimed at once", () => {
  const lockPath = join(scratch(), "lock")
  mkdirSync(dirname(lockPath), { recursive: true })
  // A pid that is not running: the holder died before its `finally` could unlink.
  writeFileSync(lockPath, "999999999")

  const held = acquireLock(lockPath, NOW)
  assert.ok(held, "a provably dead holder must not block the update")
  assert.equal(readFileSync(lockPath, "utf8"), String(process.pid), "the lock is now ours")
  held()
  assert.equal(existsSync(lockPath), false, "releasing removes it")
})

test("[US-27] a lock held by a live process is respected, so two starts cannot collide", () => {
  const lockPath = join(scratch(), "lock")
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, String(process.pid)) // we are running

  assert.equal(acquireLock(lockPath, NOW), undefined, "a live holder keeps the lock")
  assert.equal(readFileSync(lockPath, "utf8"), String(process.pid), "and it is untouched")
})

test("[US-27] the check stands down under the test runner so the suite stays offline", async () => {
  const { packageRoot } = makeCache(OLD)
  let calls = 0
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath: join(scratch(), "lock"),
    env: { NODE_TEST_CONTEXT: "child-v8" },
    fetchImpl: async () => {
      calls++
      return { ok: true, json: async () => ({ version: NEW }) }
    },
    spawnImpl: mustNotSpawn,
    log: () => {},
  })
  assert.equal(result.action, "disabled")
  assert.equal(calls, 0, "no registry call from inside the test runner")
})

test("[US-27] version comparison orders x.y.z", () => {
  assert.equal(compareSemver("0.2.0", "0.1.6"), 1)
  assert.equal(compareSemver("0.1.6", "0.1.6"), 0)
  assert.equal(compareSemver("0.1.6", "0.2.0"), -1)
})

test("[US-27] a newer published version is installed using the opencode binary alone", async () => {
  const { cacheRoot, packageRoot } = makeCache(OLD)
  const logs = []
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath: join(scratch(), "lock"),
    fetchImpl: fakeFetch(NEW),
    spawnImpl: fakeSpawn(cacheRoot, NEW),
    execPath: "/usr/local/bin/opencode",
    log: (level, message) => logs.push(`${level}:${message}`),
  })
  assert.equal(result.action, "updated")
  assert.equal(readInstalledVersion(packageRoot), NEW, "the cache now holds the new version")
  assert.ok(logs.some((l) => l.includes(OLD) && l.includes(NEW)), "the log names both versions")
})

test("[US-27] the running checkout is never the target: only an opencode cache install updates", async () => {
  const checkout = scratch("lacode-src-")
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: OLD }))
  const result = await maybeSelfUpdate({
    packageRoot: checkout,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath: join(scratch(), "lock"),
    fetchImpl: fakeFetch(NEW),
    spawnImpl: fakeSpawn(checkout, NEW),
    execPath: "/usr/local/bin/opencode",
    log: () => {},
  })
  assert.equal(result.action, "skipped")
  assert.match(result.detail ?? "", /not an opencode cache install/)
  assert.equal(readInstalledVersion(checkout), OLD, "the dev tree is untouched")
})

test("[US-27] with no newer version the check reports current and installs nothing", async () => {
  const { packageRoot } = makeCache(NEW)
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath: join(scratch(), "lock"),
    fetchImpl: fakeFetch(NEW),
    spawnImpl: () => {
      throw new Error("the installer must not run when already current")
    },
    log: () => {},
  })
  assert.equal(result.action, "current")
})

test("[US-27] the registry is consulted at most once per interval", async () => {
  const { packageRoot } = makeCache(OLD)
  const statePath = join(scratch(), "state.json")
  writeState({ checkedAt: NOW - 1000 }, statePath)
  let calls = 0
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath,
    lockPath: join(scratch(), "lock"),
    fetchImpl: async () => {
      calls++
      return { ok: true, json: async () => ({ version: NEW }) }
    },
    spawnImpl: mustNotSpawn,
    log: () => {},
  })
  assert.equal(result.action, "skipped")
  assert.equal(calls, 0, "the registry is not called within the interval")
})

test("[US-27] selfUpdate:false and LACODE_NO_SELFUPDATE=1 disable the check entirely", async () => {
  const { packageRoot } = makeCache(OLD)
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: true, json: async () => ({ version: NEW }) }
  }
  const base = { packageRoot, now: () => NOW, statePath: join(scratch(), "s.json"), lockPath: join(scratch(), "l"), fetchImpl, spawnImpl: mustNotSpawn }

  assert.equal((await maybeSelfUpdate({ ...base, enabled: false })).action, "disabled")
  assert.equal((await maybeSelfUpdate({ ...base, env: { LACODE_NO_SELFUPDATE: "1" } })).action, "disabled")
  assert.equal((await maybeSelfUpdate({ ...base, env: { LACODE_SELFUPDATE_CHILD: "1" } })).action, "disabled")
  assert.equal(calls, 0, "the registry is never consulted when disabled")
})

test("[US-27] an unreachable registry is silent and startup is unaffected", async () => {
  const { packageRoot } = makeCache(OLD)
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath: join(scratch(), "lock"),
    fetchImpl: offlineFetch,
    spawnImpl: mustNotSpawn,
    log: () => {},
  })
  assert.equal(result.action, "skipped")
  assert.match(result.detail ?? "", /registry unreachable/)
})

test("[US-27] a failure to reach a binary is reported, never thrown", async () => {
  const { cacheRoot, packageRoot } = makeCache(OLD)
  const logs = []
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath: join(scratch(), "lock"),
    fetchImpl: fakeFetch(NEW),
    spawnImpl: mustNotSpawn,
    execPath: "/usr/bin/node",
    env: { PATH: "" },
    // the cache resolves (its package.json "exists"), but no opencode binary does
    exists: (p) => p === join(cacheRoot, "package.json"),
    log: (level, message) => logs.push(`${level}:${message}`),
  })
  assert.equal(result.action, "failed")
  assert.ok(logs.some((l) => l.startsWith("warn:")))
})

test("[US-27] two processes starting together cannot both install", async () => {
  const { packageRoot } = makeCache(OLD)
  const lockPath = join(scratch(), "lock")
  const held = acquireLock(lockPath, NOW)
  assert.ok(held, "the first process takes the lock")
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath,
    fetchImpl: fakeFetch(NEW),
    spawnImpl: mustNotSpawn,
    log: () => {},
  })
  assert.equal(result.action, "skipped")
  assert.match(result.detail ?? "", /another process/)
  held()
})

test("[US-27] a failed install leaves the existing version in place", async () => {
  const { cacheRoot, packageRoot } = makeCache(OLD)
  const result = await refreshCache({
    cacheRoot,
    bin: "/usr/local/bin/opencode",
    latest: NEW,
    spawnImpl: fakeSpawn(cacheRoot, NEW, { exit: 1 }),
  })
  assert.equal(result.ok, false)
  assert.equal(readInstalledVersion(packageRoot), OLD, "the old cache is restored, not lost")
})

test("[US-27] the helpers resolve a cache root and an opencode binary from any source", () => {
  const { cacheRoot, packageRoot } = makeCache(OLD)
  assert.equal(resolveCacheRoot(packageRoot), cacheRoot)
  assert.equal(resolveCacheRoot(scratch("plain-")), undefined)

  assert.equal(resolveOpencodeBin("/opt/opencode", { PATH: "" }), "/opt/opencode")
  const binDir = scratch("bin-")
  writeFileSync(join(binDir, "opencode"), "")
  assert.equal(resolveOpencodeBin("/usr/bin/node", { PATH: binDir }), join(binDir, "opencode"))
})

test("[US-27] fetchLatest returns undefined off the happy path and the state helper throttles", async () => {
  assert.equal(await fetchLatest(offlineFetch), undefined)
  assert.equal(await fetchLatest(async () => ({ ok: false, json: async () => ({}) })), undefined)
  assert.equal(isDue(readState(join(scratch(), "missing.json")), NOW), true)
  assert.equal(isDue({ checkedAt: NOW - 1000 }, NOW), false)
})

test("[US-27] checkForUpdate reports the comparison without side effects", async () => {
  const { packageRoot } = makeCache(OLD)
  const check = await checkForUpdate({ packageRoot, fetchImpl: fakeFetch(NEW), execPath: "/opt/opencode" })
  assert.equal(check.installed, OLD)
  assert.equal(check.latest, NEW)
  assert.equal(check.newer, true)
})

// ---------------------------------------------------------------------------
// The CLI and the plugin factory, as processes
//
// Neither has an injection seam: `bin/lacode` reaches the registry through the
// global `fetch`, and the plugin factory calls the updater with the real
// paths. So both run as a child process with two things faked and nothing
// else:
//
//   * the registry, by a PRELOAD module that replaces `globalThis.fetch`
//     before the code under test runs;
//   * the installer, by a stand-in `opencode` binary on a PATH that holds
//     nothing else -- no npm, no bun.
//
// The CLI is BUNDLED before it runs, the way `scripts/build.mjs` bundles it:
// node refuses to strip types under node_modules, so the CLI cannot run from a
// cache layout as TypeScript -- which is exactly why the published package
// ships `dist/`. The bundle lands in a scratch dir, so the repo's own `dist/`
// is never rebuilt (two suites rebuilding it in parallel would race).
// ---------------------------------------------------------------------------

/** The fake registry: the version it reports, or no answer at all. */
const FAKE_REGISTRY = `globalThis.fetch = async () => {
  if (process.env.LACODE_FAKE_REGISTRY === "offline") throw new Error("ENOTFOUND registry.npmjs.org")
  return { ok: true, json: async () => ({ version: process.env.LACODE_FAKE_LATEST }) }
}
`

/**
 * A stand-in for the opencode binary.
 *
 * It records the argv it was called with and publishes the version it was
 * asked to install into the cache -- which is exactly what the real installer
 * does, so `refreshCache` can verify the install afterwards.
 *
 * It is launched through `/bin/sh` rather than a shebang script of its own:
 * the file the PATH lookup finds has no extension, and relying on node's
 * module detection for that would be a dependency the test does not need.
 */
const fakeOpencode = (dir) => {
  mkdirSync(dir, { recursive: true })
  const script = join(dir, "opencode.mjs")
  writeFileSync(
    script,
    [
      'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"',
      'import { join } from "node:path"',
      "const root = process.env.LACODE_FAKE_CACHE_ROOT",
      "const version = process.env.LACODE_FAKE_VERSION",
      'appendFileSync(process.env.LACODE_FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")',
      "if (root && version) {",
      `  const pkg = join(root, "node_modules", ${JSON.stringify(PACKAGE_NAME)})`,
      "  mkdirSync(pkg, { recursive: true })",
      `  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { ${JSON.stringify(PACKAGE_NAME)}: version } }))`,
      `  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: ${JSON.stringify(PACKAGE_NAME)}, version }))`,
      "}",
      'process.exit(Number(process.env.LACODE_FAKE_EXIT ?? 0))',
    ].join("\n"),
  )
  const binDir = join(dir, "bin")
  mkdirSync(binDir, { recursive: true })
  const launcher = join(binDir, "opencode")
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
  chmodSync(launcher, 0o755)
  return { binDir, argvLog: join(dir, "opencode-argv.log") }
}

/**
 * The CLI, bundled the way the tarball ships it.
 *
 * `pkgDir` becomes the package root: the bundle resolves its own location, so
 * putting it in a directory with a manifest naming this package is what makes
 * the CLI believe it is an installed copy of LaCode.
 */
const buildCli = async (pkgDir) => {
  mkdirSync(join(pkgDir, "dist"), { recursive: true })
  await esbuild.build({
    entryPoints: [join(ROOT, "bin", "lacode")],
    outfile: join(pkgDir, "dist", "lacode.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  })
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: OLD }))
  return join(pkgDir, "dist", "lacode.js")
}

/** An opencode plugin cache holding LaCode, and the CLI that installs into it. */
const cliCache = async () => {
  const dir = scratch("lacode-cli-")
  const cacheRoot = join(dir, "cache")
  const pkgDir = join(cacheRoot, "node_modules", "@lawaty", "lacode")
  const cli = await buildCli(pkgDir)
  writeFileSync(join(cacheRoot, "package.json"), JSON.stringify({ dependencies: { [PACKAGE_NAME]: OLD } }))
  return { dir, cacheRoot, pkgDir, cli }
}

/** Run the CLI the way a user runs it, against the fake registry. */
const runCli = (cli, args, { binDir, env = {} } = {}) => {
  const preload = join(scratch("lacode-registry-"), "registry.mjs")
  writeFileSync(preload, FAKE_REGISTRY)
  return spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    env: {
      ...process.env,
      PATH: binDir,
      HOME: scratch("lacode-home-"),
      // Belt and braces: on a node that cannot strip types the CLI re-execs
      // itself WITHOUT the --import preload, and the fake registry would be
      // gone with it. This turns that into a loud failure instead of a real
      // request to npm.
      LACODE_STRIP_TYPECHECKED: "1",
      ...env,
    },
    encoding: "utf8",
    timeout: 60000,
  })
}

/**
 * The plugin factory, booted against a registry that never answers.
 *
 * `mode` is "hang" (the request is made and never resolved) or "offline" (the
 * request fails). The factory is expected to return in both cases: it is
 * fire-and-forget, and a plugin that made startup wait on npm would make every
 * opencode launch depend on the registry being reachable.
 */
const PLUGIN_FACTORY = (pluginPath) =>
  [
    "let calls = 0",
    "const mode = process.env.LACODE_FAKE_REGISTRY ?? 'hang'",
    "globalThis.fetch = () => {",
    "  calls++",
    "  if (mode === 'offline') return Promise.reject(new Error('ENOTFOUND registry.npmjs.org'))",
    "  return new Promise(() => {})",
    "}",
    `const { selfUpdateHooks } = await import(${JSON.stringify(pluginPath)})`,
    "const lines = []",
    "const started = Date.now()",
    "const hooks = await selfUpdateHooks({ client: { app: { log: async ({ body }) => { lines.push(body.level + ': ' + body.message) } } } }, {})",
    "const elapsed = Date.now() - started",
    // Give the fire-and-forget check a moment to finish, so its outcome is
    // observable in the lines it logged.
    "await new Promise((r) => setTimeout(r, 100))",
    "console.log(JSON.stringify({ elapsed, calls, hooks: Object.keys(hooks), lines }))",
    "process.exit(0)",
  ].join("\n")

/**
 * Boot the real plugin factory in a child process.
 *
 * A child process, because the factory passes the updater the REAL state and
 * lock paths -- and those are fixed when `src/lib/selfupdate.ts` is loaded, so
 * the only way to keep the developer's own `~/.local/share` untouched is to
 * give the child its own HOME before it imports anything.
 */
const runPluginFactory = (mode) => {
  const dir = scratch("lacode-factory-")
  const script = join(dir, "factory.mjs")
  writeFileSync(script, PLUGIN_FACTORY(join(ROOT, "src", "plugins", "selfupdate.ts")))
  const env = { ...process.env, HOME: join(dir, "home"), LACODE_FAKE_REGISTRY: mode }
  // The updater stands down under the test runner on purpose; this child is
  // not a test runner, and the check has to run for the assertion to mean
  // anything.
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 30000 })
  const report = result.stdout.trim().split("\n").pop()
  return { result, report: report ? JSON.parse(report) : undefined }
}

test("[US-27] the log line says the new version takes effect on the next start", async () => {
  const { cacheRoot, packageRoot } = makeCache(OLD)
  const logs = []
  await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath: join(scratch(), "lock"),
    fetchImpl: fakeFetch(NEW),
    spawnImpl: fakeSpawn(cacheRoot, NEW),
    execPath: "/usr/local/bin/opencode",
    log: (level, message) => logs.push({ level, message }),
  })

  // ONE line, naming both versions: the old one the machine was on and the
  // new one it is being moved to.
  const lines = logs.filter((l) => l.message.includes(OLD) && l.message.includes(NEW))
  assert.equal(lines.length, 1, `exactly one log line must name both versions:\n${JSON.stringify(logs)}`)

  // The substance, not the sentence: the running session keeps its loaded
  // code, so the line has to say the change waits for a restart. A line that
  // said the update was already live would be the opposite claim.
  assert.match(lines[0].message, /restart|next start|next launch/i, `the log must say a restart is needed:\n${lines[0].message}`)
  assert.match(lines[0].message, /apply|take effect|takes effect|effective/i, `the log must say the new version becomes effective then:\n${lines[0].message}`)
})

test("[US-27] `lacode update --check` reports the available version and exits 0", async () => {
  const { cli, pkgDir } = await cliCache()
  const { binDir } = fakeOpencode(scratch("lacode-bin-"))

  const result = runCli(cli, ["update", "--check"], { binDir, env: { LACODE_FAKE_LATEST: NEW } })

  assert.equal(result.status, 0, `\`lacode update --check\` must exit 0 when an update is available:\n${result.stderr}`)
  assert.ok(result.stdout.includes(`lacode ${OLD} -> ${NEW} available`), `the available version must be reported:\n${result.stdout}`)
  assert.equal(readInstalledVersion(pkgDir), OLD, "--check reports; it installs nothing")
})

test("[US-27] `lacode update` exits non-zero only on a real failure", async () => {
  // A missing registry is a real failure.
  const offline = await cliCache()
  const offlineBin = fakeOpencode(scratch("lacode-bin-"))
  const unreachable = runCli(offline.cli, ["update"], {
    binDir: offlineBin.binDir,
    env: { LACODE_FAKE_REGISTRY: "offline" },
  })
  assert.equal(unreachable.status, 1, "a registry that cannot be reached is a real failure")
  assert.match(unreachable.stderr, /registry/, `the failure must name the registry:\n${unreachable.stderr}`)

  // Nothing to update to is NOT a failure: the machine is already current and
  // the command did what it was asked.
  const current = await cliCache()
  const currentBin = fakeOpencode(scratch("lacode-bin-"))
  const upToDate = runCli(current.cli, ["update"], { binDir: currentBin.binDir, env: { LACODE_FAKE_LATEST: OLD } })
  assert.equal(upToDate.status, 0, `there is nothing to update to; that is not a failure:\n${upToDate.stderr}`)
  assert.ok(upToDate.stdout.includes("up to date"), `the command must say the machine is current:\n${upToDate.stdout}`)

  // No cache to update is a real failure: a source checkout has nothing to
  // reinstall, and saying so is better than pretending.
  const checkout = scratch("lacode-checkout-")
  const checkoutCli = await buildCli(join(checkout, "pkg"))
  const checkoutBin = fakeOpencode(scratch("lacode-bin-"))
  const noCache = runCli(checkoutCli, ["update"], { binDir: checkoutBin.binDir, env: { LACODE_FAKE_LATEST: NEW } })
  assert.equal(noCache.status, 1, "a tree with no opencode cache has nothing to update")
  assert.match(noCache.stderr, /not an opencode cache install/, `the failure must say what is missing:\n${noCache.stderr}`)

  // A failed install is a real failure.
  const broken = await cliCache()
  const brokenBin = fakeOpencode(scratch("lacode-bin-"))
  const installFailed = runCli(broken.cli, ["update"], {
    binDir: brokenBin.binDir,
    env: {
      LACODE_FAKE_LATEST: NEW,
      LACODE_FAKE_EXIT: "1",
      LACODE_FAKE_CACHE_ROOT: broken.cacheRoot,
      LACODE_FAKE_VERSION: NEW,
      LACODE_FAKE_ARGV_LOG: brokenBin.argvLog,
    },
  })
  assert.equal(installFailed.status, 1, "an installer that fails is a real failure")
  assert.match(installFailed.stderr, /install failed/, `the failure must say the install failed:\n${installFailed.stderr}`)
})

test("[US-27] `lacode update` installs through the opencode binary alone, on a machine with neither npm nor bun", async () => {
  const { cacheRoot, cli } = await cliCache()
  const { binDir, argvLog } = fakeOpencode(scratch("lacode-bin-"))
  // Control: the machine really has the opencode binary and nothing else.
  assert.deepEqual(readdirSync(binDir), ["opencode"], "the PATH must hold the opencode binary and no package manager")

  const result = runCli(cli, ["update"], {
    binDir,
    env: {
      LACODE_FAKE_LATEST: NEW,
      LACODE_FAKE_CACHE_ROOT: cacheRoot,
      LACODE_FAKE_VERSION: NEW,
      LACODE_FAKE_ARGV_LOG: argvLog,
    },
  })

  assert.equal(result.status, 0, `the install must succeed:\n${result.stderr}`)
  assert.ok(result.stdout.includes(`Updated to ${NEW}`), `the new version must be reported:\n${result.stdout}`)
  assert.equal(
    readInstalledVersion(join(cacheRoot, "node_modules", "@lawaty", "lacode")),
    NEW,
    "the cache must hold the new version",
  )

  // The opencode binary did it, and it was asked to install the plugin.
  const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  assert.deepEqual(calls, [["plugin", PACKAGE_NAME, "-g"]], "the opencode binary is the installer")
  assert.ok(
    !/\b(npm|bun|yarn|pnpm)\b/.test(JSON.stringify(calls)),
    `no package manager may be involved in the install: ${JSON.stringify(calls)}`,
  )
})

test("[US-27] the installer is the opencode binary alone: the spawn argv names no package manager", async () => {
  const { cacheRoot, packageRoot } = makeCache(OLD)
  // A PATH with the opencode binary and nothing else: this is the machine the
  // story talks about, the one with neither npm nor bun.
  const binDir = scratch("lacode-bin-")
  writeFileSync(join(binDir, "opencode"), "")
  assert.deepEqual(readdirSync(binDir), ["opencode"], "control: the PATH holds the opencode binary and no package manager")

  const calls = []
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath: join(scratch(), "state.json"),
    lockPath: join(scratch(), "lock"),
    fetchImpl: fakeFetch(NEW),
    spawnImpl: (...args) => {
      calls.push(args)
      return fakeSpawn(cacheRoot, NEW)(...args)
    },
    // Not the opencode binary: the PATH decides, which is what a remote host
    // looks like.
    execPath: "/usr/bin/node",
    env: { PATH: binDir },
    log: () => {},
  })

  assert.equal(result.action, "updated", "the update must have been installed")
  assert.equal(calls.length, 1, "the installer runs exactly once")
  const [bin, args] = calls[0]
  assert.equal(bin, join(binDir, "opencode"), "the opencode binary is what runs")
  assert.deepEqual(args, ["plugin", PACKAGE_NAME, "-g"], "and it is asked to install the plugin globally")
  assert.ok(
    !/\b(npm|bun|yarn|pnpm)\b/.test(`${bin} ${args.join(" ")}`),
    `no package manager may appear in the install command: ${bin} ${args.join(" ")}`,
  )
})

test("[US-27] the plugin factory returns before the registry answers", () => {
  const { result, report } = runPluginFactory("hang")

  assert.equal(result.status, 0, `the factory must return while the registry is still pending:\n${result.stderr}`)
  assert.ok(report, `the child must report what it saw:\n${result.stdout}`)
  assert.equal(report.calls, 1, "the registry WAS asked -- the check really started")
  assert.ok(report.elapsed < 1000, `the factory must not wait for the registry (it took ${report.elapsed}ms)`)
  assert.deepEqual(report.hooks, [], "the factory returns no hooks of its own")
})

test("[US-27] an unreachable registry records nothing that would suppress a later retry", async () => {
  const { cacheRoot, packageRoot } = makeCache(OLD)
  const statePath = join(scratch("lacode-state-"), "selfupdate.json")
  const logs = []
  const result = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW,
    statePath,
    lockPath: join(scratch(), "lock"),
    fetchImpl: offlineFetch,
    spawnImpl: mustNotSpawn,
    log: (level, message) => logs.push(`${level}:${message}`),
  })

  assert.equal(result.action, "skipped", "an unreachable registry is not a failure")
  assert.match(result.detail ?? "", /registry unreachable/)
  assert.deepEqual(logs, [], `the check must be silent:\n${logs.join("\n")}`)

  // What it wrote to the state file is the whole question: a marker that
  // outlives the interval would stop the machine from ever checking again.
  const recorded = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}
  assert.equal(recorded.updatedTo, undefined, "a failed check must not record an update that happened")
  assert.equal(recorded.latest, undefined, "a failed check must not record a latest version it never saw")
  assert.ok(
    isDue(recorded, NOW + CHECK_INTERVAL_MS),
    `the check must be due again once the interval has passed: ${JSON.stringify(recorded)}`,
  )

  // And it really is retried: with the registry reachable again, the check runs
  // and installs.
  let calls = 0
  const again = await maybeSelfUpdate({
    packageRoot,
    now: () => NOW + CHECK_INTERVAL_MS,
    statePath,
    lockPath: join(scratch(), "lock"),
    fetchImpl: async () => {
      calls++
      return { ok: true, json: async () => ({ version: NEW }) }
    },
    spawnImpl: fakeSpawn(cacheRoot, NEW),
    execPath: "/usr/local/bin/opencode",
    log: () => {},
  })
  assert.equal(calls, 1, "the registry is consulted again once the interval has passed")
  assert.equal(again.action, "updated", "the retry installs the update")

  // And through the plugin, the failure never reaches opencode as a throw.
  const { result: plugin, report } = runPluginFactory("offline")
  assert.equal(plugin.status, 0, `the plugin must not throw into opencode:\n${plugin.stderr}`)
  assert.ok(report, `the child must report what it saw:\n${plugin.stdout}`)
  assert.equal(report.calls, 1, "the registry was asked")
  assert.ok(
    report.lines.every((line) => !line.startsWith("error")),
    `a failed check must not be logged as an error:\n${report.lines.join("\n")}`,
  )
})

test.after(() => cleanupAll())
