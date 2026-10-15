// Which LaCode is running — and why "npm ls -g" is the wrong question.
//
// The failure this exists to prevent: a config loads the plugin by ABSOLUTE PATH
// (`file:///home/you/repo/dist/index.js`) while the `lacode` on PATH belongs to
// an npm install elsewhere. Both report their own version honestly, and the
// version opencode actually runs is neither. `npm ls -g @lawaty/lacode` on that
// machine reports 0.1.0 — a version that has been unloaded for months and looks
// authoritative the whole time.
//
// Everything is injected: no real git, no real HOME, no real config, no network.
// A diagnostic that can only be tested by being wrong on a live machine is a
// diagnostic nobody runs.

import { strict as assert } from "node:assert"
import { formatVersion, readPluginEntries, readVersionReport } from "../src/lib/version.ts"

let failures = 0
const ok = (name) => {
  process.stdout.write(`  ok  ${name}\n`)
}
const check = (name, fn) => {
  try {
    fn()
    ok(name)
  } catch (error) {
    failures++
    process.stdout.write(`  FAIL ${name}: ${error?.message ?? error}\n`)
  }
}

const REPO = "/home/you/lacode"
const INSTALLED = "/home/you/.local/lib/node_modules/@lawaty/lacode"
const HOME = "/home/you"

const manifest = (version) => JSON.stringify({ name: "@lawaty/lacode", version })

/** A fake package root: a manifest, a set of files, and a git to answer for. */
const fakeRoot = (root, { version = "0.4.1", git, distIndex = 1000, sources = {}, isCheckout = true, noDist = false } = {}) => {
  const files = new Map([[`${root}/package.json`, manifest(version)]])
  if (isCheckout) files.set(`${root}/.git/HEAD`, "ref: refs/heads/master")
  if (!noDist) files.set(`${root}/dist/index.js`, "// built")
  const mtimes = new Map([[`${root}/package.json`, 0]])
  if (!noDist) mtimes.set(`${root}/dist/index.js`, distIndex)
  for (const [rel, mtime] of Object.entries(sources)) {
    files.set(`${root}/${rel}`, "// src")
    mtimes.set(`${root}/${rel}`, mtime)
  }
  return {
    exists: (p) => files.has(p) || (isCheckout && p === `${root}/.git`) || (!noDist && p === `${root}/dist`),
    readFile: (p) => files.get(p),
    stat: (p) => mtimes.get(p),
    listSources: () => Object.keys(sources).map((rel) => `${root}/${rel}`),
    git: (args) => (args[0] === "rev-parse" ? (git?.commit ?? "abc1234") : git?.porcelain),
  }
}

const withConfig = (deps, text, { path = `${HOME}/.config/opencode/opencode.jsonc` } = {}) => ({
  ...deps,
  exists: (p) => p === path || deps.exists(p),
  readFile: (p) => (p === path ? text : deps.readFile(p)),
})

// ---------------------------------------------------------------- the copy itself

check("a checkout reports its version, commit and clean state", () => {
  const r = readVersionReport({ packageRoot: REPO, home: HOME, ...fakeRoot(REPO, { git: { commit: "abc1234", porcelain: "" } }) })
  assert.equal(r.version, "0.4.1")
  assert.equal(r.source, "checkout")
  assert.equal(r.commit, "abc1234")
  assert.equal(r.dirty, false)
})

check("a modified working tree is reported dirty", () => {
  const r = readVersionReport({ packageRoot: REPO, home: HOME, ...fakeRoot(REPO, { git: { commit: "abc1234", porcelain: " M src/x.ts" } }) })
  assert.equal(r.dirty, true)
  assert.match(formatVersion(r), /abc1234 \(dirty\)/)
})

check("an installed copy reports no commit rather than a fake one", () => {
  const r = readVersionReport({
    packageRoot: INSTALLED,
    home: HOME,
    ...fakeRoot(INSTALLED, { version: "0.4.0", isCheckout: false }),
  })
  assert.equal(r.version, "0.4.0")
  assert.equal(r.source, "installed")
  assert.equal(r.commit, undefined, "a tarball has no git history; omitting beats inventing")
  assert.ok(!formatVersion(r).includes("commit"))
})

// ---------------------------------------------------------------- dist staleness

check("a dist built after its sources is current", () => {
  const r = readVersionReport({
    packageRoot: REPO,
    home: HOME,
    ...fakeRoot(REPO, { distIndex: 2000, sources: { "src/index.ts": 1000, "src/lib/pool.ts": 1500 } }),
  })
  assert.equal(r.dist, "current")
  assert.equal(r.staleSources, undefined)
})

check("a source edited after `git pull` marks dist stale and names the files", () => {
  const r = readVersionReport({
    packageRoot: REPO,
    home: HOME,
    ...fakeRoot(REPO, { distIndex: 1000, sources: { "src/index.ts": 900, "src/lib/version.ts": 5000 } }),
  })
  assert.equal(r.dist, "stale")
  assert.deepEqual(r.staleSources, ["src/lib/version.ts"])
  assert.match(formatVersion(r), /newer than dist\/index\.js/)
})

check("a copy with no dist at all says unknown, not stale", () => {
  const r = readVersionReport({
    packageRoot: REPO,
    home: HOME,
    ...fakeRoot(REPO, { noDist: true, sources: { "src/index.ts": 5000 } }),
  })
  assert.equal(r.dist, "unknown")
})

// ------------------------------------------------- the question: which copy runs

check("a config loading this copy by path is matched", () => {
  const r = readVersionReport({
    packageRoot: REPO,
    home: HOME,
    ...withConfig(fakeRoot(REPO), `{ "plugin": [["file://${REPO}/dist/index.js", {}]] }`),
  })
  assert.equal(r.servedByThisCopy, true)
  assert.equal(r.note, undefined, "a match needs no lecture")
})

check("a config loading a DIFFERENT copy says so in plain words", () => {
  const r = readVersionReport({
    packageRoot: REPO,
    home: HOME,
    ...withConfig(fakeRoot(REPO), `{ "plugin": [["file://${INSTALLED}/dist/index.js", {}]] }`),
  })
  assert.equal(r.servedByThisCopy, false)
  assert.match(r.note, /NOT this copy/)
  assert.match(r.note, /not necessarily what opencode runs/)
})

check("the bare package name matches only an installed copy", () => {
  const cfg = `{ "plugin": [["@lawaty/lacode", {}]] }`
  const installedReport = readVersionReport({ packageRoot: INSTALLED, home: HOME, ...withConfig(fakeRoot(INSTALLED, { isCheckout: false }), cfg) })
  assert.equal(installedReport.servedByThisCopy, true, "the installed copy IS the one a bare name resolves to")

  const checkoutReport = readVersionReport({ packageRoot: REPO, home: HOME, ...withConfig(fakeRoot(REPO), cfg) })
  assert.equal(checkoutReport.servedByThisCopy, false, "a checkout is never what a bare package name loads")
})

check("a bare package name while running from a checkout is the exact trap", () => {
  const r = readVersionReport({ packageRoot: REPO, home: HOME, ...withConfig(fakeRoot(REPO), `{ "plugin": ["@lawaty/lacode"] }`) })
  assert.equal(r.servedByThisCopy, false)
  assert.match(r.note, /NOT this copy/)
})

check("lacode is not among several loaded plugins", () => {
  const r = readVersionReport({
    packageRoot: REPO,
    home: HOME,
    ...withConfig(fakeRoot(REPO), `{ "plugin": [["some/other", {}], ["file://${REPO}/dist/index.js", {}]] }`),
  })
  assert.equal(r.servedByThisCopy, true, "other plugins are not our problem")
  assert.equal(r.loaded.length, 2)
})

check("a config with no plugin array says so instead of guessing", () => {
  const r = readVersionReport({ packageRoot: REPO, home: HOME, ...withConfig(fakeRoot(REPO), `{ "model": "x" }`) })
  assert.equal(r.servedByThisCopy, undefined, "no plugin array means UNKNOWN, never a confident no")
  assert.match(r.note, /no readable `plugin` array/)
})

check("a missing config is a note, never a crash", () => {
  const r = readVersionReport({ packageRoot: REPO, home: HOME, ...fakeRoot(REPO) })
  assert.equal(r.configPath, undefined)
  assert.equal(r.servedByThisCopy, undefined, "nothing to compare against is not a verdict")
  assert.match(r.note, /No opencode config found/)
  assert.match(formatVersion(r), /version\s+0\.4\.1/, "the report is still useful without a config")
})

check("an unparseable config degrades to a note", () => {
  const r = readVersionReport({ packageRoot: REPO, home: HOME, ...withConfig(fakeRoot(REPO), "{ this is not json") })
  assert.equal(r.servedByThisCopy, undefined)
  assert.ok(r.note)
})

// ---------------------------------------------------------------- safety

check("plugin OPTIONS are never carried into the report", () => {
  const r = readVersionReport({
    packageRoot: REPO,
    home: HOME,
    ...withConfig(fakeRoot(REPO), `{ "plugin": [["file://${REPO}/dist/index.js", { "omniroute": { "apiKey": "sk-secret-value" } }]] }`),
  })
  const rendered = formatVersion(r) + (r.note ?? "")
  assert.ok(!rendered.includes("sk-secret-value"), "a credential must never reach a printed line")
  assert.ok(!JSON.stringify(r).includes("sk-secret-value"), "nor be retained on the report at all")
})

check("a plugin entry with options is still recognised by its specifier", () => {
  const entries = readPluginEntries(`{ "plugin": [["@lawaty/lacode", { "enabled": false }], "plain"] }`)
  assert.deepEqual(entries?.map((e) => e.specifier), ["@lawaty/lacode", "plain"])
})

// ---------------------------------------------------------------- jsonc

check("a commented config still parses", () => {
  const entries = readPluginEntries(`{
    // the plugin we actually run
    "plugin": [
      ["@lawaty/lacode", {},],   /* trailing comma + block comment */
    ],
  }`)
  assert.deepEqual(entries?.map((e) => e.specifier), ["@lawaty/lacode"])
})

check("a '//' inside a string is content, not a comment", () => {
  const entries = readPluginEntries(`{ "plugin": ["https://example.test/x"] }`)
  assert.deepEqual(entries?.map((e) => e.specifier), ["https://example.test/x"])
})

if (failures > 0) {
  process.stdout.write(`\nFAIL: ${failures} check(s) failed\n`)
  process.exit(1)
}
process.stdout.write("\nversion: all checks passed\n")