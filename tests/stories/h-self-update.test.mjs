// Epic F (US-27) — the package keeps itself current.
//
// Offline by construction: the registry is a fake `fetch`, the installer is a
// fake `spawn`, the clock is injected, and every path is a temp dir. Nothing
// here touches npm, the network, or a real opencode cache.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { join } from "node:path"
import { PACKAGE_NAME } from "../../src/lib/package-root.ts"
import {
  acquireLock,
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
import { cleanupAll, scratch } from "./_harness.mjs"

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

test.after(() => cleanupAll())
