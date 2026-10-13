// Epic G — Context and cost.
//
//   US-19  a curated map replaces cold exploration
//   US-20  the map stays current without being asked
//   US-21  one writer keeps the map coherent
//   US-22  on-demand map operations: /context-init, /context-update, /context-review
//
// The feature under test is the codemap at `.opencode/context/`: five files, one
// writing agent, an automatic refresh, and three slash commands.
//
// Two things are asserted here that no other suite asserts, and both are worth
// saying out loud because they are the parts that silently rot:
//
//   * US-20 drives `contextAutoUpdateHooks` — the real hook factory — with a stub
//     client, a temp project root and a temp HOME. Nothing spawns a model, but
//     every decision the plugin makes (bootstrap vs update, which paths count,
//     which slots get borrowed, whether a run actually changed anything) is the
//     one it would make in a live session. That is the only honest way to test a
//     plugin whose whole job is to fire something off asynchronously.
//   * US-21 evaluates the INJECTED permission table the way opencode evaluates it
//     rather than asserting that the strings are present. A rule can contain the
//     right text and still never match, which is exactly how this map went stale
//     for three days in production (see src/lib/writer-rule.ts).

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENTS, POOLED_BASES } from "../../src/agents.ts"
import { COMMANDS, STANDING_INSTRUCTION } from "../../src/commands.ts"
import { MAX_SLOTS } from "../../src/lib/pool.ts"
import { verifyWriterRule } from "../../src/lib/writer-rule.ts"
import { contextAutoUpdateHooks } from "../../src/plugins/context-autoupdate.ts"
import { ROOT, PRESET, bootLaCode, cleanupAll, emptyConfig, fakeClock, presetModels, scratch, settle, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

/** The five files the cartographer owns, and the map is exactly these. */
const MAP_FILES = ["architecture.md", "contexts.md", "conventions.md", "workflows.md", "decisions.md"]

/** A file inside the map, in the form opencode evaluates it from a normal root. */
const MAP_FILE = ".opencode/context/architecture.md"

// ---------------------------------------------------------------------------
// A permission evaluator, copied from opencode's semantics as documented in
// src/lib/writer-rule.ts: patterns compile to ANCHORED regexes (* -> .*), the
// LAST matching rule wins (there is no specificity sorting — it is a findLast
// over the flattened entries), and a plain string is the verdict outright.
// Asserting on rule *strings* would pass for a rule that matches nothing.
//
// The "last match wins" half is load-bearing rather than pedantic: it is why
// every narrow deny in this package is declared LAST. An evaluator that ranked
// by pattern length would happily accept a deny sitting above a blanket
// `"*": "allow"` — a table opencode would in fact resolve the other way, and
// which would therefore leave the map writable by every implement tier.
// ---------------------------------------------------------------------------

const patternMatches = (pattern, file) => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(file)
}

/** What a `permission` entry says about writing `file`. */
const verdict = (rule, file) => {
  if (rule === undefined) return "allow" // an unconfigured tool is not restricted
  if (typeof rule === "string") return rule
  // findLast: every matching entry overwrites the verdict, so the last one wins.
  let winner = rule["*"] ?? "allow" // opencode's own fallback when nothing matches
  for (const [pattern, value] of Object.entries(rule)) {
    if (patternMatches(pattern, file)) winner = value
  }
  return winner
}

/**
 * Could this agent write inside the codemap at all?
 *
 * `edit` alone, because that is the only key opencode reads: its tool-permission
 * lookup folds the tool names "write" and "apply_patch" onto "edit", so a `write`
 * key in a permission block is never consulted. LaCode emits none (asserted below).
 */
const canWriteMap = (permission) => verdict(permission?.edit, MAP_FILE) === "allow"

/**
 * Run with a temporary HOME.
 *
 * `pool.state()` is called with no arguments by the autoupdate factory, so it
 * resolves its claim directory from $HOME at that moment. Pointing HOME at a
 * temp directory is what keeps these tests off the real
 * ~/.local/share/opencode/agent-pool — the same trick f-adoption-safety uses for
 * the fresh-install fixture.
 */
const withHome = async (home, fn) => {
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
}

/**
 * Boot only the autoupdate factory against a throwaway project.
 *
 * The session table always carries a root session ("root"): a session with no
 * parentID. Child sessions are supplied per-test, because "only the root
 * session refreshes the map" is itself one of the things US-20 asserts.
 */
const bootAutoupdate = async ({ withMap = false, sessions = {} } = {}) => {
  const root = scratch("proj-")
  const mapDir = join(root, ".opencode", "context")
  if (withMap) {
    mkdirSync(mapDir, { recursive: true })
    for (const name of MAP_FILES) writeFileSync(join(mapDir, name), `# ${name}\n`)
  }
  const stub = stubInput({
    sessions: { root: { id: "root", title: "main" }, ...sessions },
    directory: root,
  })
  const home = scratch("home-")
  // The autoupdate plugin borrows from the same pool; pin it to the preset so a
  // developer's own ~/.config/lacode/pool.txt cannot leak into the assertion.
  const hooks = await withHome(home, () => contextAutoUpdateHooks(stub.input, { modelsFile: PRESET }))
  return { stub, hooks, root, mapDir, home }
}

/** A promise the test resolves by hand, so an in-flight turn stays observable. */
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Make the cartographer actually change the map, so "did anything land?" is honest. */
const writesOnPrompt = (stub, mapDir) => {
  stub.client.session.prompt = async (input) => {
    stub.prompts.push(input)
    writeFileSync(join(mapDir, "architecture.md"), "# architecture.md\n\nupdated by this run\n")
    return { data: { info: {} } }
  }
}

const claimsDir = (home) => join(home, ".local", "share", "opencode", "agent-pool")
const claimFiles = (home) => {
  const dir = claimsDir(home)
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("claims.")) : []
}

/**
 * Every claim key this process currently publishes, across its claim files.
 *
 * The file itself is always rewritten (an empty payload still gets published),
 * so what matters is whether a claim for a given session is in it — not whether
 * the file exists.
 */
const liveClaims = (home) =>
  claimFiles(home).flatMap((name) => Object.keys(JSON.parse(readFileSync(join(claimsDir(home), name), "utf8"))))

/** The prompt text the cartographer was actually handed. */
const promptedWith = (stub) => stub.prompts[0].body.parts[0].text

// ---------------------------------------------------------------------------
// US-19 — a curated map replaces cold exploration
// ---------------------------------------------------------------------------

test("[US-19] the cartographer is injected as a pooled subagent, with no model of its own", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us19-inject", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  const cm = cfg.agent["context"]
  assert.ok(cm, "context must be injected for anyone who has not defined one")
  assert.equal(cm.mode, "subagent", "the cartographer is a subagent, never a root agent")
  assert.ok(POOLED_BASES.includes("context"), `context must be a pooled base: ${POOLED_BASES.join(", ")}`)
  // The pool is the only thing that decides which model runs a pooled agent, so
  // a model written next to the agent would be a second source of truth that
  // silently wins whenever routing falls through.
  assert.equal(AGENTS["context"].model, undefined, "the definition must not carry a model")
  // And the model the pool bound is a real slot, not something invented here.
  const models = presetModels()
  assert.ok(cfg.agent["context-1"], "a slot variant must exist for slot 1")
  assert.ok(models.includes(cfg.agent["context-1"].model), `variant model ${cfg.agent["context-1"].model} is not a declared slot`)
})

test("[US-19] every slot the pool can hand out has a hidden cartographer variant", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us19-variants", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // Cartography must borrow shared capacity rather than add a model of its own:
  // if there were no variant for a slot, the automatic run would have nowhere
  // to land and would either fail or escape the pool's accounting.
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const variant = cfg.agent[`context-${slot}`]
    assert.ok(variant, `hidden variant context-${slot} must exist for slot ${slot}`)
    assert.equal(variant.hidden, true, `context-${slot} must be hidden`)
  }
  assert.equal(cfg.agent[`context-${MAX_SLOTS + 1}`], undefined, "no variant may exist beyond the pool's slot cap")

  // A hidden variant is the same agent as its base, so routing through a slot
  // cannot escape the base's instructions or its permissions.
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    assert.deepEqual(
      cfg.agent[`context-${slot}`].permission,
      cfg.agent["context"].permission,
      `context-${slot} must carry the base agent's permissions unchanged`,
    )
  }
})

test("[US-19] the map protocol reaches every agent as a standing rule", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us19-standing", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  assert.deepEqual(cfg.instructions, [STANDING_INSTRUCTION], "the rule must be injected when the user has none")
  for (const name of MAP_FILES) {
    assert.ok(STANDING_INSTRUCTION.includes(name), `the standing rule must name ${name} so an agent knows what it may read`)
  }
  // "Check the map, don't go cold" only pays off if the check is cheap and the
  // result is used: one file, then the entry points it lists.
  assert.match(STANDING_INSTRUCTION, /ls \.opencode\/context/, "the check must be ls, not a glob that skips hidden directories")
  assert.match(STANDING_INSTRUCTION, /never the\s+`glob`/, "the rule must say the glob tool does not see it")
  assert.match(STANDING_INSTRUCTION, /canonical entry points/, "the rule must send the agent to the entry points the map lists")
  assert.match(STANDING_INSTRUCTION, /trust the code/i, "the map is an index; source stays authoritative")
})

test("[US-19] the cartographer is told to write an index, not an inventory", async () => {
  const prompt = AGENTS["context"].prompt

  // The map has one job: answer "what should I look at first?". A cartographer
  // that writes a directory listing has produced something more expensive than
  // the exploration it was meant to replace.
  for (const name of MAP_FILES) {
    assert.ok(prompt.includes(name), `the prompt must define what ${name} is for`)
  }
  assert.match(prompt, /Start here/, "each subsystem must get a canonical start-here list")
  assert.match(prompt, /file inventories or directory listings/i, "inventories must be forbidden by name")
  assert.match(prompt, /REDUCE context consumption/, "the map must be kept small on purpose")
  // And the scope it must refuse to widen, or it drifts into the user's home
  // directory and the next agent trusts whatever it found there.
  assert.match(prompt, /Stay inside this project/, "the cartographer must be fenced to the repository")
})

// ---------------------------------------------------------------------------
// US-20 — the map stays current without being asked
// ---------------------------------------------------------------------------

test("[US-20] a tracked edit followed by the root session going idle spawns the cartographer", async () => {
  const { stub, hooks, root } = await bootAutoupdate()
  await hooks.event({ event: { type: "file.edited", properties: { file: "src/tunnel/index.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })

  assert.equal(stub.created.length, 1, `expected one cartographer session, got ${JSON.stringify(stub.created)}`)
  assert.match(stub.created[0].title, /^context \(auto (bootstrap|update)\)$/, "the run must be labelled so a log reader can tell what it was")
  assert.equal(stub.prompts.length, 1, "the session must be prompted, not merely created")

  // It borrows a pool slot rather than pinning a model: cartography is bulk work.
  const agent = stub.prompts[0].body.agent
  assert.match(agent, /^context-[1-9]$/, `the run must use a slot variant, got ${agent}`)
  const borrowed = stub.text().find((line) => line.includes("borrowed pool slot"))
  assert.ok(borrowed, `borrowing a slot must be reported:\n${stub.text().join("\n")}`)
  assert.ok(presetModels().some((model) => borrowed.includes(model)), `the borrowed slot must be a declared slot: ${borrowed}`)

  // The prompt tells it what changed and where it is, so the run starts narrow.
  const text = promptedWith(stub)
  assert.ok(text.includes(root), "the run must be told the project root")
  assert.ok(text.includes("src/tunnel/index.ts"), "the edited path must be listed as starting context")
})

test("[US-20] the run is told to bootstrap when the map is absent and to update when it exists", async () => {
  const cold = await bootAutoupdate({ withMap: false })
  await cold.hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await cold.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.match(cold.stub.created[0].title, /auto bootstrap\)$/, "no map yet means bootstrap")
  assert.match(promptedWith(cold.stub), /Bootstrap the repository context map/, "the bootstrap procedure must be invoked")

  const warm = await bootAutoupdate({ withMap: true })
  await warm.hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await warm.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.match(warm.stub.created[0].title, /auto update\)$/, "an existing map means incremental update")
  const text = promptedWith(warm.stub)
  assert.match(text, /Incremental context update/, "the update procedure must be invoked")
  // An update that rewrites the map wholesale is a regression, not a refresh.
  assert.match(text, /no update needed/, "the run must be allowed to conclude that nothing changed")
})

test("[US-20] idle with nothing pending, a child session, or an ignored path spawns nothing", async () => {
  const idle = await bootAutoupdate()
  await idle.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.equal(idle.stub.created.length, 0, "an idle session that changed nothing must not spend a cartography run")

  // Child sessions go idle constantly, mid-task. If each one refreshed the map
  // the map would be rewritten by a dozen concurrent subagents.
  const child = await bootAutoupdate({ sessions: { kid: { id: "kid", parentID: "root" } } })
  await child.hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await child.hooks.event({ event: { type: "session.idle", properties: { sessionID: "kid" } } })
  assert.equal(child.stub.created.length, 0, "a subagent going idle must not refresh the map")

  // Generated output, vendored trees and the map's own writes are not facts
  // about the repository, and the cartographer's own writes must never re-trigger it.
  const noise = await bootAutoupdate()
  for (const file of [
    "node_modules/dep/index.js",
    "dist/bundle.js",
    "coverage/lcov.info",
    ".opencode/context/architecture.md",
    "../elsewhere/file.ts",
  ]) {
    await noise.hooks.event({ event: { type: "file.edited", properties: { file } } })
  }
  await noise.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.equal(noise.stub.created.length, 0, "generated, vendored, out-of-project and map-internal paths must not schedule a run")
})

test("[US-20] the borrowed slot is released and the cartographer going idle does not start a second run", async () => {
  const { stub, hooks, mapDir, home } = await bootAutoupdate({ withMap: true })
  // Hold the turn open so the window in which the slot is held is observable:
  // a prompt that resolves instantly releases the claim before the test can see it.
  const turn = deferred()
  stub.client.session.prompt = async (input) => {
    stub.prompts.push(input)
    writeFileSync(join(mapDir, "architecture.md"), "# architecture.md\n\nupdated by this run\n")
    return turn.promise
  }

  await hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.equal(stub.created.length, 1, "the first run must have happened")
  assert.ok(liveClaims(home).includes("created-1:context-autoupdate"), "the borrowed slot must be claimed while the cartographer runs")

  // The cartographer is itself a session, and it goes idle when it finishes.
  // Treating that as a new work session is how a single edit turns into a
  // cartography loop.
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "created-1" } } })
  assert.equal(stub.created.length, 1, "the cartographer's own idle event must not schedule a second run")

  // And the slot goes back to the pool when the turn ends, so a cartography run
  // does not permanently cost the user one of four concurrent slots.
  turn.resolve({ data: { info: {} } })
  await settle()
  assert.deepEqual(liveClaims(home), [], "the borrowed slot must be released when the run finishes")
  assert.ok(stub.lines.some((line) => line.message === "auto update finished"), "the run must be reported as finished")
})

test("[US-20] a run that changed nothing on disk is reported as such, not as success", async () => {
  // The failure this exists for: a cartographer blocked from writing resolves
  // exactly like one that succeeded, so every run claimed success while the map
  // sat untouched. Counting what landed on disk is the only honest signal.
  const { stub, hooks, mapDir } = await bootAutoupdate({ withMap: true })
  await hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await settle()

  const blocked = stub.lines.find((line) => line.message.includes("without changing the map"))
  assert.ok(blocked, `a run that changed nothing must say so:\n${stub.text().join("\n")}`)
  assert.equal(blocked.level, "warn", "a run that changed nothing is not a success")
  assert.ok(!stub.lines.some((line) => line.message === "auto update finished"), "success must not be claimed")
  assert.match(blocked.extra.hint, /one-writer/, "the message must point at the likeliest cause")

  // Contrast: a run that really wrote the file reports the change it made.
  const real = await bootAutoupdate({ withMap: true })
  writesOnPrompt(real.stub, real.mapDir)
  await real.hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await real.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await settle()

  const finished = real.stub.lines.find((line) => line.message === "auto update finished")
  assert.ok(finished, `a real change must be reported as finished:\n${real.stub.text().join("\n")}`)
  assert.ok(finished.extra.changed >= 1, `the count of changed map files must be reported, got ${finished.extra.changed}`)
})

test("[US-20] a failed run releases its slot and requeues its paths instead of stranding them", async () => {
  const clock = fakeClock()
  const { stub, hooks, home } = await bootAutoupdate({ withMap: true })
  stub.client.session.prompt = async (input) => {
    stub.prompts.push(input)
    throw new Error("provider exploded")
  }

  await hooks.event({ event: { type: "file.edited", properties: { file: "src/tunnel/index.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await settle()

  assert.equal(stub.prompts.length, 1, "the first run must have happened")
  assert.ok(stub.text().some((line) => line.includes("failed")), `a failed run must be reported:\n${stub.text().join("\n")}`)
  assert.deepEqual(liveClaims(home), [], "a failed run must release the slot it borrowed")

  // The cartographer session going idle clears the in-progress marker, then the
  // cooldown expires; the requeued path must still be in the next run.
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "created-1" } } })
  clock.advance(11 * 60 * 1000)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })

  assert.equal(stub.created.length, 2, `the requeued path must produce a second run:\n${stub.text().join("\n")}`)
  assert.ok(stub.prompts[1].body.parts[0].text.includes("src/tunnel/index.ts"), "a failed run's paths must survive to the next one")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// US-21 — one writer keeps the map coherent
// ---------------------------------------------------------------------------

/**
 * Is the map granted to this agent by an explicit allow RULE (not a blanket tool grant)?
 *
 * Only the `edit` key is consulted — see canWriteMap. A `write` block would be dead
 * config, so looking for a grant in one would assert a rule opencode ignores.
 */
const grantsMapByRule = (permission) =>
  (permission?.edit !== null &&
    typeof permission?.edit === "object" &&
    Object.entries(permission.edit).some(
      ([pattern, value]) => pattern !== "*" && value === "allow" && patternMatches(pattern, MAP_FILE),
    ))

test("[US-21] only the cartographer is granted the map by permission, and it may write nothing else", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-writers", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // Evaluated, not string-matched: a rule can name the map and still never fire.
  //
  // "Granted by rule" is the exact claim, and it is narrower than it looks — an
  // agent holding a blanket `"edit": "allow"` is also granted the map, just not
  // BY a rule. So the claim is checked two ways below: only context has a
  // grant rule, AND no other agent can reach the map at all.
  const granted = Object.entries(cfg.agent)
    .filter(([, def]) => !def.hidden)
    .filter(([, def]) => grantsMapByRule(def.permission))
    .map(([name]) => name)
  assert.deepEqual(granted, ["context"], `only the cartographer may be granted the map by rule; these others are: ${granted.join(", ")}`)

  // The stronger half, and the one this story exists for: the agents that CAN
  // write files elsewhere cannot write the map. This used to fail for build
  // and implement, which both held a blanket "edit": "allow" and relied on
  // the prompt alone to keep them out of the map.
  for (const name of Object.keys(cfg.agent)) {
    if (name.startsWith("context")) continue
    assert.equal(canWriteMap(cfg.agent[name].permission), false, `${name} must not be able to write the map`)
  }

  // And the cartographer's grant is narrow: the map, and nothing else.
  //
  // `edit` is the only key that needs checking, and it is the only key the
  // injected config carries. Asserting the absence of `write` is what keeps
  // the claim honest: a `write` block would look identical here while being
  // dead config, because opencode folds write/apply_patch onto `edit`.
  const cm = cfg.agent["context"]
  assert.equal(
    Object.prototype.hasOwnProperty.call(cm.permission, "write"),
    false,
    "the cartographer must not carry a `write` key: opencode reads `edit`",
  )
  assert.equal(verdict(cm.permission.edit, MAP_FILE), "allow", "the cartographer must be able to write inside the map")
  assert.equal(verdict(cm.permission.edit, "src/index.ts"), "deny", "the cartographer must not be able to write source code")

  // No agent anywhere may carry one: it is never read, so it is pure decoration
  // that a future edit could mistake for the real rule.
  for (const [name, def] of Object.entries(cfg.agent)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(def.permission ?? {}, "write"),
      false,
      `${name} must not declare a \`write\` permission key (it folds onto \`edit\`)`,
    )
  }
})

test("[US-21] every agent that can write files carries a narrow-last deny on both spellings of the map", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-narrow-deny", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // The exact pattern strings context's own allow uses. Whatever makes
  // the allow match makes the deny match, so a typo cannot creep into one side.
  const SPELLINGS = ["*/.opencode/context/**", ".opencode/context/**"]

  // Every agent that can write anything is a potential second writer, and the
  // three that used to be gaps are named explicitly so a regression names itself.
  const writers = ["build", "implement"]
  for (const [slot, w] of [1, 2, 3, 4].map((n) => [`implement-${n}`, cfg.agent[`implement-${n}`]])) {
    assert.ok(w, `${slot} must exist`)
    writers.push(slot)
  }
  for (const name of writers) {
    const rule = cfg.agent[name].permission.edit
    assert.equal(typeof rule, "object", `${name} must scope its edit grant, not hold a bare "allow"`)

    // Both spellings, because which one fires depends on the project root.
    for (const spelling of SPELLINGS) {
      assert.equal(rule[spelling], "deny", `${name} must deny the map at "${spelling}"`)
    }

    // And LAST, because opencode resolves by findLast over declaration order.
    // Asserted on the object's own key order, not on a set: a deny written
    // above the blanket allow is a table that reads correctly and behaves
    // exactly like the gap it replaced.
    const keys = Object.keys(rule)
    const broad = keys.indexOf("*")
    for (const spelling of SPELLINGS) {
      const at = keys.indexOf(spelling)
      assert.ok(at > broad, `${name}: "${spelling}" (position ${at}) must come AFTER "*" (position ${broad}); order decides which rule wins`)
    }

    // The deny must cost nothing else: the agent still edits ordinary files.
    assert.equal(verdict(rule, "src/index.ts"), "allow", `${name} must still be able to edit ordinary source`)
  }
})

test("[US-21] denying the map does not deny reading it", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-reads", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // Closing the map to writes must not close it to the agents the standing rule
  // tells to check it — that would turn "read one map file" into a permission
  // error and make the whole context system unusable.
  for (const name of ["implement", "explore", "context"]) {
    const perm = cfg.agent[name].permission
    assert.equal(verdict(perm.read, MAP_FILE), "allow", `${name} must still be able to READ the map`)
    assert.equal(verdict(perm.glob, MAP_FILE), "allow", `${name} must still be able to GLOB the map`)
  }
  // The cartographer keeps its own write grant.
  assert.equal(verdict(cfg.agent["context"].permission.edit, MAP_FILE), "allow", "the cartographer still writes the map")

  // `build` is the one agent that cannot read at all — a deliberate, pre-existing
  // decision (it delegates every question to @explore), NOT a consequence of
  // the map deny. Asserting the shape rather than the absence is what keeps the
  // two confusable: a bare tool denial is the standing design, a map-scoped one
  // would mean this change had leaked into reading.
  assert.equal(cfg.agent.build.permission.read, "deny", "build must still delegate all reading rather than read the map itself")
  assert.equal(typeof cfg.agent.build.permission.read, "string", "build's read denial must stay a whole-tool denial, not a map-scoped rule")
})

test("[US-21] the writer rule covers both path spellings opencode actually evaluates", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-spellings", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  const edit = cfg.agent["context"].permission.edit
  // Normally-rooted project: the evaluated path is relative to the project root.
  assert.equal(verdict(edit, ".opencode/context/architecture.md"), "allow", "the relative spelling must be allowed")
  // Project root "/": the same file is evaluated as home/<you>/.opencode/context/...
  assert.equal(verdict(edit, "home/someone/.opencode/context/architecture.md"), "allow", "the leading-* spelling must be allowed too")
  // …and the cost of allowing both must be zero: nothing outside the map opens up.
  for (const file of ["src/index.ts", ".opencode/contexts/architecture.md", "context/architecture.md", ".opencode/plans/plan.md"]) {
    assert.equal(verdict(edit, file), "deny", `${file} must stay closed to the cartographer`)
  }
})

test("[US-21] the writer rule is checked in both directions: the map is writable, and writable by nobody else", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-two-way", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  const ROOT_UNDER_TEST = "/srv/work/app"
  const MAP_UNDER_TEST = `${ROOT_UNDER_TEST}/.opencode/context`

  /** A config file carrying exactly the agent permissions given. */
  const configFile = (agents) => {
    const file = join(scratch("cfg-"), "opencode.jsonc")
    writeFileSync(file, `{"agent":${JSON.stringify(agents)}}`)
    return file
  }
  const shipped = (name) => ({ [name]: { permission: cfg.agent[name].permission } })

  // The SHIPPED agent table passes both directions, for every project root the
  // two spellings cover. This is the assertion that would fail if any gap agent
  // were reverted to a blanket allow — which is exactly how the gap is policed
  // from now on.
  const shippedFile = configFile(
    Object.fromEntries(Object.entries(cfg.agent).map(([name, def]) => [name, { permission: def.permission }])),
  )
  for (const root of [ROOT_UNDER_TEST, "/", "/root"]) {
    const map = root === ROOT_UNDER_TEST ? MAP_UNDER_TEST : `${root === "/" ? "/home/someone" : root}/.opencode/context`
    const problem = verifyWriterRule(shippedFile, map, root)
    assert.equal(problem, undefined, `the shipped agent table must be clean for project root ${root}: ${problem}`)
  }

  // The author's personal opencode.jsonc is no longer part of this repo (the
  // package injects its agent table instead of shipping one), so there is no
  // "live config" left to cross-check. The shippedFile loop above already pins
  // the contract that matters: the table the package injects is clean.

  // Direction 2 bites: a gap agent holding a blanket grant is reported, naming
  // the agent and the rule that wins for the map. The blanket is written by
  // hand rather than taken from the shipped table, because the shipped table is
  // exactly the thing that must no longer contain one.
  const blanket = verifyWriterRule(
    configFile({
      build: { permission: { edit: "allow" } },
      "context": { permission: { edit: { "*": "deny", "*/.opencode/context/**": "allow", ".opencode/context/**": "allow" } } },
    }),
    MAP_UNDER_TEST,
    ROOT_UNDER_TEST,
  )
  assert.ok(blanket, "a blanket edit allow on build must be reported")
  assert.match(blanket, /more than one writer/, "the report must say the map has a second writer")
  assert.match(blanket, /build/, "the report must name the offending agent")
  assert.match(blanket, /allow/, "the report must name the rule that wins")
  assert.match(blanket, /LAST/, "the report must say ordering is what decides the winner")

  // …and the very same agent passes once the deny is narrowed and placed last.
  assert.equal(
    verifyWriterRule(configFile(shipped("build")), MAP_UNDER_TEST, ROOT_UNDER_TEST),
    undefined,
    "build's shipped permission must not be reported once the deny is in place",
  )

  // The deny alone must NEVER be reported. Reasoning about which rule wins, not
  // about whether the word "allow" appears anywhere in the table, is the whole
  // difference between this check working and crying wolf on a correct config.
  const denying = configFile({
    build: { permission: { edit: { "*": "allow", "*/.opencode/context/**": "deny", ".opencode/context/**": "deny" } } },
    "context": { permission: { edit: { "*": "deny", "*/.opencode/context/**": "allow", ".opencode/context/**": "allow" } } },
  })
  assert.equal(verifyWriterRule(denying, MAP_UNDER_TEST, ROOT_UNDER_TEST), undefined, "a correctly-ordered narrow deny is not a violation")

  // Ordering is the whole point: the SAME deny written above the blanket allow
  // loses in opencode, and must be reported as the hole it actually is.
  const misordered = configFile({
    build: { permission: { edit: { ".opencode/context/**": "deny", "*": "allow" } } },
    "context": { permission: { edit: { "*": "deny", "*/.opencode/context/**": "allow", ".opencode/context/**": "allow" } } },
  })
  const report = verifyWriterRule(misordered, MAP_UNDER_TEST, ROOT_UNDER_TEST)
  assert.ok(report, "a deny that loses to a later blanket allow is a real hole")
  assert.match(report, /build/, "the misordered agent must be named")

  // The cartographer's own variants are exempt — including hidden slot variants.
  assert.equal(
    verifyWriterRule(configFile({ "context-3": { permission: { edit: { "*": "deny", ".opencode/context/**": "allow" } } } }), MAP_UNDER_TEST, ROOT_UNDER_TEST),
    undefined,
    "context-N is the same writer and must not be flagged",
  )

  // An agent with no `edit` rule at all is not a second writer: opencode's
  // default for an unconfigured tool is `ask`, which stops nothing by accident.
  assert.equal(
    verifyWriterRule(configFile({ build: { permission: { read: "allow" } } }), MAP_UNDER_TEST, ROOT_UNDER_TEST),
    undefined,
    "an agent that never configured `edit` is not a writer",
  )
})

test("[US-21] non-cartographer agents are told to report map changes rather than make them", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-report", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // Ownership is enforced twice, and both halves matter: the permission denies
  // the write, and the instruction tells the agent what to do instead. Without
  // the second half an agent that tries, fails, and reports "permission denied"
  // has told the user nothing.
  assert.match(STANDING_INSTRUCTION, /Never edit `\.opencode\/context\/`/, "the standing rule must forbid editing the map")
  assert.match(STANDING_INSTRUCTION, /context agent owns it/, "the standing rule must name the owner")
  assert.match(STANDING_INSTRUCTION, /final report/, "the standing rule must say where to report instead")
  assert.match(STANDING_INSTRUCTION, /Source code is authoritative/, "the map must never outrank the code")

  // Every other tier carries the same rule inline, so an agent that was given a
  // narrow prompt and never read the standing rule still cannot go rogue.
  for (const name of ["build", "plan", "explore", "implement"]) {
    assert.match(cfg.agent[name].prompt, /\.opencode\/context\//, `${name}'s prompt must mention the map`)
    assert.match(cfg.agent[name].prompt, /context|context-update/, `${name}'s prompt must say who owns it`)
  }
})

// ---------------------------------------------------------------------------
// US-22 — on-demand map operations
// ---------------------------------------------------------------------------

test("[US-22] the three context commands are injected, each targeting the cartographer as a subtask", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us22-inject", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  for (const name of ["context-init", "context-update", "context-review"]) {
    const def = cfg.command[name]
    assert.ok(def, `/${name} must be injected`)
    assert.equal(def.agent, "context", `/${name} must delegate to the cartographer`)
    assert.equal(def.subtask, true, `/${name} must run as a subtask so it cannot become a root session`)
    assert.ok(def.description && def.description.length > 0, `/${name} must describe itself in the command list`)
    assert.ok(def.template.length > 100, `/${name} must carry a real template, not a one-line stub`)
  }
})

test("[US-22] $ARGUMENTS substitution puts the user's focus in the update command and leaves the procedure intact", async () => {
  const template = COMMANDS["context-update"].template
  assert.ok(template.includes("$ARGUMENTS"), "the update command must expose a focus placeholder")

  // opencode substitutes the placeholder itself; what matters is that the
  // template is built so a plain substitution produces a usable prompt.
  const focus = "src/tunnel/** and the SSH payload contract"
  const rendered = template.replaceAll("$ARGUMENTS", focus)
  assert.ok(rendered.includes(`Focus: ${focus}`), "the focus must land where the placeholder was")
  assert.ok(!rendered.includes("$ARGUMENTS"), "no placeholder may survive substitution")
  assert.ok(rendered.includes("git status"), "the surrounding procedure must survive substitution")
  assert.ok(rendered.includes('report\n"no update needed"') || rendered.includes('"no update needed"'), "the no-op escape hatch must survive")
  assert.equal(rendered.length - focus.length + focus.length, template.length - "$ARGUMENTS".length + focus.length)

  // The other two take no arguments, so they must carry none — an unresolved
  // placeholder would reach the model as literal text.
  for (const name of ["context-init", "context-review"]) {
    assert.ok(!COMMANDS[name].template.includes("$ARGUMENTS"), `/${name} takes no arguments and must not declare a placeholder`)
  }
})

test("[US-22] each command names the procedure it delegates and nothing is left unresolved", async () => {
  const procedures = {
    "context-init": /bootstrap|verify and refresh/i,
    "context-update": /incremental/i,
    "context-review": /review/i,
  }
  for (const [name, procedure] of Object.entries(procedures)) {
    assert.match(COMMANDS[name].template, procedure, `/${name} must invoke its own procedure`)
    assert.match(COMMANDS[name].template, /system\s+prompt/, `/${name} must defer to the cartographer's prompt, not duplicate it`)
  }
  // A review is the one run that must not touch code, so that rule belongs in
  // the command itself rather than in the cartographer's general instructions.
  assert.match(COMMANDS["context-review"].template, /read-only for this run/, "a review must declare its read-only scope")
  assert.match(COMMANDS["context-review"].template, /\.opencode\/context\//, "a review must name where its fixes are allowed")
})

test("[US-22] a user-defined context command is left byte-identical while the other two are still added", async () => {
  const mine = { template: "MY OWN REVIEW", description: "mine", agent: "build" }
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us22-clobber", dir: scratch() })
  const cfg = { command: { "context-review": { ...mine } } }
  await hooks.config(cfg)
  await hooks.dispose()

  assert.deepEqual(cfg.command["context-review"], mine, "a user's own /context-review must survive untouched")
  assert.ok(cfg.command["context-init"], "the commands nobody claimed must still be added")
  assert.ok(cfg.command["context-update"], "the commands nobody claimed must still be added")
})

test("[US-22] every injected command resolves to an agent that exists in the same config", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us22-resolve", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // A command pointing at an agent the user disabled is a dead slash command:
  // it appears in the list and does nothing when typed.
  for (const [name, def] of Object.entries(cfg.command)) {
    if (!def.agent) continue
    assert.ok(cfg.agent[def.agent], `/${name} targets ${def.agent}, which is not in this config`)
  }
  for (const name of ["context-init", "context-update", "context-review"]) {
    assert.ok(cfg.agent[cfg.command[name].agent], `/${name} must resolve to a real agent`)
  }
})

test("[US-22] the shipped package documents the same three commands the plugin injects", async () => {
  // The command set is also a published surface: the package ships `docs/`, and
  // a doc that lists commands the plugin stopped injecting is worse than none.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8")
  for (const name of Object.keys(COMMANDS)) {
    assert.ok(readme.includes(`/${name}`), `README.md must mention /${name}`)
  }
  const shipped = readFileSync(join(ROOT, "package.json"), "utf8")
  assert.ok(JSON.parse(shipped).files.includes("docs"), "docs/ must be published so the context system is documented for users")
})