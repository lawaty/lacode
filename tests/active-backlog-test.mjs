// Offline unit suite for src/lib/active-backlog.ts.
//
// The module is pure -- text in, entries out, entries back to canonical text
// -- so every test here is a string and a clock, nothing else: no disk, no
// plugin, no waiting for time to pass. `now` being a parameter of
// normalizeBacklog is the whole reason the retention boundary below can be
// pinned at all.
//
// The two properties worth protecting with a test rather than a comment:
//
//   * THE RETENTION BOUNDARY IS STRICT: a task finished exactly RETENTION_DAYS
//     ago is KEPT, because the file's own preamble promises it "stays here for
//     a week after it was finished" -- `>=` would drop it inside the very week
//     the file promised to show it, and nothing would report the difference.
//   * NORMALIZE IS A FIXED POINT: normalizing canonical text changes nothing,
//     so a file that is already clean is never rewritten into a different
//     shape and a second pass after the first is a no-op.
//
// The import path is static, relative, and carries the .ts extension, so it
// resolves against THIS file and `node --test tests/active-backlog-test.mjs`
// works from anywhere in the tree.

import { test } from "node:test"
import assert from "node:assert/strict"
import { ACTIVE_BACKLOG_FILE, RETENTION_DAYS, normalizeBacklog, parseBacklog, renderBacklog } from "../src/lib/active-backlog.ts"

// A fixed clock: 2026-10-19T00:00:00Z. Every age below is counted from it in
// whole days, so the seven-day boundary is arithmetic rather than whatever the
// wall clock happens to read when the suite runs.
const NOW = Date.parse("2026-10-19T00:00:00Z")

// The header, duplicated on purpose: it is FIXED text the file documents
// verbatim, so a drift in the module's copy must fail here rather than ship as
// a rewritten preamble nobody meant to touch.
const HEADER = `# Active backlog

Tasks in flight, grouped by the week they were opened. A finished task stays
here for a week after it was finished and is then dropped; an open task stays
however long it takes. Add a line under the right week, and give a finished
task its date: \`- [x] Title — opened 2026-W43, finished 2026-10-19\`.`

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("the module names the file it owns and the window it applies", () => {
  assert.equal(ACTIVE_BACKLOG_FILE, "active.md")
  assert.equal(RETENTION_DAYS, 7)
})

test("an open task, a finished task and a task with no week all parse", () => {
  const entries = parseBacklog(`# Active backlog

## 2026-W43

- [ ] Ship the release notes — opened 2026-W43
- [x] Fix the flaky test — opened 2026-W43, finished 2026-10-19
- [ ] Nothing but a title
- [x] Done, no week, no date, finished 2026-10-18
`)
  assert.deepEqual(entries, [
    { title: "Ship the release notes", week: "2026-W43", finished: false },
    { title: "Fix the flaky test", week: "2026-W43", finished: true, finishedAt: "2026-10-19" },
    { title: "Nothing but a title", finished: false },
    { title: "Done, no week, no date", finished: true, finishedAt: "2026-10-18" },
  ])
})

test("a line that is not a checkbox task line is skipped silently", () => {
  const entries = parseBacklog(`# Active backlog

A paragraph that mentions [x] brackets but carries no list marker.

## 2026-W43

- prose with an [x] inside it
* [~] not one of the three checkbox states
- [ ]
- [ ]    
`)
  assert.deepEqual(entries, [])
})

test("metadata is recognised case-insensitively behind any of the three dashes", () => {
  const [mixed] = parseBacklog("- [X] OPENED and finished stay title text — OPENED 2026-w41, FINISHED 2026-10-01\n")
  assert.equal(mixed.title, "OPENED and finished stay title text")
  assert.equal(mixed.week, "2026-W41", "the week is canonicalised to an uppercase W")
  assert.equal(mixed.finishedAt, "2026-10-01")
  assert.equal(mixed.finished, true)

  const [hyphen] = parseBacklog("- [ ] Hyphen form - opened 2026-W40\n")
  assert.equal(hyphen.title, "Hyphen form")
  assert.equal(hyphen.week, "2026-W40")

  const [en] = parseBacklog("- [ ] En dash form – opened 2026-W39\n")
  assert.equal(en.title, "En dash form")
  assert.equal(en.week, "2026-W39")
})

test("a date the calendar refuses is title text, not metadata", () => {
  // V8 does not reject 2026-02-30 -- it rolls it over to March 2 -- so the
  // parser has to read the parsed date back to tell a real one from a lie.
  const [entry] = parseBacklog("- [x] Impossible date — finished 2026-02-30\n")
  assert.equal(entry.finished, true, "the checkbox is still a checkbox")
  assert.equal(entry.finishedAt, undefined, "no date means no claim about when it closed")
  assert.equal(entry.title, "Impossible date — finished 2026-02-30")
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("rendering groups by week, newest first, with Unscheduled last", () => {
  const text = renderBacklog([
    { title: "Older", week: "2026-W42", finished: false },
    { title: "This week", week: "2026-W43", finished: false },
    { title: "Last year", week: "2025-W52", finished: false },
    { title: "Whenever", finished: false },
    { title: "Also this week", week: "2026-W43", finished: false },
  ])
  const headings = text.split("\n").filter((line) => line.startsWith("## "))
  assert.deepEqual(headings, ["## 2026-W43", "## 2026-W42", "## 2025-W52", "## Unscheduled"])

  // Input order inside a section is preserved: "This week" was declared before
  // "Also this week", and a hand-edited file must not reshuffle under a rewrite.
  assert.ok(text.indexOf("- [ ] This week") < text.indexOf("- [ ] Also this week"))
  assert.ok(text.endsWith("\n"), "the file ends with a newline")
  assert.ok(!text.endsWith("\n\n"), "exactly ONE trailing newline, never two")
})

test("the canonical line shapes are exactly the ones the header documents", () => {
  const text = renderBacklog([
    { title: "Ship the release notes", week: "2026-W43", finished: false },
    { title: "Fix the flaky test", week: "2026-W43", finished: true, finishedAt: "2026-10-19" },
    { title: "Dated but still open", week: "2026-W43", finished: false, finishedAt: "2026-10-19" },
    { title: "No week open", finished: false },
    { title: "No week done", finished: true, finishedAt: "2026-10-18" },
    { title: "No week done, undated", finished: true },
  ])
  const lines = text.split("\n").filter((line) => line.startsWith("- ["))
  assert.deepEqual(lines, [
    "- [ ] Ship the release notes — opened 2026-W43",
    "- [x] Fix the flaky test — opened 2026-W43, finished 2026-10-19",
    // The date describes a TICKED box, so an open entry never renders one --
    // parse can produce that shape from a hand-edited line, but the canonical
    // form does not repeat the claim.
    "- [ ] Dated but still open — opened 2026-W43",
    "- [ ] No week open",
    "- [x] No week done, finished 2026-10-18",
    "- [x] No week done, undated",
  ])
})

test("an empty backlog is still the header, and nothing else", () => {
  assert.equal(renderBacklog([]), `${HEADER}\n`)
  const { text, removed } = normalizeBacklog("", NOW)
  assert.equal(text, `${HEADER}\n`)
  assert.ok(!text.includes("## "), "no section headings on an empty file")
  assert.deepEqual(removed, [])
})

test("rendered text parses back to the entries it was built from", () => {
  const entries = [
    { title: "Ship the release notes", week: "2026-W43", finished: false },
    { title: "Fix the flaky test", week: "2026-W43", finished: true, finishedAt: "2026-10-19" },
    { title: "Older open", week: "2026-W40", finished: false },
    { title: "No week open", finished: false },
    { title: "No week done", finished: true, finishedAt: "2026-10-18" },
  ]
  assert.deepEqual(parseBacklog(renderBacklog(entries)), entries)
})

// ---------------------------------------------------------------------------
// normalizeBacklog -- the rolling window
// ---------------------------------------------------------------------------

test("a finished task older than the window is dropped, and only those are", () => {
  const { text, removed } = normalizeBacklog(
    [
      "- [x] Dropped first — opened 2026-W40, finished 2026-10-10", // 9 days
      "- [ ] Open since forever — opened 2026-W01",
      "- [x] Finished, undated — opened 2026-W40",
      "- [x] Dropped second — opened 2026-W41, finished 2026-10-11", // 8 days
    ].join("\n"),
    NOW,
  )
  assert.deepEqual(removed, ["Dropped first", "Dropped second"], "removed carries the titles in file order")
  assert.ok(!text.includes("Dropped first"))
  assert.ok(!text.includes("Dropped second"))
  assert.ok(text.includes("- [ ] Open since forever — opened 2026-W01"))
  assert.ok(text.includes("- [x] Finished, undated — opened 2026-W40"))
})

test("the retention boundary is strict: exactly seven days is kept", () => {
  // Seven days to the millisecond, measured from midnight UTC -- the case a
  // `>=` would drop and the file's own preamble says must stay.
  const exact = normalizeBacklog("- [x] Exactly a week — opened 2026-W42, finished 2026-10-12", NOW)
  assert.deepEqual(exact.removed, [])
  assert.ok(exact.text.includes("- [x] Exactly a week"))

  const sixDays = normalizeBacklog("- [x] Six days old — opened 2026-W43, finished 2026-10-13", NOW)
  assert.deepEqual(sixDays.removed, [])
  assert.ok(sixDays.text.includes("- [x] Six days old"))

  const justOver = normalizeBacklog("- [x] A day over — opened 2026-W42, finished 2026-10-11", NOW)
  assert.deepEqual(justOver.removed, ["A day over"])
  assert.ok(!justOver.text.includes("A day over"))
})

test("an open task never expires, however old it is", () => {
  const { text, removed } = normalizeBacklog(
    [
      "- [ ] Ancient open task — opened 2026-W01",
      // An unchecked box with a parsed date is still open: the drop condition
      // needs finished AND a date, so a stray date cannot age an open task out.
      "- [ ] Open with a stray date — opened 2026-W01, finished 2026-10-01",
    ].join("\n"),
    NOW,
  )
  assert.deepEqual(removed, [])
  assert.ok(text.includes("- [ ] Ancient open task — opened 2026-W01"))
  assert.ok(text.includes("- [ ] Open with a stray date — opened 2026-W01"))
  assert.ok(!text.includes("2026-10-01"), "the canonical form does not repeat a date on an open line")
})

test("a finished task with no usable date is kept, because it cannot age", () => {
  const undated = normalizeBacklog("- [x] Undated done — opened 2026-W01", NOW)
  assert.deepEqual(undated.removed, [])
  assert.ok(undated.text.includes("- [x] Undated done"))

  const impossible = normalizeBacklog("- [x] Impossible date — finished 2026-02-30", NOW)
  assert.deepEqual(impossible.removed, [], "a date that does not parse is no date at all")
  assert.ok(impossible.text.includes("Impossible date"))
})

test("normalize is a fixed point on canonical text", () => {
  const rendered = renderBacklog([
    { title: "Ship the release notes", week: "2026-W43", finished: false },
    { title: "Fix the flaky test", week: "2026-W43", finished: true, finishedAt: "2026-10-19" },
    { title: "Older open", week: "2026-W40", finished: false },
    { title: "No week open", finished: false },
    { title: "No week done", finished: true, finishedAt: "2026-10-18" },
  ])
  assert.equal(normalizeBacklog(rendered, NOW).text, rendered)
  // Idempotent as well: the output of a pass is itself a fixed point, so a
  // file that is already clean is never rewritten into a different shape.
  assert.equal(normalizeBacklog(normalizeBacklog(rendered, NOW).text, NOW).text, rendered)
})
