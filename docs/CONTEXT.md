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
- **One file per question.** Five files, each with a defined scope, so an agent
  reads one of them rather than all of them.
- **Canonical entry points.** The highest-value thing in the map is a short
  "Start here" list per subsystem: the five files an agent should open, each
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

## The five files

`.opencode/context/` holds exactly these, and nothing else:

| File | What belongs in it |
| --- | --- |
| `architecture.md` | The high-level shape: layers, boundaries, entry points, dependency rules. Read this for an architectural question. |
| `contexts.md` | The major subsystems. For each: what it is for, where to start reading it, what it depends on, what must not change while you are in there. Read this for a subsystem question. |
| `conventions.md` | Repository-specific rules: naming, module layout, error handling, testing, persistence. Read this before writing code, not after. |
| `workflows.md` | The few runtime flows worth tracing end to end — how a request becomes a mutation, how a plugin hook reaches the thing it hooks. Read this when you need to know what actually happens at runtime. |
| `decisions.md` | Architectural decisions that the repository's own decision log does not already record. Concise, variable length. |

Files the user or the plan explicitly names always win over the map. The map is
a shortcut to the right starting point, not an authority: when it disagrees with
the source, the source is right and the map is wrong.

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
architectural decision, a previously undocumented invariant — and to report
"no update needed" otherwise.

If the map is missing entirely, nothing breaks: agents check, find nothing, and
explore as they always did. The standing rule that tells them to check is
injected into your config only when you have no `instructions` array of your own.

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

## One writer

Only `context` writes the map. Every other agent is told never to edit
it, and to say in its final report if its work revealed something that belongs
in there. The cartographer, in turn, is denied permission to write anything
outside the map — not by convention, but by an `edit` rule that allows
`.opencode/context/**` and nothing else.

The rule runs in both directions. The agents that *could* write anywhere else in
the repository — the root `build` agent and both implement tiers — carry the
mirror image of the cartographer's grant: `"*": "allow"` followed by a `deny` on
`.opencode/context/**`, so they edit everything except the map. The instruction
telling them not to touch it is still there, and still matters — a permission
denial tells an agent nothing about what it should have done instead — but it is
no longer the only thing standing between them and the map.

This exists because two writers produce a map that is neither current nor
trustworthy. Concurrent sessions rewriting the same five files produce
contradictions that no later reader can resolve, and the reader has no way to
tell which version is newer.

Ordering in those rules is not cosmetic. opencode resolves a file permission by
taking the **last** matching rule in declaration order, with no specificity
sorting: a `deny` written above a broad `"*": "allow"` loses. LaCode therefore
writes every narrow rule last, in both files (`src/agents.ts` and your own
`opencode.jsonc`), and `src/lib/writer-rule.ts` checks that order rather than
grepping for the word `allow` — which is what stops a correctly-placed deny from
being reported as a hole.

The rule has a sharp edge worth knowing about, because it has already bitten
this project: **opencode evaluates a file permission against the path relative
to the project root, not the absolute path the tool was given.** A rule written
as `*/.opencode/context/**` matches an absolute path and therefore matches
nothing at all. Both spellings are therefore required — `.opencode/context/**`
for a normally-rooted project and `*/.opencode/context/**` for one rooted at
`/` — and LaCode ships both. At startup the plugin checks your config for that,
and logs an error naming the rules it saw if neither form would ever fire.

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
directory does not list the five files, your shell is not at the root and
neither is opencode's worktree. The cost of getting it wrong is not a crash —
it is a silent return to a map maintained only by prompt, which is the exact
state US-21 exists to eliminate.

The symptom of getting this wrong is not a crash. The cartographer's writes are
simply denied, its run still "succeeds", and the map quietly stops changing. So
a run that changed nothing on disk is reported as a warning, not as a success:
if you see `auto update finished without changing the map` repeatedly, the first
thing to check is that permission rule, not the map's content.

## What you will see in the log

| Line | Meaning |
| --- | --- |
| `borrowed pool slot N (model, wW) for auto update` | A refresh started, on a pooled model. |
| `auto update finished` | The run completed and changed at least one map file. |
| `auto update finished without changing the map` | Nothing landed. Either nothing needed saying, or the cartographer could not write. |
| `auto update failed: …` | The run errored. The paths it was given are queued again for the next window, so the work is not lost. |
| `context map is not writable: …` | Your config's one-writer rule does not match the path opencode evaluates. Nothing will update until you fix it. |
| `context map has more than one writer: …` | An agent other than `context` would be granted the map. The offending agent and the winning rule are named. |

## Reference

- The agent and command definitions, as injected: `src/agents.ts`, `src/commands.ts`.
- The idle/edit trigger: `src/plugins/context-autoupdate.ts`.
- The one-writer rule check: `src/lib/writer-rule.ts`.
- The behavioural contracts, with acceptance criteria a test asserts:
  [USER-STORIES.md](USER-STORIES.md), US-19 to US-22.
- Tests: `tests/stories/g-context-management.test.mjs`.