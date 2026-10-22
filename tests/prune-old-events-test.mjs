// Offline unit suite for scripts/prune-old-events.mjs.
//
// opencode keeps a second, uncapped copy of every session transcript in its
// `event` table, and nothing ever prunes it. This tool deletes the event rows
// that are older than a window, except the ones that belong to a session that
// is still alive: a session that takes part in opencode's session sync, a
// session that belongs to a workspace, and a session that was touched inside
// the grace window keep their whole log.
//
// The tool reaches the database only through opencode's own CLI -- one
// statement per invocation, `db --format json "<sql>"` -- so this suite gives
// it a stand-in: a small executable that runs the statement against a
// throwaway SQLite file and prints the rows as a JSON array. The real
// opencode and the real database are never reached: LACODE_OPENCODE_BIN
// points at the stand-in, and HOME points at a temporary directory so the run
// log lands there instead of in the user's own.
//
// Three properties are worth a test rather than a comment:
//
//   * THE ID IS THE CLOCK. An event id carries the millisecond of its own
//     creation in its 12 hex characters, so a text comparison of ids against
//     a computed prefix IS a comparison of times.
//   * THE PROTECTIONS ARE NOT OPTIONAL. Sync, workspace and grace each keep a
//     session's events, and an event whose session is gone is garbage that
//     must go.
//   * THE ERA IS A FLOOR, NOT A CEILING. A window longer than the era the ids
//     live in must not turn the whole table into candidates.
//
// Run with: node --test tests/prune-old-events-test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  candidateSql,
  chunkIds,
  cutoffId,
  main,
  parseArgs,
  parseRows,
  resolveBinary,
  runSql,
  summarize,
} from "../scripts/prune-old-events.mjs"

const DAY_MS = 86400000
const HOUR_MS = 3600000
const MINUTE_MS = 60000
/** One era of event ids: 2^36 ms, 795.4 days. */
const ERA_MS = Math.pow(2, 36)
/** The sub-millisecond counter in the low bits of an event id. */
const ID_COUNTER = 4096
/** The window the fixture is built around. */
const WINDOW_DAYS = 7
/** The grace window the fixture is built around. */
const GRACE_HOURS = 1

// The schema the tool expects, table for table. There is deliberately NO
// foreign key from event to session: the real database declares none either,
// and a cascade would hide exactly the case the tool has to reason about --
// an event whose session row is gone.
const SCHEMA = [
  "CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, workspace_id text)",
  "CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)",
  "CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text)",
  "CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)",
]

/**
 * The sessions of the fixture, and the events that belong to them.
 *
 * `prunable` is the expectation the suite holds the tool to: an event marked
 * prunable must be gone after a run, and an event marked otherwise must still
 * be there. The ages are relative to the moment the fixture is built, because
 * the tool measures its window against the clock as it is.
 *
 * The session ages are deliberately spread: the id of an event orders it by
 * age, so a limit that takes the oldest candidates has to take them in a
 * predictable order.
 */
const FIXTURE = [
  {
    id: "sess-plain",
    session: { updated: 40 * DAY_MS, workspace: null },
    owner: null,
    events: [
      { age: 40 * DAY_MS, prunable: true },
      { age: 40 * DAY_MS + 1000, prunable: true },
    ],
  },
  {
    id: "sess-sync",
    session: { updated: 40 * DAY_MS, workspace: null },
    owner: "owner-1",
    events: [
      { age: 40 * DAY_MS, prunable: false },
      { age: 40 * DAY_MS + 1000, prunable: false },
    ],
  },
  {
    id: "sess-workspace",
    session: { updated: 40 * DAY_MS, workspace: "ws-1" },
    owner: null,
    events: [
      { age: 40 * DAY_MS, prunable: false },
      { age: 40 * DAY_MS + 1000, prunable: false },
    ],
  },
  {
    id: "sess-touched",
    session: { updated: 30 * MINUTE_MS, workspace: null },
    owner: null,
    events: [
      { age: 40 * DAY_MS, prunable: false },
      { age: 40 * DAY_MS + 1000, prunable: false },
    ],
  },
  {
    id: "sess-stale",
    session: { updated: 10 * DAY_MS, workspace: null },
    owner: null,
    events: [
      { age: 39 * DAY_MS, prunable: true },
      { age: 39 * DAY_MS + 1000, prunable: true },
    ],
  },
  {
    id: "sess-mixed",
    session: { updated: 10 * DAY_MS, workspace: null },
    owner: null,
    events: [
      // One event older than the window and one newer than it, in a session
      // that is outside the grace window: so what keeps the second one is
      // its age and nothing else.
      { age: 37 * DAY_MS, prunable: true },
      { age: 2 * HOUR_MS, prunable: false },
    ],
  },
  {
    id: "sess-orphan",
    // No session row and no event_sequence row: the aggregate is garbage.
    session: null,
    owner: null,
    events: [
      { age: 38 * DAY_MS, prunable: true },
      { age: 38 * DAY_MS + 1000, prunable: true },
    ],
  },
]

/** A fixture with nothing to prune: one fresh event and no protection. */
const QUIET_FIXTURE = [
  {
    id: "sess-mixed",
    session: { updated: 10 * DAY_MS, workspace: null },
    owner: null,
    events: [{ age: 2 * HOUR_MS, prunable: false }],
  },
]

/**
 * An event id for a row created at `millis`.
 *
 * The real id is `evt_` + 12 hex chars + 14 random base62 chars, and the hex
 * block is `(epochMillis mod 2^36) * 4096 + counter`: the top 36 bits are the
 * millisecond of the row's creation, so comparing two ids as text compares
 * their times. The suffix only has to be unique -- it orders the rows that
 * share a millisecond.
 */
const eventId = (millis, counter = 0, index = 0) => {
  const withinEra = ((millis % ERA_MS) + ERA_MS) % ERA_MS
  const block = withinEra * ID_COUNTER + counter
  return "evt_" + block.toString(16).padStart(12, "0") + "abcdefghijkl".slice(0, 12) + String(index).padStart(2, "0")
}

/** The rows of a table, in a stable order. */
const rowsIn = (dbPath, table) => {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
  } finally {
    db.close()
  }
}

/** The ids of the event rows that are still there. */
const eventIds = (dbPath) => rowsIn(dbPath, "event").map((row) => row.id)

/**
 * The rows the tool's own candidate query selects, run straight against the
 * fixture: the rule on its own, without a run around it.
 */
const candidates = (fixture, cutoff, grace) => {
  const db = new DatabaseSync(fixture.dbPath)
  try {
    return db.prepare(candidateSql(cutoff, grace, "", 1000)).all().map((row) => row.id)
  } finally {
    db.close()
  }
}

/**
 * The stand-in for opencode's CLI: it runs one statement against the fixture
 * database and prints the rows as a JSON array.
 *
 * It records every call it is given, so a test can prove that the stand-in
 * was the binary the tool used. The only path in it is the temporary
 * database, so the user's own database cannot be reached through it.
 */
const writeStandIn = (dir, dbPath, callsPath) => {
  const file = join(dir, "opencode.mjs")
  const source = `#!/${process.execPath}
import { appendFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

const args = process.argv.slice(2)
if (args[0] !== "db" || args[1] !== "--format" || args[2] !== "json" || args.length !== 4) {
  process.stderr.write("usage: opencode db --format json <sql>\\n")
  process.exit(2)
}
const sql = args[3]
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n")
const db = new DatabaseSync(${JSON.stringify(dbPath)})
let rows = []
try {
  if (/^(select|with|pragma)\\b/i.test(sql.trim())) rows = db.prepare(sql).all()
  else db.exec(sql)
} finally {
  db.close()
}
process.stdout.write(JSON.stringify(rows))
`
  writeFileSync(file, source)
  chmodSync(file, 0o755)
  return file
}

/** The rows the fixture seeds, and the expectations they carry. */
const build = (db, now, definition) => {
  const insertSession = db.prepare(
    "INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const insertEvent = db.prepare("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)")
  const insertSequence = db.prepare("INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, ?)")

  const rows = []
  const bySession = {}
  let index = 0
  for (const entry of definition) {
    if (entry.session) {
      insertSession.run(
        entry.id,
        "project-1",
        "/tmp/project",
        entry.id,
        "1.18.34",
        now - 40 * DAY_MS,
        now - entry.session.updated,
        entry.session.workspace,
      )
    }
    let seq = 0
    for (const item of entry.events) {
      seq += 1
      const id = eventId(now - item.age, 0, index)
      const data = "x".repeat(100 + index * 10)
      insertEvent.run(id, entry.id, seq, "message.part.updated", data)
      const row = { id, aggregate: entry.id, data, prunable: item.prunable }
      rows.push(row)
      if (!bySession[entry.id]) bySession[entry.id] = []
      bySession[entry.id].push(row)
      index += 1
    }
    if (entry.session) insertSequence.run(entry.id, seq, entry.owner)
  }
  return { rows, bySession }
}

/**
 * A throwaway database, a stand-in for the opencode CLI and a temporary home
 * directory: everything a run of the tool can reach.
 *
 * The fixture lives and dies inside one call, so an assertion that throws
 * still leaves nothing behind in the temporary directory.
 */
const withFixture = async (fn, options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "prune-events-"))
  const home = join(dir, "home")
  mkdirSync(home, { recursive: true })
  const dbPath = join(dir, "opencode.db")
  const callsPath = join(dir, "calls.jsonl")
  try {
    const db = new DatabaseSync(dbPath)
    // One clock for the whole fixture: the ages of the rows and the cutoff
    // the suite computes are counted from the same moment.
    const now = Date.now()
    let built
    try {
      for (const statement of SCHEMA) db.exec(statement)
      built = build(db, now, options.quiet ? QUIET_FIXTURE : FIXTURE)
    } finally {
      db.close()
    }
    const bin = writeStandIn(dir, dbPath, callsPath)
    const prunable = built.rows.filter((row) => row.prunable)
    const fixture = {
      dir,
      home,
      dbPath,
      callsPath,
      bin,
      now,
      rows: built.rows,
      bySession: built.bySession,
      logPath: join(home, ".local", "share", "opencode", "lacode", "event-prune.jsonl"),
      prunableIds: prunable.map((row) => row.id),
      keptIds: built.rows.filter((row) => !row.prunable).map((row) => row.id),
      prunableBytes: prunable.reduce((sum, row) => sum + row.data.length, 0),
      prunableAggregates: new Set(prunable.map((row) => row.aggregate)).size,
    }
    return await fn(fixture)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A run of the tool, with the fixture's binary and home directory in place.
 *
 * The tool reads LACODE_OPENCODE_BIN and the home directory when it runs, so
 * both are set around the call and put back afterwards, and the output is
 * collected instead of printed.
 */
const runTool = async (fixture, argv) => {
  const previousBin = process.env.LACODE_OPENCODE_BIN
  const previousHome = process.env.HOME
  const out = []
  const err = []
  const warned = []
  const log = console.log
  const error = console.error
  const warn = console.warn
  process.env.LACODE_OPENCODE_BIN = fixture.bin
  process.env.HOME = fixture.home
  console.log = (...parts) => out.push(parts.join(" "))
  console.error = (...parts) => err.push(parts.join(" "))
  console.warn = (...parts) => warned.push(parts.join(" "))
  try {
    const code = await main(argv)
    return { code, stdout: out.join("\n"), stderr: err.join("\n"), warn: warned.join("\n"), binary: resolveBinary() }
  } finally {
    console.log = log
    console.error = error
    console.warn = warn
    if (previousBin === undefined) delete process.env.LACODE_OPENCODE_BIN
    else process.env.LACODE_OPENCODE_BIN = previousBin
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

/** The log lines the run left behind. */
const logLines = (fixture) => {
  if (!existsSync(fixture.logPath)) return []
  return readFileSync(fixture.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
}

/** The calls the stand-in binary received. */
const calls = (fixture) => {
  if (!existsSync(fixture.callsPath)) return []
  return readFileSync(fixture.callsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
}

// ---------------------------------------------------------------------------
// cutoffId
// ---------------------------------------------------------------------------

test("[US-33] cutoffId is a 12 hex digit prefix that decodes to the cutoff", () => {
  const now = Date.now()
  const id = cutoffId(now, 7)
  assert.match(id, /^evt_[0-9a-f]{12}$/, "the cutoff is a prefix, not a full id")

  const block = Number.parseInt(id.slice(4), 16)
  const decoded = Math.floor(block / ID_COUNTER)
  const expected = (((now - 7 * DAY_MS) % ERA_MS) + ERA_MS) % ERA_MS
  assert.equal(decoded, expected, "the hex block carries the millisecond of the cutoff")

  // The prefix has to sort BELOW the ids of the rows it is a prefix of, and
  // ABOVE the ids of the rows that are too young: that is the whole trick.
  const older = eventId(now - 8 * DAY_MS, 0, 1)
  const younger = eventId(now - 6 * DAY_MS, 0, 2)
  assert.ok(older < id, "a row older than the cutoff sorts below the cutoff")
  assert.ok(younger > id, "a row younger than the cutoff sorts above the cutoff")
})

// ---------------------------------------------------------------------------
// the candidate rules
// ---------------------------------------------------------------------------

test("[US-33] an event older than the window is a candidate and a newer one is not", async () => {
  await withFixture(async (fixture) => {
    const cutoff = cutoffId(fixture.now, WINDOW_DAYS)
    const ids = candidates(fixture, cutoff, fixture.now - GRACE_HOURS * HOUR_MS)
    const old = fixture.bySession["sess-plain"][0]
    const fresh = fixture.bySession["sess-mixed"][1]
    assert.ok(ids.includes(old.id), "an event older than the window is a candidate")
    assert.ok(!ids.includes(fresh.id), "an event newer than the window is not a candidate")
  })
})

test("[US-33] a session that takes part in the session sync is never touched", async () => {
  await withFixture(async (fixture) => {
    // The rule on its own, before the run: nothing of that session is a
    // candidate, so nothing of it can be taken.
    const cutoff = cutoffId(fixture.now, WINDOW_DAYS)
    const ids = candidates(fixture, cutoff, fixture.now - GRACE_HOURS * HOUR_MS)
    for (const row of fixture.bySession["sess-sync"]) {
      assert.ok(!ids.includes(row.id), "a synced session's event rows are not candidates")
    }

    const result = await runTool(fixture, ["--days", String(WINDOW_DAYS), "--grace-hours", String(GRACE_HOURS)])
    assert.equal(result.code, 0)

    const after = eventIds(fixture.dbPath)
    for (const row of fixture.bySession["sess-sync"]) {
      assert.ok(after.includes(row.id), "a synced session keeps its event rows")
    }
  })
})

test("[US-33] a session that belongs to a workspace is never touched", async () => {
  await withFixture(async (fixture) => {
    const cutoff = cutoffId(fixture.now, WINDOW_DAYS)
    const ids = candidates(fixture, cutoff, fixture.now - GRACE_HOURS * HOUR_MS)
    for (const row of fixture.bySession["sess-workspace"]) {
      assert.ok(!ids.includes(row.id), "a workspace session's event rows are not candidates")
    }

    const result = await runTool(fixture, ["--days", String(WINDOW_DAYS), "--grace-hours", String(GRACE_HOURS)])
    assert.equal(result.code, 0)

    const after = eventIds(fixture.dbPath)
    for (const row of fixture.bySession["sess-workspace"]) {
      assert.ok(after.includes(row.id), "a workspace session keeps its event rows")
    }
  })
})

test("[US-33] the grace window keeps a touched session and lets a stale one go", async () => {
  await withFixture(async (fixture) => {
    // The two sessions differ in nothing but the moment they were touched, so
    // what kept one out was the grace window and nothing else.
    const cutoff = cutoffId(fixture.now, WINDOW_DAYS)
    const withGrace = candidates(fixture, cutoff, fixture.now - GRACE_HOURS * HOUR_MS)
    assert.ok(!withGrace.includes(fixture.bySession["sess-touched"][0].id))
    assert.ok(withGrace.includes(fixture.bySession["sess-stale"][0].id))

    const result = await runTool(fixture, ["--days", String(WINDOW_DAYS), "--grace-hours", String(GRACE_HOURS)])
    assert.equal(result.code, 0)

    const after = eventIds(fixture.dbPath)
    for (const row of fixture.bySession["sess-touched"]) {
      assert.ok(after.includes(row.id), "a session touched inside the grace window keeps all of its events")
    }
    for (const row of fixture.bySession["sess-stale"]) {
      assert.ok(!after.includes(row.id), "a session touched outside the grace window has its old events pruned")
    }
  })
})

test("[US-33] an event whose session is gone is prunable, because it is garbage", async () => {
  await withFixture(async (fixture) => {
    const cutoff = cutoffId(fixture.now, WINDOW_DAYS)
    const ids = candidates(fixture, cutoff, fixture.now - GRACE_HOURS * HOUR_MS)
    for (const row of fixture.bySession["sess-orphan"]) {
      assert.ok(ids.includes(row.id), "an event without a session is a candidate")
    }

    const result = await runTool(fixture, ["--days", String(WINDOW_DAYS), "--grace-hours", String(GRACE_HOURS)])
    assert.equal(result.code, 0)

    const after = eventIds(fixture.dbPath)
    for (const row of fixture.bySession["sess-orphan"]) {
      assert.ok(!after.includes(row.id), "an event without a session is garbage and must go")
    }
  })
})

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

test("[US-33] --dry-run reports the counts and deletes nothing", async () => {
  await withFixture(async (fixture) => {
    const before = rowsIn(fixture.dbPath, "event")
    const result = await runTool(fixture, ["--dry-run"])
    assert.equal(result.code, 0)

    assert.deepEqual(rowsIn(fixture.dbPath, "event"), before, "a dry run changes nothing")

    const lines = logLines(fixture)
    assert.equal(lines.length, 1, "a dry run leaves its record too")
    const record = JSON.parse(lines[0])
    assert.equal(record.rows, fixture.prunableIds.length, "the row count")
    assert.equal(record.bytes, fixture.prunableBytes, "the byte count")
    assert.equal(record.aggregates, fixture.prunableAggregates, "the aggregate count")
    assert.equal(record.dryRun, true)
  })
})

test("[US-33] a real run deletes exactly the candidate rows and keeps the rest", async () => {
  await withFixture(async (fixture) => {
    const result = await runTool(fixture, [])
    assert.equal(result.code, 0)

    assert.equal(result.binary, fixture.bin, "the run went through the stand-in binary")
    const seen = calls(fixture)
    assert.ok(seen.length > 0, "the run reached the database through the CLI seam")
    assert.ok(
      seen.every((args) => args[0] === "db" && args[1] === "--format" && args[2] === "json" && args.length === 4),
      "every statement went through the CLI seam, one statement per invocation",
    )

    const after = eventIds(fixture.dbPath)
    assert.deepEqual(after.slice().sort(), fixture.keptIds.slice().sort(), "only the candidates are gone")
    assert.deepEqual(
      after.filter((id) => fixture.prunableIds.includes(id)),
      [],
      "no candidate survived the run",
    )
  })
})

test("[US-33] a run never changes the event_sequence table or the session table", async () => {
  await withFixture(async (fixture) => {
    const sessions = rowsIn(fixture.dbPath, "session")
    const sequences = rowsIn(fixture.dbPath, "event_sequence")

    const result = await runTool(fixture, [])
    assert.equal(result.code, 0)

    assert.deepEqual(rowsIn(fixture.dbPath, "session"), sessions, "the session table is not the tool's business")
    assert.deepEqual(rowsIn(fixture.dbPath, "event_sequence"), sequences, "no event sequence is deleted or changed")
  })
})

test("[US-33] --limit takes at most that many rows and reports the rest", async () => {
  await withFixture(async (fixture) => {
    const limit = 3
    const result = await runTool(fixture, ["--limit", String(limit)])
    assert.equal(result.code, 0)

    const after = eventIds(fixture.dbPath)
    const deleted = fixture.prunableIds.filter((id) => !after.includes(id)).sort()
    assert.equal(deleted.length, limit, "no more than the limit goes")
    assert.deepEqual(
      deleted,
      fixture.prunableIds.slice().sort().slice(0, limit),
      "the oldest candidates go first",
    )

    const lines = logLines(fixture)
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0])
    assert.equal(record.rows, limit, "the record counts what went, not what could have gone")

    const rest = fixture.prunableIds.length - limit
    assert.ok(
      result.stdout
        .split("\n")
        .some((line) => (line.match(/\d+/g) || []).map(Number).includes(rest)),
      `the report names the ${rest} candidate row(s) left for a later run`,
    )
  })
})

test("[US-33] a run leaves one JSON line in the log and a run with nothing to prune leaves none", async () => {
  await withFixture(async (fixture) => {
    const result = await runTool(fixture, [])
    assert.equal(result.code, 0)

    const lines = logLines(fixture)
    assert.equal(lines.length, 1, "exactly one line per run")

    const record = JSON.parse(lines[0])
    assert.equal(record.rows, fixture.prunableIds.length, "the row count")
    assert.equal(record.bytes, fixture.prunableBytes, "the byte count")
    assert.equal(record.aggregates, fixture.prunableAggregates, "the aggregate count")
    assert.equal(record.dryRun, false)
    assert.equal(record.days, WINDOW_DAYS)
    assert.equal(record.graceHours, GRACE_HOURS)
    assert.match(record.cutoff, /^evt_[0-9a-f]{12}$/, "the record carries the cutoff it used")
    assert.equal(typeof record.elapsedMs, "number")
    assert.ok(
      Math.abs(Date.parse(record.ts) - Date.now()) < 60000,
      "the record is stamped with the moment of the run",
    )
  })

  await withFixture(
    async (fixture) => {
      const result = await runTool(fixture, [])
      assert.equal(result.code, 0)
      assert.deepEqual(logLines(fixture), [], "a run with nothing to prune writes no line")
      assert.equal(eventIds(fixture.dbPath).length, fixture.rows.length, "and changes nothing")
    },
    { quiet: true },
  )
})

test("[US-33] --help exits 0 and an unknown flag exits 2", async () => {
  await withFixture(async (fixture) => {
    const help = await runTool(fixture, ["--help"])
    assert.equal(help.code, 0)
    assert.ok(help.stdout.includes("--days"), "the usage names the flags it takes")
    assert.deepEqual(calls(fixture), [], "the usage touches no database")

    const bad = await runTool(fixture, ["--nope"])
    assert.equal(bad.code, 2, "a usage mistake is the usage exit code")
    assert.ok(bad.stderr.includes("--nope"), "the refusal names the flag it did not know")
    assert.deepEqual(calls(fixture), [], "a usage mistake touches no database")
  })
})

test("[US-33] a window longer than the id era must not take the whole table", async () => {
  await withFixture(async (fixture) => {
    const before = eventIds(fixture.dbPath).length
    // A thousand days is longer than the whole era, so the cutoff would fall
    // into an older era without the clamp -- and every row in the table would
    // look older than it.
    const result = await runTool(fixture, ["--days", "1000"])
    assert.equal(result.code, 0)

    const after = eventIds(fixture.dbPath)
    assert.ok(after.length > 0, "the run must not wipe the event table")
    assert.equal(before, fixture.rows.length, "and it started with a full table")

    const fresh = fixture.bySession["sess-mixed"][1]
    assert.ok(
      after.includes(fresh.id),
      "an event from hours ago survives a window of any length, because nothing but the window protected it",
    )

    // And the operator is told, because a window that was quietly shortened is
    // a window that would quietly prune less than it says.
    assert.ok(result.warn.trim() !== "", "the operator is told that the window was clamped")
  })
})

// ---------------------------------------------------------------------------
// the pieces the run is made of
// ---------------------------------------------------------------------------

test("[US-33] parseArgs reads the flags the usage names and refuses the ones it does not", () => {
  assert.deepEqual(parseArgs([]), {
    days: 7,
    graceHours: 1,
    limit: 0,
    dryRun: false,
    vacuum: false,
    help: false,
  })
  assert.deepEqual(
    parseArgs(["--days", "30", "--grace-hours", "6", "--limit", "100", "--dry-run", "--vacuum", "--help"]),
    {
      days: 30,
      graceHours: 6,
      limit: 100,
      dryRun: true,
      vacuum: true,
      help: true,
    },
  )
  assert.equal(parseArgs(["-h"]).help, true, "the short help flag is the long one")
  assert.throws(() => parseArgs(["--nope"]), /unknown option: --nope/)
  assert.throws(() => parseArgs(["--days"]), /--days needs a value/)
  assert.throws(() => parseArgs(["--days", "soon"]), /--days needs a non-negative number/)
})

test("[US-33] parseRows reads the JSON the CLI prints", () => {
  assert.deepEqual(parseRows('[{"id":"evt_000000000000"}]'), [{ id: "evt_000000000000" }])
  assert.deepEqual(parseRows("[]"), [])
  assert.deepEqual(parseRows(""), [])
  assert.deepEqual(parseRows("   \n"), [], "a CLI that printed nothing is an empty result, not an error")
})

test("[US-33] resolveBinary takes the explicit binary first", async () => {
  await withFixture(async (fixture) => {
    const previous = process.env.LACODE_OPENCODE_BIN
    process.env.LACODE_OPENCODE_BIN = fixture.bin
    try {
      assert.equal(resolveBinary(), fixture.bin, "the explicit binary wins over everything else")
    } finally {
      if (previous === undefined) delete process.env.LACODE_OPENCODE_BIN
      else process.env.LACODE_OPENCODE_BIN = previous
    }
  })
})

test("[US-33] runSql runs one statement through the binary and returns its rows", async () => {
  await withFixture(async (fixture) => {
    const rows = runSql(fixture.bin, "SELECT count(*) AS c FROM event")
    assert.equal(Number(rows[0].c), fixture.rows.length)
    const seen = calls(fixture)
    assert.equal(seen.length, 1, "one statement, one invocation")
    assert.equal(seen[0][3], "SELECT count(*) AS c FROM event")
  })
})

test("[US-33] chunkIds cuts a list into the pieces one statement may carry", () => {
  assert.deepEqual(chunkIds([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunkIds([], 2), [])
  assert.deepEqual(chunkIds(null, 2), [])
  assert.deepEqual(chunkIds([1, 2, 3], 0), [[1, 2, 3]], "a size of zero falls back to the tool's own chunk size")
})

test("[US-33] summarize puts the counts in one line", () => {
  const numbers = (line) => (line.match(/\d+/g) || []).map(Number).sort((a, b) => a - b)
  assert.deepEqual(numbers(summarize({ rows: 3, bytes: 120, aggregates: 2 })), [2, 3, 120], "the counts are in the line")
  assert.deepEqual(
    numbers(summarize({ dryRun: true, rows: 3, bytes: 120, aggregates: 2 })),
    [2, 3, 120],
    "a dry run reports the same counts",
  )
  assert.ok(!summarize({ rows: 3, bytes: 120, aggregates: 2 }).includes("\n"), "the summary is one line")
})
