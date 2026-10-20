# Changelog

All notable changes to LaCode are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions come from git release commits; the npm version is bumped in the same
commit as the changelog entry it describes.
## [Unreleased]

## [0.9.0] — the cartographer keeps an active backlog, and the model stops naming slot variants

### Added

- **The cartographer keeps an active backlog, and the plugin enforces its
  window.** `.opencode/context/active.md` is a sixth file in the map directory:
  the work in flight, grouped by the ISO week each task was opened in. A task
  that is not marked `[x]` is open, and an open task is never removed however
  old it is; a task that is finished and dated is kept for a week after it was
  finished and is then dropped. The file is therefore a rolling window rather
  than a history — the question it answers is "what is open, and what just
  closed", not "what has ever been done". A backlog that only grows is a
  backlog nobody reads.

  The window is applied by `src/lib/active-backlog.ts` and by the plugin, not
  by the cartographer's prompt. Deciding when a task has aged out is
  arithmetic, and arithmetic belongs where a test can pin the boundary: a rule
  a model applies is a rule the model applies when it feels like it — one run
  prunes and the next does not, and nothing anywhere reports the difference,
  so the failure is silent and the backlog just grows. The plugin normalizes
  the file on every edit of it and once when the session starts, so a hand
  edit is grouped and pruned whether the cartographer ran or not, and the file
  is rewritten only when its canonical form differs from what is on disk, so
  the write cannot loop. The boundary is strict: a task finished exactly seven
  days ago is still that week's news, and is kept.

### Fixed

- **A slot variant is no longer in the agent list the model is shown, so the model
  stops naming slots by hand.** opencode builds the system prompt's "Available
  agent types" block by filtering the agent registry on `mode !== "primary"` and on
  the caller's task permission. It never reads `hidden`: that flag is honoured only
  by the TUI, the @-mention pickers, the "agent not found" message and default-agent
  resolution. Every pooled variant was therefore listed to the model under its own
  name — "explore-1: Hidden pool variant explore-1" — and a model that can see
  twelve concrete slot names reaches for them, so the root agent kept spawning
  `explore-1` and `implement-4` instead of the bare base, and the pool refused
  every one. The refusal was right and the leak that provoked it was not: naming a
  variant is how a caller would pick the provider and skip the rotation and the
  slot's ceiling, so it cannot be allowed to succeed. The variants now carry
  `mode: "primary"`, the one field that filter respects, which takes them out of
  the agent list while leaving them spawnable by name — the task tool resolves an
  agent by name and never reads its mode — and out of the TUI, where `hidden`
  already kept them. The bare bases are untouched and stay in the list, so the
  model has nothing but the bases to choose from.

- **A refusal no longer names the variant it refused, and the instructions no
  longer list the names they forbid.** The refusal was the strongest remaining
  channel. It is the tool result the model reads at the exact moment it is
  choosing what to spawn next, and it used to repeat the name that had just been
  denied — so the denial was the thing that taught the name, and the model copied
  it back. It now names the base instead, which is what the model should type.
  The same reasoning applies to the rules themselves: "never name a `-N` variant
  (`explore-1`..`explore-4`, `implement-1`..)" put eight concrete agent names in
  front of the model in the sentence that told it what to spawn. A rule that
  lists the names it forbids teaches the names; the rule now states the rule
  without an example, in the shipped agent prompts, the project prompts and the
  global delegation rules.

- **The cartographer no longer leaves empty sessions in the session list.** The
  session was created before the run started, and only the turn's own success
  and failure paths retired it. Anything that threw in between — a slot that
  could not be picked, a claim that could not be written, a prompt that failed
  before it returned — stranded a session with no messages in it: an entry in
  the user's list that opens as nothing at all. Retirement now covers the whole
  gap between the create and the prompt, and the delete is *verified* rather
  than assumed — it is read back afterwards, retried once, and a failure is
  logged instead of swallowed. (Archiving is not a way out: opencode's list is
  served from the session rows themselves, so a session with `time_archived` set
  is still listed. Only a delete removes an entry.)
- **A finished cartographer run retires its session and keeps the transcript**
  was already true, and stays true: the transcript is written first and the
  session deleted second, because the transcript is the only record of what the
  run did. The plugin's own last 20 runs are kept in full.

### Changed

- **The bundled default pool no longer ships a model its provider has withdrawn.**
  `presets/free-tier.json` named `opencode/space-bunny-free` as its first slot at
  weight 3 — the slot that took the most turns. The opencode provider withdrew that
  model, and because it was the default, every new session then died at step 0 with
  `ProviderModelNotFoundError: Model not found: opencode/space-bunny-free`. Nothing
  in the package could tell: the pool warns about a slot that is missing from the
  config, not about a slot whose model the provider no longer serves, and the root
  agent's own model lives in the user's config rather than here.

- **`scripts/retire-cartographer-sessions.mjs` clears the sessions the feature
  did not reach.** Retirement landed after 250 runs had already piled up across
  the machine's projects, and those were never cleaned. The tool talks to the
  opencode server over its HTTP API — the same interface the plugin uses — and
  writes a compact record of each retired session to
  `~/.local/share/opencode/lacode/cartographer-archive/` before deleting it, so
  nothing is lost. `--dry-run` shows what it would do.

## [0.8.0] — cooldowns are probed instead of trusted, and the instructions agent can read the map

### Added

- **Benched models are now checked by using them.** A model that rate-limits or runs
  out of quota is benched until its window ends, and that window is computed
  backoff rather than a promise from the provider — a quota-shaped one reaches six
  hours, long enough for a provider that recovered, or whose quota was reset by hand
  in its own console, to stay excluded while every delegated spawn queues behind the
  survivors. `pool_recheck` asks instead of guessing: one real request on that exact
  model, with a one-word prompt and its own system string so the check costs
  handfuls of tokens rather than shipping a subagent's instructions. A model that
  answers is re-admitted at once — no restart, no reload, because `readLimits`
  rebuilds the cooldown state from disk on every routing decision — and one that is
  still limited keeps exactly the window it had. `src/lib/probe.ts` owns the probe;
  it runs every fifteen minutes while anything is cooling (`probeMs`, `0` disables)
  and on demand through the tool, one model at a time, silent when nothing changed
  and reported as a toast plus a log line when something did.

  Three rules keep a health check from becoming the thing it is checking for. A
  probe's own failure is never counted as a strike, or repeated checks would drive
  the window to the six-hour cap and no probe could ever pass; the only window it
  may change is one the provider itself stated, which is the provider correcting a
  guess. A probe's 429 never benches a whole provider — one request is evidence
  about one request. And a probe is a root session like any other, so it is marked
  in the shared pool state to keep the cartographer's idle trigger from starting a
  context run on its way past.

### Changed

- **A finished cartographer run leaves the session list.** opencode's list shows
  root sessions, and the cartographer was created with no `parentID` — so every
  automatic run landed in the user's main list and buried real work (112 of them
  on one machine). Nesting it under the triggering session is unsafe:
  `pool.bindChild` adopts a fresh child into any claim the parent holds without a
  target, which is exactly what a root has while its own explore tasks are in
  flight, and the reaper would abort the cartographer as though it were the hung
  task. Archiving is unavailable in 1.18.34 — no archive method, and `session.list`
  takes only `directory`. So the run now exports its transcript to
  `~/.local/share/opencode/lacode/cartographer/` (last 20 kept, override with
  `LACODE_TRANSCRIPT_DIR`) and deletes the session, on the failure path as well as
  the success path, since a retrying cartographer is what fills a list fastest.
  Its notifications were already suppressed.

- **A slot's concurrency ceiling is now twice its weight.** Weight still sets how
  many turns a slot takes per weighted round-robin rotation, but the ceiling is
  `2 × weight`, so one full rotation fills only half the pool and the run is walked
  twice before every slot is full. `pool_status` prints the ceiling as `load=n/2w`,
  and a weight-3 slot may now hold 6 concurrent sessions.

- **The `instructions` agent can read the context map.** Its `read` grant was
  scoped to `AGENTS.md` alone, so an `/agent-instructions` directive was applied
  without sight of what the project has already settled — the agent could restate
  a fact `conventions.md` records, or contradict one it had never read. The map is
  now readable through both path spellings (`.opencode/context/**` and
  `*/.opencode/context/**`), declared after the broad deny so the grant is not
  inert. The **write** grant is unchanged and still reaches `AGENTS.md` only: the
  map stays read-only to this agent, `context` remains its only writer, and the
  writer guard — which reads `edit` alone — needs no new exemption.

### Fixed

- **The pool no longer grows without bound.** The per-session `activity` and
  `children` maps were written on every message event and every `session.created`
  and never pruned, so a long-running server accumulated an entry per session for
  the life of the process. Both are now swept by the reaper and on every spawn, and
  the notifier's per-session bookkeeping (`active` / `titles`) is capped at 500.

- **The routing log no longer prints a slot variant's name.** It read
  `routed explore -> explore-2`, which is read by the very agent being routed and
  hands it a valid-looking agent name in the exact place it decides what to spawn.
  The refusals that followed were the model copying those names back —
  `implement-4` 23 times, `implement-2` 20, `explore-2` 12, roughly one per routed
  spawn. The line now names the slot and the model, which is the same diagnostic
  value with nothing for the model to echo. The refusal itself is unchanged.

- **The notification helper spawn is bounded.** Question, permission and error
  outcomes bypass the notification cooldown on purpose — a session blocked on a
  prompt the user was never told about is the silent stall this plugin exists to
  prevent — so a failure storm could start one detached helper per event, each
  `bin/oc-notify` → `bin/oc` → an ssh attempt, with nothing reaping them. The
  bound is on the transport, not on the decision: at most 4 helpers in flight,
  and one that has not answered in 30s is killed. Which notifications fire is
  unchanged.

- **A provider-stated reset can no longer bench a model for days.** A stated
  window ("Resets in 35min") is still trusted over the computed backoff, but the
  parse was unbounded, so one malformed upstream number removed a slot from
  rotation indefinitely: an `account_rate_limit` carrying `retry in 329917s`
  (~3.8 days) cooled a model for **91.6 hours**, long past the window it was
  waiting for, and every delegated spawn queued behind the survivors. A stated
  window is now discarded past `STATED_COOLDOWN_MAX_MS` (6h, the quota cap) so
  the caller falls back to the ordinary strike backoff instead of trusting a
  number it cannot believe. A limit already on disk is unaffected — delete its
  `limit.<model>.json` to re-admit the model now.

- **`"Resets in 2hr 17min"` is no longer read as 2h00.** The unit alternations
  were ordered `h|hr|hour`, so `2hr 17min` matched the bare `h`, left `r 17min`
  unparsed and silently dropped the minutes — a window too *short* by exactly the
  part it discarded, despite the docstring claiming that spelling was handled.
  Alternations are now longest-first (`hour|hr|h`, `minute|min|m`, `second|sec|s`).

- **The OmniRoute sticky-assignment table is bounded.** It is keyed by session and
  only a *failure* deleted an entry, so it grew with every session the process ever
  served rather than with the sessions in flight. It is now capped at 500,
  evicting oldest-first, and a `select()` that returns an existing assignment
  re-inserts it — previously a long-running session kept its original position and
  was evicted as "oldest" while still actively in use.

- **A pinned agent whose model is cooling now says so.** `basic` and `expert`
  hard-code a model and are not pooled, so a spawn of either falls through routing
  with nothing logged: when that provider was benched the escalation agent simply
  read as "cancelled". The pool now warns once, naming the model, the reason and
  the fact that only `explore`/`implement`/`context` can fail over.

- **The shared state directory now cleans itself without needing traffic.** Dead
  claims files and lapsed cooldowns were reclaimed only as a side effect of
  `snapshot()`, which runs when something spawns — so an idle machine, or one
  whose process was killed before its next spawn, carried a dead process's claims
  file and every lapsed cooldown indefinitely, and those files are read on every
  routing decision. `sweepStateDir` applies the same policy on an hourly clock,
  and once at startup so the previous run's debris goes immediately. It never
  touches this process's own claims file, `cursor.json`, a running cooldown, or a
  lapsed cooldown still inside its strike-decay window (deleting that would reset
  the strike count and restart the backoff at 1).

## [0.7.1] — /agent-instructions creates AGENTS.md on first use

### Changed

- **`/agent-instructions` creates `AGENTS.md` on first use.** The hidden
  `instructions` agent now creates the project's root `AGENTS.md` when it does
  not exist, seeded with the instruction you pass, instead of refusing. Nothing
  is created at startup and no placeholder content is written — the file appears
  only when you run the command, and holds only what you asked for.

## [0.7.0] — standing instructions move to the project AGENTS.md

### Changed

- **Standing instructions moved to the project root `AGENTS.md`.** The
  `/manager-directive` command and the hidden `manager` agent are gone,
  replaced by `/agent-instructions` and the hidden `instructions` agent. The
  `instructions` agent is the only writer of the project's root `AGENTS.md`;
  every other agent is permission-denied on that path. The plugin no longer
  injects a standing instruction — standing rules now live in `AGENTS.md`
  itself. `ensureManagerFile` is gone.

### Removed

- `/manager-directive` command
- `manager` agent
- `src/lib/manager-directive.ts`
- `applyInstructions` / `STANDING_INSTRUCTION` / `CURRENT_STATE_RULE` from
  `src/commands.ts`
- The `ensureManagerFile` call from `src/index.ts`

## [0.6.0] — a client-only /pool command, and README corrections

### Added

- **`/pool <instruction>`** — a client-only command that rewrites this machine's
  pool override, `~/.config/lacode/pool.txt`, from a short instruction. It
  applies the loader's rules (at most 4 distinct slots, weight in (0, 100], line
  order is the rotation), writes the WHOLE file rather than a patch, reports the
  before → after table, and reminds you that nothing hot-reloads.

### Fixed

- README: the count of agent keys deliberately *not* injected was stated as
  three, not the five `docs/CONFIGURATION.md` lists; and the `lacode` CLI section
  was missing `version`, `update`, `receive` and `tunnel setup`.
  `docs/INSTALL.md`'s CLI list gained `version` and `update`. A stale test title
  ("three commands") was corrected to match what it asserts.

## [0.5.0] — a user-only /manager-directive, instant limit failover, and the longcat preset

Released on the npm **`beta`** dist-tag (not `latest`) while the project is
experimental; `latest` remains 0.4.2.

### Added

- **`/manager-directive <text>`** — a client-only command that runs a hidden
  `manager` agent to apply your instruction to `.opencode/context/manager.md`
  (record it, move it between sections, rewrite `## Current`, …). The `manager`
  agent is the only agent permitted to edit that file, its grant is scoped to
  `manager.md` alone, and no other agent can spawn it — the command is the only
  route in. The one-writer guard (`writer-rule.ts` Direction 3) now exempts
  exactly that agent name and still reports every other writer.

### Changed

- **Bundled pool preset** — `opencode-go/step-5-preview-free` and
  `opencode/step-5-preview-free` were retired upstream. Slots 2 and 4 now name
  `longcat-2.5-preview-free` on the same providers (`opencode-go`, `opencode`).
  Update `~/.config/lacode/pool.txt` if you pinned the old ids there.

### Fixed

- **Immediate failover on a usage limit** — when a limit-shaped assistant error or
  a limit-shaped `session.status` retry names the session an in-flight claim is
  running on, the pool aborts that session at once instead of leaving it for the
  ~5-minute hang reaper. The claim is released and the next spawn routes to a slot
  that answers; a limit on an unrelated session never kills a claim.

## [0.4.2] — fix silent claim eviction, unkillable chatty tasks, and gateway 5xx misclassification

### Fixed

- **Heartbeat-aware claim publishing**: `publish()` now filters claims by `(claim.hb ?? claim.t)` instead of `claim.t`, matching how `pruneOwn` and `readSiblings` already judge liveness. A claim past `CLAIM_TTL_MS` with a fresh heartbeat was being written out of its own file, causing every other process to hand the slot out again while the task still held it.
- **Claim ceiling (`MAX_CLAIM_AGE_MS`)**: a claim older than 30 minutes is now condemned regardless of activity. Previously, any message event reset the silence clock, so a task that hung while trickling output could reset it forever and never be killed. The ceiling is checked first; a claim that is both past it and silent is reported as `overran`, not `hung`.
- **Single condemn rule**: `condemnReason()` is now the one place the condemn logic lives. Both `findStuck()` (the reaper) and `pool_status` use it, so a claim the status reports as healthy cannot be one the reaper is about to kill.
- **Gateway 5xx and transient errors take the flat cooldown**: a 502, 503, 504, queue-budget exhaustion, or `TimeoutError` now cools the model flat (~60s, `strikes: 1`, reason `endpoint-unavailable`) instead of falling through unhandled. A real 429 or limit-shaped error still escalates through `recordStrike` unchanged.
- **Reaper log distinguishes `overran` from `hung`**: a ceiling kill logs `overran <variant> on <model> after <age>s; aborted session <id>` with no silence claim; a silence kill keeps the existing `hung` wording.
- **`pool_status` reports `overran` count**: a new line shows how many claims are past the ceiling and would be condemned, matching the reaper's own judgment.

### Documented

- `docs/OMNIROUTE.md`: corrected the `ProviderModelNotFoundError` troubleshooting row — `combo` is registered whether or not the gateway advertises it, so a valid gateway route works there without an allowlist entry.

## [0.4.1] — refuse hand-named slot variants, and ship a changelog

### Added

- `CHANGELOG.md`, reconstructing all 13 published releases from their commits. It
  ships with the package, so an install can read what changed without the repo.

### Changed

- A pool slot variant named by hand (`explore-1`, `implement-2`, …) is now
  **refused** rather than counted. Naming one skipped both the round-robin
  rotation and the slot's ceiling, so six spawns of `explore-1` put six
  concurrent claims on a slot bounded at three. The refusal names the bare base
  to spawn instead, is logged, and escapes the routing catch — swallowed into
  "spawn unchanged" it would have admitted the spawn it forbids.
- Agent prompts dropped the long explanation of why a variant must not be named.
  It is enforced now, and the refusal carries the reason; the prompts keep only
  the bare-base rule and what to do on refusal. 1,012 characters removed across
  the `build`, `plan` and `explore` prompts.

### Documented

- `isAvailable` and `pickSlot` now say, in place, that the pool is deliberately
  fail-open in two places: a model absent from the catalog is not treated as
  unavailable, and when every slot is cooling they are re-admitted rather than
  the work refused. Both were previously only discoverable by reading the code.

## [0.4.0] — order-first weighted round-robin, and a reaper that can kill

### Changed

- **Slot selection is now order-first weighted round-robin.** Weight was both
  the priority and the ceiling, so the heaviest slot was re-prioritised on every
  spawn and refilled the moment a claim completed, while the others sat idle.
  Selection walks the slot list in order, each slot taking as many turns as its
  weight says, from a cursor persisted in the pool directory so the rotation is
  shared by every opencode process rather than restarting in each one. Weights
  `[3,2,1,1]` now produce the run `1,1,1,2,2,3,4`.
- The concurrency ceiling is unchanged: a slot still holds at most `weight`
  concurrent claims, and overflow still goes to the least-loaded slot.
- `pool_status` previews the next slot without advancing the rotation, so
  looking at the pool no longer shifts every spawn after it.

### Fixed

- **A hung subagent could not be killed.** The reaper detected the wedge, freed
  the claim, and then failed to abort the session — because the claim was
  released *before* the abort, so a failed kill orphaned the session with
  nothing left to retry it. Kills are verified against the response, retried
  three times, and only a confirmed kill releases the claim; a give-up names
  the session to kill by hand.
- A kill reported success for any HTTP response, including the gateway's
  `200` with body `true` for a session that does not exist.
- A claim that never bound to a child session was logged as `Infinitys of
  silence` and cooled the provider, though an unbound claim is no evidence that
  anything hung. It is now released without cooling, and a child created before
  its claim is bound at reap time instead of being lost.
- **A live task lost its slot past the TTL.** Claims now carry a heartbeat
  refreshed by message activity, and abandonment is measured from it. A task
  that ran past the 10-minute TTL previously stopped being counted while it
  kept working, so the slot was handed out again — a ceiling-3 slot ran five.

## [0.3.0] — a sound per notification outcome (US-29)

### Changed

- Notification outcomes are per-notification and sound, rather than one silent
  aggregate.

## [0.2.2] — stop capping gateway traffic at 5s

### Fixed

- `timeoutMs` no longer caps real provider traffic at 5s. It was documented as
  a probe budget only, but it was being applied to live completions too.

## [0.2.1] — OmniRoute registers the provider only

### Changed

- The OmniRoute integration registers the provider and nothing else; it writes
  no pool file and no variants.

## [0.2.0] — OmniRoute as the pool's primary slot

### Added

- OmniRoute, a local OpenAI-compatible gateway, as the pool's primary slot, with
  combo routing, sticky sessions and cooldown on usage limits.

## [0.1.10] — observable self-update outcome

### Changed

- The self-update reports its outcome instead of failing silently.

## [0.1.9] — reclaim update locks orphaned by a dead process

### Fixed

- An update lock left behind by a dead process is reclaimed rather than blocking
  every later update.

## [0.1.7] — self-update, hermetic tests

### Added

- Self-update on restart, and a hermetic test suite that does not read the
  developer's own `~/.config`.

## [0.1.6] — small implement asks, Step 5 Preview pool

### Changed

- Implementation asks are split into smaller units.
- `opencode-go/step-5-preview-free` added to the bundled pool preset.

## [0.1.5] — build/plan may spawn basic and expert

### Changed

- `build` and `plan` may spawn `basic` and `expert`, which are not pooled.

## [0.1.4] — flat pool.txt

### Changed

- The pool's user config is a flat `~/.config/lacode/pool.txt`, one model per
  line with an optional weight.

## [0.1.3] — ship the updated notification/remote docs

### Changed

- Notification and remote-control documentation brought up to date.

## [0.1.1]

### Added

- First published release: pooled subagents over a shared set of models.

[Unreleased]: https://github.com/lawaty/lacode/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/lawaty/lacode/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/lawaty/lacode/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/lawaty/lacode/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/lawaty/lacode/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/lawaty/lacode/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/lawaty/lacode/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/lawaty/lacode/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/lawaty/lacode/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/lawaty/lacode/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lawaty/lacode/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/lawaty/lacode/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/lawaty/lacode/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lawaty/lacode/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/lawaty/lacode/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/lawaty/lacode/compare/v0.1.7...v0.1.9
[0.1.7]: https://github.com/lawaty/lacode/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/lawaty/lacode/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/lawaty/lacode/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lawaty/lacode/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lawaty/lacode/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/lawaty/lacode/releases/tag/v0.1.1