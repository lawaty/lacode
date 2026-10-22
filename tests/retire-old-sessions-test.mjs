// Offline unit suite for scripts/retire-old-sessions.mjs.
//
// The tool retires opencode sessions past a retention window together with
// everything that belongs to them: messages, parts, todos, shares, inputs, the
// context epoch and the event rows. It reaches the database through opencode's
// own CLI, one statement per invocation, so no process is spawned here either:
// the helpers that build the SQL are the unit under test, and the statements
// they produce are run against a temporary SQLite file that this file creates.
//
// Two properties are worth a test rather than a comment:
//
//   * THE GRACE WINDOW IS A STOP, NOT A SPEED. A session that is old but was
//     touched an hour ago belongs to somebody who is working in it right now,
//     and a retirement tool that deleted it would be deleting live work. The
//     clock is fixed, so the two sessions that are old but touched stay put
//     for a reason the suite can name.
//   * A CHILD GOES WITH ITS PARENT. opencode's session.parent_id carries no
//     foreign key, so a parent deleted on its own would leave the child behind
//     as an orphan. The candidate query walks the tree, and the delete then
//     takes the child with everything else.
//
// The two ways that promise could be broken are covered here as well:
//
//   * A LIMIT TAKES WHOLE TREES. --limit counts the oldest candidates, and a
//     candidate comes with its children, so a limit that cut a parent from its
//     child would leave exactly the orphan the recursive query exists to
//     prevent. The selection is a pure function, so it is tested on its own.
//   * THE DIRECTORY FILTER PICKS ROOTS, NOT A CLOSURE. --directory selects the
//     sessions rooted in that directory; the recursive arm is not filtered, so
//     a child in another directory goes with its parent.
//
// Run with: node --test tests/retire-old-sessions-test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  candidateSql,
  childTableSql,
  chunkIds,
  computeCutoffs,
  deleteStatement,
  parseArgs,
  parseRows,
  selectSessions,
  summarize,
} from "../scripts/retire-old-sessions.mjs"

const DAY_MS = 86400000
const HOUR_MS = 3600000
// A fixed clock: 2026-10-22T00:00:00Z. Every age below is counted from it, so
// a session's age is arithmetic rather than whatever the wall clock reads when
// the suite runs.
const NOW = Date.parse("2026-10-22T00:00:00Z")

// The schema the tool expects, table for table. No foreign keys are declared:
// opencode's own database does not declare them either (session.parent_id
// carries none), and a cascade would hide exactly the ordering the delete
// depends on.
const SCHEMA = [
  "CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)",
  "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT)",
  "CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  "CREATE TABLE todo(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)",
  "CREATE TABLE session_share(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)",
  "CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)",
  "CREATE TABLE session_input(id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT)",
  "CREATE TABLE session_context_epoch(session_id TEXT PRIMARY KEY, baseline TEXT)",
  "CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)",
  "CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)",
]

// The fixed set of sessions. The three old ones are past both windows; `recent`
// and `touched` are old but were touched inside the grace window, and `young`
// is inside the age window.
const SESSIONS = [
  { id: "old-parent", parent: null, directory: "/a", title: "Old parent", created: NOW - 40 * DAY_MS, updated: NOW - 40 * DAY_MS },
  { id: "old-child", parent: "old-parent", directory: "/a", title: "Old child", created: NOW - 40 * DAY_MS, updated: NOW - 40 * DAY_MS },
  { id: "old-other", parent: null, directory: "/b", title: "Old other", created: NOW - 40 * DAY_MS, updated: NOW - 40 * DAY_MS },
  { id: "recent", parent: null, directory: "/a", title: "Recent", created: NOW - 40 * DAY_MS, updated: NOW - 1 * HOUR_MS },
  { id: "touched", parent: null, directory: "/a", title: "Touched", created: NOW - 40 * DAY_MS, updated: NOW - 2 * HOUR_MS },
  { id: "young", parent: null, directory: "/a", title: "Young", created: NOW - 2 * DAY_MS, updated: NOW - 2 * DAY_MS },
]

/**
 * The rows every session owns, so a delete that reaches further than the
 * selected ids is caught rather than assumed away.
 */
const seed = (db) => {
  const session = db.prepare(
    "INSERT INTO session(id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
  )
  const message = db.prepare("INSERT INTO message(id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
  const part = db.prepare("INSERT INTO part(id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
  const todo = db.prepare("INSERT INTO todo(id, session_id, data) VALUES (?, ?, ?)")
  const share = db.prepare("INSERT INTO session_share(id, session_id, data) VALUES (?, ?, ?)")
  const sessionMessage = db.prepare("INSERT INTO session_message(id, session_id, data) VALUES (?, ?, ?)")
  const input = db.prepare("INSERT INTO session_input(id, session_id, prompt) VALUES (?, ?, ?)")
  const epoch = db.prepare("INSERT INTO session_context_epoch(session_id, baseline) VALUES (?, ?)")
  const event = db.prepare("INSERT INTO event(id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)")
  const sequence = db.prepare("INSERT INTO event_sequence(aggregate_id, seq) VALUES (?, ?)")

  for (const row of SESSIONS) {
    session.run(row.id, "project-1", row.parent, row.id, row.directory, row.title, "1.18.34", row.created, row.updated)
    message.run(`msg-${row.id}`, row.id, row.created, row.updated, "{}")
    part.run(`part-${row.id}`, `msg-${row.id}`, row.id, row.created, row.updated, "{}")
    todo.run(`todo-${row.id}`, row.id, "{}")
    share.run(`share-${row.id}`, row.id, "{}")
    sessionMessage.run(`smsg-${row.id}`, row.id, "{}")
    input.run(`input-${row.id}`, row.id, "hello")
    epoch.run(row.id, `baseline-${row.id}`)
    event.run(`event-${row.id}`, row.id, 1, "message.part.updated", "{}")
    sequence.run(row.id, 1)
  }
}

/**
 * A temporary database with the tables the tool expects and the fixed sessions
 * in them.
 *
 * The fixture lives and dies inside one call, so an assertion that throws
 * still leaves nothing behind in the temporary directory.
 */
const withFixture = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "retire-sessions-"))
  const db = new DatabaseSync(join(dir, "opencode.db"))
  try {
    // The tool runs against opencode's own database, where the foreign keys
    // are already on. Saying so here keeps the fixture honest about that.
    db.exec("PRAGMA foreign_keys = ON")
    for (const statement of SCHEMA) db.exec(statement)
    seed(db)
    return fn(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The statements the tool runs, in the order it runs them: the event tables
 * name their own rows, so nothing cascades them from the session, and the
 * session rows go last because that is what the foreign keys cascade from.
 */
const toolStatements = (childTables, ids) => [
  ...deleteStatement("event", "aggregate_id", ids),
  ...deleteStatement("event_sequence", "aggregate_id", ids),
  ...childTables.flatMap((table) => deleteStatement(table, "session_id", ids)),
  ...deleteStatement("session", "id", ids),
]

/**
 * A table or column name, checked before it goes near a statement -- the same
 * rule the tool applies to its own identifiers.
 */
const identifier = (name) => {
  assert.match(String(name), /^[A-Za-z_][A-Za-z0-9_]*$/, `not a plain SQL identifier: ${name}`)
  return String(name)
}

/** How many rows a table holds for these ids. */
const countRows = (db, table, column, ids) => {
  const name = identifier(table)
  const key = identifier(column)
  const list = ids.map((id) => `'${String(id).split("'").join("''")}'`).join(",")
  return Number(db.prepare(`SELECT count(*) AS c FROM ${name} WHERE ${key} IN (${list})`).get().c)
}

/** The ids a table holds, in a stable order. */
const idsIn = (db, table, column) => {
  const name = identifier(table)
  const key = identifier(column)
  return db.prepare(`SELECT ${key} AS k FROM ${name} ORDER BY ${key} ASC`).all().map((row) => row.k)
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("[US-32] parseArgs starts from the documented defaults", () => {
  assert.deepEqual(parseArgs([]), {
    days: 30,
    graceHours: 24,
    limit: 0,
    directories: [],
    dryRun: false,
    noEvents: false,
    vacuum: false,
    help: false,
  })
  assert.deepEqual(parseArgs(undefined), parseArgs([]), "no argument at all is the same as no argument")
})

test("[US-32] parseArgs reads every flag the usage names", () => {
  assert.deepEqual(
    parseArgs([
      "--days", "60",
      "--grace-hours", "6",
      "--limit", "100",
      "--directory", "/a",
      "--directory", "/b",
      "--dry-run",
      "--no-events",
      "--vacuum",
      "--help",
    ]),
    {
      days: 60,
      graceHours: 6,
      limit: 100,
      directories: ["/a", "/b"],
      dryRun: true,
      noEvents: true,
      vacuum: true,
      help: true,
    },
  )
  assert.equal(parseArgs(["-h"]).help, true, "the short help flag is the long one")
})

test("[US-32] parseArgs leaves the caller's argument list alone", () => {
  const argv = ["--days", "60", "--dry-run"]
  parseArgs(argv)
  assert.deepEqual(argv, ["--days", "60", "--dry-run"], "the tool must not rewrite the array it was handed")
})

test("[US-32] an option the tool does not know is refused", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown option: --nope/)
  assert.throws(
    () => parseArgs(["--nope"]),
    (error) => error.exitCode === 2,
    "a usage mistake must stop the run with the usage exit code",
  )
})

test("[US-32] a flag without its value is refused", () => {
  assert.throws(() => parseArgs(["--days"]), /--days needs a value/)
  assert.throws(() => parseArgs(["--directory"]), /--directory needs a value/)
  // A value that is itself a flag is a missing value, not a value.
  assert.throws(() => parseArgs(["--days", "--limit", "5"]), /--days needs a value/)
})

test("[US-32] a flag whose value is not a number is refused", () => {
  assert.throws(() => parseArgs(["--days", "soon"]), /--days needs a non-negative number/)
  assert.throws(() => parseArgs(["--grace-hours", "-1"]), /--grace-hours needs a non-negative number/)
  assert.throws(() => parseArgs(["--limit", "1.5.2"]), /--limit needs a non-negative number/)
})

// ---------------------------------------------------------------------------
// computeCutoffs
// ---------------------------------------------------------------------------

test("[US-32] computeCutoffs turns the two windows into two timestamps", () => {
  assert.deepEqual(computeCutoffs(NOW, 30, 24), {
    createdCutoff: NOW - 30 * DAY_MS,
    updatedCutoff: NOW - 24 * HOUR_MS,
  })
  assert.deepEqual(computeCutoffs(NOW, 7, 1), {
    createdCutoff: NOW - 7 * DAY_MS,
    updatedCutoff: NOW - 1 * HOUR_MS,
  })
})

// ---------------------------------------------------------------------------
// candidateSql
// ---------------------------------------------------------------------------

test("[US-32] the candidate query selects the old sessions and nothing else", () => {
  withFixture((db) => {
    const cutoffs = computeCutoffs(NOW, 30, 24)
    const rows = db.prepare(candidateSql(cutoffs, [])).all()
    const ids = rows.map((row) => row.id).sort()

    assert.deepEqual(ids, ["old-child", "old-other", "old-parent"])
    assert.ok(!ids.includes("recent"), "a session touched an hour ago is inside the grace window")
    assert.ok(!ids.includes("touched"), "a session touched two hours ago is inside the grace window")
    assert.ok(!ids.includes("young"), "a session two days old is inside the age window")
    assert.ok(ids.includes("old-child"), "the child of an old parent goes with it")
  })
})

test("[US-32] each session is left out for the window the brief names, not another", () => {
  withFixture((db) => {
    // With no grace at all the two touched sessions come back, so what kept
    // them out was the grace window and nothing else.
    const noGrace = computeCutoffs(NOW, 30, 0)
    const touched = db.prepare(candidateSql(noGrace, [])).all().map((row) => row.id).sort()
    assert.deepEqual(touched, ["old-child", "old-other", "old-parent", "recent", "touched"])

    // With a one-day age window the young session comes back, so what kept it
    // out was the age window and nothing else.
    const oneDay = computeCutoffs(NOW, 1, 24)
    const young = db.prepare(candidateSql(oneDay, [])).all().map((row) => row.id).sort()
    assert.deepEqual(young, ["old-child", "old-other", "old-parent", "young"])
  })
})

test("[US-32] the candidate query carries the fields the archive record needs", () => {
  withFixture((db) => {
    const cutoffs = computeCutoffs(NOW, 30, 24)
    const rows = db.prepare(candidateSql(cutoffs, [])).all()
    const child = rows.find((row) => row.id === "old-child")
    assert.equal(child.parent_id, "old-parent")
    assert.equal(child.directory, "/a")
    assert.equal(child.title, "Old child")
    assert.equal(child.project_id, "project-1")
    assert.equal(child.time_created, NOW - 40 * DAY_MS)
    assert.equal(child.time_updated, NOW - 40 * DAY_MS)
  })
})

test("[US-32] a directory filter narrows the selection to that directory", () => {
  withFixture((db) => {
    const cutoffs = computeCutoffs(NOW, 30, 24)
    const other = db.prepare(candidateSql(cutoffs, ["/b"])).all().map((row) => row.id)
    assert.deepEqual(other, ["old-other"])

    const first = db.prepare(candidateSql(cutoffs, ["/a"])).all().map((row) => row.id).sort()
    assert.deepEqual(first, ["old-child", "old-parent"], "the other project's old sessions stay out of it")

    const both = db.prepare(candidateSql(cutoffs, ["/a", "/b"])).all().map((row) => row.id).sort()
    assert.deepEqual(both, ["old-child", "old-other", "old-parent"])
  })
})

test("[US-32] a child in another directory goes with its parent, on purpose", () => {
  withFixture((db) => {
    // The child lives in /b and its parent in /a, and the run is pointed at
    // /a. The child comes along, and that is the deliberate behaviour: the
    // filter selects the sessions ROOTED in the directory, and stranding a
    // child is worse than crossing a directory boundary.
    db.prepare(
      "INSERT INTO session(id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(
      "cross-child",
      "project-1",
      "old-parent",
      "cross-child",
      "/b",
      "Cross child",
      "1.18.34",
      NOW - 40 * DAY_MS,
      NOW - 40 * DAY_MS,
    )

    const cutoffs = computeCutoffs(NOW, 30, 24)
    const rows = db.prepare(candidateSql(cutoffs, ["/a"])).all()
    const cross = rows.find((row) => row.id === "cross-child")
    assert.equal(cross.directory, "/b", "the child really does live in another directory")
    assert.deepEqual(
      rows.map((row) => row.id).sort(),
      ["cross-child", "old-child", "old-parent"],
      "the parent in /a brings the child in /b with it",
    )
  })
})

// ---------------------------------------------------------------------------
// selectSessions
// ---------------------------------------------------------------------------

test("[US-32] no limit selects every candidate", () => {
  const rows = [
    { id: "old-parent", parent_id: null },
    { id: "old-child", parent_id: "old-parent" },
    { id: "old-other", parent_id: null },
  ]
  assert.deepEqual(
    selectSessions(rows, 0).map((row) => row.id),
    ["old-parent", "old-child", "old-other"],
  )
})

test("[US-32] a limit takes the oldest candidates whole, so a child never outlives its parent", () => {
  const rows = [
    { id: "old-parent", parent_id: null },
    { id: "old-child", parent_id: "old-parent" },
    { id: "old-other", parent_id: null },
  ]
  // The flat cut the tool used to take is the orphan the recursive query was
  // written to prevent: the parent goes, and the child stays behind pointing
  // at a parent_id that no longer exists.
  assert.deepEqual(rows.slice(0, 1).map((row) => row.id), ["old-parent"])
  assert.deepEqual(
    selectSessions(rows, 1).map((row) => row.id),
    ["old-parent", "old-child"],
    "the child goes with the parent the limit picked",
  )
})

test("[US-32] a limit keeps a whole tree, not only the children of the root", () => {
  const rows = [
    { id: "old-parent", parent_id: null },
    { id: "old-child", parent_id: "old-parent" },
    { id: "old-grandchild", parent_id: "old-child" },
    { id: "old-other", parent_id: null },
  ]
  assert.deepEqual(
    selectSessions(rows, 1).map((row) => row.id),
    ["old-parent", "old-child", "old-grandchild"],
    "every descendant of the chosen root comes with it",
  )
})

test("[US-32] a candidate whose parent is not a candidate is a root of its own", () => {
  // The recursion descends, it does not climb: a candidate may have a parent
  // that is not a candidate. That parent stays alive and is left alone, and
  // the candidate counts against the limit on its own.
  const rows = [
    { id: "old-child", parent_id: "alive-parent" },
    { id: "old-other", parent_id: null },
  ]
  assert.deepEqual(selectSessions(rows, 1).map((row) => row.id), ["old-child"])
})

test("[US-32] the selected set keeps a child exactly when it keeps its parent", () => {
  withFixture((db) => {
    const cutoffs = computeCutoffs(NOW, 30, 24)
    const rows = db.prepare(candidateSql(cutoffs, [])).all()
    for (const limit of [1, 2, 3]) {
      const selected = selectSessions(rows, limit).map((row) => row.id)
      assert.equal(
        selected.includes("old-child"),
        selected.includes("old-parent"),
        `a limit of ${limit} kept the parent without its child`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// childTableSql
// ---------------------------------------------------------------------------

test("[US-32] the child table query finds every table that owns rows of a session", () => {
  withFixture((db) => {
    const tables = db.prepare(childTableSql()).all().map((row) => row.tbl).sort()
    assert.deepEqual(tables, [
      "message",
      "part",
      "session_context_epoch",
      "session_input",
      "session_message",
      "session_share",
      "todo",
    ])
    assert.ok(!tables.includes("session"), "the session table is not a child of itself")
    assert.ok(!tables.includes("event"), "the event table names its rows by aggregate, not by session")
    assert.ok(!tables.includes("event_sequence"))
  })
})

test("[US-32] the tool's delete list covers every table the child query found", () => {
  withFixture((db) => {
    const childTables = db.prepare(childTableSql()).all().map((row) => row.tbl)
    const statements = toolStatements(childTables, ["old-parent"])
    const tables = statements.map((statement) => /^DELETE FROM ([A-Za-z_][A-Za-z0-9_]*)/.exec(statement)[1])

    assert.deepEqual(
      tables,
      ["event", "event_sequence", ...childTables, "session"],
      "the event tables go first, then every child table, then the session",
    )
    assert.deepEqual(
      [...tables].sort(),
      [
        "event",
        "event_sequence",
        "message",
        "part",
        "session",
        "session_context_epoch",
        "session_input",
        "session_message",
        "session_share",
        "todo",
      ],
      "no table of the fixture is left out of the delete",
    )
  })
})

// ---------------------------------------------------------------------------
// deleteStatement
// ---------------------------------------------------------------------------

test("[US-32] a delete statement names its table and its column and quotes its ids", () => {
  assert.deepEqual(deleteStatement("session", "id", ["old-parent", "old-other"]), [
    "DELETE FROM session WHERE id IN ('old-parent','old-other')",
  ])
})

test("[US-32] a single quote in an id is doubled, so the statement stays one string", () => {
  assert.deepEqual(deleteStatement("session", "id", ["it's"]), [
    "DELETE FROM session WHERE id IN ('it''s')",
  ])
})

test("[US-32] more than five hundred ids are split into several statements", () => {
  const ids = Array.from({ length: 501 }, (_, index) => `id-${index}`)
  const statements = deleteStatement("session", "id", ids)
  assert.equal(statements.length, 2, "a long IN list is a statement-size risk, so it is cut up")
  assert.ok(statements[0].includes("'id-0'"))
  assert.ok(statements[0].includes("'id-499'"))
  assert.ok(!statements[0].includes("'id-500'"))
  assert.equal(statements[1], "DELETE FROM session WHERE id IN ('id-500')")

  assert.equal(deleteStatement("session", "id", ids.slice(0, 500)).length, 1, "exactly five hundred ids still fit")
  assert.deepEqual(deleteStatement("session", "id", []), [], "no ids means no statement to run")
})

test("[US-32] an identifier that is not a plain name is refused", () => {
  assert.throws(() => deleteStatement("session; DROP TABLE session", "id", ["x"]), /unsafe SQL identifier/)
  assert.throws(() => deleteStatement("session", "id; --", ["x"]), /unsafe SQL identifier/)
  assert.throws(() => deleteStatement("session", "1id", ["x"]), /unsafe SQL identifier/)
})

test("[US-32] chunkIds cuts a list into the pieces one statement may carry", () => {
  assert.deepEqual(chunkIds([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunkIds([], 2), [])
  assert.deepEqual(chunkIds(null, 2), [])
  assert.deepEqual(chunkIds([1, 2, 3], 0), [[1, 2, 3]], "a size of zero falls back to the tool's own chunk size")
  assert.equal(chunkIds(Array.from({ length: 500 }, (_, index) => index), 500).length, 1)
})

// ---------------------------------------------------------------------------
// the delete
// ---------------------------------------------------------------------------

test("[US-32] the delete takes the old sessions and everything that belongs to them", () => {
  withFixture((db) => {
    const cutoffs = computeCutoffs(NOW, 30, 24)
    const retired = db.prepare(candidateSql(cutoffs, [])).all().map((row) => row.id)
    const childTables = db.prepare(childTableSql()).all().map((row) => row.tbl)

    for (const statement of toolStatements(childTables, retired)) db.exec(statement)

    assert.deepEqual(
      idsIn(db, "session", "id"),
      ["recent", "touched", "young"],
      "the old sessions and the old child are gone; the rest are untouched",
    )

    for (const table of childTables) {
      assert.equal(countRows(db, table, "session_id", retired), 0, `${table} still holds a retired session's row`)
      assert.equal(countRows(db, table, "session_id", ["recent", "touched", "young"]), 3, `${table} lost a row it should keep`)
    }
    assert.equal(countRows(db, "event", "aggregate_id", retired), 0, "the retired sessions' event rows are gone")
    assert.equal(countRows(db, "event", "aggregate_id", ["recent", "touched", "young"]), 3)
    assert.equal(countRows(db, "event_sequence", "aggregate_id", retired), 0, "their event sequences are gone")
    assert.equal(countRows(db, "event_sequence", "aggregate_id", ["recent", "touched", "young"]), 3)

    const orphans = Number(
      db.prepare("SELECT count(*) AS c FROM event WHERE aggregate_id NOT IN (SELECT id FROM session)").get().c,
    )
    assert.equal(orphans, 0, "no event row may outlive the session it belongs to")
  })
})

test("[US-32] the delete leaves the sessions the grace window kept exactly as they were", () => {
  withFixture((db) => {
    const cutoffs = computeCutoffs(NOW, 30, 24)
    const retired = db.prepare(candidateSql(cutoffs, [])).all().map((row) => row.id)
    const childTables = db.prepare(childTableSql()).all().map((row) => row.tbl)

    for (const statement of toolStatements(childTables, retired)) db.exec(statement)

    for (const id of ["recent", "touched", "young"]) {
      assert.equal(countRows(db, "session", "id", [id]), 1, `${id} must still be a session`)
      assert.equal(countRows(db, "message", "session_id", [id]), 1, `${id} must still own its message`)
      assert.equal(countRows(db, "part", "session_id", [id]), 1, `${id} must still own its part`)
      assert.equal(countRows(db, "todo", "session_id", [id]), 1, `${id} must still own its todo`)
      assert.equal(countRows(db, "session_share", "session_id", [id]), 1, `${id} must still own its share`)
      assert.equal(countRows(db, "session_message", "session_id", [id]), 1, `${id} must still own its session message`)
      assert.equal(countRows(db, "session_input", "session_id", [id]), 1, `${id} must still own its input`)
      assert.equal(countRows(db, "session_context_epoch", "session_id", [id]), 1, `${id} must still own its epoch`)
      assert.equal(countRows(db, "event", "aggregate_id", [id]), 1, `${id} must still own its event rows`)
      assert.equal(countRows(db, "event_sequence", "aggregate_id", [id]), 1, `${id} must still own its event sequence`)
    }
  })
})

// ---------------------------------------------------------------------------
// parseRows
// ---------------------------------------------------------------------------

test("[US-32] parseRows reads the JSON the CLI prints", () => {
  assert.deepEqual(parseRows('[{"id":"old-parent","title":"Old parent"}]'), [
    { id: "old-parent", title: "Old parent" },
  ])
  assert.deepEqual(parseRows("[]"), [])
  assert.deepEqual(parseRows(""), [])
  assert.deepEqual(parseRows("   \n"), [], "a CLI that printed nothing is an empty result, not an error")
})

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test("[US-32] summarize says what went, in one line", () => {
  assert.equal(
    summarize({ sessions: 3, events: 5, children: 7 }),
    "retired 3 session(s) with 5 event row(s) and 7 child row(s)",
  )
  assert.equal(
    summarize({ dryRun: true, sessions: 3, events: 5, children: 7 }),
    "would retire 3 session(s) with 5 event row(s) and 7 child row(s)",
  )
  assert.equal(summarize(), "retired 0 session(s) with 0 event row(s) and 0 child row(s)")
})
