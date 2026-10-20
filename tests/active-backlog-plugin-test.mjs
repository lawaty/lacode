// Integration suite for the plugin side of the active backlog: the rolling
// window in src/lib/active-backlog.ts wired into the context-autoupdate hook.
//
// A PLAIN test, not a story: it is an integration test of the plugin hook, not
// a user story, so it carries no [US-N] tag and lives outside tests/stories/
// (only tests/stories/ is scanned by the coverage guard).
//
// tests/active-backlog-test.mjs already pins the WINDOW itself — the strict
// seven-day boundary, the fixed point — against a pure function and a fixed
// clock. What only an integration test can pin is the plugin's half of the
// contract:
//
//   * the hook factory — the REAL one, not a copy — normalizes the file on a
//     `file.edited` for `.opencode/context/active.md`, dropping the aged-out
//     task and regrouping the survivors;
//   * a backlog edit never enters `pending`, so it cannot schedule a
//     cartography run: the plugin maintains this one map file itself;
//   * the rewrite cannot loop: a second pass over the canonical file changes
//     nothing (normalize is a fixed point, and the plugin only writes when the
//     canonical form differs from what is on disk);
//   * the drop is reported through the log, not silent.
//
// The plugin calls normalizeBacklog with the DEFAULT clock, so the fixtures
// derive their dates from Date.now() rather than a hard-coded calendar day:
// the boundary is seven days from "now", and "now" is whenever the suite runs.
//
// The boot mirrors tests/stories/g-context-management.test.mjs: stub client,
// temp project root, temp HOME (so the pool's claim dir never touches the
// developer's ~/.local/share/opencode/agent-pool), and modelsFile pinned to
// the bundled preset (so a developer's own ~/.config/lacode/pool.txt cannot
// leak in).

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { contextAutoUpdateHooks } from "../src/plugins/context-autoupdate.ts"
import { PRESET, cleanupAll, scratch, stubInput } from "./stories/_harness.mjs"

test.after(cleanupAll)

const DAY_MS = 24 * 60 * 60 * 1000

/** The calendar date `msAgo` milliseconds before now, as the file spells it. */
const isoDay = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 10)

/** The ISO week ("2026-W43") containing the instant `msAgo` before now. */
const isoWeek = (msAgo) => {
  const d = new Date(Date.now() - msAgo)
  d.setUTCHours(0, 0, 0, 0)
  // Thursday of the ISO week: the year and week numbers are read off it.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/**
 * Run with a temporary HOME.
 *
 * The factory calls pool.state() at boot, which resolves its claim directory
 * from $HOME at that moment. Pointing HOME at a temp directory is what keeps
 * this test off the real ~/.local/share/opencode/agent-pool.
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
 * Boot the REAL hook factory against a throwaway project.
 *
 * No active.md is written before the factory runs: the factory normalizes the
 * file from the moment it boots, so a fixture written earlier would be pruned
 * by the boot pass and the subsequent `file.edited` would find nothing to drop
 * — hiding exactly the behaviour this file pins. The fixture lands AFTER boot,
 * and the edit event is what must prune it.
 */
const bootWithBacklog = async (fixture) => {
  const root = scratch("backlog-proj-")
  const mapDir = join(root, ".opencode", "context")
  mkdirSync(mapDir, { recursive: true })
  const stub = stubInput({
    sessions: { root: { id: "root", title: "main" } },
    directory: root,
  })
  const home = scratch("backlog-home-")
  const hooks = await withHome(home, () => contextAutoUpdateHooks(stub.input, { modelsFile: PRESET }))
  const backlogPath = join(mapDir, "active.md")
  writeFileSync(backlogPath, fixture)
  return { stub, hooks, backlogPath }
}

test("a backlog edit is normalized in place, pruned by the window, and never schedules a cartography run", async () => {
  // Ages and weeks are counted from the REAL clock, because the plugin calls
  // normalizeBacklog with the default `now`. Two days is comfortably inside
  // the window and nine comfortably past it, so no time-of-day edge can flip
  // either side of the boundary.
  const thisWeek = isoWeek(0)
  const lastWeek = isoWeek(7 * DAY_MS) // exactly one ISO week back, always distinct
  const finishedRecent = isoDay(2 * DAY_MS)
  const finishedStale = isoDay(9 * DAY_MS)

  // A hand-formatted mixture: an open task, a recently-finished task, a
  // finished task past the window, and an open task with no week at all.
  const fixture = [
    `## ${lastWeek}`,
    "",
    `- [x] Stale chore — opened ${lastWeek}, finished ${finishedStale}`,
    `- [ ] Old open work — opened ${lastWeek}`,
    "",
    `## ${thisWeek}`,
    "",
    `- [x] Recently done — opened ${thisWeek}, finished ${finishedRecent}`,
    `- [ ] Fresh open task — opened ${thisWeek}`,
    "",
    "## Unscheduled",
    "",
    "- [ ] Weekless open task",
    "",
  ].join("\n")

  const { stub, hooks, backlogPath } = await bootWithBacklog(fixture)

  // Fire the hook for the backlog's exact path and await it.
  await hooks.event({ event: { type: "file.edited", properties: { file: ".opencode/context/active.md" } } })
  const after = readFileSync(backlogPath, "utf8")

  // The rolling window dropped the nine-day-old finished task, anywhere in
  // the file, and kept everything else.
  assert.ok(!after.includes("Stale chore"), `a task finished more than a week ago must be gone:\n${after}`)
  assert.ok(after.includes("Old open work"), "an open task never expires, however old it is")
  assert.ok(after.includes("Recently done"), "a task finished inside the window stays")
  assert.ok(after.includes(`finished ${finishedRecent}`), "the survivor keeps its finish date")
  assert.ok(after.includes("Weekless open task"), "an open task with no week stays, unscheduled")

  // The survivors are grouped by week, newest first, Unscheduled last.
  const headings = after.split("\n").filter((line) => line.startsWith("## "))
  assert.deepEqual(headings, [`## ${thisWeek}`, `## ${lastWeek}`, "## Unscheduled"], "survivors must be regrouped by week")

  // The backlog is the one map file the PLUGIN maintains: an edit to it must
  // never enter `pending`, so going idle afterwards spawns no cartographer.
  assert.equal(stub.created.length, 0, "editing the backlog must not schedule a cartography run")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.equal(stub.created.length, 0, "an idle session after a backlog edit must still spawn nothing")

  // The drop is reported, not silent: one log line naming the count.
  const dropLines = stub.text().filter((line) => line.includes("dropped 1 task"))
  assert.equal(dropLines.length, 1, `the drop must be logged exactly once:\n${stub.text().join("\n")}`)
  assert.ok(dropLines[0].startsWith("info "), `the drop is housekeeping, reported at info:\n${dropLines[0]}`)

  // The write cannot loop: normalize is a fixed point, and the plugin writes
  // only when the canonical form differs from what is on disk.
  await hooks.event({ event: { type: "file.edited", properties: { file: ".opencode/context/active.md" } } })
  assert.equal(readFileSync(backlogPath, "utf8"), after, "a second pass over a clean file must change nothing")
  assert.equal(
    stub.text().filter((line) => line.includes("dropped 1 task")).length,
    1,
    "the second pass has nothing to drop and must stay silent",
  )
})
