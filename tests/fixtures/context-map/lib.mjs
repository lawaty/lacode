// Fixture runner for the context-map contract.
//
// Each fixture is a small consumer tree with two maps:
//
//   map/before/  what the old prompt produced (the defects in O1-O6)
//   map/after/   the compact map the new contract requires
//
// The runner COPIES the fixture to a scratch directory before touching it. The
// fixture in the repository is never edited, and the consumer's live map is
// never involved. `now` is a parameter so lifecycle boundaries are deterministic.

import { cpSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { auditMap, maintainMap, parseMapEntries } from "../../../src/lib/map-schema.ts"
import { scratch } from "../../stories/_harness.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

const POINTER =
  /(?:—|–|→|->)\s*See\s+`([^`\n]+)`(?:\s*§\s*([^()\n]+?))?(?:\s*\(verified\s+(\d{4}-\d{2}-\d{2})\))?\s*$/i

const norm = (value) =>
  value
    .toLowerCase()
    .replace(/^\[(binding|provisional|disputed)\]\s*/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

const nonBlank = (text) => text.split(/\r?\n/).filter((line) => line.trim()).length

/** Parse the old, unmarked dialect so a before/after diff is still possible. */
const legacyEntries = (text) => {
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = /^\s*[-*+]\s+(.*)$/.exec(raw)
    if (!line) continue
    const body = line[1].replace(/\s+/g, " ").trim()
    const pointer = POINTER.exec(body)
    const rule = body.replace(POINTER, "").trim()
    if (!rule) continue
    out.push({
      rule,
      pointer: pointer?.[1],
      section: pointer?.[2]?.trim(),
      verified: pointer?.[3],
    })
  }
  return out
}

const diffFile = (beforeText, afterText, kind) => {
  const beforeEntries = kind === "entries" ? legacyEntries(beforeText) : []
  const afterEntries = kind === "entries" ? parseMapEntries(afterText) : []
  const afterRules = new Set(afterEntries.map((entry) => norm(entry.rule)))
  const beforeRules = new Set(beforeEntries.map((entry) => norm(entry.rule)))

  const removed = beforeEntries.filter((entry) => !afterRules.has(norm(entry.rule))).map((entry) => entry.rule)
  const added = afterEntries.filter((entry) => !beforeRules.has(norm(entry.rule))).map((entry) => entry.rule)

  // "Meaning changed" is deliberately conservative: same pointer + section, a
  // different rule. A rewritten rule that also moved its pointer is reported as
  // one removal and one addition, not as a silent edit.
  const byHome = new Map()
  for (const entry of beforeEntries) {
    if (!entry.pointer) continue
    byHome.set(`${entry.pointer}|${entry.section ?? ""}`, entry)
  }
  const changed = []
  for (const entry of afterEntries) {
    const previous = byHome.get(`${entry.pointer}|${entry.section ?? ""}`)
    if (!previous) continue
    if (norm(previous.rule) !== norm(entry.rule)) {
      changed.push({ home: `${entry.pointer}${entry.section ? ` §${entry.section}` : ""}`, before: previous.rule, after: entry.rule })
    }
  }

  return {
    beforeLines: nonBlank(beforeText),
    afterLines: nonBlank(afterText),
    lineDelta: nonBlank(afterText) - nonBlank(beforeText),
    beforeEntries: beforeEntries.length,
    afterEntries: afterEntries.length,
    removed,
    added,
    changed,
  }
}

/**
 * Run one fixture. Returns the audits, the lifecycle result and a per-file diff.
 * The caller decides pass/fail; this function never throws on a map violation.
 */
export const checkFixture = (name, { now = Date.now() } = {}) => {
  const source = join(HERE, name)
  const root = scratch(`context-fixture-${name}-`)
  // scratch() creates the directory; cpSync into an existing directory would
  // nest the source, so replace it first.
  rmSync(root, { recursive: true, force: true })
  cpSync(source, root, { recursive: true })

  const fixed = new Date(now)
  for (const entry of readdirSync(root, { recursive: true })) {
    const full = join(root, entry)
    try {
      if (statSync(full).isFile()) utimesSync(full, fixed, fixed)
    } catch {}
  }

  const mapDir = join(root, ".opencode", "context")
  rmSync(mapDir, { recursive: true, force: true })
  cpSync(join(root, "map", "before"), mapDir, { recursive: true })

  const targetDir = join(root, ".opencode", "context-after")
  rmSync(targetDir, { recursive: true, force: true })
  cpSync(join(root, "map", "after"), targetDir, { recursive: true })

  const fixedTime = new Date("2026-10-26T00:00:00Z")
  for (const dir of [root, mapDir, targetDir]) {
    try {
      for (const entry of readdirSync(dir, { recursive: true })) {
        const full = join(dir, entry)
        try {
          if (statSync(full).isFile()) utimesSync(full, fixedTime, fixedTime)
        } catch {}
      }
    } catch {}
  }

  const before = auditMap(root, mapDir, now)
  const lifecycle = maintainMap(root, mapDir, now)
  const afterLifecycle = auditMap(root, mapDir, now)
  const after = auditMap(root, targetDir, now)

  const files = {}
  for (const spec of after.files.map((file) => file.spec)) {
    const beforeText = readFileSync(join(source, "map", "before", spec.file), "utf8")
    const afterText = readFileSync(join(source, "map", "after", spec.file), "utf8")
    files[spec.file] = diffFile(beforeText, afterText, spec.kind)
  }

  return { name, root, mapDir, before, afterLifecycle, after, lifecycle, files }
}

/** All the pass conditions the deliverable names, as data rather than prose. */
export const judge = (result) => {
  const beforeKinds = new Set(result.before.violations.map((violation) => violation.kind))
  const afterKinds = new Set(result.after.violations.map((violation) => violation.kind))
  const decisions = result.after.files.find((file) => file.spec.file === "decisions.md")
  const afterText = (file) => {
    const text = result.after.files.find((entry) => entry.spec.file === file)
    return text ? readFileSync(join(result.root, ".opencode", "context-after", file), "utf8") : ""
  }

  const large = result.name === "large"
  const split = large
    ? afterText("architecture.md").includes("replay must never block admission")
    : afterText("architecture.md").includes("split into a gateway and a store")
  const never = large
    ? /never collapse it into the projector|must not be collapsed/i.test(afterText("contexts.md") + afterText("decisions.md"))
    : /must not be collapsed/i.test(afterText("contexts.md"))

  return {
    // (a) decisions within budget and every entry matches the schema
    decisionsWithinBudget: Boolean(decisions) && decisions.lines <= decisions.spec.budget,
    decisionsSchemaClean: !result.after.violations.some(
      (violation) => violation.file === "decisions.md" && (violation.kind === "schema" || violation.kind === "budget"),
    ),
    // (b) no restatement in the target; the before map demonstrably had one
    noRestatement: !afterKinds.has("restatement") && beforeKinds.has("restatement"),
    // (c) the deliberate contradiction is reported before, and gone after
    driftReported: beforeKinds.has("drift") && !afterKinds.has("drift"),
    // (d) no dangling reference in the target; the before map had one
    noDangling: !afterKinds.has("dangling") && beforeKinds.has("dangling"),
    // (e) the constraints survive in the target
    splitSurvives: split,
    neverCollapsedSurvives: never,
    // (f) every file answers its charter and none is degenerate
    noCharterViolation: !afterKinds.has("charter"),
    everyFileWithinBudget: !afterKinds.has("budget"),
    everyEntryInSchema: !afterKinds.has("schema"),
    // the lifecycle really removed something and kept the binding constraint
    lifecycleRemoved: result.lifecycle.removedTotal >= 1,
    bindingSurvivesLifecycle: readFileSync(join(result.mapDir, "decisions.md"), "utf8").includes(
      result.name === "large" ? "stays append-only" : "stays stateless",
    ),
  }
}
