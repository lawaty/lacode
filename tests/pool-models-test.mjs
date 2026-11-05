// presets/free-tier.json is the one file a user edits to change which models the pool
// runs, and what share of the work each one takes. This suite drives the config
// hook against temporary copies of that file and against the injected config
// (fixtures/config.mjs: the fixture provider block plus the package's own agent
// set), proving:
//
//   1. the shipped file parses, and its slots have valid weights
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
//   6. weight is a slot's active-session budget: capacity is the sum of the weights,
//      one pass fills each usable slot to its weight in declaration order, a bad
//      weight warns and keeps the slot, and the pre-weight `tier` spelling still
//      maps to its implied weight
//   7. the pool has no slot cap: a longer file routes every slot, and the watcher
//      declares the variant an older config did not carry

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
    status: async () => (await hooks.tool.pool_status.execute({}, {})).output,
    lines,
    warned: () => lines.filter((l) => l.startsWith("warn")),
  }
}

const BASES = ["explore", "implement", "context"]

// 1. the shipped file is well formed
const shipped = JSON.parse(readFileSync(MODELS, "utf8"))
assert(Array.isArray(shipped.slots) && shipped.slots.length >= 2, "presets/free-tier.json must list at least two slots")
shipped.slots.forEach((slot, i) => {
  assert(typeof slot.model === "string" && slot.model.includes("/"), `slot ${i + 1} needs a provider/model-id`)
  assert(typeof slot.weight === "number" && Number.isFinite(slot.weight), `slot ${i + 1} needs a numeric weight`)
  assert(slot.weight > 0 && slot.weight <= pool.MAX_WEIGHT, `slot ${i + 1} weight must be in (0, ${pool.MAX_WEIGHT}], got ${slot.weight}`)
})
// two providers at most half the pool, so one provider-wide limit cannot kill it
const providers = new Set(shipped.slots.map((s) => pool.providerOf(s.model)))
assert(providers.size >= 2, `the pool must span at least two providers, got ${[...providers].join(", ")}`)

// no two slots share a model family, so one withdrawal cannot empty the pool.
// Two slots of the same model on two providers is not diversity: the model is
// withdrawn once, both slots go, and the pool is half a pool.
const familyOf = (model) => model.split("/")[1].replace(/-free$/, "").split(/-\d/)[0]
const families = new Set()
for (const slot of shipped.slots) {
  const family = familyOf(slot.model)
  assert(!families.has(family), `two slots share the "${family}" family; one withdrawal would empty the pool`)
  families.add(family)
}

// The built-in fallback is the SAME slot table as the shipped preset. It only
// fires when no pool source is readable, but "the bundled preset is what you
// get" stops being true the moment the two drift -- and they have drifted once
// already (36a3bdd, Longcat -> Step 5 Preview). It is also where a withdrawn
// model hides longest: the fallback is what a user with no pool file and an
// unreadable preset gets, so a dead model there is a pool of one dead model.
const fallback = pool.FALLBACK_SLOTS.map((s) => `${s.model} ${s.weight}`).join(" | ")
const preset = shipped.slots.map((s) => `${s.model} ${s.weight}`).join(" | ")
assert(fallback === preset, `FALLBACK_SLOTS must be the shipped preset's slot table.\n  fallback: ${fallback}\n  preset:   ${preset}`)

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

// 6. individual bad entries are handled without dropping the good slots. A bad weight
// is NOT a rejection: it is share, not validity, so it warns and keeps the slot at
// weight 1. A repeated model is valid too -- each line is its own slot. The one
// rejection under test is a model with no provider prefix.
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
assert(warns.length === 2, `each bad entry should warn once (the repeated model is valid now), got ${warns.length}: ${warns.join(" | ")}`)
assert(warns.some((l) => l.includes("weight must be a number")), `a bad weight should warn, got ${warns.join(" | ")}`)
assert(warns.some((l) => l.includes("provider/model-id")), `a model with no provider must warn, got ${warns.join(" | ")}`)
// A repeated model gets its own slot; a bad weight keeps the model at weight 1.
for (const base of BASES) {
  assert(broken.cfg.agent[`${base}-1`].model === GOOD_1, `slot 1 must run the first entry, got ${broken.cfg.agent[`${base}-1`].model}`)
  assert(broken.cfg.agent[`${base}-2`].model === GOOD_1, `a repeated model must get its own slot, got ${broken.cfg.agent[`${base}-2`].model}`)
  assert(broken.cfg.agent[`${base}-3`].model === GOOD_2, `slot 3 must run the entry with the bad weight, got ${broken.cfg.agent[`${base}-3`].model}`)
  assert(broken.cfg.agent[`${base}-4`].model === GOOD_3, `slot 4 must run the third valid entry, got ${broken.cfg.agent[`${base}-4`].model}`)
}

// 7. weight is a slot's active-session budget and the pool's capacity is the sum of
//    the weights. Routing is ONE pass in declaration order: the weight-3 slot fills to
//    3 before the weight-1 slot gets any; past that the pool is at capacity and
//    overflow goes to the least-loaded slot. Measured by spawns, because the claim
//    files pool_status reads are exactly those spawns.
const HEAVY = `${PROV_A}/fixture-weight-heavy`
const LIGHT = `${PROV_B}/fixture-weight-light`
const HEAVY_WEIGHT = 3
const LIGHT_WEIGHT = 1
const weighted = await apply(file("weighted.json", { slots: [{ model: HEAVY, weight: HEAVY_WEIGHT }, { model: LIGHT, weight: LIGHT_WEIGHT }] }), "weighted")
const RUN = ["1", "1", "1", "2"]
const WEIGHTED = RUN.length
assert(
  pool.slotCeiling({ weight: HEAVY_WEIGHT }) === HEAVY_WEIGHT &&
    pool.slotCeiling({ weight: LIGHT_WEIGHT }) === LIGHT_WEIGHT,
  `a slot's cap must be its weight (${HEAVY_WEIGHT} and ${LIGHT_WEIGHT} here), got ${pool.slotCeiling({ weight: HEAVY_WEIGHT })} and ${pool.slotCeiling({ weight: LIGHT_WEIGHT })}`,
)
const tally = { [HEAVY]: 0, [LIGHT]: 0 }
const tallyPick = async (callID) => {
  const slot = (await weighted.spawn(callID)).replace("explore-", "")
  tally[slot === "1" ? HEAVY : LIGHT]++
  return slot
}
// ONE PASS: the first slot's whole budget of 3 claims comes before the weight-1 slot,
// because declaration order, not weight, sets preference.
for (let i = 0; i < WEIGHTED; i++) {
  const slot = Number(await tallyPick(`w${i}`))
  assert(slot === Number(RUN[i]), `spawn ${i + 1} must take position ${i} of the fill order (slot ${RUN[i]}), got slot ${slot}`)
}
assert(
  tally[HEAVY] === HEAVY_WEIGHT && tally[LIGHT] === LIGHT_WEIGHT,
  `${WEIGHTED} spawns must stand each slot at its weight, got ${tally[HEAVY]}/${HEAVY_WEIGHT} heavy vs ${tally[LIGHT]}/${LIGHT_WEIGHT} light`,
)
// pool_status reports the weight as the denominator, marking a slot FULL at it
const weightedStatus = await weighted.status()
for (const [model, weight] of [
  [HEAVY, HEAVY_WEIGHT],
  [LIGHT, LIGHT_WEIGHT],
]) {
  assert(
    new RegExp(`slot \\d+ w${weight}\\s+${model}\\s+load=${weight}/${weight} FULL`).test(weightedStatus),
    `status should report ${model} at load=${weight}/${weight} FULL (a weight-${weight} slot's cap is its weight), got:\n${weightedStatus}`,
  )
}
// OVERFLOW: every slot is at its weight, so the pick goes to the least-loaded one.
const SPILL = 2
const spill = []
for (let i = 0; i < SPILL; i++) spill.push(await tallyPick(`x${i}`))
assert(
  spill.every((slot) => slot === "2") && tally[HEAVY] === HEAVY_WEIGHT,
  `past capacity the overflow must go to the least-loaded slot, not pile on the weight-3 slot, got ${spill.join(",")} after ${tally[HEAVY]}/${HEAVY_WEIGHT} heavy vs ${tally[LIGHT]}/${LIGHT_WEIGHT} light`,
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

// 9. the pool has no slot cap: a longer file routes every slot, and the watcher
//    declares the variant an older injected config did not carry.
const BIG = 6
const many = await apply(
  file("many-slots.json", { slots: Array.from({ length: BIG }, (_, i) => ({ model: `${PROV_A}/fixture-cap-${i + 1}`, weight: 1 })) }),
  "many-slots",
)
assert(many.warned().filter((l) => l.includes("capped")).length === 0, "the pool must not warn about a slot cap")
const manyPicks = []
for (let i = 0; i < BIG * 2; i++) manyPicks.push((await many.spawn(`c${i}`)).replace("explore-", ""))
assert(
  new Set(manyPicks).size === BIG && !manyPicks.includes(String(BIG + 1)),
  `every one of the ${BIG} slots may route, got ${[...new Set(manyPicks)].join(",")}`,
)
for (let i = 1; i <= BIG; i++) {
  assert(many.cfg.agent[`explore-${i}`], `variant explore-${i} must exist for slot ${i}`)
}

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
    "# my pool\nopencode-go/minimax-m3.1-flash-free 3\n\nopencode/deepseek-v4.1-flash-free 2   # the fast one\nopencode/big-pickle\n",
    "pool.txt",
  )
  assert(parsed.slots.length === 3, `flat file: expected 3 slots, got ${parsed.slots.length}`)
  assert(parsed.slots[0].model === "opencode-go/minimax-m3.1-flash-free" && parsed.slots[0].weight === 3, `slot 1: ${JSON.stringify(parsed.slots[0])}`)
  assert(parsed.slots[1].weight === 2, `a trailing comment must not break the weight: ${JSON.stringify(parsed.slots[1])}`)
  assert(parsed.slots[2].weight === 1, `an absent weight must default to 1: ${JSON.stringify(parsed.slots[2])}`)
  assert(parsed.slots.every((s, i) => s.index === i + 1), "indices are array position")
}

// ...and omniroute gateway ids survive that parse: everything after the FIRST slash is
// the model id, so omniroute's own prefix is never mistaken for a provider. A plain
// gateway id ("auto") and a vendor-prefixed live id ("openrouter/google/...") split
// the same way, and the weight still comes from the line.
{
  const parsed = pool.parseTextSlots("omniroute/auto 3\nomniroute/openrouter/google/gemini-4-argon 2\n", "omniroute.txt")
  assert(parsed.slots.length === 2, `omniroute file: expected 2 slots, got ${parsed.slots.length}`)
  const auto = pool.splitModel(parsed.slots[0].model)
  assert(auto.provider === "omniroute" && auto.id === "auto", `omniroute/auto must split to provider omniroute, id auto, got ${JSON.stringify(auto)}`)
  assert(parsed.slots[0].weight === 3, `omniroute/auto must carry weight 3, got ${parsed.slots[0].weight}`)
  const live = pool.splitModel(parsed.slots[1].model)
  assert(
    live.provider === "omniroute" && live.id === "openrouter/google/gemini-4-argon",
    `a multi-segment id must split on the FIRST slash only, got ${JSON.stringify(live)}`,
  )
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

// --- US-34: notify parsing and announcesReset --------------------------------
{
  // 1. "notify": false in JSON -> false; missing notify on opencode/bar -> true.
  const parsedFalse = pool.parseSlots({ slots: [{ model: "opencode/foo", notify: false }] }, "test.json")
  assert(parsedFalse.slots.length === 1, "[US-34] notify false JSON must produce one slot")
  assert(parsedFalse.slots[0].notify === false, `[US-34] "notify": false in JSON -> slot.notify === false, got ${parsedFalse.slots[0].notify}`)

  const parsedMissing = pool.parseSlots({ slots: [{ model: "opencode/bar" }] }, "test.json")
  assert(parsedMissing.slots[0].notify === true, `[US-34] missing notify on opencode/bar -> true, got ${parsedMissing.slots[0].notify}`)

  // 2. missing notify on groq/bar -> false.
  const parsedMissingGroq = pool.parseSlots({ slots: [{ model: "groq/bar" }] }, "test.json")
  assert(parsedMissingGroq.slots[0].notify === false, `[US-34] missing notify on groq/bar -> false, got ${parsedMissingGroq.slots[0].notify}`)

  // 3. "notify": "off" on opencode/baz -> false; "notify": "yes" -> true.
  const parsedOff = pool.parseSlots({ slots: [{ model: "opencode/baz", notify: "off" }] }, "test.json")
  assert(parsedOff.slots[0].notify === false, `[US-34] "notify": "off" on opencode/baz -> false, got ${parsedOff.slots[0].notify}`)
  const parsedYes = pool.parseSlots({ slots: [{ model: "opencode/qux", notify: "yes" }] }, "test.json")
  assert(parsedYes.slots[0].notify === true, `[US-34] "notify": "yes" -> true, got ${parsedYes.slots[0].notify}`)

  // 4. "notify": "on" on groq/baz -> true.
  const parsedOnGroq = pool.parseSlots({ slots: [{ model: "groq/baz", notify: "on" }] }, "test.json")
  assert(parsedOnGroq.slots[0].notify === true, `[US-34] "notify": "on" on groq/baz -> true, got ${parsedOnGroq.slots[0].notify}`)

  // 5. invalid "notify": "maybe" on opencode/bad -> true and problems mention notify.
  const parsedBad = pool.parseSlots({ slots: [{ model: "opencode/bad", notify: "maybe" }] }, "test.json")
  assert(parsedBad.slots[0].notify === true, `[US-34] invalid "notify": "maybe" on opencode/bad -> true, got ${parsedBad.slots[0].notify}`)
  assert(parsedBad.problems.some((p) => p.includes("notify")), `[US-34] invalid notify problems must mention notify, got ${parsedBad.problems.join(" | ")}`)

  // 6. invalid "notify": "maybe" on groq/bad -> false and problems mention notify.
  const parsedBadGroq = pool.parseSlots({ slots: [{ model: "groq/bad", notify: "maybe" }] }, "test.json")
  assert(parsedBadGroq.slots[0].notify === false, `[US-34] invalid "notify": "maybe" on groq/bad -> false, got ${parsedBadGroq.slots[0].notify}`)
  assert(parsedBadGroq.problems.some((p) => p.includes("notify")), `[US-34] invalid notify problems must mention notify, got ${parsedBadGroq.problems.join(" | ")}`)

  // 7. flat text: keep opencode/foo notify:off -> false and opencode/bar 2 b:shared notify:off -> weight 2/bucket shared/false; add groq/foo (no token) -> false, opencode/foo (no token) -> true, groq/foo notify:on -> true.
  const flat1 = pool.parseTextSlots("opencode/foo notify:off", "pool.txt")
  assert(flat1.slots[0].notify === false, `[US-34] flat opencode/foo notify:off -> false, got ${flat1.slots[0].notify}`)
  const flat2 = pool.parseTextSlots("opencode/bar 2 b:shared notify:off", "pool.txt")
  assert(flat2.slots[0].weight === 2, `[US-34] flat weight 2 with tokens, got ${flat2.slots[0].weight}`)
  assert(flat2.slots[0].bucket === "shared", `[US-34] flat bucket shared, got ${flat2.slots[0].bucket}`)
  assert(flat2.slots[0].notify === false, `[US-34] flat notify false with other tokens, got ${flat2.slots[0].notify}`)
  const flat3 = pool.parseTextSlots("opencode/baz notify:off 2", "pool.txt")
  assert(flat3.slots[0].weight === 2, `[US-34] token order p/m notify:off 2 still weight 2, got ${flat3.slots[0].weight}`)
  assert(flat3.slots[0].notify === false, `[US-34] token order notify still false, got ${flat3.slots[0].notify}`)
  const flatGroqNoToken = pool.parseTextSlots("groq/foo", "pool.txt")
  assert(flatGroqNoToken.slots[0].notify === false, `[US-34] flat groq/foo (no token) -> false, got ${flatGroqNoToken.slots[0].notify}`)
  const flatOpencodeNoToken = pool.parseTextSlots("opencode/foo", "pool.txt")
  assert(flatOpencodeNoToken.slots[0].notify === true, `[US-34] flat opencode/foo (no token) -> true, got ${flatOpencodeNoToken.slots[0].notify}`)
  const flatGroqOn = pool.parseTextSlots("groq/foo notify:on", "pool.txt")
  assert(flatGroqOn.slots[0].notify === true, `[US-34] flat groq/foo notify:on -> true, got ${flatGroqOn.slots[0].notify}`)

  // 8. announcesReset: mix(false+true) -> true; all-false -> false; empty opencode/z -> true; empty groq/z -> false; groq slot notify:true -> true.
  const slotsMix = [
    { index: 1, model: "opencode/x", weight: 1, notify: false },
    { index: 2, model: "opencode/x", weight: 1, notify: true },
  ]
  assert(pool.announcesReset(slotsMix, "opencode/x") === true, "[US-34] announcesReset mix (false+true) -> true")
  const slotsAllFalse = [
    { index: 1, model: "opencode/y", weight: 1, notify: false },
    { index: 2, model: "opencode/y", weight: 1, notify: false },
  ]
  assert(pool.announcesReset(slotsAllFalse, "opencode/y") === false, "[US-34] announcesReset all false -> false")
  assert(pool.announcesReset([], "opencode/z") === true, "[US-34] announcesReset empty opencode/z -> true")
  assert(pool.announcesReset([], "groq/z") === false, "[US-34] announcesReset empty groq/z -> false")
  const slotsGroqOn = [{ index: 1, model: "groq/z", weight: 1, notify: true }]
  assert(pool.announcesReset(slotsGroqOn, "groq/z") === true, "[US-34] announcesReset groq slot notify:true -> true")
}

import { test } from "node:test"

test("[US-34] notify parsing and announcesReset in pool-models-test", () => {
  // already asserted above in the script style; repeat minimal checks via imported API
  const parsedFalse = pool.parseSlots({ slots: [{ model: "opencode/foo", notify: false }] }, "test.json")
  assert(parsedFalse.slots[0].notify === false, "[US-34] parsedFalse notify === false")
  const parsedMissing = pool.parseSlots({ slots: [{ model: "opencode/bar" }] }, "test.json")
  assert(parsedMissing.slots[0].notify === true, "[US-34] parsedMissing notify === true")
  const parsedMissingGroq = pool.parseSlots({ slots: [{ model: "groq/bar" }] }, "test.json")
  assert(parsedMissingGroq.slots[0].notify === false, "[US-34] parsedMissingGroq notify === false")
  const parsedOff = pool.parseSlots({ slots: [{ model: "opencode/baz", notify: "off" }] }, "test.json")
  assert(parsedOff.slots[0].notify === false, "[US-34] parsedOff notify === false")
  const parsedOnGroq = pool.parseSlots({ slots: [{ model: "groq/baz", notify: "on" }] }, "test.json")
  assert(parsedOnGroq.slots[0].notify === true, "[US-34] parsedOnGroq notify === true")
  const parsedBad = pool.parseSlots({ slots: [{ model: "opencode/bad", notify: "maybe" }] }, "test.json")
  assert(parsedBad.slots[0].notify === true, "[US-34] parsedBad notify === true")
  assert(parsedBad.problems.some((p) => p.includes("notify")))
  const parsedBadGroq = pool.parseSlots({ slots: [{ model: "groq/bad", notify: "maybe" }] }, "test.json")
  assert(parsedBadGroq.slots[0].notify === false, "[US-34] parsedBadGroq notify === false")
  assert(parsedBadGroq.problems.some((p) => p.includes("notify")))
  const flat1 = pool.parseTextSlots("opencode/foo notify:off", "pool.txt")
  assert(flat1.slots[0].notify === false, "[US-34] flat1 notify === false")
  const flatGroqNoToken = pool.parseTextSlots("groq/foo", "pool.txt")
  assert(flatGroqNoToken.slots[0].notify === false, "[US-34] flatGroqNoToken notify === false")
  const flatOpencodeNoToken = pool.parseTextSlots("opencode/foo", "pool.txt")
  assert(flatOpencodeNoToken.slots[0].notify === true, "[US-34] flatOpencodeNoToken notify === true")
  const flatGroqOn = pool.parseTextSlots("groq/foo notify:on", "pool.txt")
  assert(flatGroqOn.slots[0].notify === true, "[US-34] flatGroqOn notify === true")
  const slotsMix = [
    { index: 1, model: "opencode/x", weight: 1, notify: false },
    { index: 2, model: "opencode/x", weight: 1, notify: true },
  ]
  assert(pool.announcesReset(slotsMix, "opencode/x") === true, "[US-34] announcesReset mix === true")
  const slotsAllFalse = [
    { index: 1, model: "opencode/y", weight: 1, notify: false },
    { index: 2, model: "opencode/y", weight: 1, notify: false },
  ]
  assert(pool.announcesReset(slotsAllFalse, "opencode/y") === false, "[US-34] announcesReset allFalse === false")
  assert(pool.announcesReset([], "opencode/z") === true, "[US-34] announcesReset empty opencode === true")
  assert(pool.announcesReset([], "groq/z") === false, "[US-34] announcesReset empty groq === false")
  const slotsGroqOn = [{ index: 1, model: "groq/z", weight: 1, notify: true }]
  assert(pool.announcesReset(slotsGroqOn, "groq/z") === true, "[US-34] announcesReset groq notify:true === true")
})

rmSync(dir, { recursive: true, force: true })
console.log("\nALL POOL-MODEL CHECKS PASSED")