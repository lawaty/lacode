import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const pool = await import(join(HERE, "..", "src", "lib", "pool.ts"))

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
}

const freshDir = (label) => mkdtempSync(join(tmpdir(), `lacode-pool-tpm-${label}-`))

// --- Existing parse/slot-signature/pick checks (must keep working) ---

// Text: sub-threshold TPM dropped.
{
  const { slots, problems } = pool.parseTextSlots("a/b 1 c:131072 tpm:8000\n", "test")
  assert(slots.length === 0 || slots === pool.FALLBACK_SLOTS, `sub-threshold tpm slot must be dropped/fallback, got ${slots.length}`)
  assert(slots === pool.FALLBACK_SLOTS, "only sub-threshold tpm slot must resolve to FALLBACK_SLOTS")
  const mentioned = problems.some((p) => /a\/b/.test(p) && /tpm 8000/.test(p) && /20000-token\/minute minimum/.test(p) && /dropping/i.test(p))
  assert(mentioned, `problems must mention dropped tpm 8000, got ${JSON.stringify(problems)}`)
  console.log("text tpm:8000 dropped ok")
}

// Text: threshold TPM kept.
{
  const { slots } = pool.parseTextSlots("c/d 1 c:131072 tpm:20000\n", "test")
  assert(slots.length === 1 && slots[0].model === "c/d" && slots[0].tpm === 20000, "tpm 20000 must be kept")
  console.log("text tpm:20000 kept ok")
}

// Text: unknown tpm kept.
{
  const { slots, problems } = pool.parseTextSlots("e/f 1 c:131072\n", "test")
  assert(slots.length === 1 && slots[0].tpm === undefined, "unknown tpm must be undefined")
  assert(!problems.some((p) => /tpm/i.test(p)), `no tpm problems expected: ${JSON.stringify(problems)}`)
  console.log("text unknown tpm kept ok")
}

// JSON: sub-threshold dropped and threshold kept.
{
  const { slots, problems } = pool.parseSlots(
    { slots: [{ model: "a/b", context: 131072, tpm: 8000 }, { model: "c/d", context: 131072, tpm: 20000 }] },
    "test",
  )
  assert(slots.length === 1 && slots[0].model === "c/d" && slots[0].tpm === 20000, "JSON survivor must be c/d@20000")
  assert(problems.some((p) => /a\/b/.test(p) && /dropping/i.test(p)), "JSON drop problem expected")
  console.log("JSON tpm drop/keep ok")
}

// JSON: unknown tpm kept.
{
  const { slots } = pool.parseSlots({ slots: [{ model: "a/b", context: 131072 }] }, "test")
  assert(slots.length === 1 && slots[0].tpm === undefined, "JSON unknown tpm must be undefined")
  console.log("JSON unknown tpm kept ok")
}

// slotSignature changes when tpm changes.
{
  const dir = freshDir("sig")
  try {
    const base = { inlineModels: { slots: [{ model: "a/b", weight: 1, context: 131072, tpm: 20000 }] }, dir, id: "sig" }
    const s = pool.state(base)
    pool.init(s, () => {})
    pool.ensureSlots(s, () => {})
    const before = pool.reloadSlots(s, () => {})
    assert(before.changed === false, "reload with same slots must not change")
    s.inlineModels = { slots: [{ model: "a/b", weight: 1, context: 131072, tpm: 30000 }] }
    const after = pool.reloadSlots(s, () => {})
    assert(after.changed === true, "reload with different tpm must change")
    assert(after.slots[0].tpm === 30000, `new tpm must be 30000, got ${after.slots[0].tpm}`)
    console.log("slotSignature tpm change ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// pickSlot TPM budget (hand-built slots bypass parse validation).
{
  const tpmLimited = { index: 1, model: "unit/tpm-limited", weight: 1, context: 131072, tpm: 8000 }
  const large = { index: 2, model: "unit/large", weight: 1, context: 131072 }
  const state = { slots: [tpmLimited, large], catalog: new Map() }
  const snap = { counts: new Map(), cooling: new Map(), siblings: [], own: new Map(), dirReady: true }
  assert(pool.pickSlot(state, snap, 30000).model === "unit/large", "neededContext 30000 must skip tpm-limited")
  assert(pool.pickSlot(state, snap, 5000).model === "unit/tpm-limited", "neededContext 5000 must pick tpm-limited")
  console.log("pickSlot TPM budget ok")
}

// --- New learned TPM runtime checks (plan steps 3) ---

// noteTpm(s, "unit/small", 8000) writes learned-tpm.json, returns true, removes model from s.slots.
{
  const dir = freshDir("note-small")
  try {
    mkdirSync(dir, { recursive: true })
    const s = pool.state({
      id: "small",
      dir,
      models: { slots: [{ model: "unit/small", weight: 1, context: 131072 }, { model: "unit/ok", weight: 1, context: 131072 }] },
    })
    pool.init(s, () => {})
    pool.ensureSlots(s, () => {})
    assert(s.slots.some((x) => x.model === "unit/small"), "unit/small must exist before noteTpm")
    const dropped = pool.noteTpm(s, "unit/small", 8000)
    assert(dropped === true, `noteTpm small must return true, got ${dropped}`)
    assert(!s.slots.some((x) => x.model === "unit/small"), "unit/small must be removed from live slots")
    assert(s.slots.some((x) => x.model === "unit/ok"), "unit/ok must remain")
    const learnedPath = join(dir, pool.LEARNED_TPM_FILE)
    assert(existsSync(learnedPath), "learned-tpm.json must be written")
    const map = JSON.parse(readFileSync(learnedPath, "utf8"))
    assert(map["unit/small"] === 8000, `learned-tpm.json must map unit/small->8000, got ${JSON.stringify(map)}`)
    console.log("noteTpm small drops+writes ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A NEW state with same dir + ensureSlots drops the learned-small model.
{
  const dir = freshDir("persist-small")
  try {
    mkdirSync(dir, { recursive: true })
    const s1 = pool.state({
      id: "s1",
      dir,
      models: { slots: [{ model: "unit/small", weight: 1, context: 131072 }, { model: "unit/ok", weight: 1, context: 131072 }] },
    })
    pool.init(s1, () => {})
    pool.ensureSlots(s1, () => {})
    assert(pool.noteTpm(s1, "unit/small", 8000) === true, "precondition: noteTpm writes small")

    const s2 = pool.state({
      id: "s2",
      dir,
      models: { slots: [{ model: "unit/small", weight: 1, context: 131072 }, { model: "unit/ok", weight: 1, context: 131072 }] },
    })
    pool.init(s2, () => {})
    pool.ensureSlots(s2, () => {})
    assert(!s2.slots.some((x) => x.model === "unit/small"), "new state ensureSlots must drop learned-small")
    assert(s2.slots.some((x) => x.model === "unit/ok"), "new state must keep unit/ok")
    console.log("persisted learned-small dropped on ensureSlots ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// noteTpm(s, "unit/large", 40000) keeps slot and sets tpm to 40000 (or min with existing).
{
  const dir = freshDir("note-large")
  try {
    mkdirSync(dir, { recursive: true })
    const s = pool.state({
      id: "large",
      dir,
      models: { slots: [{ model: "unit/large", weight: 1, context: 131072, tpm: 60000 }, { model: "unit/other", weight: 1, context: 131072 }] },
    })
    pool.init(s, () => {})
    pool.ensureSlots(s, () => {})
    const dropped = pool.noteTpm(s, "unit/large", 40000)
    assert(dropped === false, `noteTpm large must return false, got ${dropped}`)
    const slot = s.slots.find((x) => x.model === "unit/large")
    assert(slot, "unit/large must remain")
    assert(slot.tpm === 40000, `unit/large tpm must be min(existing 60000, learned 40000)=40000, got ${slot.tpm}`)
    const map = JSON.parse(readFileSync(join(dir, pool.LEARNED_TPM_FILE), "utf8"))
    assert(map["unit/large"] === 40000, "learned-tpm.json must record 40000")
    console.log("noteTpm large keeps+sets min tpm ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// learned value >= MIN_SLOT_TPM does not drop slot on reload.
{
  const dir = freshDir("reload-keep")
  try {
    mkdirSync(dir, { recursive: true })
    const s = pool.state({
      id: "reload",
      dir,
      models: { slots: [{ model: "unit/reload", weight: 1, context: 131072 }] },
    })
    pool.init(s, () => {})
    pool.ensureSlots(s, () => {})
    assert(pool.noteTpm(s, "unit/reload", 25000) === false, "25000 must not drop")
    // Change inline models to force reload path to re-resolve/apply.
    s.inlineModels = { slots: [{ model: "unit/reload", weight: 2, context: 131072 }] }
    const result = pool.reloadSlots(s, () => {})
    assert(result.slots.some((x) => x.model === "unit/reload"), "reload must keep learned-safe model")
    const slot = result.slots.find((x) => x.model === "unit/reload")
    assert(slot.tpm === 25000, `reload must apply learned tpm 25000, got ${slot?.tpm}`)
    assert(result.changed === true, "weight change should report changed")
    console.log("reload applies learned >=MIN_SLOT_TPM without dropping ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Extra: readLearnedTpm returns {} on missing/invalid and keeps only finite positive.
{
  const dir = freshDir("read")
  try {
    mkdirSync(dir, { recursive: true })
    const s = pool.state({ id: "read", dir, models: { slots: [{ model: "unit/x", weight: 1, context: 131072 }] } })
    assert(Object.keys(pool.readLearnedTpm(s)).length === 0, "missing file must return {}")
    pool.init(s, () => {})
    assert(pool.noteTpm(s, "unit/x", 0) === false, "invalid tpm must return false")
    assert(pool.noteTpm(s, "unit/x", Number.NaN) === false, "NaN tpm must return false")
    assert(pool.noteTpm(s, "unit/x", -1) === false, "negative tpm must return false")
    console.log("readLearnedTpm/noteTpm validation ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// parseRateLimitHeaders: extract x-ratelimit-limit-tokens (case-insensitive), finite positive int; else undefined.
{
  assert(pool.parseRateLimitHeaders({ "x-ratelimit-limit-tokens": "8000" }) === 8000, 'string "8000" must parse to 8000')
  assert(pool.parseRateLimitHeaders({ "X-RateLimit-Limit-Tokens": "8000" }) === 8000, "case-insensitive header key must work")
  assert(pool.parseRateLimitHeaders({ "x-ratelimit-limit-tokens": 8000 }) === 8000, "numeric value must parse to 8000")
  assert(pool.parseRateLimitHeaders({}) === undefined, "missing header must be undefined")
  assert(pool.parseRateLimitHeaders({ "x-ratelimit-limit-tokens": "garbage" }) === undefined, "garbage must be undefined")
  assert(pool.parseRateLimitHeaders({ "x-ratelimit-limit-tokens": "0" }) === undefined, "zero must be undefined")
  assert(pool.parseRateLimitHeaders({ "x-ratelimit-limit-tokens": "-1" }) === undefined, "negative must be undefined")
  assert(pool.parseRateLimitHeaders({ "x-ratelimit-limit-tokens": "8000.5" }) === undefined, "non-integer must be undefined")
  assert(pool.parseRateLimitHeaders(null) === undefined, "null headers must be undefined")
  assert(pool.parseRateLimitHeaders(undefined) === undefined, "undefined headers must be undefined")
  assert(pool.parseRateLimitHeaders([]) === undefined, "array headers must be undefined")
  console.log("parseRateLimitHeaders ok")
}

console.log("\nALL CHECKS PASSED")
