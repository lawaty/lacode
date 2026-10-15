// Which LaCode is this, and -- the question that actually matters -- which one is
// opencode running.
//
// `lacode --version` is a lie waiting to happen. Nothing stops a config from
// loading the plugin by ABSOLUTE PATH (`file:///home/you/repo/dist/index.js`)
// while the `lacode` on PATH belongs to an npm install somewhere else entirely.
// Both then legitimately report their own version, both are "correct", and the
// version opencode is running is neither. That is not hypothetical: it is the
// setup on the machine this was written on, where `npm ls -g` says 0.1.0 while
// opencode loads a local build.
//
// So the report is about RESOLUTION, not about a number:
//   - which copy is speaking (package root, checkout or installed)
//   - what it was built from (commit, dirty state, dist staleness)
//   - what the user's config actually loads, and whether that is this copy
//
// Everything is injected -- git, the clock, the home directory, the config text
// -- so the whole module is testable with no repository, no subprocess and no
// network. Nothing here reaches the npm registry: `lacode update --check` is
// the command that answers "is there something newer", and mixing the two would
// make a diagnostic hang on the network.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJsonc } from "./jsonc.ts"
import { PACKAGE_NAME, PACKAGE_ROOT } from "./package-root.ts"
import { readInstalledVersion } from "./selfupdate.ts"

export type DistState = "current" | "stale" | "unknown"

/** One `plugin` entry's SOURCE SPECIFIER only — never its options. */
export type PluginEntry = { specifier: string; options?: Record<string, unknown> }

export type VersionReport = {
  version?: string
  root: string
  source: "checkout" | "installed"
  commit?: string
  dirty?: boolean
  dist?: DistState
  staleSources?: string[]
  configPath?: string
  loaded?: string[]
  /** True when every lacode entry in the config resolves to THIS package root. */
  servedByThisCopy: boolean | undefined
  note?: string
}

export type VersionDeps = {
  packageRoot?: string
  home?: string
  /** Runs a git command; returns undefined when git is unavailable. */
  git?: (args: string[]) => string | undefined
  /** Reads a file; injected so a test can describe a config that is not there. */
  readFile?: (path: string) => string | undefined
  stat?: (path: string) => number | undefined
  exists?: (path: string) => boolean
  listSources?: (root: string) => string[]
}

const nodeStat = (path: string) => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

const nodeExists = (path: string) => existsSync(path)

const nodeRead = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

const realGit = (root: string) => (args: string[]): string | undefined => {
  try {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000 })
    if (result.status !== 0) return undefined
    return (result.stdout ?? "").trim()
  } catch {
    return undefined
  }
}

/** Every `.ts` under `<root>/src`, for the staleness comparison. */
const walkSources = (root: string): string[] => {
  const found: string[] = []
  const stack = [join(root, "src")]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const full = join(dir, name)
      if (name.endsWith(".ts")) found.push(full)
      else if (name === "plugins" || name === "lib" || name === "tunnel") stack.push(full)
    }
  }
  return found
}

/**
 * Is `dist/` behind its own sources?
 *
 * This is the trap a checkout-only install walks into: opencode loads
 * `dist/index.js`, the source is what gets edited and committed, and a `git
 * pull` updates one without touching the other. Nothing fails -- the plugin
 * simply keeps running yesterday's code -- so "the file is older" is the only
 * signal available.
 */
const checkDist = (
  root: string,
  deps: Required<Pick<VersionDeps, "stat" | "exists" | "listSources">>,
): { dist: DistState; stale?: string[] } => {
  if (!deps.exists(join(root, "dist"))) return { dist: "unknown" }
  const built = deps.stat(join(root, "dist", "index.js"))
  if (built === undefined) return { dist: "unknown" }
  const sources = deps.listSources(root).map((file) => ({ file, mtime: deps.stat(file) }))
  const newer = sources.filter((s) => s.mtime !== undefined && s.mtime > built).map((s) => relative(root, s.file))
  if (newer.length > 0) return { dist: "stale", stale: newer }
  return { dist: "current" }
}

/** The `plugin` array, reduced to each entry's source specifier. */
export const readPluginEntries = (raw: string): PluginEntry[] | undefined => {
  const parsed = parseJsonc(raw) as { plugin?: unknown } | undefined
  const list = parsed?.plugin
  if (!Array.isArray(list)) return undefined
  const entries: PluginEntry[] = []
  for (const item of list) {
    if (typeof item === "string") entries.push({ specifier: item })
    else if (Array.isArray(item) && typeof item[0] === "string") {
      entries.push({ specifier: item[0], options: (item[1] ?? undefined) as Record<string, unknown> | undefined })
    }
  }
  return entries
}

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** Does this plugin specifier resolve to the copy reporting? */
const resolvesHere = (specifier: string, packageRoot: string): boolean => {
  if (specifier === PACKAGE_NAME) {
    // Bare name -> the installed copy. It is this one only if we ARE installed.
    return packageRoot.split(sep).includes("node_modules")
  }
  if (specifier.startsWith("file://")) {
    try {
      const path = fileURLToPath(specifier)
      return isInside(path, packageRoot) || isInside(packageRoot, path)
    } catch {
      return false
    }
  }
  if (specifier.startsWith(".")) return resolvesHere(new URL(specifier, `file://${packageRoot}/`).href, packageRoot)
  return false
}

export function readVersionReport(deps: VersionDeps = {}): VersionReport {
  const packageRoot = deps.packageRoot ?? PACKAGE_ROOT
  const home = deps.home ?? homedir()
  const git = deps.git ?? realGit(packageRoot)
  const readFile = deps.readFile ?? nodeRead
  const stat = deps.stat ?? nodeStat
  const exists = deps.exists ?? nodeExists
  const listSources = deps.listSources ?? walkSources

  const isCheckout = exists(join(packageRoot, ".git"))
  const report: VersionReport = {
    version: readInstalledVersion(packageRoot, readFile),
    root: packageRoot,
    source: isCheckout ? "checkout" : "installed",
  }

  if (isCheckout) {
    report.commit = git(["rev-parse", "--short", "HEAD"]) || "(unknown)"
    report.dirty = (git(["status", "--porcelain"]) ?? "").length > 0
  }
  const dist = checkDist(packageRoot, { stat, exists, listSources })
  report.dist = dist.dist
  if (dist.stale) report.staleSources = dist.stale

  const configPath = [join(home, ".config", "opencode", "opencode.jsonc"), join(home, ".config", "opencode", "opencode.json")].find(
    (candidate) => exists(candidate),
  )
  if (!configPath) {
    report.note = `No opencode config found under ${join(home, ".config", "opencode")}; nothing to compare this copy against.`
    return report
  }
  report.configPath = configPath
  const entries = readPluginEntries(readFile(configPath) ?? "")
  if (!entries) {
    report.note = `${configPath} has no readable \`plugin\` array.`
    return report
  }
  report.loaded = entries.map((e) => e.specifier)
  // Every entry goes through resolvesHere, INCLUDING the bare package name:
  // short-circuiting on the name would make a checkout claim to be the copy an
  // npm install serves, which is the exact confusion this command exists to end.
  const lacodeEntries = entries.filter((e) => e.specifier.includes("lacode"))
  const ours = lacodeEntries.filter((e) => resolvesHere(e.specifier, packageRoot))
  if (lacodeEntries.length === 0) {
    report.servedByThisCopy = false
    report.note = `${configPath} loads no LaCode plugin entry.`
    return report
  }
  if (ours.length > 0) {
    // Only "every lacode entry is this copy" counts as serving: two plugins
    // loaded at once means one of them wins, and which is not ours to guess.
    report.servedByThisCopy = ours.length === lacodeEntries.length
    if (!report.servedByThisCopy) {
      report.note = `${configPath} loads LaCode from more than one place; only some entries resolve to this copy.`
    }
    return report
  }
  report.servedByThisCopy = false
  report.note =
    `opencode loads LaCode from ${lacodeEntries.map((e) => e.specifier).join(", ")} — `
    + `NOT this copy at ${packageRoot}. The version above is this CLI, not necessarily what opencode runs.`
  return report
}

/** Render a report as `key  value` lines, matching `lacode doctor`. */
export const formatVersion = (report: VersionReport): string => {
  const lines: [string, unknown][] = [
    ["version", report.version ?? "(unknown)"],
    ["root", report.root],
    ["source", report.source],
  ]
  if (report.commit) {
    lines.push(["commit", `${report.commit}${report.dirty ? " (dirty)" : ""}`])
  }
  if (report.dist) {
    const stale = report.staleSources?.length ? ` — ${report.staleSources.length} source file(s) newer than dist/index.js` : ""
    lines.push(["dist", `${report.dist}${stale}`])
  }
  if (report.configPath) lines.push(["config", report.configPath])
  if (report.loaded?.length) lines.push(["plugin", report.loaded.join(", ")])
  if (report.servedByThisCopy !== undefined) {
    lines.push(["this copy", report.servedByThisCopy ? "yes — opencode loads this copy" : "NO — see note"])
  }
  return lines.map(([key, value]) => `${key.padEnd(10)} ${String(value)}`).join("\n")
}