// Epic F -- Adoption and safety.
//
//   US-15  one-line install with sane defaults
//   US-16  merges, never clobbers
//   US-17  a single off switch
//
// US-15 and US-17 are tested against an "installed package" fixture: the exact
// file set `package.json.files` publishes (dist/, presets/, package.json), in a
// temp directory with a temp HOME. That is the only honest way to test "a fresh
// machine with no LaCode config" -- running from the working tree would find
// this repo's own opencode.jsonc and its own ~/.config/lacode, and quietly pass
// for the wrong reason. The fixture builds dist/ through the same
// `scripts/build.mjs` that `prepack` runs, so the tests and the tarball cannot
// disagree about what ships.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "../../scripts/build.mjs"
import { ROOT, cleanupAll, scratch, spawn, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const manifest = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

let built = false
/** Compile dist/ once per test process — the fixture ships whatever files ships. */
const ensureBuilt = async () => {
  if (built) return
  await build()
  built = true
}

/** A recursive listing, used to prove a directory was left completely untouched. */
const existing = (dir, prefix = "") => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`
    return entry.isDirectory() ? existing(join(dir, entry.name), `${name}/`) : [name]
  })
}

/** Copy the file set the published package ships into `pkgDir`. */
const copyPublishedFiles = (pkgDir) => {
  for (const entry of manifest().files) {
    if (entry.endsWith(".md")) {
      // Document entries are optional for behaviour; skip so the fixture does
      // not need a LICENSE file that may not exist in a fresh checkout.
      continue
    }
    const from = join(ROOT, entry)
    if (!existsSync(from)) continue
    cpSync(from, join(pkgDir, entry), { recursive: true })
  }
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest(), null, 2))
}

/** A temp directory holding exactly the files the published package ships. */
const installedPackage = async () => {
  await ensureBuilt()
  const dir = scratch("installed-")
  copyPublishedFiles(dir)
  // The peer dependency is supplied by the HOST, never shipped: linking the
  // repo's copy into node_modules is exactly what `npm install @lawaty/lacode`
  // produces, and it is what proves the package resolves without vendoring.
  mkdirSync(join(dir, "node_modules"), { recursive: true })
  symlinkSync(join(ROOT, "node_modules", "@opencode-ai"), join(dir, "node_modules", "@opencode-ai"), "dir")
  return dir
}

/** Run with a temp HOME so nothing can be read from or written to the real one. */
const withHome = async (home, fn) => {
  const previous = { HOME: process.env.HOME, XDG: process.env.XDG_DATA_HOME }
  process.env.HOME = home
  process.env.XDG_DATA_HOME = join(home, ".local", "share")
  try {
    return await fn()
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
    if (previous.XDG === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous.XDG
  }
}

/** Boot the plugin the way a consumer does: through the `.` the manifest declares. */
const bootFrom = async (dir, options) => {
  const { default: LaCode } = await import(pathToFileURL(join(dir, manifest().exports["."])).href)
  const stub = stubInput()
  const hooks = await LaCode(stub.input, options)
  return { stub, hooks }
}

// ---------------------------------------------------------------------------
// US-15 -- one-line install
// ---------------------------------------------------------------------------

test("[US-15] one config line is enough: a bare config boots and delivers the whole agent set", async () => {
  // What a new user writes is `{"plugin": ["@lawaty/lacode"]}` plus whatever
  // opencode hands the config hook. Nothing else is required, so this asserts
  // the value is delivered from an otherwise-empty config -- no hand-written
  // agents, no hand-written commands, no manual preset.
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))
  const hooks = await LaCode(stub.input)
  const cfg = { plugin: ["@lawaty/lacode"] }
  await hooks.config(cfg)

  for (const agent of ["build", "plan", "explore-fast", "implement-fast", "explore-deep", "implement-deep", "context-manager"]) {
    assert.ok(cfg.agent[agent], `${agent} must be injected by the single config line`)
  }
  for (const command of ["context-init", "context-update", "context-review"]) {
    assert.ok(cfg.command[command], `/${command} must be injected by the single config line`)
  }
  assert.ok(Array.isArray(cfg.instructions) && cfg.instructions.length > 0, "the standing rule must be injected too")

  // And the injected set actually routes work, so this is value, not decoration.
  const { routed } = await spawn(hooks, cfg, {})
  assert.match(routed, /^explore-fast-[1-9]$/, `delegated work must route to a pool slot, got ${routed}`)
  await hooks.dispose()
})

test("[US-15] with no configuration at all, the installed package falls back to shipped defaults and works", async () => {
  const dir = await installedPackage()
  const home = scratch("fresh-home-")
  // Control: the fixture really is the published shape, and really has no
  // user config for the pool to read.
  assert.ok(existsSync(join(dir, manifest().exports["."])), "the entry point the manifest declares must be present")
  assert.ok(existsSync(join(dir, "presets", "free-tier.json")))
  assert.ok(!existsSync(join(dir, "src")), "the tarball carries the built package, not the TypeScript sources")
  assert.ok(!existsSync(join(dir, "opencode.jsonc")), "an installed package has no opencode.jsonc")

  const { hooks, stub } = await withHome(home, async () => {
    const booted = await bootFrom(dir, { id: "us15-fresh", dir: scratch() })
    const cfg = {}
    await booted.hooks.config(cfg)
    assert.ok(cfg.agent["explore-fast"], "shipped defaults must supply the agents with no user config")
    const { routed, model } = await spawn(booted.hooks, cfg, {})
    assert.match(routed, /^explore-fast-[1-9]$/, "routing must work out of the box")
    await booted.hooks.dispose()
    return booted
  })

  // The bundled preset was the source, and it was reported as such.
  const bound = stub.text().find((line) => line.includes("bound"))
  assert.ok(bound, `the pool must report what it bound:\n${stub.text().join("\n")}`)
  assert.match(bound, /presets\/free-tier\.json/, `with no user config the bundled preset must be used: ${bound}`)
  void hooks
})

test("[US-15] the peer dependency is declared, not duplicated inside the package", async () => {
  const pkg = manifest()
  assert.equal(pkg.peerDependencies?.["@opencode-ai/plugin"], "1.18.34", "the SDK must be declared as a peer")
  assert.equal(pkg.dependencies, undefined, "the peer must not also be a hard dependency: that is duplication")
  assert.ok(!pkg.files.includes("node_modules"), "node_modules must not be published")

  // And the source imports it as a peer, never vendored: there is exactly one
  // module importing it, and no local copy of it in the tree.
  for (const file of ["src/index.ts", "src/plugins/agent-pool.ts", "src/plugins/notify.ts", "src/plugins/context-autoupdate.ts"]) {
    const source = readFileSync(join(ROOT, file), "utf8")
    assert.match(source, /from "@opencode-ai\/plugin"/, `${file} must import the declared peer`)
  }
  assert.ok(!existsSync(join(ROOT, "src", "node_modules")), "the SDK must never be vendored into the package")
})

test("[US-15] every entry point the manifest publishes is built JavaScript, not a TypeScript source", async () => {
  await ensureBuilt()
  const pkg = manifest()

  // The manifest is the contract, so read it rather than a copy of it: a new
  // subpath added without a build is the exact defect this asserts against.
  const entryPoints = [
    ...Object.entries(pkg.exports).map(([subpath, target]) => ({ subpath, target })),
    ...Object.entries(pkg.bin).map(([subpath, target]) => ({ subpath: `bin ${subpath}`, target })),
  ].filter(({ subpath }) => subpath !== "./package.json")

  assert.ok(entryPoints.length >= 6, "the plugin, four subpaths and the CLI are all published")

  for (const { subpath, target } of entryPoints) {
    assert.equal(typeof target, "string", `${subpath} must be a single path`)
    assert.ok(!target.endsWith(".ts"), `${subpath} must not publish TypeScript: node refuses to strip types under node_modules (${target})`)
    assert.ok(!target.includes("node_modules"), `${subpath} must not point into node_modules (${target})`)
    assert.ok(!target.startsWith("./src/"), `${subpath} must point at the build, not the sources (${target})`)
    assert.ok(target.startsWith("./dist/"), `${subpath} must point into dist/ (${target})`)
    assert.ok(pkg.files.includes(target.replace(/^\.\/([^/]+)\/.*$/, "$1")), `files must ship ${target}, or the tarball has a dangling entry point`)

    const file = join(ROOT, target)
    assert.ok(existsSync(file), `${subpath} -> ${target} does not exist; run \`npm run build\``)

    // `node --check` parses as JavaScript and REJECTS type syntax, so this is a
    // real proof of "plain JS" rather than a regex that a comment could fake.
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
    assert.equal(checked.status, 0, `${target} is not plain JavaScript:\n${checked.stderr}`)
  }

  // The CLI is spawned, not imported: it has to arrive executable.
  const cli = join(ROOT, pkg.bin.lacode)
  assert.ok(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node"), "the built CLI must keep its shebang so npm can link it")
  assert.ok(statSync(cli).mode & 0o111, "the built CLI must ship with the executable bit set")
})

test("[US-15] the published package loads and runs from inside node_modules, where node refuses to strip types", async () => {
  await ensureBuilt()
  // Laid out the way npm lays it out, because the location IS the bug: node
  // strips types natively from 22.18 and refuses to under node_modules, which
  // is why `lacode --help` died with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
  // on a global install while opencode (a Bun binary) kept working perfectly.
  const dir = scratch("installed-nm-")
  const pkgDir = join(dir, "node_modules", "@lawaty", "lacode")
  mkdirSync(pkgDir, { recursive: true })
  copyPublishedFiles(pkgDir)
  mkdirSync(join(dir, "node_modules", "@opencode-ai"), { recursive: true })
  symlinkSync(join(ROOT, "node_modules", "@opencode-ai", "plugin"), join(dir, "node_modules", "@opencode-ai", "plugin"), "dir")

  // A consumer importing the package BY NAME, the way a plugin host does.
  const consumer = join(dir, "consumer.mjs")
  writeFileSync(
    consumer,
    [
      'import plugin from "@lawaty/lacode"',
      'import { encodePayload } from "@lawaty/lacode/tunnel"',
      'import { splitModel } from "@lawaty/lacode/pool"',
      'console.log(JSON.stringify({ plugin: typeof plugin, payload: encodePayload({ title: "t" }), model: splitModel("openrouter/nvidia/x:free") }))',
    ].join("\n"),
  )
  const imported = spawnSync(process.execPath, [consumer], { cwd: dir, encoding: "utf8" })
  assert.equal(imported.status, 0, `a plain node consumer must be able to import the installed package:\n${imported.stderr}`)
  const seen = JSON.parse(imported.stdout.trim())
  assert.equal(seen.plugin, "function", "the default export must be the plugin factory")
  assert.match(seen.payload, /^t\n/, `the tunnel subpath must resolve to real code: ${seen.payload}`)
  assert.deepEqual(seen.model, { provider: "openrouter", id: "nvidia/x:free" }, "the pool subpath must resolve to real code")

  // And the CLI, run exactly as npm's bin link would run it.
  const help = spawnSync(process.execPath, [join(pkgDir, manifest().bin.lacode), "--help"], { encoding: "utf8" })
  assert.equal(help.status, 0, `\`lacode --help\` must exit 0 on an install:\n${help.stderr}`)
  assert.match(help.stdout, /lacode notify TITLE/, `the CLI must print its usage:\n${help.stdout}`)
})

// ---------------------------------------------------------------------------
// US-16 -- merge, never clobber
// ---------------------------------------------------------------------------

test("[US-16] a user-defined agent of the same name is left byte-identical", async () => {
  const mine = { description: "MY explorer", mode: "subagent", prompt: "MY PROMPT", permission: { read: "allow" }, temperature: 0.9 }
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))
  const hooks = await LaCode(stub.input)
  const cfg = { agent: { "explore-fast": { ...mine } } }
  await hooks.config(cfg)

  assert.deepEqual(cfg.agent["explore-fast"], mine, "a user's agent must survive injection untouched")
  assert.equal(cfg.agent["explore-fast"].prompt, "MY PROMPT", "not even a prompt may be patched")

  // Every other agent was still added, so a merge never means "give up".
  assert.ok(cfg.agent["implement-fast"], "the rest of the set must still be injected")
  assert.ok(stub.text().some((line) => line.includes("kept")), "the skip must be reported once")
  await hooks.dispose()
})

test("[US-16] a user-defined command of the same name is left byte-identical", async () => {
  const mine = { template: "MY UPDATE", description: "mine", agent: "build" }
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))
  const hooks = await LaCode(stub.input)
  const cfg = { command: { "context-update": { ...mine } } }
  await hooks.config(cfg)

  assert.deepEqual(cfg.command["context-update"], mine, "a user's command must survive untouched")
  assert.ok(cfg.command["context-init"], "the commands nobody claimed must still be added")
  await hooks.dispose()
})

test("[US-16] a merge preserves every pre-existing key in the file across a round trip", async () => {
  // The user's config is not only agents and commands: theme, mcp servers, and
  // plugin options must come out the far side untouched, including nested ones.
  const original = {
    $schema: "https://opencode.ai/config.json",
    theme: "tokyonight",
    model: "anthropic/claude-opus-4-1",
    small_model: "anthropic/claude-haiku-4-5",
    autoupdate: false,
    mcp: { playwright: { type: "local", command: ["npx", "playwright-mcp"], enabled: true } },
    permission: { edit: "ask", bash: { "*": "ask", "git status": "allow" } },
    plugin: [["some-other-plugin", { key: "value" }]],
    agent: { mine: { model: "a/b", permission: { read: "allow" } } },
    command: { mine: { template: "t" } },
    instructions: ["my own standing rule"],
    keybind: { "ctrl+s": "save" },
  }
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))
  const hooks = await LaCode(stub.input)

  // The round trip a real install performs: parse, inject, write back, re-read.
  const cfg = JSON.parse(JSON.stringify(original))
  await hooks.config(cfg)
  const written = `${JSON.stringify(cfg, null, 2)}\n`
  const reread = JSON.parse(written)

  for (const key of Object.keys(original)) {
    if (key === "agent" || key === "command") continue // asserted separately below
    assert.deepEqual(reread[key], original[key], `pre-existing key "${key}" must survive the round trip unchanged`)
  }
  assert.deepEqual(reread.agent.mine, original.agent.mine, "a pre-existing agent must survive byte-identically")
  assert.deepEqual(reread.command.mine, original.command.mine, "a pre-existing command must survive byte-identically")
  assert.equal(reread.instructions.length, 1, "existing standing instructions must not be appended to or rewritten")
  await hooks.dispose()
})

test("[US-16] merging twice in a row produces an identical result", async () => {
  const first = { agent: { mine: { prompt: "mine" } }, theme: "dark" }
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))

  const hooks = await LaCode(stub.input)
  const cfg = JSON.parse(JSON.stringify(first))
  await hooks.config(cfg)
  const afterOne = JSON.stringify(cfg)
  await hooks.config(cfg)
  const afterTwo = JSON.stringify(cfg)
  await hooks.dispose()

  assert.equal(afterTwo, afterOne, "a second merge must change nothing")

  // And the same, across a fresh process-shaped boot, so "install twice" is safe.
  const stub2 = stubInput()
  const again = await LaCode(stub2.input)
  const cfg2 = JSON.parse(JSON.stringify(first))
  await again.config(cfg2)
  await again.config(cfg2)
  await again.dispose()
  assert.equal(JSON.stringify(cfg2), afterOne, "a second boot must converge on the same config")
})

// ---------------------------------------------------------------------------
// US-17 -- the single off switch
// ---------------------------------------------------------------------------

test("[US-17] with the off switch set, nothing at all is injected", async () => {
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))
  const hooks = await LaCode(stub.input, { enabled: false })
  const cfg = { agent: { mine: { prompt: "mine" } }, command: { mine: { template: "t" } } }
  await hooks.config(cfg)

  assert.deepEqual(Object.keys(cfg.agent), ["mine"], "no agent may be injected")
  assert.deepEqual(Object.keys(cfg.command), ["mine"], "no command may be injected")
  assert.equal(cfg.instructions, undefined, "no standing rule may be injected")
  await hooks.dispose()
})

test("[US-17] with the off switch set, the bootstrap makes no writes at all", async () => {
  // "Off" means off. Not "off but it still creates a config directory", which
  // is the shape a half-wired switch takes.
  const dir = await installedPackage()
  const home = scratch("off-home-")
  const before = new Set(existing(home))

  await withHome(home, async () => {
    const { hooks } = await bootFrom(dir, { enabled: false })
    await hooks.config({})
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    await hooks.dispose()
  })

  assert.ok(!existsSync(join(home, ".config", "lacode")), "the off switch must not create the user config directory")
  assert.deepEqual([...existing(home)].sort(), [...before].sort(), `the off switch must write nothing at all, found: ${existing(home).join(", ")}`)
})

test("[US-17] with the off switch unset, behaviour is otherwise identical to enabling", async () => {
  // The claim is not "disabling changes something" but "disabling changes ONLY
  // this", so the enabled and explicitly-enabled results must match exactly,
  // and the disabled result must differ by exactly the injected keys.
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))

  const unset = await LaCode(stub.input, {})
  const cfgUnset = {}
  await unset.config(cfgUnset)
  await unset.dispose()

  const explicit = await LaCode(stub.input, { enabled: true })
  const cfgExplicit = {}
  await explicit.config(cfgExplicit)
  await explicit.dispose()

  assert.equal(JSON.stringify(cfgUnset), JSON.stringify(cfgExplicit), "unset and enabled must be the same boot")

  const disabled = await LaCode(stub.input, { enabled: false })
  const cfgDisabled = {}
  await disabled.config(cfgDisabled)
  await disabled.dispose()

  assert.equal(JSON.stringify(cfgDisabled), "{}", "the off switch must be the only difference")
  assert.ok(Object.keys(cfgUnset.agent).length > 0, "control: the enabled boot really does inject agents")
})

