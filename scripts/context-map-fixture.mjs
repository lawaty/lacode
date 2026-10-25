// Human-readable fixture report for the context-map contract.
//
//   node scripts/context-map-fixture.mjs [small|large|all]
//
// Every fixture is copied to a scratch directory before the lifecycle runs; the
// fixture in the repository is never edited, and the consumer's live map is only
// ever read (the live audit at the end).
//
// The output is the report the change asks for: per file, line delta, entries
// removed/added, every entry whose meaning changed, and the pass/fail conditions.
// `--json` writes the full structured report to stdout instead.

import { auditMap } from "../src/lib/map-schema.ts"
import { checkFixture, judge } from "../tests/fixtures/context-map/lib.mjs"
import { join } from "node:path"

const args = process.argv.slice(2)
const json = args.includes("--json")
const names = args.filter((arg) => arg === "small" || arg === "large")
const which = names.length > 0 ? names : ["small", "large"]
const now = Date.parse(process.env.FIXTURE_NOW ?? `${new Date().toISOString().slice(0, 10)}T00:00:00Z`)

const counts = (violations) => {
  const out = {}
  for (const violation of violations) out[violation.kind] = (out[violation.kind] ?? 0) + 1
  return out
}

const report = { now: new Date(now).toISOString(), fixtures: [], live: undefined }

for (const name of which) {
  const result = checkFixture(name, { now })
  const verdict = judge(result)

  // The live map is read, never written. It is the observed consumer map that
  // motivated the change; keeping it in the report makes the baseline concrete.
  if (name === "small" && report.live === undefined) {
    const root = process.cwd()
    const live = auditMap(root, join(root, ".opencode", "context"), now)
    report.live = { violations: live.violations.length, kinds: counts(live.violations) }
  }

  report.fixtures.push({
    name,
    before: { violations: result.before.violations.length, kinds: counts(result.before.violations) },
    lifecycle: {
      removedTotal: result.lifecycle.removedTotal,
      files: result.lifecycle.files.map((file) => ({ file: file.file, removed: file.removed })),
    },
    after: { violations: result.after.violations.length, kinds: counts(result.after.violations) },
    files: result.files,
    verdict,
  })

  if (json) continue

  console.log(`\n=== ${name} ===`)
  console.log(`before: ${result.before.violations.length} violation(s) ${JSON.stringify(counts(result.before.violations))}`)
  console.log(`lifecycle removed: ${result.lifecycle.removedTotal}`)
  for (const file of result.lifecycle.files) {
    for (const entry of file.removed) console.log(`  - ${file.file}: ${entry.text || entry.title}`)
  }
  console.log(`after:  ${result.after.violations.length} violation(s)`)
  for (const [file, diff] of Object.entries(result.files)) {
    console.log(
      `  ${file}: ${diff.beforeLines} -> ${diff.afterLines} non-blank lines (${diff.lineDelta >= 0 ? "+" : ""}${diff.lineDelta}), ` +
        `entries ${diff.beforeEntries} -> ${diff.afterEntries} (removed ${diff.removed.length}, added ${diff.added.length})`,
    )
    for (const entry of diff.changed) console.log(`    meaning changed at ${entry.home}: "${entry.before}" -> "${entry.after}"`)
  }
  const failed = Object.entries(verdict).filter(([, passed]) => !passed)
  console.log(`pass conditions: ${Object.keys(verdict).length - failed.length}/${Object.keys(verdict).length}`)
  for (const [condition, passed] of Object.entries(verdict)) console.log(`  ${passed ? "PASS" : "FAIL"} ${condition}`)
}

if (report.live) {
  if (!json) {
    console.log(`\n=== live map (this repository, read-only) ===`)
    console.log(`${report.live.violations} violation(s) ${JSON.stringify(report.live.kinds)}`)
  }
}

if (json) console.log(JSON.stringify(report, null, 2))
