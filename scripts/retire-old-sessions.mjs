// Retire opencode sessions that are older than a retention window, together
// with everything that belongs to them, and keep a compact record of what went.
//
// opencode has no session retention of its own: no age prune, no TTL, no bulk
// delete endpoint. The session list grows until the database is unwieldy, and
// the only way to remove a session is to delete it one at a time. This tool is
// the general case of what scripts/retire-cartographer-sessions.mjs does for
// the cartographer's own runs: every session past the window, and every row
// that belongs to it.
//
//   node scripts/retire-old-sessions.mjs --dry-run
//   node scripts/retire-old-sessions.mjs --days 60 --grace-hours 6
//   node scripts/retire-old-sessions.mjs --directory /path/to/project --limit 100
//
//   --directory D      only sessions of this project directory (a child always goes with its parent)
//
// All SQL goes through opencode's own CLI -- `opencode db --format json "<sql>"` --
// because that is the one place the database is reachable wherever opencode
// runs: no sqlite module, no node 22, and the foreign keys are already on.
// The CLI runs exactly the statement it is given, so every call carries one.
//
// This file stays inside ES2019 on purpose: the remote host runs node 12.22.9
// (/usr/bin/node) and nothing else, so there is no `?.`, no `??`, no `node:`
// import prefix, no top-level await and no `import.meta.dirname` in it. ESM is
// fine -- node 12.17 runs a .mjs file unflagged.
//
// What is kept: a compact record per retired session, in
// ~/.local/share/opencode/lacode/session-archive/. Who ran it, where, when,
// and what it was called.

import { spawnSync } from "child_process"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { homedir } from "os"
import path from "path"
import { fileURLToPath } from "url"

const DAY_MS = 86400000
const HOUR_MS = 3600000
/** How many ids one DELETE statement may carry. */
const CHUNK_SIZE = 500
const DEFAULT_DAYS = 30
const DEFAULT_GRACE_HOURS = 24
/** How many sessions a dry run names before it counts the rest. */
const DRY_RUN_ROWS = 20

const USAGE = `node scripts/retire-old-sessions.mjs [options]

  --days N           retention window in days, by time_created   (default 30)
  --grace-hours N    skip anything touched more recently than this (default 24)
  --limit N          delete at most N sessions                    (default 0 = no limit)
  --directory D      only sessions of this project directory (a child always goes with its parent)
  --dry-run          report what would go; change nothing
  --no-events        keep the event rows of deleted sessions
  --vacuum           rewrite the database afterwards so the freed pages go back to the filesystem
  --help             print the usage and exit 0`

/** A SQL string literal, with the single quotes doubled. */
const quote = (value) => "'" + String(value).split("'").join("''") + "'"

/** A table or column name, checked before it goes near a statement. */
const identifier = (name) => {
  const text = String(name)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new Error(`unsafe SQL identifier: ${text}`)
  return text
}

/** The error text without the terminal colours the CLI prints it in. */
const plain = (text) =>
  String(text === undefined || text === null ? "" : text).split(/\u001b\[[0-9;]*m/).join("")

/** Where the records go; LACODE_ARCHIVE_DIR overrides the default. */
const archiveDir = () => {
  const override = process.env.LACODE_ARCHIVE_DIR
  if (override) return override
  return path.join(homedir(), ".local", "share", "opencode", "lacode", "session-archive")
}

/**
 * The opencode binary: the explicit one, then the one in the home directory
 * (a non-interactive shell has no PATH entry for it, and a systemd unit has no
 * PATH at all), then whatever PATH offers.
 */
export const resolveBinary = () => {
  const explicit = process.env.OPENCODE_BIN
  if (explicit) return explicit
  const home = path.join(homedir(), ".opencode", "bin", "opencode")
  if (existsSync(home)) return home
  return "opencode"
}

/**
 * The database the CLI opens: the explicit one, then the path the CLI itself
 * prints, then the default location.
 */
export const resolveDatabasePath = (bin) => {
  const explicit = process.env.OPENCODE_DB
  if (explicit) return explicit
  const result = spawnSync(bin, ["db", "path"], { encoding: "utf8" })
  if (!result.error && result.status === 0) {
    const printed = String(result.stdout || "").trim()
    if (printed) return printed
  }
  return path.join(homedir(), ".local", "share", "opencode", "opencode.db")
}

/**
 * One statement, one invocation: the CLI runs exactly the statement it is
 * given, and a multi-statement string would silently run only the first.
 */
const runSql = (bin, sql) => {
  const result = spawnSync(bin, ["db", "--format", "json", sql], { encoding: "utf8" })
  if (result.error) throw new Error(`${bin}: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = plain(result.stderr).trim() || plain(result.stdout).trim() || `exit ${result.status}`
    throw new Error(`statement failed: ${detail}\n  ${sql.slice(0, 160)}`)
  }
  return parseRows(result.stdout)
}

/** The rows the CLI printed, as an array. */
export const parseRows = (stdout) => {
  const text = stdout === undefined || stdout === null ? "" : String(stdout).trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`could not read the database output as JSON: ${error.message}`)
  }
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** The two cutoffs: how old a session is, and how long ago it was touched. */
export const computeCutoffs = (now, days, graceHours) => ({
  createdCutoff: now - days * DAY_MS,
  updatedCutoff: now - graceHours * HOUR_MS,
})

/**
 * The sessions past the window, with their descendants.
 *
 * The recursive part is what keeps a child from being orphaned: opencode's
 * session.parent_id carries no foreign key, so a parent deleted on its own
 * would leave the child behind.
 */
export const candidateSql = (cutoffs, directories) => {
  const dirs = Array.isArray(directories) ? directories : []
  // The directory filter sits on the anchor on purpose: the recursive arm is
  // not filtered, because a child that belongs to a selected parent goes with
  // it, even when the child sits in another directory.
  const filter = dirs.length ? ` AND directory IN (${dirs.map(quote).join(",")})` : ""
  return [
    "WITH RECURSIVE targets(id) AS (",
    `  SELECT id FROM session WHERE time_created < ${cutoffs.createdCutoff} AND time_updated < ${cutoffs.updatedCutoff}${filter}`,
    "  UNION",
    "  SELECT s.id FROM session s JOIN targets t ON s.parent_id = t.id",
    ")",
    "SELECT t.id AS id, s.title AS title, s.directory AS directory, s.project_id AS project_id,",
    "       s.parent_id AS parent_id, s.time_created AS time_created, s.time_updated AS time_updated",
    "FROM targets t JOIN session s ON s.id = t.id ORDER BY s.time_created ASC",
  ].join("\n")
}

/**
 * The sessions a run touches: every candidate, or -- under a limit -- the
 * oldest top-level candidates together with everything below them.
 *
 * The limit is taken over the TOP-LEVEL rows, not over the flat list: a limit
 * that cuts a parent from its child is the orphan the recursive query was
 * written to prevent. A top-level row is one whose parent is not among the
 * candidates -- the recursion descends, it does not climb, so a candidate may
 * have a parent that stays alive, and that parent is left alone.
 */
export const selectSessions = (rows, limit) => {
  const list = Array.isArray(rows) ? rows : []
  const max = Number(limit) || 0
  if (max <= 0) return list.slice()

  // The map of the candidate set: id -> the parent it names, whether or not
  // that parent is itself a candidate.
  const parents = new Map()
  for (const row of list) parents.set(row.id, row.parent_id === undefined ? null : row.parent_id)

  const roots = []
  for (const row of list) {
    const parent = parents.get(row.id)
    if (parent === null || parent === undefined || !parents.has(parent)) roots.push(row)
  }

  // The rows the limit names: the oldest roots, oldest first, because the
  // query sorts by creation time.
  const chosen = new Set()
  for (const root of roots.slice(0, max)) chosen.add(root.id)

  // The closure: a row joins the selection when one of its ancestors inside
  // the candidate set is one of the chosen roots.
  const keep = new Set(chosen)
  for (const row of list) {
    if (keep.has(row.id)) continue
    const seen = new Set()
    let parent = parents.get(row.id)
    while (parent !== null && parent !== undefined && parents.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      if (chosen.has(parent)) {
        keep.add(row.id)
        break
      }
      parent = parents.get(parent)
    }
  }

  return list.filter((row) => keep.has(row.id))
}

/**
 * Every table that owns rows of a session, read out of the schema instead of
 * a hard-coded list -- a table added later is then not silently missed.
 */
export const childTableSql = () =>
  [
    "SELECT m.name AS tbl FROM sqlite_master m JOIN pragma_table_info(m.name) p",
    "WHERE m.type='table' AND p.name='session_id'",
  ].join("\n")

/** The ids, in chunks small enough for one statement to carry. */
export const chunkIds = (ids, size) => {
  const list = Array.isArray(ids) ? ids : []
  const step = size && size > 0 ? size : CHUNK_SIZE
  const chunks = []
  for (let i = 0; i < list.length; i += step) chunks.push(list.slice(i, i + step))
  return chunks
}

/**
 * The DELETE statements that take a table's rows out -- one per chunk of ids,
 * because a long IN list is a statement-size risk and a chunk that fails
 * leaves the rest to the next run.
 */
export const deleteStatement = (table, column, ids) => {
  const name = identifier(table)
  const key = identifier(column)
  return chunkIds(ids, CHUNK_SIZE).map(
    (chunk) => `DELETE FROM ${name} WHERE ${key} IN (${chunk.map(quote).join(",")})`,
  )
}

/** The value a flag takes, or a complaint about the flag. */
const flagValue = (argv, index, flag) => {
  const raw = argv[index]
  if (raw === undefined || raw === null || raw === "" || String(raw).startsWith("--")) {
    throw usageError(`${flag} needs a value`)
  }
  return String(raw)
}

/** The number a flag takes, or a complaint about the flag. */
const flagNumber = (argv, index, flag) => {
  const raw = flagValue(argv, index, flag)
  const value = Number(raw)
  if (!isFinite(value) || value < 0) throw usageError(`${flag} needs a non-negative number, got "${raw}"`)
  return value
}

/** A flag the user got wrong; the run stops with exit code 2. */
const usageError = (message) => {
  const error = new Error(message)
  error.exitCode = 2
  return error
}

/**
 * The command line. Unknown flags and missing values are refused here, so the
 * rest of the tool never has to guess what was meant.
 */
export const parseArgs = (argv) => {
  const options = {
    days: DEFAULT_DAYS,
    graceHours: DEFAULT_GRACE_HOURS,
    limit: 0,
    directories: [],
    dryRun: false,
    noEvents: false,
    vacuum: false,
    help: false,
  }
  const args = Array.isArray(argv) ? argv.slice() : []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--days") options.days = flagNumber(args, ++index, "--days")
    else if (arg === "--grace-hours") options.graceHours = flagNumber(args, ++index, "--grace-hours")
    else if (arg === "--limit") options.limit = flagNumber(args, ++index, "--limit")
    else if (arg === "--directory") options.directories.push(flagValue(args, ++index, "--directory"))
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--no-events") options.noEvents = true
    else if (arg === "--vacuum") options.vacuum = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else throw usageError(`unknown option: ${arg}`)
  }
  return options
}

/** The one line that says what went. */
export const summarize = (result) => {
  const state = result || {}
  const sessions = Number(state.sessions) || 0
  const events = Number(state.events) || 0
  const children = Number(state.children) || 0
  const verb = state.dryRun ? "would retire" : "retired"
  return `${verb} ${sessions} session(s) with ${events} event row(s) and ${children} child row(s)`
}

/** How many rows a table holds for these ids. */
const countRows = (bin, table, column, ids) => {
  const name = identifier(table)
  const key = identifier(column)
  let total = 0
  for (const chunk of chunkIds(ids, CHUNK_SIZE)) {
    const rows = runSql(bin, `SELECT count(*) AS c FROM ${name} WHERE ${key} IN (${chunk.map(quote).join(",")})`)
    for (const row of rows) total += Number(row.c) || 0
  }
  return total
}

/** The ids that are still in the session table. */
const survivingIds = (bin, ids) => {
  const found = []
  for (const chunk of chunkIds(ids, CHUNK_SIZE)) {
    const rows = runSql(bin, `SELECT id FROM session WHERE id IN (${chunk.map(quote).join(",")})`)
    for (const row of rows) found.push(row.id)
  }
  return found
}

/** The event rows whose session is gone. */
const orphanEvents = (bin) => {
  const rows = runSql(bin, "SELECT count(*) AS c FROM event WHERE aggregate_id NOT IN (SELECT id FROM session)")
  let total = 0
  for (const row of rows) total += Number(row.c) || 0
  return total
}

/**
 * The tool itself: read the candidates, delete what belongs to them, verify
 * that what was deleted is gone, and keep a record of it.
 */
const run = (argv) => {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`retire-old-sessions: ${error.message}`)
    console.error(USAGE)
    return error.exitCode ? error.exitCode : 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const bin = resolveBinary()
  const database = resolveDatabasePath(bin)
  const cutoffs = computeCutoffs(Date.now(), options.days, options.graceHours)

  let candidates
  try {
    candidates = runSql(bin, candidateSql(cutoffs, options.directories))
  } catch (error) {
    console.error(`retire-old-sessions: ${error.message}`)
    return 1
  }

  const rows = candidates.map((row) => ({
    id: row.id,
    title: row.title,
    directory: row.directory,
    project_id: row.project_id,
    parent_id: row.parent_id,
    time_created: row.time_created,
    time_updated: row.time_updated,
  }))
  // The query already sorts by creation time, so the oldest come first, and a
  // limit takes the oldest roots whole: a child goes with its parent.
  const selected = selectSessions(rows, options.limit)
  const ids = selected.map((row) => row.id)

  let childTables = []
  try {
    const tableRows = runSql(bin, childTableSql())
    childTables = tableRows.map((row) => row.tbl).filter(Boolean)
  } catch (error) {
    console.error(`retire-old-sessions: ${error.message}`)
    return 1
  }

  // The counts are read before anything is deleted, so the summary can say
  // what went with the sessions. A dry run reads them too, and changes
  // nothing.
  let eventRows = 0
  let childRows = 0
  try {
    if (!options.noEvents) {
      eventRows += countRows(bin, "event", "aggregate_id", ids)
      eventRows += countRows(bin, "event_sequence", "aggregate_id", ids)
    }
    for (const table of childTables) childRows += countRows(bin, table, "session_id", ids)
  } catch (error) {
    console.error(`retire-old-sessions: ${error.message}`)
    return 1
  }

  if (options.dryRun) {
    console.log(`database: ${database}`)
    const shown = selected.slice(0, DRY_RUN_ROWS)
    for (const row of shown) {
      console.log(`  ${row.id}  ${row.title || "(untitled)"}  ${row.directory || ""}`)
    }
    if (selected.length > shown.length) console.log(`  ... and ${selected.length - shown.length} more session(s)`)
    console.log(summarize({ dryRun: true, sessions: selected.length, events: eventRows, children: childRows }))
    return 0
  }

  if (ids.length === 0) {
    console.log(summarize({ dryRun: false, sessions: 0, events: 0, children: 0 }))
    return 0
  }

  // The order matters. The event tables name their own rows -- nothing
  // cascades them from the session -- and the session rows go last, because
  // that is what the foreign keys cascade from.
  const statements = []
  if (!options.noEvents) {
    statements.push(...deleteStatement("event", "aggregate_id", ids))
    statements.push(...deleteStatement("event_sequence", "aggregate_id", ids))
  }
  for (const table of childTables) statements.push(...deleteStatement(table, "session_id", ids))
  statements.push(...deleteStatement("session", "id", ids))

  for (const statement of statements) {
    try {
      runSql(bin, statement)
    } catch (error) {
      console.error(`retire-old-sessions: ${error.message}`)
      console.error("retire-old-sessions: stopped; the ids that are left go on the next run")
      return 1
    }
  }

  let survivors = []
  let orphans = 0
  try {
    survivors = survivingIds(bin, ids)
    orphans = options.noEvents ? 0 : orphanEvents(bin)
  } catch (error) {
    console.error(`retire-old-sessions: ${error.message}`)
    return 1
  }
  if (survivors.length > 0) {
    console.error(`retire-old-sessions: ${survivors.length} session(s) survived the delete:`)
    for (const id of survivors) console.error(`  ${id}`)
    return 1
  }
  if (orphans > 0) {
    console.error(`retire-old-sessions: ${orphans} orphan event row(s) left behind`)
    return 1
  }

  if (options.vacuum) {
    try {
      runSql(bin, "VACUUM")
      console.log("vacuumed the database")
    } catch (error) {
      console.warn(`retire-old-sessions: vacuum failed (${error.message}); the deletions are done`)
    }
  }

  const records = selected.map((row) => ({
    id: row.id,
    title: row.title,
    directory: row.directory,
    projectID: row.project_id,
    created: row.time_created,
    updated: row.time_updated,
  }))

  let archivePath = null
  if (records.length > 0) {
    const directory = archiveDir()
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    archivePath = path.join(directory, `${stamp}.json`)
    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(archivePath, JSON.stringify({ retired: records }, null, 2))
    } catch (error) {
      console.warn(`retire-old-sessions: could not write the archive (${error.message})`)
      archivePath = null
    }
  }

  console.log(summarize({ dryRun: false, sessions: selected.length, events: eventRows, children: childRows }))
  if (archivePath) console.log(`records: ${archivePath}`)
  return 0
}

/**
 * The entry point. It never throws: a failed statement is reported and the
 * run stops with a non-zero exit code.
 */
export const main = async (argv) => {
  try {
    return run(argv)
  } catch (error) {
    console.error(`retire-old-sessions: ${error && error.message ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`retire-old-sessions: ${error && error.message ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
