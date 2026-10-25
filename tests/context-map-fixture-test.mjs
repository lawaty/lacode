// Fixture regression: the same contract on a small synthetic consumer and on a
// realistic multi-subsystem one. Both maps are copied to scratch first; the
// fixture trees are never edited.
//
// The assertions are the deliverable's pass conditions (a)-(f), plus a check
// that the BEFORE map really does carry the defects the change is meant to
// prevent. A suite that only asserts the good map would pass if the validator
// stopped detecting anything.

import { test } from "node:test"
import assert from "node:assert/strict"
import { checkFixture, judge } from "./fixtures/context-map/lib.mjs"
import { cleanupAll } from "./stories/_harness.mjs"

test.after(cleanupAll)

const NOW = Date.parse("2026-10-26T00:00:00Z")
const kinds = (audit) => new Set(audit.violations.map((violation) => violation.kind))

for (const name of ["small", "large"]) {
  test(`[context-map] ${name} fixture: the before map has the defects and the after map passes every condition`, () => {
    const result = checkFixture(name, { now: NOW })
    const beforeKinds = kinds(result.before)
    const afterKinds = kinds(result.after)

    // The baseline must actually exercise the failure modes. Without this, a
    // validator that returned no violations at all would "pass".
    for (const kind of ["schema", "restatement", "dangling", "drift"]) {
      assert.ok(beforeKinds.has(kind), `${name}: the before map must exhibit ${kind}: ${[...beforeKinds]}`)
    }
    if (name === "large") assert.ok(beforeKinds.has("budget"), "the large before map must exceed a budget")
    if (name === "small") assert.ok(beforeKinds.has("archive"), "the small before map must carry archive language")

    const verdict = judge(result)
    for (const [condition, passed] of Object.entries(verdict)) {
      assert.equal(passed, true, `${name}: ${condition}`)
    }

    // The target is clean and every file still answers its charter.
    assert.deepEqual(result.after.violations, [], JSON.stringify(result.after.violations, null, 2))
    assert.ok(!afterKinds.has("charter"))
    assert.ok(result.after.files.every((file) => file.entries.length >= file.spec.minEntries || file.spec.kind === "backlog"))

    // The lifecycle is a real write, not a report: it removed the expired
    // provisional entries and left the binding constraint in place.
    assert.ok(result.lifecycle.removedTotal >= 1)
    assert.ok(result.lifecycle.files.some((file) => file.file === "decisions.md" && file.removed.length === 1))
  })
}
