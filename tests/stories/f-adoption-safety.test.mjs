// Epic F -- Adoption and safety.
//
//   US-15  one-line install with sane defaults
//   US-16  merges, never clobbers
//   US-17  a single off switch
//   US-24  tool grants are documented, not injected
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
import { ROOT, bootLaCode, cleanupAll, scratch, spawn, stubInput } from "./_harness.mjs"

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
// US-15 -- the injected set is COMPLETE, not merely present
//
// Both of these were found by diffing the injected agent set against the
// author's own working config: the keys were there, so "the agent exists" tests
// passed while the setup a client actually gets was quietly incomplete.
//
// ---------------------------------------------------------------------------

test("[US-15] the deep tiers are not left on the main model: deepModel pins them, and nothing is pinned without it", async () => {
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))

  // Unset: unchanged behaviour, no model written, so the tiers fall through to
  // whatever the user's default is. A package must not ship a provider.
  const bare = await LaCode(stub.input)
  const bareCfg = {}
  await bare.config(bareCfg)
  for (const name of ["explore-deep", "implement-deep"]) {
    assert.equal(bareCfg.agent[name].model, undefined, `${name} must carry no model when deepModel is unset`)
  }
  // The pooled bases are unaffected by the option: the pool owns those models.
  assert.equal(bareCfg.agent["explore-fast"].model, undefined, "a pooled base is still model-less")
  await bare.dispose()

  // Set: both unpooled tiers are pinned, and only they are.
  const pinned = await LaCode(stub.input, { deepModel: "example/deep-tier" })
  const pinnedCfg = { provider: { example: {} } }
  await pinned.config(pinnedCfg)
  for (const name of ["explore-deep", "implement-deep"]) {
    assert.equal(pinnedCfg.agent[name].model, "example/deep-tier", `${name} must be pinned to the configured model`)
  }
  assert.equal(pinnedCfg.agent["explore-fast"].model, undefined, "deepModel must not touch a pooled base")

  // This provider has NO whitelist, which opencode already reads as "every model
  // the provider offers is allowed". Writing one to hold a single id would turn
  // it into an allowlist naming nothing else, so opencode would delete every
  // other model the user runs there -- the pin is the plugin's business, their
  // provider list is not.
  assert.ok(!("whitelist" in pinnedCfg.provider.example), `an absent whitelist must stay absent, got ${JSON.stringify(pinnedCfg.provider.example)}`)
  await pinned.dispose()

  // A provider the user HAS restricted still needs the pin listed: opencode drops
  // every model an allowlist does not name, so without it the deep tiers resolve
  // to nothing and silently fall back to the session's model.
  const restricted = await LaCode(stub.input, { deepModel: "example/deep-tier" })
  const restrictedCfg = { provider: { example: { whitelist: ["their-own"] } } }
  await restricted.config(restrictedCfg)
  assert.deepEqual(restrictedCfg.provider.example.whitelist, ["their-own", "deep-tier"], "an existing whitelist must gain the pin without losing its own entries")
  await restricted.dispose()
})

test("[US-16] a deepModel never overwrites a deep tier the user defined themselves", async () => {
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))
  const hooks = await LaCode(stub.input, { deepModel: "example/deep-tier" })
  const mine = { description: "MY deep explorer", mode: "subagent", model: "mine/own-choice" }
  const cfg = { agent: { "explore-deep": { ...mine } } }
  await hooks.config(cfg)

  assert.deepEqual(cfg.agent["explore-deep"], mine, "merge-without-clobber outranks the deepModel option")
  // The sibling tier LaCode DID inject is still pinned, so the option is not inert.
  assert.equal(cfg.agent["implement-deep"].model, "example/deep-tier")
  await hooks.dispose()
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

// ---------------------------------------------------------------------------
// US-24 -- the tool grant is DOCUMENTED, not injected
//
// LaCode used to inject `tools: { "playwright_*": true }` on the four
// exploration and implementation tiers, with a comment claiming it rescued a
// user who had Playwright plus a global `"tools": { "playwright_*": false }`.
//
// That claim was false. opencode folds an agent's `tools` into its permission
// list while DECODING the config, before any plugin runs; a plugin's `config`
// hook mutates the already-decoded object, so the fold never re-runs and the
// injected value is read by nothing. Verified on opencode 1.18.34/1.18.35 with
// `opencode debug agent explore-fast`: the same grant written in the USER's own
// config produces two `playwright_*` entries (deny, then allow -- last wins),
// while the plugin-injected one produces only the deny.
//
// These tests pin the LIMITATION rather than the removed behaviour, so the dead
// grant cannot be quietly reintroduced on the belief that it is merely missing.
// ---------------------------------------------------------------------------

test("[US-24] no injected agent carries a `tools` grant: the host folds agent.tools before the config hook runs, so an injected one is inert", async () => {
  const stub = stubInput()
  const { default: LaCode } = await import(join(ROOT, "src", "index.ts"))
  const hooks = await LaCode(stub.input)
  // The author's own config shape: a global deny on the browser namespace.
  const cfg = { tools: { "playwright_*": false } }
  await hooks.config(cfg)

  const names = Object.keys(cfg.agent)
  assert.ok(names.length > 0, "control: agents really are injected")
  for (const name of names) {
    assert.ok(!("tools" in cfg.agent[name]), `${name} must not carry a tools field -- it is folded at load time and never read`)
  }

  // The tiers the dead grant used to sit on are named explicitly, so removing
  // the test above cannot quietly remove the check along with the field.
  for (const name of ["explore-fast", "explore-deep", "implement-fast", "implement-deep"]) {
    assert.equal(cfg.agent[name]?.tools, undefined, `${name} is the tier the phantom grant targeted`)
  }
  // ...and so is every hidden pool variant, which inherited it from its base.
  for (const name of ["explore-fast-1", "explore-fast-4", "implement-fast-1", "implement-fast-4"]) {
    assert.equal(cfg.agent[name]?.tools, undefined, `${name} inherited the phantom grant from its base`)
  }
  await hooks.dispose()
})

test("[US-24] removing the tools field removed nothing else: every agent field the host reads after the hook is still injected", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub)
  const cfg = {}
  await hooks.config(cfg)

  // These are exactly the fields opencode's post-hook agent assembly loop reads.
  // If one of them ever goes missing the grant removal has broken something real.
  for (const name of Object.keys(cfg.agent)) {
    const def = cfg.agent[name]
    assert.equal(typeof def.description, "string", `${name} must carry a description`)
    assert.equal(typeof def.prompt, "string", `${name} must carry a prompt`)
    assert.equal(typeof def.permission, "object", `${name} must carry a permission block`)
    assert.equal(typeof def.mode, "string", `${name} must carry a mode`)
    assert.equal(typeof def.temperature, "number", `${name} must carry a temperature`)
  }
  // `hidden` is the one field only some agents carry, so it is checked on the
  // pool variants specifically rather than on every agent.
  for (const name of ["explore-fast-1", "implement-fast-4", "context-manager-2"]) {
    assert.equal(cfg.agent[name]?.hidden, true, `${name} must stay hidden`)
  }
  await hooks.dispose()
})

test("[US-24] the limitation is documented for users: README states it above the injection list and shows the config that actually works", async () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8")

  // Prominent, not buried: the warning heading appears BEFORE "What gets
  // injected", so a reader meets it before the list of what the plugin provides.
  const warningAt = readme.indexOf("Per-agent tool grants must be in your own config")
  const injectedAt = readme.indexOf("### What gets injected")
  assert.ok(warningAt !== -1, `README must carry the tool-grant warning; found none:\n${readme}`)
  assert.ok(injectedAt !== -1, "README must still have its injection section")
  assert.ok(warningAt < injectedAt, "the warning must come BEFORE the injection list, not after it")

  // It must say the thing that is actually true, and not the thing that was
  // previously claimed.
  assert.match(readme, /config-load\s+time/, "the README must give the load-time-folding reason, or the grant gets re-added")
  assert.match(readme, /cannot grant tools to its agents/, "the README must state plainly that the plugin cannot do this")
  assert.ok(
    !/carry `tools: \{"playwright_\*": true\}`/.test(readme),
    "README must not still claim the tiers carry the grant",
  )

  // And a minimal example the reader can paste, naming all four tiers plus the
  // global deny it exists to work around.
  //
  // The example is looked for INSIDE the warning section, not anywhere in the
  // README: the README's first ```jsonc block is the plugin-options tuple under
  // "Configuration", and matching that would assert the fix lives in an
  // unrelated place. Scoping the search to the prose that explains the problem
  // is also what makes this an assertion about placement -- an example parked
  // below "What gets injected", away from the reason, fails here.
  const section = readme.slice(warningAt, injectedAt)
  assert.ok(section.length > 0, "the warning section must not be empty")
  const example = section.match(/```jsonc\n([\s\S]*?)```/)
  assert.ok(example, "the warning section must show a copy-pasteable example next to the reason")
  assert.match(example[1], /"playwright_\*": false/, "the example must show the global deny being worked around")
  for (const tier of ["explore-fast", "explore-deep", "implement-fast", "implement-deep"]) {
    assert.ok(example[1].includes(`"${tier}"`), `the example must grant the browser tools to ${tier}`)
  }
})

test("[US-24] the source records why the grant is absent, so a future reader does not re-add it", async () => {
  const source = readFileSync(join(ROOT, "src", "agents.ts"), "utf8")

  // The header must name the mechanism, not just the conclusion.
  assert.match(source, /schema transform/, "agents.ts must cite the AgentConfig decode that folds tools")
  assert.match(source, /visibleTools/, "agents.ts must name the runtime gate that never reads agent.tools")

  // And the code itself must not have crept back. The header comment is allowed
  // to NAME the playwright namespace -- it has to, to explain the scenario --
  // so the check is for an actual `tools:` key in an agent literal, not for the
  // string. The agent literals in this file use QUOTED keys, so both spellings
  // are matched; the unquoted-only form misses a `"tools": {` re-introduction.
  // The authoritative check remains the injected config in the first test, which
  // catches the grant however it is spelled.
  assert.ok(!/BROWSER_GRANT/.test(source), "the BROWSER_GRANT constant must not come back")
  assert.ok(!/tools\??:\s*Record<string, boolean>/.test(source), "the AgentDef.tools field must not come back")
  assert.ok(!/^\s+"?tools"?:\s*\{/m.test(source), "no agent literal may carry a tools grant")
})

