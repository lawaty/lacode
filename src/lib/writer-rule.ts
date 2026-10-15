import { readFileSync } from "node:fs"
import * as path from "node:path"

// A plugin module's exports ARE its plugins: opencode iterates every export of a
// plugin file and calls it, then uses the return value as a hooks object
// (Plugin.init -> Wy/Gy -> hooks.push(await fn(input, options))). So this lives in
// lib/, not in plugins/context-autoupdate.ts. Exported from the plugin file it is
// invoked with the plugin input as its arguments; readFileSync then throws EISDIR,
// the catch below swallows it, and the plugin registry is left holding undefined.
// Every later hook dispatch then fails on that entry ("undefined is not an object
// (evaluating 'hooks.config')"), taking the whole process down.

const CONTEXT_DIR = path.join(".opencode", "context")

/** The agent family allowed to write the map, including every hidden slot variant. */
const WRITER = "context"

const toPosix = (value: string) => value.split(path.sep).join("/")

/** A permission pattern as the anchored regex opencode compiles it to. */
const compilePattern = (pattern: string) => {
  const escaped = toPosix(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s")
}

/**
 * The rule that actually decides `file`, or undefined if none matches.
 *
 * LAST match wins, because opencode evaluates the flattened entries of a
 * permission object with findLast over Object.entries order. There is no
 * specificity sorting: a broad `"*": "allow"` written AFTER a narrow
 * `.opencode/context/**": "deny"` overrides it, and one written BEFORE loses.
 * That is why the narrow rules in every agent here are declared last, and why
 * "does an allow appear somewhere in this table" is the wrong question to ask —
 * a `deny` correctly sitting behind an `allow` would be reported as a hole.
 */
const winningRule = (rule: unknown, file: string): { pattern: string; action: string } | undefined => {
  if (typeof rule === "string") return { pattern: "<whole tool>", action: rule }
  if (!rule || typeof rule !== "object") return undefined
  let winner: { pattern: string; action: string } | undefined
  for (const [pattern, action] of Object.entries(rule)) {
    if (compilePattern(pattern).test(file)) winner = { pattern, action: String(action) }
  }
  return winner
}

/**
 * Strip `//` and slash-star comments, then trailing commas, so a .jsonc file
 * parses as JSON. String-aware on both counts: a `//` inside a description or a
 * `"*"` inside a quoted pattern is content, not syntax, and truncating there
 * would turn a real config into an unparseable one.
 */
const stripJsonc = (raw: string) => {
  let out = ""
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"') {
      out += ch
      i++
      while (i < raw.length) {
        out += raw[i]
        if (raw[i] === "\\") {
          out += raw[i + 1] ?? ""
          i += 2
          continue
        }
        if (raw[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++
      continue
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/**
 * The config's agents, or undefined if this file cannot be parsed as JSON.
 *
 * Undefined means "say nothing", never "assume no agents": this check is a
 * startup diagnostic, and a config written in a dialect this reader does not
 * understand is not evidence of a broken one-writer rule.
 */
const readAgents = (raw: string): Record<string, unknown> | undefined => {
  try {
    const agents = (JSON.parse(stripJsonc(raw)) as { agent?: unknown }).agent
    if (agents && typeof agents === "object" && !Array.isArray(agents)) return agents as Record<string, unknown>
    return {}
  } catch {
    return undefined
  }
}

const permissionOf = (agent: unknown) =>
  (agent as { permission?: { edit?: unknown } } | undefined)?.permission?.edit

/** The path form opencode actually evaluates for this project's map. */
const evaluatedForm = (mapDir: string, projectRoot?: string) => {
  const absolute = toPosix(path.join(mapDir, "architecture.md"))
  return projectRoot ? toPosix(path.relative(projectRoot, absolute)) : absolute
}

/**
 * The path form opencode would evaluate for the client's own file. Deliberately
 * ONE form, mirroring evaluatedForm: when a project root is known that is the
 * only form opencode tests, and checking the other one too reports holes that
 * do not exist. The deny has to carry both spellings precisely because only one
 * of them is ever evaluated at a time.
 */
const managerForm = (mapDir: string, projectRoot?: string) => {
  const absolute = toPosix(path.join(mapDir, "manager.md"))
  return projectRoot ? toPosix(path.relative(projectRoot, absolute)) : absolute
}

// Verifies the one-writer permission rule actually matches this project's map.
//
// opencode evaluates a file permission against the path RELATIVE TO THE PROJECT ROOT,
// not the absolute path the tool was handed: a write of
// /repo/.opencode/context/architecture.md is logged and evaluated as
// ".opencode/context/architecture.md". Patterns compile to anchored regexes (* -> .*)
// and the LONGEST match wins, so neither form covers every project on its own:
//
//   ".opencode/context/**"    fires for a normally-rooted project, but not when the
//                             project root is "/" (the form is then home/.../...)
//   "*/.opencode/context/**"  fires only when the project root is "/"
//
// So the rule to check is whichever form applies to THIS project's root. Checking the
// absolute path instead is what let commit 6f6af0a "fix" a working rule into a silently
// broken one. Reproduced here so a malformed rule is reported at startup instead of
// discovered weeks later as a silently stale map.
//
// The rule has two directions and only checking one is how a map ends up with two
// writers:
//
//   1. the cartographer can write it      (checked here, and reported the way it always was)
//   2. nothing else can write it         (checked here, per agent, by evaluating each
//                                         agent's own winning rule — not by looking for
//                                         the word "allow" anywhere in its table)
//
// Only `edit` is read anywhere, because that is the only key opencode consults: its
// tool-permission lookup folds the tool names "write" and "apply_patch" onto "edit",
// so a `write` key in a permission block is never read. LaCode therefore emits no
// `write` keys, and this scanner does not look for them: matching one would assert a
// rule opencode would ignore.
export const verifyWriterRule = (configPath: string, mapDir: string, projectRoot?: string) => {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch {
    return undefined // no config to inspect (custom config path, or stripped deploy)
  }
  const rules: string[] = []
  for (const block of raw.matchAll(/"edit"\s*:\s*\{([^}]*)\}/g)) {
    for (const rule of block[1].matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*"(allow|ask|deny)"/g)) {
      if (rule[2] === "allow") rules.push(rule[1].replace(/\\"/g, '"'))
    }
  }

  const form = evaluatedForm(mapDir, projectRoot)

  // Direction 1 — the cartographer must actually be able to write the map.
  if (rules.length > 0) {
    if (!rules.some((rule) => compilePattern(rule).test(form))) {
      return `context map is not writable: none of the allow rules in ${path.basename(configPath)} match `
        + (projectRoot
            ? `the project-root-relative form "${form}" that opencode actually evaluates for project root ${toPosix(projectRoot)}`
            : `the absolute form "${form}"`)
        + `. Rules seen: ${rules.map((r) => `"${r}"`).join(", ")}. opencode evaluates file permissions against the path RELATIVE TO THE PROJECT ROOT, so `
        + `"${CONTEXT_DIR}/**" is what fires for a normally-rooted project while "*/${CONTEXT_DIR}/**" only fires when the project root is "/". Allow both forms.`
    }
  }

  // Direction 2 — nobody but the cartographer may write the map.
  //
  // Each agent is evaluated the way opencode evaluates it: find the LAST rule
  // matching the path opencode would evaluate, and report it only if that rule
  // is an allow. An agent carrying the correct narrow-last deny therefore passes
  // silently, which is the whole point — the deny is supposed to be there.
  const agents = readAgents(raw)
  if (agents) {
    const offenders: string[] = []
    for (const [name, def] of Object.entries(agents)) {
      if (name === WRITER || name.startsWith(WRITER)) continue
      const win = winningRule(permissionOf(def), form)
      // An agent with no `edit` rule is not a second writer: opencode's default
      // for an unconfigured tool is "ask", which stops nothing by accident.
      if (win?.action === "allow") offenders.push(`${name} (edit rule "${win.pattern}": "${win.action}")`)
    }
    if (offenders.length > 0) {
      return `context map has more than one writer: ${offenders.join(", ")} would be granted `
        + `the map by permission, evaluating "${form}". `
        + `Only ${WRITER} may write the map. Narrow the grant and put the deny LAST -- opencode takes the `
        + `LAST matching rule, so "${CONTEXT_DIR}/**": "deny" written after "*": "allow" is what denies it: `
        + `"*": "allow", "*/${CONTEXT_DIR}/**": "deny", "${CONTEXT_DIR}/**": "deny". `
        + `Both spellings are required because the evaluated path depends on the project root.`
    }
  }

  // Direction 3 -- manager.md is the CLIENT'S, and no agent may write it.
  //
  // This one deliberately includes the cartographer itself, which Direction 2
  // skips. The shipped deny-last for manager.md lives in our agent definition,
  // and applyAgents leaves a key the user already defines byte-for-byte alone
  // ("no permission is merged"). So a user who declares their own `context` agent
  // silently discards that deny -- and because the only other check deliberately
  // skips writer agents, the one file built to be untouchable becomes the one file
  // nothing inspects. Checked here, where it cannot be configured away.
  const managerPath = managerForm(mapDir, projectRoot)
  const agentDefs = readAgents(raw)
  if (agentDefs) {
    const writers: string[] = []
    for (const [name, def] of Object.entries(agentDefs)) {
      const win = winningRule(permissionOf(def), managerPath)
      if (win?.action === "allow") writers.push(`${name} (edit rule "${win.pattern}": "${win.action}")`)
    }
    if (writers.length > 0) {
      return `${CONTEXT_DIR}/manager.md is writable by permission: ${writers.join(", ")}. `
        + `It is the client's own file — what they are working on, what is ratified, what every agent `
        + `must respect — and no agent writes it. Deny it LAST, after any broad allow, because opencode `
        + `takes the LAST matching rule: `
        + `"*": "allow", "*/${CONTEXT_DIR}/manager.md": "deny", "${CONTEXT_DIR}/manager.md": "deny". `
        + `Declare this on every agent above, including \`${WRITER}\`: an agent you define yourself replaces `
        + `the shipped one wholesale, permission and all.`
    }
  }

  return undefined
}