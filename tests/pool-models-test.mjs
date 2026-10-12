// presets/free-tier.json is the one file a user edits to change which models the pool
// runs, and what share of the work each one takes. This suite drives the config
// hook against temporary copies of that file and against the injected config
// (fixtures/config.mjs: the fixture provider block plus the package's own agent
// set), proving:
//
//   1. the shipped file parses, and its slots are distinct models with valid weights
//   2. the config hook rewrites every variant agent's model from the file, so the
//      injected config can disagree and still lose
//   3. a model missing from a provider's existing whitelist is appended to it,
//      since opencode deletes every model a provider offers that an allowlist
//      does not name (and a provider with no whitelist is left alone: absent
//      already means everything is allowed)
//   4. a missing or broken file degrades to the built-in defaults with a warning
//      instead of a pool that cannot route
//   5. slot count is data, not code: three slots route 1,2,3 and the fourth agent
//      name is simply absent
//   6. weight is a ceiling and a priority: the heaviest slot fills to its own weight
//      before the next slot starts, a bad weight warns and keeps the slot, and the
//      pre-weight `tier` spelling still maps to the weight it used to imply
//   7. the pool is capped at pool.MAX_SLOTS, because the injected agent set declares
//      one variant per base per slot and a bigger pool would route to nothing

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const MODELS = join(HERE, "..", "presets", "free-tier.json")
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")
const realCfg = () => shippedConfig()

// Each pool instance gets its own log buffer: warnOnce state is per instance, so
// sharing one buffer would let an earlier instance's warnings satisfy a later one.
const makeClient = () => {
  const lines = []
  return { lines, client: { app: { log: async ({ body }) => void lines.push(`${body.level} ${body.message}`) } } }
}
const pool = await import(join(HERE, "..", "src", "lib", "pool.ts"))
const { agentPoolHooks: AgentPool } = await import(PLUGIN)

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
}

const dir = mkdtempSync(join(tmpdir(), "pool-models-"))
const file = (name, content) => {
  const path = join(dir, name)
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content))
  return path
}

const apply = async (modelsFile, id) => {
  const { lines, client } = makeClient()
  const claims = mkdtempSync(join(dir, "claims-"))
  const hooks = await AgentPool({ client }, { id: id ?? String(Math.random()), dir: claims, modelsFile })
  const cfg = realCfg()
  await hooks.config(cfg)
  return {
    cfg,
    spawn: async (callID, requested = "explore", sessionID = "s1") => {
      const out = { args: { subagent_type: requested, prompt: "x" } }
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
      return out.args.subagent_type
    },
    lines,
    warned: () => lines.filter((l) => l.startsWith("warn")),
  }
}

const BASES = ["explore", "implement", "context"]

// 1. the shipped file is well formed
const shipped = JSON.parse(readFileSync(MODELS, "utf8"))
assert(Array.isArray(shipped.slots) && shipped.slots.length >= 2, "presets/free-tier.json must list at least two slots")
const ids = new Set()
shipped.slots.forEach((slot, i) => {
  assert(typeof slot.model === "string" && slot.model.includes("/"), `slot ${i + 1} needs a provider/model-id`)
  assert(typeof slot.weight === "number" && Number.isFinite(slot.weight), `slot ${i + 1} needs a numeric weight`)
  assert(slot.weight > 0 && slot.weight <= pool.MAX_WEIGHT, `slot ${i + 1} weight must be in (0, ${pool.MAX_WEIGHT}], got ${slot.weight}`)
  assert(!ids.has(slot.model), `slot ${i + 1} repeats ${slot.model}; slots must be distinct`)
  ids.add(slot.model)
})
// two providers at most half the pool, so one provider-wide limit cannot kill it
const providers = new Set(shipped.slots.map((s) => pool.providerOf(s.model)))
assert(providers.size >= 2, `the pool must span at least two providers, got ${[...providers].join(", ")}`)

// 2. a different file rewrites every variant agent, even against a config that
//    names different models and carries no whitelist entry for the new ones.
//    The fixture must name models the injected config has never heard of (that is
//    what proves auto-whitelisting), so it invents ids and borrows only the
//    provider names, which must exist in the config for the hook to touch them.
const [PROV_A, PROV_B] = [...providers]
const swapped = [
  { model: `${PROV_A}/fixture-primary-a`, weight: 2 },
  { model: `${PROV_B}/fixture-primary-b`, weight: 2 },
  { model: `${PROV_A}/fixture-overflow-c`, weight: 1 },
]
const a = await apply(file("swapped.json", { slots: swapped }))
for (const base of BASES) {
  swapped.forEach((slot, i) => {
    const variant = a.cfg.agent[`${base}-${i + 1}`]
    assert(variant, `${base}-${i + 1} must exist in the injected config`)
    assert(variant.model === slot.model, `${base}-${i + 1} must run ${slot.model} from the file, got ${variant.model}`)
  })
}

// 3. whitelisting is automatic on a provider that has one: without it opencode
//    deletes the model from the provider and the agent resolves to no model at
//    all. The fixture providers do carry whitelists, which is what makes this
//    the append path rather than the leave-alone path the story suite covers.
for (const slot of swapped) {
  const { provider, id } = pool.splitModel(slot.model)
  assert(a.cfg.provider[provider] !== undefined, `provider ${provider} must be configured in the fixture config`)
  assert(a.cfg.provider[provider].whitelist.includes(id), `${slot.model} must be whitelisted on ${provider}`)
}
assert(
  a.lines.some((l) => l.includes("whitelisted") && l.includes("fixture-primary-b")),
  `adding a model to a provider whitelist should be logged, got ${a.lines.join(" | ")}`,
)
// an already-whitelisted model is added exactly once: run the same file again and
// check no id is duplicated. Which model to use is the shipped file's business.
const second = await apply(file("swapped-again.json", { slots: swapped }), "swapped-again")
for (const slot of swapped) {
  const { provider, id } = pool.splitModel(slot.model)
  const seen = second.cfg.provider[provider].whitelist.filter((x) => x === id).length
  assert(seen <= 1, `${slot.model} must not be whitelisted twice, got ${seen}`)
}

// 4. a three-slot file routes only 1,2,3 -- the slot count is data, not code
const picks = []
for (let i = 0; i < 6; i++) picks.push((await a.spawn(`s${i}`)).replace("explore-", ""))
assert(new Set(picks).size === 3, `only three slots exist, got ${[...new Set(picks)].join(",")}`)
assert(!picks.includes("4"), "slot 4 does not exist in a three-slot file")

// 5. a missing file falls back to the built-in defaults rather than refusing to route
const missing = await apply(join(dir, "does-not-exist.json"), "missing")
assert(missing.warned().some((l) => l.includes("unreadable")), "a missing file should warn")
const fallbackPick = await missing.spawn("f1")
assert(fallbackPick === "explore-1", `defaults should still route, got ${fallbackPick}`)

// 6. individual bad entries are dropped with a warning; the good slots still route
// A bad weight is NOT in that set: it is preference only, so it warns and keeps the
// slot at weight 1 rather than throwing away a model. Two rejection rules are under
// test, each needing a distinct violation: a repeat of slot 1's model and a model
// with no provider prefix.
const GOOD_1 = `${PROV_A}/fixture-good-1`
const GOOD_2 = `${PROV_B}/fixture-good-2`
const GOOD_3 = `${PROV_B}/fixture-good-3`
const broken = await apply(
  file("broken.json", {
    slots: [
      { model: GOOD_1, weight: 2 },
      { model: GOOD_1, weight: 1 },
      { model: GOOD_2, weight: "heavy" },
      { model: GOOD_3, weight: 1 },
      { model: "fixture-no-provider", weight: 1 },
    ],
  }),
  "broken",
)
const warns = broken.warned().filter((l) => l.includes("presets/free-tier.json") || l.includes("slot "))
assert(warns.length === 3, `each bad entry should warn once, got ${warns.length}: ${warns.join(" | ")}`)
assert(warns.some((l) => l.includes("weight must be a number")), `a bad weight should warn, got ${warns.join(" | ")}`)
// the model behind the bad weight survives, only its preference is lost
assert(
  broken.cfg.agent["explore-2"].model === GOOD_2,
  `a slot with a bad weight must still route, got ${broken.cfg.agent["explore-2"].model}`,
)
for (const base of BASES) {
  assert(broken.cfg.agent[`${base}-1`].model === GOOD_1, `slot 1 must run the first valid entry, got ${broken.cfg.agent[`${base}-1`].model}`)
  assert(broken.cfg.agent[`${base}-2`].model === GOOD_2, `slot 2 must run the entry with the bad weight, got ${broken.cfg.agent[`${base}-2`].model}`)
  assert(broken.cfg.agent[`${base}-3`].model === GOOD_3, `slot 3 must run the third valid entry, got ${broken.cfg.agent[`${base}-3`].model}`)
}

// 7. weight is a ceiling AND a priority. The heaviest slot must take all of its own
//    spawns before the lighter one sees any, then both overflow evenly -- which is what
//    a main model "3 sessions to itself" means. Measured by spawns, because the claim
//    files pool_status reads are exactly those spawns.
const HEAVY = `${PROV_A}/fixture-weight-heavy`
const LIGHT = `${PROV_B}/fixture-weight-light`
const weighted = await apply(file("weighted.json", { slots: [{ model: HEAVY, weight: 3 }, { model: LIGHT, weight: 1 }] }), "weighted")
const HEAVY_CEILING = 3
const tally = { [HEAVY]: 0, [LIGHT]: 0 }
const tallyPick = async (callID) => {
  const slot = (await weighted.spawn(callID)).replace("explore-", "")
  tally[slot === "1" ? HEAVY : LIGHT]++
  return slot
}
for (let i = 0; i < HEAVY_CEILING; i++) {
  const slot = await tallyPick(`w${i}`)
  assert(slot === "1", `spawn ${i + 1} must go to the weight-3 slot before the weight-1 slot is touched, got slot ${slot}`)
}
// the ceiling is a ceiling: the heavy slot holds no more than its weight until the
// light one has caught up
const SPILL = 3
for (let i = HEAVY_CEILING; i < HEAVY_CEILING + SPILL; i++) {
  await tallyPick(`w${i}`)
  assert(
    tally[HEAVY] <= HEAVY_CEILING + 1,
    `the weight-3 slot must stop at its ceiling while the weight-1 slot has room, got ${tally[HEAVY]}/${HEAVY_CEILING} vs ${tally[LIGHT]}`,
  )
}
// past every ceiling the overflow equalises rather than piling on the heavy slot
const heavyShare = tally[HEAVY] / (HEAVY_CEILING + SPILL)
assert(
  heavyShare < 0.8 && heavyShare > 0.3,
  `the overflow must spread rather than pile on the heavy slot, got ${tally[HEAVY]} heavy vs ${tally[LIGHT]} light`,
)
// and the config hook reports the weights it bound, so a typo is visible in the log
assert(
  weighted.lines.some((l) => l.includes(`1=${HEAVY} w3`) && l.includes(`2=${LIGHT} w1`)),
  `the bind log should name each slot's weight, got ${weighted.lines.join(" | ")}`,
)

// 8. the pre-weight `tier` spelling still works, so a host that has not picked up
//    this file keeps its headroom instead of silently flattening every slot to
//    weight 1 -- and says so once per distinct value
const legacy = await apply(
  file("legacy.json", { slots: [{ model: `${PROV_A}/fixture-legacy-a`, tier: "primary" }, { model: `${PROV_B}/fixture-legacy-b`, tier: "overflow" }] }),
  "legacy",
)
const legacyWarns = legacy.warned().filter((l) => l.includes("tier") && l.includes("deprecated"))
assert(legacyWarns.length === 2, `each distinct legacy tier should warn once, got ${legacyWarns.length}: ${legacyWarns.join(" | ")}`)
assert(
  legacy.lines.some((l) => l.includes(`1=${PROV_A}/fixture-legacy-a w2`) && l.includes(`2=${PROV_B}/fixture-legacy-b w1`)),
  `primary must bind as weight 2 and overflow as weight 1, got ${legacy.lines.join(" | ")}`,
)

// 9. the pool is capped: the injected config declares exactly one variant per base per
//    slot, so a longer file would route spawns at agents that do not exist. Both
//    halves of that are checked -- the extra entries are dropped with a warning,
//    and the shipped file is not over the cap.
const overCap = await apply(
  file("over-cap.json", { slots: Array.from({ length: pool.MAX_SLOTS + 2 }, (_, i) => ({ model: `${PROV_A}/fixture-cap-${i + 1}`, weight: 1 })) }),
  "over-cap",
)
const capWarns = overCap.warned().filter((l) => l.includes("capped"))
assert(capWarns.length === 2, `each ignored entry past the cap should warn, got ${capWarns.length}: ${capWarns.join(" | ")}`)
const capPicks = []
for (let i = 0; i < pool.MAX_SLOTS * 2; i++) capPicks.push((await overCap.spawn(`c${i}`)).replace("explore-", ""))
assert(
  new Set(capPicks).size === pool.MAX_SLOTS && !capPicks.includes(String(pool.MAX_SLOTS + 1)),
  `only the first ${pool.MAX_SLOTS} slots may route, got ${[...new Set(capPicks)].join(",")}`,
)
assert(shipped.slots.length <= pool.MAX_SLOTS, `presets/free-tier.json lists ${shipped.slots.length} slots, over the ${pool.MAX_SLOTS} cap`)
const shippedVariants = Object.keys(realCfg().agent).filter((n) => /-[5-9]$/.test(n))
assert(shippedVariants.length === 0, `the injected config must not declare a variant beyond the cap, got ${shippedVariants.join(", ")}`)

// 10. the injected config declares the variants with no model at all: the hook is the
//    only thing that puts one there, so there is nothing left to fall out of sync
const declared = realCfg()
for (const base of BASES) {
  for (let i = 1; i <= shipped.slots.length; i++) {
    assert(declared.agent[`${base}-${i}`] !== undefined, `${base}-${i} must be declared`)
    assert(declared.agent[`${base}-${i}`].model === undefined, `${base}-${i} must not hard-code a model`)
  }
}
// and exactly one per slot: an extra variant would be an agent the pool never binds
// a model to, so it would silently inherit the session's
for (const base of BASES) {
  const variants = Object.keys(declared.agent).filter((n) => new RegExp(`^${base}-[0-9]+$`).test(n))
  assert(variants.length === shipped.slots.length, `${base} must declare exactly ${shipped.slots.length} pool variants, got ${variants.join(", ")}`)
}

// 11. the real file drives the real config unchanged
const live = await apply(MODELS, "live")
shipped.slots.forEach((slot, i) => {
  for (const base of BASES) {
    assert(live.cfg.agent[`${base}-${i + 1}`].model === slot.model, `${base}-${i + 1} must run ${slot.model}`)
  }
})
// and nothing is routed to a variant the injected config does not define
for (let i = 1; i <= shipped.slots.length; i++) {
  for (const base of BASES) assert(live.cfg.agent[`${base}-${i}`], `${base}-${i} must exist for slot ${i} of ${shipped.slots.length}`)
}

// 8. the flat pool.txt format: `model [weight]` per line, comments/blanks ignored
{
  const parsed = pool.parseTextSlots(
    "# my pool\nopencode-go/longcat-2.5-preview-free 3\n\nopencode/space-bunny-free 2   # the fast one\nopencode/big-pickle\n",
    "pool.txt",
  )
  assert(parsed.slots.length === 3, `flat file: expected 3 slots, got ${parsed.slots.length}`)
  assert(parsed.slots[0].model === "opencode-go/longcat-2.5-preview-free" && parsed.slots[0].weight === 3, `slot 1: ${JSON.stringify(parsed.slots[0])}`)
  assert(parsed.slots[1].weight === 2, `a trailing comment must not break the weight: ${JSON.stringify(parsed.slots[1])}`)
  assert(parsed.slots[2].weight === 1, `an absent weight must default to 1: ${JSON.stringify(parsed.slots[2])}`)
  assert(parsed.slots.every((s, i) => s.index === i + 1), "indices are array position")
}

// ...and any slot file the loader reads accepts flat OR JSON (auto-detected by a leading "{")
{
  const flat = file("flat-pool.txt", "opencode-go/a 2\nopencode/b\n")
  const resolved = pool.resolveModels({ modelsFile: flat })
  assert(resolved.slots.length === 2 && resolved.slots[0].model === "opencode-go/a" && resolved.slots[0].weight === 2, `flat modelsFile: ${JSON.stringify(resolved.slots)}`)
  assert(resolved.origin === flat, "origin must be the file")

  const json = file("obj-pool.json", { slots: [{ model: "opencode-go/a", weight: 2 }] })
  const resolvedJson = pool.resolveModels({ modelsFile: json })
  assert(resolvedJson.slots.length === 1 && resolvedJson.slots[0].model === "opencode-go/a", `JSON still works: ${JSON.stringify(resolvedJson.slots)}`)
}

rmSync(dir, { recursive: true, force: true })
console.log("\nALL POOL-MODEL CHECKS PASSED")