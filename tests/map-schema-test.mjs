// The context map's deterministic contract: schema, budget, lifecycle and drift.
//
// These are the rules a prompt cannot enforce. The cartographer is an LLM and
// will sometimes ignore an instruction; it cannot ignore a validator that reads
// what it wrote. The suite is deliberately fixture-driven and offline: a temp
// project root stands in for a consumer repository, and `now` is a parameter so
// the lifecycle boundaries can be pinned without waiting.
//
// What is NOT here: a live model run. The prompt/schema is exercised at the
// boundary the plugin owns (validation of text on disk); the model's compliance
// is what the fixture maps in tests/fixtures/context-map represent.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENTS } from "../src/agents.ts"
import {
  MAP_FILES,
  MAP_SPEC_BY_FILE,
  MAP_SPECS,
  NAVIGATION_FILES,
  auditMap,
  maintainMap,
  normalizeMapText,
  parseMapEntries,
  validateMapText,
} from "../src/lib/map-schema.ts"
import { cleanupAll, scratch } from "./stories/_harness.mjs"

test.after(cleanupAll)

const DAY_MS = 24 * 60 * 60 * 1000
const TODAY = new Date().toISOString().slice(0, 10)
const NOW = Date.parse(`${TODAY}T00:00:00Z`)
const daysAgo = (days) => new Date(NOW - days * DAY_MS).toISOString().slice(0, 10)

const write = (root, name, text) => {
  const file = join(root, name)
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, text)
}

/** A small but structurally real repository: a page, two code files, a map. */
const makeRepo = () => {
  const root = scratch("map-fixture-")
  const map = join(root, ".opencode", "context")
  mkdirSync(map, { recursive: true })
  write(
    root,
    "docs/DESIGN.md",
    [
      "# Design",
      "",
      "## The two halves",
      "",
      "The gateway admits requests and the store applies mutations to durable state.",
      "",
      "## Retention",
      "",
      "The retention window is 7 days.",
      "",
      "## Record lengths",
      "",
      "None of the record lengths are parsed; the header is ignored.",
      "",
    ].join("\n"),
  )
  write(root, "src/gateway.ts", "export const admit = (request: string) => request\n")
  write(root, "src/store.ts", "export const apply = (mutation: string) => mutation\n")
  return { root, map }
}

const validMap = (today = TODAY) => ({
  "architecture.md": [
    "# Architecture",
    "",
    `- [binding] The system is split into a gateway and a store because the gateway must stay stateless. — See \`docs/DESIGN.md\` §The two halves (verified ${today})`,
    `- [binding] The gateway is the only admission point. — See \`src/gateway.ts\` (verified ${today})`,
    `- [binding] The store is the only writer of durable state. — See \`src/store.ts\` (verified ${today})`,
    `- [binding] The two halves communicate through the store boundary, not by imports of internals. — See \`docs/DESIGN.md\` §The two halves (verified ${today})`,
    "",
  ].join("\n"),
  "contexts.md": [
    "# Contexts",
    "",
    `- [binding] Gateway: admission only; start at \`src/gateway.ts\`. — See \`docs/DESIGN.md\` §The two halves (verified ${today})`,
    `- [binding] Store: mutations only; start at \`src/store.ts\`. — See \`src/store.ts\` (verified ${today})`,
    `- [binding] The boundary between the two must not be collapsed. — See \`docs/DESIGN.md\` §The two halves (verified ${today})`,
    "",
  ].join("\n"),
  "conventions.md": [
    "# Conventions",
    "",
    `- [binding] Read the owning page before changing a boundary. — See \`docs/DESIGN.md\` §The two halves (verified ${today})`,
    `- [binding] Never bypass the store for a mutation. — See \`src/store.ts\` (verified ${today})`,
    `- [binding] Keep the gateway free of durable state. — See \`src/gateway.ts\` (verified ${today})`,
    "",
  ].join("\n"),
  "workflows.md": [
    "# Workflows",
    "",
    `- [binding] A request is admitted by the gateway and then applied by the store. — See \`docs/DESIGN.md\` §The two halves (verified ${today})`,
    `- [binding] Retention is applied by the store, never by the gateway. — See \`docs/DESIGN.md\` §Retention (verified ${today})`,
    "",
  ].join("\n"),
  "decisions.md": [
    "# Decisions",
    "",
    `- [binding] The gateway stays stateless so it can be replaced without touching durable state. — See \`docs/DESIGN.md\` §The two halves (verified ${today})`,
    `- [provisional] The retention window may be tuned in a later release. — See \`docs/DESIGN.md\` §Retention (verified ${today})`,
    "",
  ].join("\n"),
  "active.md": ["# Active backlog", "", "## 2026-W43", "", "- [ ] Ship the split — opened 2026-W43", ""].join("\n"),
})

const writeMap = (map, files) => {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(map, name), text)
}

const kinds = (violations) => violations.map((violation) => violation.kind)
const has = (violations, kind) => violations.some((violation) => violation.kind === kind)

test("the budget covers every file, and decisions is tightly bounded", () => {
  assert.deepEqual(MAP_FILES, [
    "architecture.md",
    "contexts.md",
    "conventions.md",
    "workflows.md",
    "decisions.md",
    "active.md",
  ])
  assert.equal(NAVIGATION_FILES.length, 5)
  for (const spec of MAP_SPECS) {
    assert.ok(spec.budget > 0, `${spec.file} needs a budget`)
    assert.ok(spec.minEntries >= 0)
  }
  assert.equal(MAP_SPEC_BY_FILE.get("decisions.md").budget, 120)
  // The observed failure was a 465-line decisions file. A cap that permits it
  // is not a cap.
  assert.ok(MAP_SPEC_BY_FILE.get("decisions.md").budget < 200)
})

test("a valid map passes every check, and its entries parse", () => {
  const { root, map } = makeRepo()
  writeMap(map, validMap())
  const audit = auditMap(root, map, NOW)
  assert.deepEqual(audit.violations, [], audit.violations.map((v) => `${v.file}:${v.kind}:${v.detail}`).join("\n"))
  assert.equal(audit.ok, true)
  const decisions = audit.files.find((file) => file.spec.file === "decisions.md")
  assert.equal(decisions.entries.length, 2)
  assert.equal(decisions.entries[0].marker, "binding")
  assert.equal(decisions.entries[0].section, "The two halves")
  assert.equal(decisions.entries[0].verified, TODAY)
})

test("a decision record is a schema violation, not a style nit", () => {
  const { root, map } = makeRepo()
  const files = validMap()
  files["decisions.md"] = [
    "# Decisions",
    "",
    "## Use a gateway",
    "",
    "**Context:** we needed admission.",
    "",
    "**Decision:** add a gateway.",
    "",
    "**Consequences:** one more process.",
    "",
  ].join("\n")
  writeMap(map, files)
  const audit = auditMap(root, map, NOW)
  assert.ok(has(audit.violations, "schema"), kinds(audit.violations).join(","))
  assert.ok(
    audit.violations.some((violation) => violation.detail.includes("decision-record")),
    "the record block must be named",
  )
})

test("an over-budget file reports the budget", () => {
  const { root, map } = makeRepo()
  const files = validMap()
  const filler = Array.from({ length: 130 }, (_, i) => `- [binding] Filler rule ${i}. — See \`docs/DESIGN.md\` §The two halves (verified ${TODAY})`)
  files["decisions.md"] = `# Decisions\n\n${filler.join("\n")}\n`
  writeMap(map, files)
  const audit = auditMap(root, map, NOW)
  assert.ok(has(audit.violations, "budget"), "an over-budget file must fail the audit")
})

test("every entry needs a provenance marker and a bounded rule", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const unmarked = validateMapText(spec, "# Decisions\n\n- a rule with no home\n", { root })
  assert.ok(has(unmarked.violations, "schema"))
  const tooLong = validateMapText(
    spec,
    [
      "# Decisions",
      "",
      `- [binding] First line of the rule.`,
      "  second line",
      "  third line",
      "  fourth line",
      `  — See \`docs/DESIGN.md\` §The two halves (verified ${TODAY})`,
      "",
    ].join("\n"),
    { root },
  )
  assert.ok(tooLong.violations.some((violation) => violation.detail.includes("5 lines")), JSON.stringify(tooLong.violations))
})

test("a page pointer must name a section; a code pointer need not", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const noSection = validateMapText(
    spec,
    `# Decisions\n\n- [binding] The split matters. — See \`docs/DESIGN.md\` (verified ${TODAY})\n`,
    { root },
  )
  assert.ok(noSection.violations.some((violation) => violation.detail.includes("§section")))
  const code = validateMapText(
    spec,
    `# Decisions\n\n- [binding] The gateway admits. — See \`src/gateway.ts\` (verified ${TODAY})\n`,
    { root },
  )
  assert.ok(!code.violations.some((violation) => violation.detail.includes("§section")), JSON.stringify(code.violations))
})

test("a dangling pointer is reported as dangling AND unarchived, and is never auto-dropped", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const text = `# Decisions\n\n- [provisional] A retired fact that has no page. — See \`docs/RETIRED.md\` §Gone (verified ${daysAgo(400)})\n`
  const result = validateMapText(spec, text, { root })
  assert.ok(has(result.violations, "dangling"))
  assert.ok(has(result.violations, "unarchived"))
  // The archive-of-record guard: no source means NEVER delete the only copy.
  const normalized = normalizeMapText(spec, text, { now: NOW, canResolve: () => false })
  assert.deepEqual(normalized.removed, [])
  assert.equal(normalized.text, text)
})

test("a missing page section is drift", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const result = validateMapText(
    spec,
    `# Decisions\n\n- [binding] The split matters. — See \`docs/DESIGN.md\` §No Such Section (verified ${TODAY})\n`,
    { root },
  )
  assert.ok(result.violations.some((violation) => violation.kind === "drift" && violation.detail.includes("no longer exists")))
})

test("a table is a restatement; a long verbatim span is too", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const table = validateMapText(
    spec,
    `# Decisions\n\n| Field | Length |\n| --- | --- |\n| a | 4 |\n\n- [binding] The split matters. — See \`docs/DESIGN.md\` §The two halves (verified ${TODAY})\n`,
    { root },
  )
  assert.ok(has(table.violations, "restatement"), JSON.stringify(table.violations))
  const copied = validateMapText(
    spec,
    `# Decisions\n\n- [binding] The gateway admits requests and the store applies mutations to durable state. — See \`docs/DESIGN.md\` §The two halves (verified ${TODAY})\n`,
    { root },
  )
  assert.ok(copied.violations.some((violation) => violation.kind === "restatement" && violation.detail.includes("verbatim")))
})

test("archive-of-record language is reported", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const result = validateMapText(
    spec,
    `# Decisions\n\nThis is the only place the retired decision remains.\n\n- [binding] The split matters. — See \`docs/DESIGN.md\` §The two halves (verified ${TODAY})\n`,
    { root },
  )
  assert.ok(has(result.violations, "archive"), JSON.stringify(result.violations))
})

test("archive language is about the map, not any use of the word only", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const result = validateMapText(
    spec,
    [
      "# Decisions",
      "",
      "`AGENTS.md` is the only copy of the context rules.",
      "This is the only place the cooling state is told apart from an idle provider.",
      "",
      `- [binding] The split matters. — See \`docs/DESIGN.md\` §The two halves (verified ${TODAY})`,
      "",
    ].join("\n"),
    { root },
  )
  assert.ok(!result.violations.some((violation) => violation.kind === "archive"), JSON.stringify(result.violations))
})

test("a numeric contradiction and a negation conflict are both drift, reported not resolved", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const numeric = validateMapText(
    spec,
    `# Decisions\n\n- [binding] The retention window is 14 days. — See \`docs/DESIGN.md\` §Retention (verified ${TODAY})\n`,
    { root },
  )
  assert.ok(numeric.violations.some((violation) => violation.kind === "drift" && violation.detail.includes("14")))
  const negation = validateMapText(
    spec,
    `# Decisions\n\n- [binding] The record lengths are parsed from the header. — See \`docs/DESIGN.md\` §Record lengths (verified ${TODAY})\n`,
    { root },
  )
  assert.ok(
    negation.violations.some((violation) => violation.kind === "drift" && violation.detail.includes("possible contradiction")),
    JSON.stringify(negation.violations),
  )
})

test("a source modified after its verified date is drift", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const page = join(root, "docs", "DESIGN.md")
  const changed = new Date("2026-06-01T00:00:00Z")
  utimesSync(page, changed, changed)
  const result = validateMapText(
    spec,
    `# Decisions\n\n- [binding] The split matters. — See \`docs/DESIGN.md\` §The two halves (verified 2026-01-01)\n`,
    { root },
  )
  assert.ok(result.violations.some((violation) => violation.kind === "drift" && violation.detail.includes("changed on")))
})

test("lifecycle drops only old provisional entries whose source still resolves", () => {
  const spec = MAP_SPEC_BY_FILE.get("decisions.md")
  const { root } = makeRepo()
  const text = [
    "# Decisions",
    "",
    `- [binding] A binding constraint is exempt from age. — See \`docs/DESIGN.md\` §The two halves (verified ${daysAgo(400)})`,
    `- [provisional] An old provisional entry with a source. — See \`docs/DESIGN.md\` §Retention (verified ${daysAgo(31)})`,
    `- [provisional] An old provisional entry with no source. — See \`docs/GONE.md\` §Gone (verified ${daysAgo(400)})`,
    `- [disputed] A disagreement is exempt from age. — See \`docs/DESIGN.md\` §Retention (verified ${daysAgo(400)})`,
    "",
  ].join("\n")
  const result = normalizeMapText(spec, text, { now: NOW, canResolve: (pointer) => pointer === "docs/DESIGN.md" })
  assert.equal(result.removed.length, 1)
  assert.match(result.removed[0].text, /old provisional entry with a source/)
  assert.ok(result.text.includes("A binding constraint is exempt"))
  assert.ok(result.text.includes("An old provisional entry with no source"))
  assert.ok(result.text.includes("A disagreement is exempt"))
  assert.ok(!result.text.includes("An old provisional entry with a source"))
  // Idempotent: a clean file is a fixed point.
  const again = normalizeMapText(spec, result.text, { now: NOW, canResolve: (pointer) => pointer === "docs/DESIGN.md" })
  assert.equal(again.text, result.text)
  assert.deepEqual(again.removed, [])
})

test("the generalized sweep keeps the active backlog's 7-day window", () => {
  const root = scratch("map-active-")
  const map = join(root, ".opencode", "context")
  mkdirSync(map, { recursive: true })
  const finishedRecent = daysAgo(2)
  const finishedStale = daysAgo(9)
  write(
    root,
    ".opencode/context/active.md",
    [
      "# Active backlog",
      "",
      "## 2026-W43",
      "",
      `- [x] Stale chore — opened 2026-W43, finished ${finishedStale}`,
      `- [ ] Open work — opened 2026-W43`,
      `- [x] Recent chore — opened 2026-W43, finished ${finishedRecent}`,
      "",
    ].join("\n"),
  )
  const result = maintainMap(root, map, NOW)
  const after = readFileSync(join(map, "active.md"), "utf8")
  assert.equal(result.removedTotal, 1)
  assert.ok(!after.includes("Stale chore"))
  assert.ok(after.includes("Open work"))
  assert.ok(after.includes("Recent chore"))
})

test("the same rule stated in two files is a duplicate", () => {
  const { root, map } = makeRepo()
  const files = validMap()
  const rule = "One fact has exactly one home in the map."
  files["architecture.md"] += `- [binding] ${rule} — See \`docs/DESIGN.md\` §The two halves (verified ${TODAY})\n`
  files["contexts.md"] += `- [binding] ${rule} — See \`docs/DESIGN.md\` §The two halves (verified ${TODAY})\n`
  writeMap(map, files)
  const audit = auditMap(root, map, NOW)
  assert.ok(has(audit.violations, "duplicate"), JSON.stringify(audit.violations))
})

test("an empty file fails its charter", () => {
  const { root, map } = makeRepo()
  const files = validMap()
  files["architecture.md"] = "# Architecture\n"
  writeMap(map, files)
  const audit = auditMap(root, map, NOW)
  assert.ok(audit.violations.some((violation) => violation.file === "architecture.md" && violation.kind === "charter"))
})

test("the prompt the model runs is the tracked prompt, and it states the contract", () => {
  const tracked = readFileSync(join(process.cwd(), ".opencode", "prompts", "context.txt"), "utf8")
  assert.equal(AGENTS.context.prompt, tracked, "src/agents.ts and .opencode/prompts/context.txt must not drift")
  for (const phrase of [
    "[binding]",
    "[provisional]",
    "[disputed]",
    "At most 120 lines",
    "30 days",
    "Point, do not restate",
    "Drift check — report, never overwrite",
    "Never the archive",
    "non-blank lines",
  ]) {
    assert.ok(tracked.includes(phrase), `prompt is missing: ${phrase}`)
  }
})
