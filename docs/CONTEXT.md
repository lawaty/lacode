# The context map

Every task an agent starts, it starts by exploring: list the directories, open
the entry points, work out which layer a change belongs to, discover which files
call which. On a large repository that is the single most expensive part of the
job, and it happens *every time* — for a question that touches one file, for a
refactor that moves one module, for a session you start after an hour of
something else.

LaCode keeps a short, maintained map of your repository at `.opencode/context/`
and makes every agent read it before exploring. The map answers one question —
**"what should I look at first?"** — and nothing else.

This document is the user-facing description of the system: what the files are,
who writes them, when they are refreshed, and what you can do by hand.

## Why it exists

Agents are stateless between tasks. Anything an agent learns about your
codebase in one session is discarded at the end of it, and re-derived — at full
price — by the next agent. Writing the findings down once, in a form small
enough to read in one call, is what turns that repeated cost into a single
upfront one.

The mechanism is deliberately narrow, because a map that costs more to read than
the exploration it replaces is worse than no map:

- **Conclusions, not inventories.** "`OrderService` is the application boundary
  for order mutations", not "there is a file called OrderService in
  `src/orders/`". The cartographer is forbidden by name from writing directory
  listings, copying source, or restating what the README already says.
- **One file per question.** Five navigation files, each with a defined scope, so
  an agent reads one of them rather than all of them. A sixth file,
  `active.md`, holds the work in flight rather than a map of the repository.
- **Canonical entry points.** The highest-value thing in the map is a short
  "Start here" list per subsystem: the canonical files an agent should open, each
  with a one-phrase reason.
- **It links out.** Your project's own README, ADRs and docs are authoritative
  and are not duplicated here.

On cost: the saving is in **tokens not spent re-discovering structure**, and it
is paid by exploration tokens rather than by the expensive main model — the
cartographer that maintains the map runs on a pooled model like every other
subagent. **No savings percentage is published here, because none has been
independently measured.** A number derived from somebody else's repository and
token mix is not a claim about yours; see [BENCHMARKS.md](BENCHMARKS.md) for the
harness that produces a number for your own workload.

## The files in the map

`.opencode/context/` holds the five navigation files below, plus one file that is
a work list rather than a map:

| File | What belongs in it |
| --- | --- |
| `architecture.md` | The high-level shape: layers, boundaries, entry points, dependency rules. Read this for an architectural question. |
| `contexts.md` | The major subsystems. For each: what it is for, where to start reading it, what it depends on, what must not change while you are in there. Read this for a subsystem question. |
| `conventions.md` | Repository-specific rules: naming, module layout, error handling, testing, persistence. Read this before writing code, not after. |
| `workflows.md` | The few runtime flows worth tracing end to end — how a request becomes a mutation, how a plugin hook reaches the thing it hooks. Read this when you need to know what actually happens at runtime. |
| `decisions.md` | Architectural constraints that bind future work and that the repository's own decision log does not already record. Each entry states the constraint and points at the page or path that owns it. Capped at 120 non-blank lines; decision records and deliberation are not copied here. |
| `active.md` | The active backlog: work in flight, grouped by the ISO week each task was opened in. A task that is not marked `[x]` is open and is never removed; a task that is finished and dated is kept for a week after it was finished, then dropped. The plugin enforces that window — see [How it stays current](#how-it-stays-current). Not a navigation file: there is no question it is the answer to. |

The project's root `AGENTS.md` is the standing-instructions home: the client's
own statement of intent, what they want worked on and how they want it
approached. It sits outside the map, is per-clone and not committed, and has
no prescribed structure. It has exactly one writer — the hidden `instructions`
agent, reachable only from the `/agent-instructions` command.

Files the user or the plan explicitly names always win over the map. The map is
a shortcut to the right starting point, not an authority. When it disagrees with
**code**, the code is right and the map is wrong. When it disagrees with a
**project page**, neither side is automatically right: the map may be current
and the page stale (that has happened). The disagreement is reported and marked
`[disputed]`; the page's owner resolves it. The cartographer never silently
overwrites either side.

## The entry contract

Every navigation entry has one shape, in every file:

```markdown
- [binding] The operative rule, in at most three non-blank lines. — See `docs/DESIGN.md` §The two halves (verified 2026-10-26)
```

- **A provenance marker.** `[binding]` is a constraint established against the
  source and exempt from age expiry. `[provisional]` is an inference or an
  unverified claim and expires 30 days after `verified`. `[disputed]` records a
  map/page disagreement and is kept, reported, and exempt from age until the
  owner resolves it. There is no second confidence dialect.
- **The rule, not the deliberation.** No Context / Decision / Consequences /
  Alternatives blocks, status lines, or decision records. A reader needs the
  constraint, not the meeting that produced it.
- **A pointer.** A fact whose home is a page cites the page **and** its section
  (`docs/DESIGN.md §Retention`). A fact whose home is code cites the path, with
  an optional line or symbol. No pointer means the content has no source in the
  tree — it is reported as unarchived, never emitted as though it were derived.
- **A verification date.** `(verified YYYY-MM-DD)` drives both the lifecycle and
  the drift check.

Every file has a hard cap, counted in **non-blank lines**: architecture 150,
contexts 200, conventions 150, workflows 150, decisions 120, active 60. Lines
are the unit because they are what a reader pays for, they bound an entry that
wraps to three lines, and the validator can count them exactly; an entry count
does not bound cost, and a token count needs a tokenizer and is model-specific.
The cap is enforced by a post-generation validator, not only by the prompt.

The lifecycle generalises the window `active.md` already had. A finished backlog
task is dropped after 7 days. A `[provisional]` entry in any navigation file is
dropped 30 days after its `verified` date unless it is re-verified. `[binding]`
and `[disputed]` never expire by age. An entry whose cited source no longer
exists is **never** auto-dropped: it may be the only copy, so it is reported as
unarchived and kept. Only provisional entries whose source still resolves are
eligible for the sweep. The arithmetic lives in `src/lib/map-schema.ts`; the
cartographer writes the shape, code decides what has aged out.

The map is **local and untracked**. It describes *your* checkout on *this*
machine, so committing it would churn on every session that edits a file, and
syncing it to another host would push a description of one machine's projects
onto hosts that have different ones. If you see `.opencode/context/` in a diff,
something has gone wrong.

## How it stays current

The `context` agent maintains the map. It runs in two ways: on its own,
after a session that changed something, and on demand through the three
commands — both of which go through the same agent, so they behave the same way.

### Automatically

After a **root** session goes idle, and only if that session edited a file
inside the project, LaCode starts a `context` run:

1. It collects the paths the session touched, dropping anything generated,
   vendored or outside the project (`node_modules`, `dist`, `coverage`,
   `.git`, and — importantly — the map itself, so the cartographer's own writes
   never trigger another run).
2. It picks `bootstrap` or `update` from what is on disk: if
   `.opencode/context/` does not exist, the run builds the map from scratch;
   if it exists, the run updates it.
3. It borrows a slot from the same pool every other subagent uses, creates a
   session, and hands it the changed paths as *starting context* — not as an
   exhaustive list and not as an instruction to document all of them.

Three things deliberately do **not** trigger a run: a session that edited
nothing, a subagent going idle (they go idle constantly, mid-task), and a second
run within ten minutes of the last one.

An update defaults to *no edit*. A changed file is not a changed fact:
formatting, local renames, added tests and dependency bumps rarely alter what
the map should say. The cartographer is told to edit only when the work
introduced or revealed something that will help a future agent — a new boundary,
a new or moved entry point, a changed workflow, a new convention, an
architectural decision, an undocumented invariant — and to report
"no update needed" otherwise.

After the turn ends, the plugin applies the per-file lifecycle and then audits
the map. The audit is **report-only**: it never rewrites a claim and never
deletes an entry whose source is gone. It checks the schema, each file's line
budget, dangling paths and `§sections`, a numeric claim absent from its cited
source, a possible negation conflict, a source modified after its `verified`
date, tables and fenced blocks (restatements), duplicate rules across files,
archive-of-record language, and whether each file still answers its charter. A
failure is a loud `error` in the log; it is what turns the prompt's rules into a
gate. The deterministic half is `src/lib/map-schema.ts`; the semantic drift pass
is the cartographer's, and it reports a page disagreement instead of picking a
side.

If the map is missing entirely, nothing breaks: agents run the check, find no
`.opencode/context/`, and explore from scratch. What tells them to run the check
is an entry appended to your config's `instructions` array: your own entries are
kept as they are, and a marked entry goes after them unless one of your entries
already carries its marker or its opt-out. LaCode appends two such entries, each
governed by its own pair — the context-map rule
(`<!-- lacode:context-map-instruction:v1 -->`, opt out with
`<!-- lacode:context-map-instruction:off -->`) and the rule that documentation
states the current state (`<!-- lacode:current-state-rule:v1 -->`, opt out with
`<!-- lacode:current-state-rule:off -->`). One opt-out suppresses only the rule
it names.

### On demand

```bash
/context-init      # build the map, or verify and refresh an existing one
/context-update    # incremental refresh; accepts a focus, e.g. /context-update src/payments
/context-review    # audit it for staleness, contradictions, duplication and bloat
```

All three delegate to the same agent, which is why they are consistent with the
automatic run rather than a separate mechanism. `/context-review` treats
everything outside `.opencode/context/` as read-only: it fixes the map, never
your source.

If you have defined a command of the same name, yours wins and is left exactly
as you wrote it — the same merge-without-clobber rule the agents follow.

`active.md` is the file the plugin maintains as a backlog rather than as a
navigation map. The cartographer records what happened — work in flight, and a
task marked finished with the date it finished — and the plugin decides what is
still worth keeping: the file is regrouped by week and a task that was finished
more than a week ago is dropped. The arithmetic lives in
`src/lib/active-backlog.ts`, not in the cartographer's prompt, because a rule a
model applies is a rule the model applies when it feels like it, and the failure
is silent — the backlog just grows. The plugin normalizes the file on every edit
of it and once when the session starts, so a hand edit is grouped and pruned
whether the cartographer ran or not, and the file is rewritten only when its
canonical form differs from what is on disk, so the write cannot loop.

The same code owns the navigation files' lifecycle, but it may only **drop** an
entry that is `[provisional]`, past its 30-day window, and whose cited source
still exists. It never drops a binding constraint or disputed entry, and it
never drops an entry with no source — that is the one case where the map may be
the only copy. The plugin is not a second writer of the map in the permission
sense: `context` is still the only **agent** that writes it. The lifecycle is
housekeeping by code, the same category as the backlog window.

## One writer

Only `context` writes the map. Every other agent is told never to edit
it, and to say in its final report if its work revealed something that belongs
in there. The cartographer, in turn, is denied permission to write anything
outside the map — not by convention, but by an `edit` rule that allows
`.opencode/context/**` and nothing else.

The rule runs in both directions. The agents that *could* write anywhere else in
the repository — the root `build` agent and both implement tiers — carry the
mirror image of the cartographer's grant: `"*": "allow"` followed by a `deny` on
`.opencode/context/**`, so they edit everything except the map. Enforcement is
two mechanisms at once, and both are load-bearing: the injected instruction
naming the one writer, and the permission rule — a permission denial tells an
agent nothing about what it should have done instead.

This exists because two writers produce a map that is neither current nor
trustworthy. Concurrent sessions rewriting the same files produce
contradictions that no later reader can resolve, and the reader has no way to
tell which version is newer.

Ordering in those rules is not cosmetic. opencode resolves a file permission by
taking the **last** matching rule in declaration order, with no specificity
sorting: a `deny` written above a broad `"*": "allow"` loses. LaCode therefore
writes every narrow rule last, in both files (`src/agents.ts` and your own
`opencode.jsonc`), and `src/lib/writer-rule.ts` checks that order rather than
grepping for the word `allow` — which is what stops a correctly-placed deny from
being reported as a hole.

The rule has a sharp edge worth knowing about: **opencode evaluates a file
permission against the path relative to the project root, not the absolute path
the tool was given.** A rule written as `*/.opencode/context/**` matches an
absolute path and therefore matches nothing at all. Both spellings are therefore
required — `.opencode/context/**` for a normally-rooted project and
`*/.opencode/context/**` for one rooted at `/` — and LaCode ships both. At
startup the plugin checks your config for that, and logs an error naming the
rules it saw if neither form would ever fire.

### The residual risk: a subdirectory worktree

Those patterns are matched against `relative(worktree, filepath)`, and the
spelling that is supposed to fire depends on where the worktree root sits:

- **worktree = repo root** → the map is `.opencode/context/architecture.md`, and
  `.opencode/context/**` fires. `*/.opencode/context/**` does not.
- **worktree = `/`** → the map is `home/<you>/…/.opencode/context/…`, and only
  `*/.opencode/context/**` fires.

Shipping both spellings covers those two. What it does **not** cover is a third
case: if the worktree is a subdirectory rather than the repo root — you opened
opencode one directory down from the repository root — then the evaluated path
gains a prefix that matches *neither* pattern. Both rules match nothing, the
deny against other agents silently stops applying, and **nothing is reported**,
because a rule matching nothing is not an error in opencode's evaluator and the
startup check has no way to see a worktree it was not told about.

How to detect it: open opencode from the repository root, not from a
subdirectory of it. If `ls .opencode/context` from your shell's current
directory does not list the map files, your shell is not at the root and
neither is opencode's worktree. The cost of getting it wrong is not a crash —
it is a map maintained only by prompt, with no mechanism enforcing who writes it.

The symptom is silence: the cartographer's writes are denied without an error,
its run reports success, and the map quietly stops changing. So a run that
changed nothing on disk is reported as a warning, not as a success: if you see
`auto update finished without changing the map` repeatedly, the first thing
to check is that permission rule, not the map's content.

## What you will see in the log

| Line | Meaning |
| --- | --- |
| `borrowed pool slot N (model, wW) for auto update` | A refresh started, on a pooled model. |
| `auto update finished` | The run completed and changed at least one map file. |
| `auto update finished without changing the map` | Nothing landed. Either nothing needed saying, or the cartographer could not write. |
| `auto update failed: …` | The run errored. The paths it was given are queued again for the next window, so the work is not lost. |
| `map lifecycle: dropped N expired provisional entr… from <file>` | The code sweep dropped an entry past its 30-day window. Binding and disputed entries are never dropped. |
| `context map validation passed` | Every file is in schema and within budget, every pointer resolves, and the drift checks found nothing. |
| `context map validation failed: N issue(s)` | The run's map is off schema or over budget, cites a missing path/section, restates a page, or has a possible contradiction. The map is **not** rewritten; the log names up to 20 issues and the paths to fix. |
| `context map is not writable: …` | Your config's one-writer rule does not match the path opencode evaluates. Nothing will update until you fix it. |
| `context map has more than one writer: …` | An agent other than `context` would be granted the map. The offending agent and the winning rule are named. |

## Reference

- The agent and command definitions, as injected: `src/agents.ts`, `src/commands.ts`.
- The prompt the model actually runs, in one place: `src/lib/cartographer-prompt.ts`; the tracked copy is `.opencode/prompts/context.txt`, and a test pins equality.
- The idle/edit trigger and the post-run audit wiring: `src/plugins/context-autoupdate.ts`.
- The schema, budget, lifecycle and deterministic drift check: `src/lib/map-schema.ts`.
- The active backlog's window: `src/lib/active-backlog.ts`.
- The one-writer rule check: `src/lib/writer-rule.ts`.
- Fixtures and their report: `tests/fixtures/context-map/`, `scripts/context-map-fixture.mjs`.
- The behavioural contracts, with acceptance criteria a test asserts:
  [USER-STORIES.md](USER-STORIES.md), US-19 to US-22.
- Tests: `tests/stories/g-context-management.test.mjs`.