// Context-map schema, budgets, lifecycle and drift checks.
//
// The map is a DERIVED navigation index: the prompt tells the cartographer what
// to write, and this module measures what it actually wrote. It is deliberately
// the deterministic half of the contract, for the same reason the active
// backlog's window lives in code rather than in a prompt (see
// active-backlog.ts): a rule a model applies is a rule it applies when it feels
// like it, and the failure is silent.
//
// Three things this module will NOT do, because each one turns a derived index
// into an authority it is not:
//
//   1. It never "fixes" a disagreement. A map claim that contradicts a cited
//      page is REPORTED (the map may be right and the page stale -- that has
//      happened); the owning page resolves it, not this code.
//   2. It never deletes content that has no resolvable source. Such an entry is
//      reported as unarchived and left alone: it may be the only copy. The
//      lifecycle sweep drops only PROVISIONAL entries whose source still
//      exists, and only after their window.
//   3. It never touches source code or a project page. It reads them to check a
//      pointer and writes only the map file it is asked to normalize.
//
// Pure-ish by design: parsing, validation and lifecycle are text-in/text-out
// (the tests drive them without a filesystem); the two convenience functions at
// the bottom (`maintainMap`, `auditMap`) own the disk IO and are what the
// plugin calls.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { ACTIVE_BACKLOG_FILE, normalizeBacklog } from "./active-backlog.ts"

export type MapMarker = "binding" | "provisional" | "disputed"
export type MapFileKind = "entries" | "backlog"

export type MapSpec = {
  /** File name inside `.opencode/context/`. */
  file: string
  /** One-line charter; used in reports, never as a heuristic. */
  charter: string
  /**
   * Hard cap in NON-BLANK LINES. Lines, not entries or tokens: the cost is what
   * a reader loads, an entry count does not bound that cost (one entry may wrap
   * to three lines), and a token count needs a tokenizer and is model-specific.
   * Non-blank lines are what a validator can count exactly and a reviewer can
   * check by eye. `wc -l` is the same measure plus blank lines.
   */
  budget: number
  /** A navigation file that falls below this many entries is degenerate. */
  minEntries: number
  kind: MapFileKind
  /** Days a provisional entry may live without re-verification. */
  provisionalDays: number
  /** A citation to a page (`.md`) must name a section, not just the file. */
  sectionRequired: boolean
}

// The budgets are deliberately tight. The map is read at the start of EVERY
// task, so its cost is paid on every task; the observed failure was a 465-line
// decisions file and 257/209/199-line navigation files. The numbers leave room
// for the constraints an agent actually needs and force consolidation of the
// rest. Decisions gets the tightest navigation budget because a decision log is
// where deliberation accretes.
export const PROVISIONAL_DAYS = 30

export const MAP_SPECS: MapSpec[] = [
  {
    file: "architecture.md",
    charter: "cross-subsystem structure: layers, boundaries, entry points, dependency rules",
    budget: 150,
    minEntries: 4,
    kind: "entries",
    provisionalDays: PROVISIONAL_DAYS,
    sectionRequired: true,
  },
  {
    file: "contexts.md",
    charter: "subsystem boundaries: purpose, start-here files, what must not change",
    budget: 200,
    minEntries: 3,
    kind: "entries",
    provisionalDays: PROVISIONAL_DAYS,
    sectionRequired: true,
  },
  {
    file: "conventions.md",
    charter: "rules to follow before writing code",
    budget: 150,
    minEntries: 3,
    kind: "entries",
    provisionalDays: PROVISIONAL_DAYS,
    sectionRequired: true,
  },
  {
    file: "workflows.md",
    charter: "runtime behaviour worth tracing",
    budget: 150,
    minEntries: 2,
    kind: "entries",
    provisionalDays: PROVISIONAL_DAYS,
    sectionRequired: true,
  },
  {
    file: "decisions.md",
    charter: "architectural constraints that bind future work",
    budget: 120,
    minEntries: 1,
    kind: "entries",
    provisionalDays: PROVISIONAL_DAYS,
    sectionRequired: true,
  },
  {
    file: ACTIVE_BACKLOG_FILE,
    charter: "work in flight, grouped by the ISO week it was opened",
    budget: 60,
    minEntries: 0,
    kind: "backlog",
    provisionalDays: PROVISIONAL_DAYS,
    sectionRequired: false,
  },
]

export const MAP_SPEC_BY_FILE = new Map(MAP_SPECS.map((spec) => [spec.file, spec]))
export const MAP_FILES = MAP_SPECS.map((spec) => spec.file)
/** The five navigation files, i.e. everything except the active backlog. */
export const NAVIGATION_FILES = MAP_SPECS.filter((spec) => spec.kind === "entries").map((spec) => spec.file)

const DAY_MS = 24 * 60 * 60 * 1000

// An entry STARTS with a provenance marker and a list bullet. Continuation
// lines are indented by at least two spaces, which is what lets the rule wrap
// to three lines while keeping the entry a single list item. Nothing else is
// an entry: that is the schema, and an unmarked list item is a schema
// violation rather than a second dialect.
const ENTRY_START = /^([-*+])\s+\[(binding|provisional|disputed)\]\s+(.*)$/i
const CONTINUATION = /^\s{2,}\S/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const FENCE = /^\s*(?:```|~~~)/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|[\s:|-]*-{3,}[\s:|-]*\|\s*$/
const VERIFIED = /\(verified\s+(\d{4}-\d{2}-\d{2})\)\s*$/i
const POINTER =
  /(?:—|–|→|->)\s*See\s+`([^`\n]+)`(?:\s*§\s*([^()\n]+?))?(?:\s*\(verified\s+(\d{4}-\d{2}-\d{2})\))?\s*$/i

// The charter is architectural constraints, not a deliberation ledger. These
// headings are a decision RECORD: they are exactly what the observed 465-line
// file was made of, and their presence is a schema violation, not a style nit.
const DECISION_RECORD =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?(Context|Decision|Consequences|Alternatives|Status|Trade-?offs|Rationale)(?:\*\*)?\s*(?::|$)/im

// The map must never advertise itself as the only copy. This is the sentence
// shape the observed map used in its own preamble, one generation away from
// losing text that nothing else held.
// Deliberately about the MAP, not any use of "only": "the only copy of the
// context rules is AGENTS.md" and "the only record of what the run did is the
// transcript" are legitimate statements about other artefacts. What is forbidden
// is the map saying IT is the only copy, or that some text exists only here.
const ARCHIVE_LANGUAGE =
  /\b(?:archive\s+of\s+record|this\s+(?:is|file\s+is|map\s+is)\s+the\s+only\s+(?:copy|record)|the\s+only\s+place\s+[^.\n]{0,80}?\b(?:remains|survives)\b|the\s+only\s+(?:copy|record)\s+[^.\n]{0,80}?\b(?:remains|survives|is\s+kept)\b|(?:survives|remains|is\s+kept)\s+only\s+here|no\s+longer\s+exists\s+(?:in|anywhere)|exists\s+only\s+(?:in|here))\b/i

const isCalendarDate = (value: string): boolean => {
  const at = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value
}

const normalizeHeading = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/^\s*\d+(?:\.\d+)*[.)]?\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

const normalizeRule = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

const truncate = (value: string, max = 90): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

export type MapEntry = {
  /** 0-based index of the marker line. */
  startLine: number
  /** Exclusive end of the entry block (marker line + continuations). */
  endLine: number
  marker: MapMarker
  /** Marker line plus continuation lines, joined with newlines. */
  body: string
  /** The operative rule with the pointer and verified date removed. */
  rule: string
  /** Number of non-blank lines the entry occupies (1–3 by schema). */
  lineCount: number
  pointer?: string
  section?: string
  verified?: string
}

/**
 * Parse the entries in a navigation file. Everything that is not an entry
 * (title, headings, preamble prose, blank lines) is ignored here; the validator
 * reports unmarked list items and forbidden blocks separately.
 */
export const parseMapEntries = (text: string): MapEntry[] => {
  const lines = text.split(/\r?\n/)
  const entries: MapEntry[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const start = ENTRY_START.exec(lines[i])
    if (!start) continue
    const bodyLines = [start[3]]
    let j = i + 1
    // Collect indented continuations. More than two is still collected here so
    // the validator can report the real line count rather than silently split
    // an over-long entry into two.
    while (j < lines.length && CONTINUATION.test(lines[j]) && !FENCE.test(lines[j])) {
      bodyLines.push(lines[j].trim())
      j++
    }
    const body = bodyLines.join("\n")
    const flat = body.replace(/\s+/g, " ").trim()
    const pointerMatch = POINTER.exec(flat)
    const verifiedMatch = VERIFIED.exec(flat)
    const pointer = pointerMatch?.[1]?.trim()
    const section = pointerMatch?.[2]?.trim() || undefined
    const verified = pointerMatch?.[3] ?? verifiedMatch?.[1]
    const rule = flat
      .replace(POINTER, "")
      .replace(VERIFIED, "")
      .trim()
    entries.push({
      startLine: i,
      endLine: j,
      marker: start[2].toLowerCase() as MapMarker,
      body,
      rule,
      lineCount: bodyLines.filter((line) => line.trim()).length,
      ...(pointer ? { pointer } : {}),
      ...(section ? { section } : {}),
      ...(verified ? { verified } : {}),
    })
    i = j - 1
  }
  return entries
}

export type ViolationKind =
  | "missing-file"
  | "charter"
  | "budget"
  | "schema"
  | "dangling"
  | "unarchived"
  | "restatement"
  | "archive"
  | "drift"
  | "duplicate"

export type Violation = {
  file: string
  /** 1-based, when the violation belongs to one line. */
  line?: number
  kind: ViolationKind
  detail: string
}

export type ResolvedPointer = {
  /** Absolute path on disk, or undefined when the pointer escapes the root. */
  absolute?: string
  exists: boolean
  /** The cited section's text, when a section was requested and found. */
  sectionText?: string
  sectionFound?: boolean
  mtimeMs?: number
  /** Text used for claim checks: the section when found, else the whole file. */
  sourceText?: string
}

const stripLineSuffix = (pointer: string): string =>
  pointer
    .replace(/[\\/]$/, "")
    // `path:12`, `path:12-20`, `path#L12`, `path#L12-L20`
    .replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/i, "")

const headingOf = (line: string): { level: number; text: string } | undefined => {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
  if (!match) return undefined
  return { level: match[1].length, text: match[2] }
}

const sectionText = (text: string, section: string): string | undefined => {
  const lines = text.split(/\r?\n/)
  const wanted = normalizeHeading(section)
  if (!wanted) return undefined
  for (let i = 0; i < lines.length; i++) {
    const heading = headingOf(lines[i])
    if (!heading) continue
    const normalized = normalizeHeading(heading.text)
    if (!(normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized))) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const next = headingOf(lines[j])
      if (next && next.level <= heading.level) {
        end = j
        break
      }
    }
    return lines.slice(i + 1, end).join("\n")
  }
  return undefined
}

/**
 * Resolve a pointer (`path`, optional `§Section`) against the project root.
 * Never throws and never follows a pointer outside the root: a map that cites
 * `../../secrets` is a dangling citation, not a read.
 */
export const resolvePointer = (root: string, pointer: string, section?: string): ResolvedPointer => {
  const cleaned = stripLineSuffix(pointer.trim().replace(/^`|`$/g, ""))
  if (!cleaned) return { exists: false }
  const absolute = path.resolve(root, cleaned)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (absolute !== root && !absolute.startsWith(rootWithSep)) return { exists: false }
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    return { exists: false }
  }
  if (!stat.isFile()) return { exists: false }
  let text: string | undefined
  try {
    // A pointer is a citation, not a licence to load a corpus into memory.
    if (stat.size <= 512 * 1024) text = readFileSync(absolute, "utf8")
  } catch {
    text = undefined
  }
  if (section && text !== undefined) {
    const found = sectionText(text, section)
    return {
      absolute,
      exists: true,
      mtimeMs: stat.mtimeMs,
      sectionFound: found !== undefined,
      ...(found !== undefined ? { sectionText: found } : {}),
      sourceText: found ?? text,
    }
  }
  return { absolute, exists: true, mtimeMs: stat.mtimeMs, ...(text !== undefined ? { sourceText: text } : {}) }
}

const words = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[`*_[\]()]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "has", "have", "had",
  "not", "never", "none", "into", "onto", "than", "then", "when", "where", "which", "what", "who",
  "will", "would", "can", "could", "must", "may", "might", "its", "their", "your", "our", "you",
  "they", "them", "there", "here", "only", "also", "but", "all", "any", "each", "every", "more",
  "most", "some", "such", "one", "two", "use", "used", "using", "via", "per", "out", "own",
])

const contentWords = (value: string): string[] =>
  words(value).filter((word) => word.length >= 4 && !STOPWORDS.has(word))

const ngrams = (values: string[], size: number): Set<string> => {
  const out = new Set<string>()
  for (let i = 0; i + size <= values.length; i++) out.add(values.slice(i, i + size).join(" "))
  return out
}

const hasNegation = (value: string): boolean =>
  /\b(?:not|never|none|no\s+longer|refuted|unsupported|absent|missing|removed|without)\b/i.test(value)

// A negation only CONTRADICTS a positive claim when it negates a state. "The
// projector must never block admission" is not the opposite of "the projector
// never blocks admission"; both say the same thing. Requiring a copula or
// state auxiliary keeps that shared phrasing out of the report while still
// catching the observed shape ("none of the lengths ARE parsed").
const STATE_AUXILIARY = /\b(?:is|are|was|were|has|have|had|does|do|can|could)\b/i

const numbersIn = (value: string): string[] =>
  (value.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []).map((number) => number.replace(/,/g, ""))

/**
 * A page restatement check: a long verbatim run from the cited page. This is
 * deliberately narrow (12 words) so ordinary shared terminology -- a type name,
 * a path, a short phrase -- is not flagged. Tables, fenced blocks and the
 * three-line schema carry the rest of the load.
 */
const sharesVerbatimRun = (rule: string, source: string): boolean => {
  const entryWords = words(rule)
  if (entryWords.length < 12) return false
  const sourceGrams = ngrams(words(source), 12)
  for (const gram of ngrams(entryWords, 12)) if (sourceGrams.has(gram)) return true
  return false
}

/**
 * A possible negation conflict: the entry asserts something, and a sentence in
 * the cited section asserts the same thing with a negation. This is the shape
 * of the drift the observed map had (the map said a set of lengths were
 * parsed; the owning page said none of them were). It is a REPORT, never a
 * correction, and it is a heuristic: the report says "possible", because a
 * human or the cartographer must decide which side is right.
 */
const possibleNegationConflict = (rule: string, source: string): string | undefined => {
  if (hasNegation(rule)) return undefined
  const entryWords = new Set(contentWords(rule))
  if (entryWords.size < 3) return undefined
  const sentences = source.split(/(?:[.!?]\s+|\n+)/)
  for (const sentence of sentences) {
    if (!hasNegation(sentence) || !STATE_AUXILIARY.test(sentence)) continue
    const sentenceWords = new Set(contentWords(sentence))
    if (sentenceWords.size === 0) continue
    let overlap = 0
    for (const word of entryWords) if (sentenceWords.has(word)) overlap++
    const ratio = overlap / Math.min(entryWords.size, sentenceWords.size)
    if (overlap >= 3 && ratio >= 0.5) return truncate(sentence.trim())
  }
  return undefined
}

const invalidNumbers = (rule: string, source: string): string[] => {
  const claimed = [...new Set(numbersIn(rule))]
  if (claimed.length === 0) return []
  const sourceNumbers = new Set(numbersIn(source))
  return claimed.filter((number) => !sourceNumbers.has(number))
}

export type ValidateOptions = {
  root: string
  /** Injected for tests, and to make the drift check deterministic. */
  now?: number
}

export type FileValidation = {
  spec: MapSpec
  lines: number
  entries: MapEntry[]
  violations: Violation[]
}

/**
 * Validate one map file's TEXT. The active backlog is checked for its budget
 * and charters only; its entry shape belongs to active-backlog.ts.
 */
export const validateMapText = (spec: MapSpec, text: string, options: ValidateOptions): FileValidation => {
  const violations: Violation[] = []
  const lines = text.split(/\r?\n/)
  const nonBlank = lines.filter((line) => line.trim()).length
  const push = (kind: ViolationKind, detail: string, line?: number) =>
    violations.push({ file: spec.file, kind, detail, ...(line !== undefined ? { line: line + 1 } : {}) })

  if (nonBlank === 0) push("charter", `empty file; charter is ${spec.charter}`)
  if (nonBlank > spec.budget) {
    push("budget", `${nonBlank} non-blank lines exceeds the ${spec.budget}-line budget; consolidate, do not pad`)
  }

  if (spec.kind === "backlog") {
    if (!text.startsWith("# ")) push("charter", "active backlog must start with a top-level heading")
    return { spec, lines: nonBlank, entries: [], violations }
  }

  const entries = parseMapEntries(text)

  // Forbidden blocks: a table or a fenced block is a restatement of the page
  // that owns the fact, and a decision-record heading is the deliberation the
  // charter excludes.
  let inFence = false
  let tableReported = false
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      if (!inFence) push("restatement", "fenced code block; the map cites the file that owns the code, it does not copy it", i)
      inFence = !inFence
      continue
    }
    if (!inFence && !tableReported && (TABLE_ROW.test(lines[i]) || TABLE_SEPARATOR.test(lines[i]))) {
      push("restatement", "table; a table belongs on the page that owns it, not in the map", i)
      tableReported = true
    }
  }
  const record = DECISION_RECORD.exec(text)
  if (record) {
    push("schema", `decision-record block (${record[1]}); state only the operative constraint and its pointer`)
  }
  if (ARCHIVE_LANGUAGE.test(text)) {
    push("archive", "the map claims to be an archive or the only copy; derived content must never be the archive of record")
  }

  // Every list item is an entry and every entry carries a marker. An unmarked
  // bullet is the old free-form dialect, and it is where decision records and
  // mixed provenance came from.
  const entryStarts = new Set(entries.map((entry) => entry.startLine))
  inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (!inFence && LIST_ITEM.test(lines[i]) && !entryStarts.has(i)) {
      push("schema", "unmarked list item; every entry starts with - [binding], - [provisional] or - [disputed]", i)
    }
  }

  let binding = 0
  for (const entry of entries) {
    const line = entry.startLine
    if (entry.marker === "binding") binding++
    if (entry.lineCount > 3) {
      push("schema", `entry is ${entry.lineCount} lines; the rule must fit in one to three`, line)
    }
    if (!entry.verified) {
      push("schema", "entry has no (verified YYYY-MM-DD); the lifecycle and drift checks need it", line)
    } else if (!isCalendarDate(entry.verified)) {
      push("schema", `verified date ${entry.verified} is not a real calendar date`, line)
    } else if (Date.parse(`${entry.verified}T00:00:00Z`) > (options.now ?? Date.now()) + DAY_MS) {
      // A verification cannot be days in the future; this catches a hand-edited
      // year, which would otherwise keep an entry alive forever. One day of
      // grace is deliberate: `verified` is a local calendar date and the clock
      // reading here is UTC, so "today" can legitimately be one day ahead.
      push("schema", `verified date ${entry.verified} is more than a day in the future`, line)
    }
    if (!entry.pointer) {
      push("schema", "entry has no `— See <path>` pointer; a fact with no home is not a map entry", line)
      push("unarchived", "content has no resolvable source in the tree; report it, do not emit it as derived", line)
      continue
    }
    if (spec.sectionRequired && /\.md$/i.test(stripLineSuffix(entry.pointer)) && !entry.section) {
      push("schema", `page citation \`${entry.pointer}\` needs a §section; a page is cited, not restated`, line)
    }

    const resolved = resolvePointer(options.root, entry.pointer, entry.section)
    if (!resolved.exists) {
      push("dangling", `cites \`${entry.pointer}\`, which does not exist in the tree`, line)
      push("unarchived", `no source for \`${entry.pointer}\`; keep the text and report it, never delete it`, line)
      continue
    }
    if (entry.section && resolved.sectionFound === false) {
      push("drift", `cites §${entry.section} in \`${entry.pointer}\`, but that section no longer exists`, line)
      continue
    }
    if (resolved.mtimeMs !== undefined && entry.verified) {
      const modified = new Date(resolved.mtimeMs).toISOString().slice(0, 10)
      if (modified > entry.verified) {
        push("drift", `\`${entry.pointer}\` changed on ${modified}, after this entry was verified on ${entry.verified}; re-verify it`, line)
      }
    }
    if (resolved.sourceText !== undefined) {
      const missing = invalidNumbers(entry.rule, resolved.sourceText)
      if (missing.length > 0) {
        push("drift", `numeric claim(s) ${missing.join(", ")} not found in \`${entry.pointer}\`; the map and the source may disagree`, line)
      }
      if (sharesVerbatimRun(entry.rule, resolved.sourceText)) {
        push("restatement", `contains a long verbatim span from \`${entry.pointer}\`; cite the section instead`, line)
      }
      const conflict = possibleNegationConflict(entry.rule, resolved.sourceText)
      if (conflict) {
        push("drift", `possible contradiction with \`${entry.pointer}\`: "${conflict}"; verify, do not silently overwrite either side`, line)
      }
    }
  }

  if (entries.length < spec.minEntries) {
    push("charter", `${entries.length} entr${entries.length === 1 ? "y" : "ies"} is degenerate for ${spec.charter}`)
  } else if (entries.length > 0 && binding === 0) {
    push("charter", "every entry is provisional or disputed; a navigation file must carry at least one binding constraint")
  }

  return { spec, lines: nonBlank, entries, violations }
}

export type RemovedEntry = { line: number; text: string }

export type NormalizeMapResult = {
  text: string
  removed: RemovedEntry[]
  kept: number
}

/**
 * Apply the lifecycle to one file's text.
 *
 * `canResolve` is what makes the sweep safe: a provisional entry is dropped
 * only when its pointer still resolves in the tree. An entry whose source is
 * gone is never dropped -- it is the unarchived content the caller must report.
 */
export const normalizeMapText = (
  spec: MapSpec,
  text: string,
  options: { now?: number; canResolve?: (pointer: string, section?: string) => boolean } = {},
): NormalizeMapResult => {
  const now = options.now ?? Date.now()

  if (spec.kind === "backlog") {
    const result = normalizeBacklog(text, now)
    return {
      text: result.text,
      removed: result.removed.map((title) => ({ line: 0, text: title })),
      kept: 0,
    }
  }

  const entries = parseMapEntries(text)
  const drop = new Set<number>()
  const removed: RemovedEntry[] = []
  for (const entry of entries) {
    // Binding constraints and disputed entries are EXEMPT from age: a
    // constraint does not stop binding because it is old, and a disagreement is
    // not resolved by a clock.
    if (entry.marker !== "provisional") continue
    if (!entry.verified || !entry.pointer) continue
    // No source, no drop. This is the archive-of-record guard: deleting an
    // entry that exists only in the map would destroy the only copy.
    if (options.canResolve && !options.canResolve(entry.pointer, entry.section)) continue
    const at = Date.parse(`${entry.verified}T00:00:00Z`)
    if (!Number.isFinite(at)) continue
    if (now - at <= spec.provisionalDays * DAY_MS) continue
    for (let i = entry.startLine; i < entry.endLine; i++) drop.add(i)
    removed.push({ line: entry.startLine + 1, text: truncate(entry.rule) })
  }

  if (removed.length === 0) return { text, removed, kept: entries.length }

  const keptLines = text.split(/\r?\n/).filter((_, index) => !drop.has(index))
  // Removing a block can leave three blank lines where the entry was. Collapse
  // them so the file stays canonical and a second pass cannot "change" it.
  const compact = keptLines.join("\n").replace(/\n{3,}/g, "\n\n")
  const out = compact.endsWith("\n") ? compact : `${compact}\n`
  return { text: out, removed, kept: entries.length - removed.length }
}

export type MapMaintenance = {
  files: Array<{ file: string; changed: boolean; removed: RemovedEntry[] }>
  removedTotal: number
}

/** Apply every file's lifecycle to the map on disk. Never throws on a missing file. */
export const maintainMap = (root: string, mapDir: string, now = Date.now()): MapMaintenance => {
  const files: MapMaintenance["files"] = []
  let removedTotal = 0
  for (const spec of MAP_SPECS) {
    const absolute = path.join(mapDir, spec.file)
    if (!existsSync(absolute)) continue
    let before: string
    try {
      before = readFileSync(absolute, "utf8")
    } catch {
      continue
    }
    const canResolve = (pointer: string, section?: string) => resolvePointer(root, pointer, section).exists
    const result = normalizeMapText(spec, before, { now, canResolve })
    const changed = result.text !== before
    if (changed) writeFileSync(absolute, result.text)
    if (result.removed.length > 0) {
      removedTotal += result.removed.length
      files.push({ file: spec.file, changed, removed: result.removed })
    } else if (changed) {
      // The backlog rewrites to canonical form without necessarily dropping a
      // task; report the rewrite so the caller can log it.
      files.push({ file: spec.file, changed, removed: [] })
    }
  }
  return { files, removedTotal }
}

export type MapAudit = {
  ok: boolean
  files: FileValidation[]
  violations: Violation[]
}

/** Read and validate every map file. Read-only: it never writes and never fixes. */
export const auditMap = (root: string, mapDir: string, now = Date.now()): MapAudit => {
  const files: FileValidation[] = []
  const violations: Violation[] = []
  const rulesSeen = new Map<string, string>()

  for (const spec of MAP_SPECS) {
    const absolute = path.join(mapDir, spec.file)
    if (!existsSync(absolute)) {
      const violation: Violation = { file: spec.file, kind: "missing-file", detail: `missing; charter is ${spec.charter}` }
      violations.push(violation)
      continue
    }
    let text: string
    try {
      text = readFileSync(absolute, "utf8")
    } catch {
      violations.push({ file: spec.file, kind: "missing-file", detail: "unreadable" })
      continue
    }
    const result = validateMapText(spec, text, { root, now })
    files.push(result)
    violations.push(...result.violations)

    if (spec.kind === "entries") {
      for (const entry of result.entries) {
        const key = normalizeRule(entry.rule)
        if (key.length < 12) continue
        const home = rulesSeen.get(key)
        if (home !== undefined && home !== spec.file) {
          violations.push({
            file: spec.file,
            line: entry.startLine + 1,
            kind: "duplicate",
            detail: `same rule is already stated in ${home}; one fact has one home`,
          })
        } else if (home === undefined) {
          rulesSeen.set(key, spec.file)
        }
      }
    }
  }

  return { ok: violations.length === 0, files, violations }
}

/** One-line-per-issue rendering for the plugin log. */
export const formatViolations = (violations: Violation[], limit = 20): string[] =>
  violations.slice(0, limit).map((violation) => {
    const where = violation.line !== undefined ? `${violation.file}:${violation.line}` : violation.file
    return `${where} [${violation.kind}] ${violation.detail}`
  })
