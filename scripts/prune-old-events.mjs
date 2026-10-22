// Prune opencode's event table: the second, uncapped copy of every session
// transcript.
//
// opencode keeps the event log of every session in the `event` table: prompts,
// tool output, whole files and diffs, rows up to 30 MiB. It is 68% of the local
// database and 86% of the remote host's, it grows about 289 MB a day, and
// nothing ever prunes it -- opencode has no age-based prune, no TTL and no bulk
// delete for it. The session sweep (scripts/retire-old-sessions.mjs) takes a
// session away with its events, but a session that is still alive keeps every
// event it ever produced, so the table grows without a bound.
//
//   node scripts/prune-old-events.mjs --dry-run
//   node scripts/prune-old-events.mjs --days 7 --grace-hours 1
//   node scripts/prune-old-events.mjs --limit 5000 --vacuum
//
//   --days N           age window in days                             (default 7)
//   --grace-hours N    skip a session touched more recently than this (default 1)
//   --limit N          delete at most N event rows                    (default 0 = no limit)
//   --dry-run          report what would go; change nothing
//   --vacuum           rewrite the database afterwards so the freed pages go back to the filesystem
//   --help             print the usage and exit 0
//
// All SQL goes through opencode's own CLI -- `opencode db --format json "<sql>"` --
// because that is the one place the database is reachable wherever opencode
// runs: no sqlite module, no node 22. The CLI runs exactly the statement it is
// given, so every call carries one, and there are no bind parameters: every
// value is inlined into the SQL.
//
// The tool writes to the `event` table and to nothing else. It reads
// `event_sequence` and `session` to decide what is safe to remove: a session
// that takes part in opencode's session sync, a session that belongs to a
// workspace, and a session that was touched inside the grace window keep
// their whole log.
//
// This file stays inside ES2019 on purpose: the remote host runs node 12.22.9
// (/usr/bin/node) and nothing else, so there is no `?.`, no `??`, no `node:`
// import prefix, no top-level await and no `import.meta.dirname` in it. ESM is
// fine -- node 12.17 runs a .mjs file unflagged.
//
// What is kept: one summary line per run, in
// ~/.local/share/opencode/lacode/event-prune.jsonl. A JSONL file and not one
// file per run: this is a recurring job, and per-run files would litter.

import { spawnSync } from "child_process"
import { appendFileSync, existsSync, mkdirSync } from "fs"
import { homedir } from "os"
import path from "path"
import { fileURLToPath } from "url"

const DAY_MS = 86400000
const HOUR_MS = 3600000
/** The sub-millisecond counter in the low bits of an event id. */
const ID_COUNTER = 4096
/** One era of event ids: 2^36 ms, 795.4 days. */
const ERA_MS = Math.pow(2, 36)
/** How many candidate ids one page carries, and one DELETE statement. */
const PAGE_SIZE = 2000
const DEFAULT_DAYS = 7
const DEFAULT_GRACE_HOURS = 1

const USAGE = `node scripts/prune-old-events.mjs [options]

  --days N           age window in days                             (default 7)
  --grace-hours N    skip a session touched more recently than this (default 1)
  --limit N          delete at most N event rows                    (default 0 = no limit)
  --dry-run          report what would go; change nothing
  --vacuum           rewrite the database afterwards so the freed pages go back to the filesystem
  --help             print the usage and exit 0`

/** A SQL string literal, with the single quotes doubled. */
const quote = (value) => "'" + String(value).split("'").join("''") + "'"

/** The error text without the terminal colours the CLI prints it in. */
const plain = (text) =>
  String(text === undefined || text === null ? "" : text).split(/\u001b\[[0-9;]*m/).join("")

/** Where the summary line of every run goes. */
const logPath = () => path.join(homedir(), ".local", "share", "opencode", "lacode", "event-prune.jsonl")

/**
 * The opencode binary: the explicit one, then the one in the home directory
 * (a non-interactive shell has no PATH entry for it, and a systemd unit has no
 * PATH at all), then whatever PATH offers.
 */
export const resolveBinary = () => {
  const explicit = process.env.LACODE_OPENCODE_BIN
  if (explicit) return explicit
  const home = path.join(homedir(), ".opencode", "bin", "opencode")
  if (existsSync(home)) return home
  return "opencode"
}

/**
 * One statement, one invocation: the CLI runs exactly the statement it is
 * given, and a multi-statement string would silently run only the first.
 */
export const runSql = (bin, sql) => {
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

/**
 * The id every row older than the window carries: the cut-off, as a prefix.
 *
 * An event id is `evt_` + 12 hex chars + 14 random base62 chars, and the hex
 * part is the 48-bit big-endian block `(epochMillis mod 2^36) * 4096 +
 * counter`, where the counter is the sub-millisecond counter. So the block's
 * top 36 bits are the milliseconds of the row's creation, and because the
 * block is fixed width and big-endian, a plain TEXT comparison of the id
 * against a computed prefix IS a comparison of times -- and the primary key
 * index makes it a range scan rather than a table walk.
 *
 * The era (Math.floor(nowMillis / 2^36)) is deliberately not part of the
 * prefix: the cutoff and the rows it is compared against share the current
 * era, and the era only matters for rows older than 795.4 days. Those rows
 * belong to sessions the session sweep removes with their events, so they are
 * not this tool's business.
 */
export const cutoffId = (nowMillis, days) => {
  const cutoffMillis = Number(nowMillis) - Number(days) * DAY_MS
  // The modulo is taken positive: a window of more than 795 days puts the
  // cutoff before the era it lives in, and a negative block has no hex
  // prefix at all.
  const withinEra = ((cutoffMillis % ERA_MS) + ERA_MS) % ERA_MS
  const block = withinEra * ID_COUNTER
  return "evt_" + block.toString(16).padStart(12, "0")
}

/**
 * The rows that may go, as one statement.
 *
 * The two NOT EXISTS clauses are the protections. A session that takes part
 * in opencode's session sync has an owner_id in `event_sequence` and is never
 * touched; neither is a session that belongs to a workspace (its log is
 * replayed to other machines) or one that was touched inside the grace
 * window. An event whose session is gone has no protection and is prunable:
 * that is garbage, and garbage is what this table is made of.
 *
 * `afterId` is the keyset pagination: "" for the first page, then the last id
 * of the previous page. There is no OFFSET anywhere in this file -- a page
 * that moves while the table is written to would skip rows and repeat them.
 */
export const candidateSql = (cutoffIdString, graceCutoffMillis, afterId, limit) =>
  [
    "SELECT e.id FROM event e",
    ` WHERE e.id > ${quote(afterId)} AND e.id < ${quote(cutoffIdString)}`,
    "   AND NOT EXISTS (SELECT 1 FROM event_sequence es",
    "                    WHERE es.aggregate_id = e.aggregate_id AND es.owner_id IS NOT NULL)",
    "   AND NOT EXISTS (SELECT 1 FROM session s",
    "                    WHERE s.id = e.aggregate_id",
    `                      AND (s.workspace_id IS NOT NULL OR s.time_updated >= ${graceCutoffMillis}))`,
    " ORDER BY e.id",
    ` LIMIT ${limit}`,
  ].join("\n")

/**
 * The same conditions in one counting statement: how many rows are out there,
 * how many bytes they hold and how many sessions they belong to. No
 * pagination and no limit -- this is the measurement of the whole candidate
 * set, not of a page.
 */
const summarySql = (cutoffIdString, graceCutoffMillis) =>
  [
    "SELECT count(*) AS rows, sum(length(e.data)) AS bytes, count(DISTINCT e.aggregate_id) AS aggregates FROM event e",
    ` WHERE e.id < ${quote(cutoffIdString)}`,
    "   AND NOT EXISTS (SELECT 1 FROM event_sequence es",
    "                    WHERE es.aggregate_id = e.aggregate_id AND es.owner_id IS NOT NULL)",
    "   AND NOT EXISTS (SELECT 1 FROM session s",
    "                    WHERE s.id = e.aggregate_id",
    `                      AND (s.workspace_id IS NOT NULL OR s.time_updated >= ${graceCutoffMillis}))`,
  ].join("\n")

/** The ids, in chunks small enough for one statement to carry. */
export const chunkIds = (ids, size) => {
  const list = Array.isArray(ids) ? ids : []
  const step = size && size > 0 ? size : PAGE_SIZE
  const chunks = []
  for (let i = 0; i < list.length; i += step) chunks.push(list.slice(i, i + step))
  return chunks
}

/** The DELETE that takes a page of ids out. The event table and nothing else. */
const deleteStatement = (ids) => `DELETE FROM event WHERE id IN (${ids.map(quote).join(",")})`

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
  if (!/^\d+$/.test(raw)) throw usageError(`${flag} needs a non-negative number (an integer), got "${raw}"`)
  return Number(raw)
}

/** A flag the user got wrong; the run stops with exit code 2. */
const usageError = (message) => {
  const error = new Error(message)
  error.exitCode = 2
  return error
}

/**
 * The command line. Unknown flags, missing values and values that are not
 * non-negative integers are refused here, so the rest of the tool never has
 * to guess what was meant.
 */
export const parseArgs = (argv) => {
  const options = {
    days: DEFAULT_DAYS,
    graceHours: DEFAULT_GRACE_HOURS,
    limit: 0,
    dryRun: false,
    vacuum: false,
    help: false,
  }
  const args = Array.isArray(argv) ? argv.slice() : []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--days") options.days = flagNumber(args, ++index, "--days")
    else if (arg === "--grace-hours") options.graceHours = flagNumber(args, ++index, "--grace-hours")
    else if (arg === "--limit") options.limit = flagNumber(args, ++index, "--limit")
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--vacuum") options.vacuum = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else throw usageError(`unknown option: ${arg}`)
  }
  return options
}

/** The one line that says what went. */
export const summarize = (result) => {
  const state = result || {}
  const rows = Number(state.rows) || 0
  const bytes = Number(state.bytes) || 0
  const aggregates = Number(state.aggregates) || 0
  const verb = state.dryRun ? "would prune" : "pruned"
  return `${verb} ${rows} event row(s) in ${aggregates} session(s), ${bytes} byte(s)`
}

/**
 * The window the run may look back, clamped to the era the event ids live in.
 *
 * An event id carries the milliseconds of the row's creation inside the era
 * it was created in, so a text comparison against a computed prefix is a
 * comparison of times only while both sides sit in the same era. A window
 * that reaches past the start of the era would compare the whole table
 * against a prefix of an older era and call rows that are hours old old, so
 * the window never reaches past the era start. Rows older than that are left
 * to the session sweep, which takes those sessions away with their events.
 */
const eraSafeDays = (nowMillis, days) => {
  const eraStart = Math.floor(nowMillis / ERA_MS) * ERA_MS
  const inEra = Math.floor((nowMillis - eraStart) / DAY_MS)
  if (days <= inEra) return { days, clamped: false }
  return { days: inEra, clamped: true }
}

/**
 * The bytes and the sessions of a selection the summary cannot measure: the
 * summary counts every candidate, and a limit may have cut the selection
 * short. The rows are read before they are deleted.
 */
const accountSelection = (bin, ids) => {
  let bytes = 0
  const aggregates = new Set()
  for (const chunk of chunkIds(ids, PAGE_SIZE)) {
    const rows = runSql(
      bin,
      `SELECT e.aggregate_id AS aggregate_id, length(e.data) AS bytes FROM event e WHERE e.id IN (${chunk.map(quote).join(",")})`,
    )
    for (const row of rows) {
      bytes += Number(row.bytes) || 0
      if (row.aggregate_id) aggregates.add(row.aggregate_id)
    }
  }
  return { bytes, aggregates: aggregates.size }
}

/** The candidate ids, page by page, and never more than the limit allows. */
const selectIds = (bin, cutoff, graceCutoff, limit) => {
  const ids = []
  let afterId = ""
  for (;;) {
    const left = limit > 0 ? limit - ids.length : PAGE_SIZE
    if (left <= 0) break
    const want = Math.min(PAGE_SIZE, left)
    const rows = runSql(bin, candidateSql(cutoff, graceCutoff, afterId, want))
    if (rows.length === 0) break
    for (const row of rows) ids.push(row.id)
    afterId = ids[ids.length - 1]
    if (rows.length < want) break
  }
  return ids
}

/** The one line of JSON every run leaves behind. */
const writeLog = (record) => {
  const file = logPath()
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(record) + "\n")
  return file
}

/**
 * The tool itself: measure the candidates, take the ones that may go, and
 * keep a record of it.
 */
const run = (argv) => {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`prune-old-events: ${error.message}`)
    console.error(USAGE)
    return error.exitCode ? error.exitCode : 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const bin = resolveBinary()
  const started = Date.now()
  const now = started
  const graceCutoff = now - options.graceHours * HOUR_MS
  const window = eraSafeDays(now, options.days)
  const cutoff = cutoffId(now, window.days)
  if (window.clamped) {
    console.warn(
      `prune-old-events: a window of ${options.days} days reaches past the start of the id era; the cutoff was clamped to ${window.days} days, and rows older than that are left to the session sweep`,
    )
  }

  // The measurement comes first: it is the same whether the run deletes or
  // only reports, and it is what says whether there is anything to do.
  let totals
  try {
    totals = runSql(bin, summarySql(cutoff, graceCutoff))[0] || {}
  } catch (error) {
    console.error(`prune-old-events: ${error.message}`)
    return 1
  }
  const candidateRows = Number(totals.rows) || 0
  const candidateBytes = Number(totals.bytes) || 0
  const candidateAggregates = Number(totals.aggregates) || 0

  if (candidateRows === 0) {
    console.log("nothing to prune")
    return 0
  }

  // The selection is what the run may take: every candidate, or the oldest
  // ones up to the limit. A dry run without a limit needs no selection at
  // all -- the measurement already says what would go.
  let ids = []
  if (!options.dryRun || options.limit > 0) {
    try {
      ids = selectIds(bin, cutoff, graceCutoff, options.limit)
    } catch (error) {
      console.error(`prune-old-events: ${error.message}`)
      return 1
    }
  }

  // The numbers of the report are the numbers of what went. Without a limit
  // that is the measurement; with one the selection may be smaller, and then
  // the selection itself is measured before its rows are gone.
  let rows = ids.length || candidateRows
  let bytes = candidateBytes
  let aggregates = candidateAggregates
  if (ids.length > 0 && ids.length < candidateRows) {
    try {
      const measured = accountSelection(bin, ids)
      rows = ids.length
      bytes = measured.bytes
      aggregates = measured.aggregates
    } catch (error) {
      console.error(`prune-old-events: ${error.message}`)
      return 1
    }
  }

  if (!options.dryRun) {
    let deleted = 0
    let page = 0
    for (const chunk of chunkIds(ids, PAGE_SIZE)) {
      page += 1
      try {
        runSql(bin, deleteStatement(chunk))
      } catch (error) {
        console.error(`prune-old-events: ${error.message}`)
        console.error(`prune-old-events: stopped at page ${page}; ${deleted} row(s) had already been deleted`)
        return 1
      }
      deleted += chunk.length
    }
    rows = deleted
  }

  const elapsedMs = Date.now() - started
  const record = {
    ts: new Date(now).toISOString(),
    days: window.days,
    graceHours: options.graceHours,
    cutoff,
    rows,
    bytes,
    aggregates,
    dryRun: options.dryRun,
    elapsedMs,
  }

  let written = null
  try {
    written = writeLog(record)
  } catch (error) {
    console.warn(`prune-old-events: could not write the log (${error.message})`)
  }

  console.log(summarize({ dryRun: options.dryRun, rows, bytes, aggregates }))
  console.log(
    `cutoff ${cutoff}   window ${window.days} day(s)   grace ${options.graceHours} hour(s)   elapsed ${elapsedMs} ms`,
  )
  if (ids.length > 0 && ids.length < candidateRows) {
    console.log(`${candidateRows - ids.length} more candidate row(s) were left for a later run`)
  }
  if (written) console.log(`log: ${written}`)

  if (options.vacuum && !options.dryRun) {
    try {
      runSql(bin, "VACUUM")
      console.log("vacuumed the database")
    } catch (error) {
      console.warn(`prune-old-events: vacuum failed (${error.message}); the deletions are done`)
    }
  }

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
    console.error(`prune-old-events: ${error && error.message ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`prune-old-events: ${error && error.message ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
