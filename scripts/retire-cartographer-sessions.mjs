// Retire the cartographer's sessions from opencode's session list.
//
// The autoupdate plugin retires each session it creates, by writing the
// transcript out and then deleting the session. A run that fails between the
// session creation and the prompt can leave an empty session behind, and this
// tool clears any such session still in the list.
//
// It talks to the opencode server over its HTTP API -- the same interface the
// plugin uses -- because that is where the session list lives. The database is
// only ever READ, and only to find which project directories to ask about.
//
//   node scripts/retire-cartographer-sessions.mjs --dry-run
//   node scripts/retire-cartographer-sessions.mjs
//   node scripts/retire-cartographer-sessions.mjs "/path/to/project"
//
// Credentials come from OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD
// and the address from OPENCODE_SERVER_URL (default http://127.0.0.1:4097).
//
// What is kept: a compact record per retired session, in
// ~/.local/share/opencode/lacode/cartographer-archive/. A full transcript of a
// hundred-and-seventy-message run is megabytes of noise; what is worth having
// is who ran it, when, and what it said. The plugin's own transcripts (the
// last 20 runs, in full) are untouched.

import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"

const BASE = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4097"
const USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
const PASS = process.env.OPENCODE_SERVER_PASSWORD ?? ""
const ARCHIVE = join(homedir(), ".local", "share", "opencode", "lacode", "cartographer-archive")

/** Titles the cartographer has used for its sessions, oldest spelling included. */
const IS_CARTOGRAPHER = (title) => /^context(-manager)? \(auto/.test(title ?? "")
/** A run this young may still be in flight; leave it alone. */
const MIN_AGE_MS = 10 * 60 * 1000

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const wanted = args.filter((a) => !a.startsWith("--"))

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Every project directory opencode knows about: a worktree and its sandboxes.
 */
const projectDirectories = async () => {
  const projects = (await call("GET", "/project")) ?? []
  const directories = new Set()
  for (const project of projects) {
    if (project.worktree) directories.add(project.worktree)
    // A sandbox is a plain path, not an object.
    for (const sandbox of project.sandboxes ?? []) {
      if (typeof sandbox === "string") directories.add(sandbox)
      else if (sandbox?.worktree) directories.add(sandbox.worktree)
    }
  }
  return directories
}

/**
 * The directories the cartographer has actually run in.
 *
 * The session list only serves the sessions of the project that OWNS the
 * directory asked for, and the cartographer ran in directories that are not
 * anybody's worktree -- the home directory, mostly. Those are unreachable
 * through the project list, so the database is read for them. Read-only, and
 * only ever for the set of directories to ask about.
 */
const databaseDirectories = () => {
  const db = join(homedir(), ".local", "share", "opencode", "opencode.db")
  if (!existsSync(db)) return []
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite")
    const rows = new DatabaseSync(db, { readOnly: true })
      .prepare("select distinct directory from session where title like 'context%auto%'")
      .all()
    return rows.map((r) => r.directory).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Every session in a directory. The list defaults to 100 rows, so the limit is
 * raised: `start` is accepted but ignored, so there is no paging to do.
 */
const listSessions = async (directory) => {
  const query = `?directory=${encodeURIComponent(directory)}&limit=5000`
  return (await call("GET", `/session${query}`)) ?? []
}

/**
 * The cartographer sessions the database still holds, for the directories that
 * were not reachable through the session list.
 */
const databaseSessions = () => {
  const db = join(homedir(), ".local", "share", "opencode", "opencode.db")
  if (!existsSync(db)) return []
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite")
    return new DatabaseSync(db, { readOnly: true })
      .prepare("select id, title, directory, project_id, time_created from session where title like 'context%auto%'")
      .all()
  } catch {
    return []
  }
}

const compact = (session, messages) => {
  const texts = []
  for (const message of messages ?? []) {
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.text) texts.push({ role: message.info?.role, text: part.text.slice(0, 600) })
    }
  }
  return {
    sessionID: session.id,
    title: session.title,
    directory: session.directory,
    projectID: session.projectID,
    created: session.time?.created,
    updated: session.time?.updated,
    messageCount: messages?.length ?? 0,
    firstText: texts[0] ?? null,
    lastText: texts[texts.length - 1] ?? null,
  }
}

const directories = wanted.length ? wanted : [...new Set([...(await projectDirectories()), ...databaseDirectories()])]
if (directories.length === 0) {
  console.error("no project directories to scan; pass them as arguments")
  process.exit(1)
}

let retired = 0
let failed = 0
const records = []

for (const directory of directories) {
  const query = `?directory=${encodeURIComponent(directory)}`
  let sessions = []
  try {
    sessions = await listSessions(directory)
  } catch (error) {
    console.error(`  ${directory}: could not list sessions (${error.message})`)
    continue
  }
  const targets = sessions.filter(
    (s) => IS_CARTOGRAPHER(s.title) && Date.now() - (s.time?.created ?? 0) > MIN_AGE_MS,
  )
  for (const session of targets) {
    let messages = []
    try {
      messages = (await call("GET", `/session/${session.id}/message${query}`)) ?? []
    } catch {
      /* an unreadable transcript still leaves a deletable session */
    }
    records.push(compact(session, messages))
    if (dryRun) {
      retired++
      continue
    }
    try {
      await call("DELETE", `/session/${session.id}${query}`)
      retired++
    } catch (error) {
      failed++
      console.error(`  ${session.id}: ${error.message}`)
    }
  }
}

// A second sweep: the list only serves the sessions of the project that owns
// the directory asked for, so a cartographer session in a directory nobody owns
// (the home directory, mostly) is in the database but not in any list. Those
// are still deletable by id, and they are still in the user's list -- the list
// is what opencode serves for THEIR directory, which is the home directory.
const seen = new Set(records.map((r) => r.sessionID))
for (const row of databaseSessions()) {
  if (seen.has(row.id)) continue
  if (Date.now() - (row.time_created ?? 0) <= MIN_AGE_MS) continue
  const directory = row.directory
  const query = `?directory=${encodeURIComponent(directory)}`
  const alive = await call("GET", `/session/${row.id}${query}`).catch(() => undefined)
  if (alive === undefined) continue
  let messages = []
  try {
    messages = (await call("GET", `/session/${row.id}/message${query}`)) ?? []
  } catch {
    /* an unreadable transcript still leaves a deletable session */
  }
  records.push(compact({ id: row.id, title: row.title, directory, projectID: row.project_id, time: { created: row.time_created } }, messages))
  if (dryRun) {
    retired++
    continue
  }
  try {
    await call("DELETE", `/session/${row.id}${query}`)
    retired++
  } catch (error) {
    failed++
    console.error(`  ${row.id}: ${error.message}`)
  }
}

if (!dryRun && records.length) {
  mkdirSync(ARCHIVE, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  writeFileSync(join(ARCHIVE, `${stamp}.json`), JSON.stringify({ retired: records }, null, 2))
}

console.log(
  dryRun
    ? `would retire ${retired} cartographer session(s) across ${directories.length} project(s)`
    : `retired ${retired} cartographer session(s) across ${directories.length} project(s)${failed ? `, ${failed} failed` : ""}`,
)
if (!dryRun && records.length) console.log(`records: ${join(ARCHIVE, "<timestamp>.json")}`)
