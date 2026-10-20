// Active backlog: text in, text out, and the rolling window the file exists to serve.
//
// The backlog is a short view of work in flight -- tasks grouped by the ISO
// week they were opened -- and it stays readable ONLY because it rolls. The
// window exists so that what just landed is always near the top and the
// finished never pile up: a finished task lingers for RETENTION_DAYS so the
// file still shows what closed this week, then it is dropped; an open task
// stays however long it takes, because age is no reason to lose track of
// unfinished work. Without the drop the file only ever grows, and a list that
// only ever grows is a list nobody reads.
//
// THE RETENTION RULE LIVES IN THIS MODULE, IN CODE, NOT IN A MODEL PROMPT. A
// rule a model applies is a rule the model applies when it feels like it: one
// run prunes, the next run does not, and nothing anywhere reports the
// difference -- the failure is SILENT, the backlog just grows, slowly enough
// that nobody notices until the file is unreadable. Code applies the rule on
// every normalize, identically, and a test can pin the exact boundary ("more
// than a week", strictly). The model's job is to write a line in the right
// shape; deciding when that line has aged out is arithmetic, and arithmetic
// belongs where it can be checked.
//
// Pure by design: no disk, no plugin exports, no side effects. The caller owns
// reading and writing ACTIVE_BACKLOG_FILE; this module only turns text into
// entries and entries back into canonical text. `now` is a parameter of
// normalizeBacklog (defaulting to Date.now()) precisely so the retention
// boundary can be tested without waiting for time to pass.

export const ACTIVE_BACKLOG_FILE = "active.md"
export const RETENTION_DAYS = 7

export type BacklogEntry = {
  title: string
  week?: string        // "2026-W43" — the ISO week it was opened in
  finished: boolean
  finishedAt?: string  // "2026-10-19"
}

const DAY_MS = 24 * 60 * 60 * 1000

// The fixed file header. It is part of the canonical form because a file whose
// header the parser also re-emits survives a full rewrite unchanged, and the
// instructions in the preamble are for the human editing the file -- they must
// not drift with the data.
const HEADER = `# Active backlog

Tasks in flight, grouped by the week they were opened. A finished task stays
here for a week after it was finished and is then dropped; an open task stays
however long it takes. Add a line under the right week, and give a finished
task its date: \`- [x] Title — opened 2026-W43, finished 2026-10-19\`.`

// A task line is a markdown list item whose checkbox is [ ], [x] or [X].
// Everything else in the file -- the header, headings, preamble prose, blank
// lines, hand-written notes -- is not a task and is skipped silently, so the
// parser can be pointed at a file a human has been editing freely without
// having to understand the parts that are not data.
const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s*\[([ xX])\]\s*(.*)$/

// `opened <ISO week>` and `finished <date>` ride after the title, separated
// from it by an em dash, en dash or hyphen (the canonical form uses the em
// dash; a hand-edited file may use either of the others). `finished` also
// follows a COMMA in the canonical two-fragment line, because the pair reads
// `— opened 2026-W43, finished 2026-10-19` and the second fragment is not
// separated from the first by a dash. Matching the fragments by SHAPE -- the
// digits and all -- is what keeps a title that happens to contain the word
// "opened" or a stray hyphen from being read as metadata: anything that does
// not look exactly like `2026-W43` or a real calendar date is title text and
// stays where it is.
const META =
  /(?:—|–|-)\s*opened\s+(\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3]))|[,—–-]\s*finished\s+(\d{4}-\d{2}-\d{2})/gi

// A regex accepts `2026-02-30`; the calendar does not. V8 does not return NaN
// for the overflow either -- it silently rolls the date over to March 2 -- so
// the only reliable check is to parse the instant and read the date back: a
// real date reads back as itself, a rollover does not.
const isCalendarDate = (s: string): boolean => {
  const at = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === s
}

export const parseBacklog = (text: string): BacklogEntry[] => {
  const entries: BacklogEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = TASK_LINE.exec(raw)
    if (!line) continue
    const finished = line[1] !== " "
    let week: string | undefined
    let finishedAt: string | undefined
    const stripped = line[2].replace(META, (fragment, openedWeek, finishedDate) => {
      // First occurrence wins for each field; every recognized fragment is
      // stripped regardless, so a rewrite cannot duplicate one.
      if (openedWeek !== undefined) {
        week ??= openedWeek.toUpperCase()
        return ""
      }
      if (finishedDate !== undefined && isCalendarDate(finishedDate)) {
        finishedAt ??= finishedDate
        return ""
      }
      return fragment // an impossible date is title text, not metadata
    })
    // Trim the separators and whitespace the removed fragments leave at the
    // ends. Nothing inside is touched: collapsing interior whitespace would
    // rewrite a title the user typed, and the result of this trim is already
    // stable under a re-parse.
    const title = stripped.replace(/^[\s—–-]+|[\s—–-]+$/g, "")
    if (!title) continue // a bare checkbox carries no work to track
    entries.push({ title, ...(week ? { week } : {}), finished, ...(finishedAt ? { finishedAt } : {}) })
  }
  return entries
}

// Weeks are headings, so they are ordered NEWEST FIRST: the reader's eye lands
// on this week first. Entries inside a section keep INPUT ORDER -- re-sorting
// them would silently reshuffle a hand-edited file, and a file that moves
// under the user's hands stops being one they trust. A week heading that is
// not an ISO week (only possible for a hand-built entry) sorts after the real
// ones rather than vanishing from the order; `## Unscheduled` is last always.
const ISO_WEEK = /^(\d{4})-W(\d{2})$/i
const newestFirst = (a: string, b: string): number => {
  const ma = ISO_WEEK.exec(a)
  const mb = ISO_WEEK.exec(b)
  if (ma && mb) return Number(mb[1]) - Number(ma[1]) || Number(mb[2]) - Number(ma[2])
  if (ma) return -1
  if (mb) return 1
  return a < b ? 1 : a > b ? -1 : 0
}

const renderLine = (entry: BacklogEntry): string => {
  const box = entry.finished ? "[x]" : "[ ]"
  const meta: string[] = []
  if (entry.week) meta.push(`opened ${entry.week}`)
  // The date describes the box being ticked, so it rides only on a FINISHED
  // entry -- an unchecked line carrying a parsed date was a hand-editing
  // accident, and the canonical form does not repeat it. That keeps render a
  // pure function of what the entry means, and render -> parse -> render
  // stable for every entry either side can produce.
  if (entry.finished && entry.finishedAt) meta.push(`finished ${entry.finishedAt}`)
  const head = `- ${box} ${entry.title}`
  if (meta.length === 0) return head
  // The week leads behind an em dash and `finished` follows behind a comma;
  // an entry with no week gets the bare `, finished ...` form.
  return entry.week ? `${head} — ${meta.join(", ")}` : `${head}, ${meta.join(", ")}`
}

export const renderBacklog = (entries: BacklogEntry[]): string => {
  const buckets = new Map<string | null, BacklogEntry[]>()
  for (const entry of entries) {
    const key = entry.week ? entry.week : null
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }
  const weeks = [...buckets.keys()].filter((week): week is string => week !== null).sort(newestFirst)
  let out = HEADER
  for (const week of weeks) out += `\n\n## ${week}\n\n${buckets.get(week)!.map(renderLine).join("\n")}`
  const unscheduled = buckets.get(null)
  if (unscheduled) out += `\n\n## Unscheduled\n\n${unscheduled.map(renderLine).join("\n")}`
  return `${out}\n` // exactly one trailing newline, never two
}

export const normalizeBacklog = (text: string, now = Date.now()): { text: string; removed: string[] } => {
  const entries = parseBacklog(text)
  const kept: BacklogEntry[] = []
  const removed: string[] = []
  for (const entry of entries) {
    // Drop IFF finished AND dated AND STRICTLY more than RETENTION_DAYS old:
    // `>` and not `>=`, because the rule is "stays here for a week after it
    // was finished" -- exactly seven days is still that week. A finished
    // entry with no date has nothing to age from and is kept; a date that
    // does not parse cannot age either (parseBacklog refuses to record one,
    // so the guard below is belt and braces) and is kept the same way; an
    // open entry is kept however old it is, since unfinished work does not
    // expire.
    if (entry.finished && entry.finishedAt) {
      const at = Date.parse(`${entry.finishedAt}T00:00:00Z`)
      if (Number.isFinite(at) && now - at > RETENTION_DAYS * DAY_MS) {
        removed.push(entry.title)
        continue
      }
    }
    kept.push(entry)
  }
  // Rendering the KEPT entries makes the result canonical, so normalizing an
  // already-canonical file changes nothing -- the fixed point the suite pins.
  return { text: renderBacklog(kept), removed }
}
