# Changelog

All notable changes to LaCode are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions come from git release commits; the npm version is bumped in the same
commit as the changelog entry it describes.

## [1.1.0] — a map contract, feedback, and host credential sync

### Added

- **A one-time feedback hint, the `lacode feedback` command, and GitHub issue
  templates.** The hint is local only: no telemetry, no analytics, and it sends
  nothing anywhere. It shows at most once, only when a TUI sink exists, and a
  toast that fails does not consume it. Opt out with `feedbackHint: false` or
  `LACODE_NO_FEEDBACK_HINT=1`; the flag is
  `~/.local/share/opencode/lacode/feedback.json`.
- **The post-publish host sync now syncs provider credentials.** After
  `npm publish`, `scripts/sync-hosts.mjs` copies the allowlisted providers from
  the local opencode auth store (`OC_AUTH_PROVIDERS`, default
  `opencode-go opencode`) to each host, keeps host-only providers, and writes
  the remote `auth.json` atomically with a timestamped backup.

### Changed

- **The context map has one entry schema, a per-file budget and a per-file
  lifecycle.** Every navigation entry is a provenance marker (`[binding]`,
  `[provisional]` or `[disputed]`), a rule of at most three non-blank lines, and
  a `— See <path>[ §Section] (verified YYYY-MM-DD)` pointer. No Context /
  Decision / Consequences / Alternatives blocks. Every file has a hard cap in
  non-blank lines (architecture 150, contexts 200, conventions 150, workflows
  150, decisions 120, active 60). The 30-day provisional window generalises the
  active backlog's 7-day finished-task window; binding and disputed entries are
  exempt, and an entry whose source is gone is never auto-dropped.
- **The prompt now lives in `src/lib/cartographer-prompt.ts`,** with the tracked
  copy at `.opencode/prompts/context.txt`; a test pins equality so a reviewer
  reads the text the model actually runs.

### Fixed

- **`LACODE_SYNC_DRY_RUN=1` no longer contacts a host.** It used to print the
  plan and then SSH to every host to exercise the credential helper when a local
  auth store existed, which sent provider credentials during a “dry run”. It now
  reads only the local plan and prints the auth summary; no SSH and no `npm view`.
- **The post-publish host sync accepts a real `opencode.jsonc`.** Comments and
  trailing commas no longer make a host fail as “config not normalized
  (unparseable)”.
- **A constraints file is no longer a deliberation ledger.** `decisions.md` is
  capped, decision-record blocks are a schema violation, and the prompt tells
  the cartographer to state the constraint and point at the page that owns it.
- **Restatement and drift are now reported instead of silently trusted.** After
  every run the map is audited for dangling paths/sections, a numeric claim
  absent from its cited source, a possible negation conflict, a source modified
  after `verified`, tables/fenced blocks/verbatim spans, duplicate rules,
  archive-of-record language and charter degeneration. The audit is
  **report-only**: it never rewrites a claim and never deletes content with no
  source, because the map may be the only copy and the page may be the stale
  side. A failure is a loud `context map validation failed` error.
- **The lifecycle no longer belongs to one file.** `active.md` still uses its
  seven-day finished-task window; every other file now expires provisional
  entries after 30 days, and only when the cited source still resolves.

## [1.0.3] — one notification even when the plugin is loaded twice

### Fixed

- **A question or permission popup is raised once when two LaCode instances share
  a process.** opencode auto-discovers every file under
  `~/.config/opencode/plugins/`, so a host that also lists `@lawaty/lacode` in
  `opencode.jsonc` loaded two copies. `done` was already deduplicated by the
  completion marker, but the notification claim treated any claim holding our
  own pid as ours — indistinguishable between two instances in one process. The
  claim now carries a per-instance token, so the second instance loses while the
  same instance may still raise a new prompt.

### Changed

- **Publishing syncs the published version to every host.** `postpublish` runs
  `scripts/sync-hosts.mjs`: it installs `@lawaty/lacode@<version>`, normalises
  each host's config to a single LaCode entry (preserving its options), disables
  stale auto-discovered shims, and warns when a host cannot run the helper.

## [1.0.2] — the permission chime plays when the popup appears

### Fixed

- **An actionable notification no longer delays its sound until it is answered.**
  `sendLocal()` played the chime after `notify-send` returned, but an actionable
  send (`--action` implies `--wait`) blocks until the user clicks a button or
  dismisses the popup. The chime therefore played at click time — and never at
  all when the popup was left alone — which made permission sounds look
  intermittent. The sound now starts before the notifier runs, and a test pins
  the order with a blocking fake notifier.

## [1.0.1] — notification sounds you can hear, and a title that names the workspace

### Fixed

- **Notification sounds play again.** The plugin preferred the bash `oc-notify`
  helper, which discards the sound field, so a chime was never played on that
  path; it now prefers the lacode CLI, whose `sendLocal` plays
  `sounds/<outcome>.wav`. The bash helper stays as a last-resort fallback.
- **The four chimes survive a suspended sink.** Each WAV was 0.20–0.32 s at 42%
  full-scale, which a suspended Bluetooth output swallowed whole while the link
  woke. They are now 1.0–1.46 s at 90% peak, and a test pins both the duration
  and the peak so the regression cannot return.
- **A popup no longer fades on its own.** `interacted` is scoped to the popup it
  was set on: a new popup starts un-interacted and auto-dismisses only when the
  user interacts in that session while it is live. Previously every popup in a
  session the user had ever typed in closed after five seconds.
- **The published `bin` entry uses the `./dist/…` form** the packaging check
  requires, so the release tarball passes its own adoption test.

### Changed

- **Notification titles name the workspace as well as the session.** The title
  is now `{workspace} - {session}`, where the workspace is the basename of the
  session's directory, falling back to the plugin directory. The popup header
  stays `LaCode`. Internal cartographer sessions are still suppressed, because
  the check runs on the session title before the prefix is added.

## [1.0.0] — images, ordered slot fill, and a limit that fails over

### Added

- **Image attachments from the clipboard or from files.** `/image-in-cb` reads
  the system clipboard through `wl-paste`/`xclip` on Linux, `pngpaste` on macOS,
  or PowerShell on Windows, and `/image` attaches one or more image files. Paths
  honour quotes, `~` and globs; identical bytes are deduped within a message;
  each file is capped at 4 MiB, at 10 images, and at 20 MiB total. Images are
  archived content-addressed under `~/.local/share/opencode/lacode/images` and
  delivered to the model as `FilePart`s. Configure with `imagePaste`
  (`enabled`, `maxBytes`, `maxImages`, `dir`) or `LACODE_IMAGE_DIR`.
- **A system-prompt guard against slot-variant names.** Every system string is
  scrubbed by `scrubSlotNames()` before the model sees it, so a stale prompt
  cannot teach the model `explore-1` and friends. The transform logs once when
  it has to strip a literal.

### Changed

- **Slot routing fills slots in declaration order in up to two passes.** A
  slot's `weight` is its active-session budget for one pass. Pass 1 fills each
  usable slot to its weight in declaration order; once every usable slot has
  reached its weight, pass 2 fills each to twice its weight. Live claims decide
  the next slot, a released claim immediately reopens its slot, and overflow
  goes to the least-loaded usable slot. There is no stored position.
- **A hand-named slot variant is coerced to its base, not refused.** The task
  hook rewrites `explore-1` to `explore` before routing, so a caller cannot pin
  a provider or skip ordered fill. Injected agent prompts no longer name
  variants, and `expert` is explicitly opt-in.
- **Rate-limit failover uses the authenticated plugin client.** Aborting a
  limited child goes through `client.session.abort`, not a bare `fetch`, so an
  `opencode serve` protected by `OPENCODE_SERVER_USERNAME/PASSWORD` no longer
  answers 401 and leaves the child running. A failed abort holds the claim for
  the reaper to retry instead of releasing the slot while the session lives.
- **A limit on a pooled child with no local claim is identified and handled.**
  The failover path reads the session's `parentID` and user message to recognise
  a pooled variant (`implement-1`, `explore-2`, `context-N`), cools that slot,
  and aborts the child. Root, non-pooled, and unidentifiable sessions are left
  alone.

### Fixed

- **A limited or hung session no longer survives its slot.** The rate-limit path
  aborts it immediately, including the transient-outage path in
  `message.updated`, and a failed abort no longer frees the slot.
- **`pool_status` says a cooling slot is unavailable.** A cooling slot is marked
  `UNAVAILABLE (COOLING …)`, and the summary reads `unavailable/cooling: …`.
- **A `done` popup is raised once per idle period, and an `error` suppresses the
  `done` that follows it in the same turn.** The per-session completion marker
  is cleared when the session goes busy again or is deleted.

### Documented

- README documents `/image`, `/image-in-cb`, `imagePaste`, the `latest` dist-tag
  for 1.0.0, and the ordered two-pass fill. `OPERATIONS.md`, `presets/README.md`
  and the preset comments describe the same routing rule.

## [0.11.0] — the old sessions and the old event rows are swept away on their own, and a pool edit takes effect without a restart

### Added

- **A pool edit is picked up live, and a model the provider has withdrawn no
  longer takes its slot down with it.** The slot table used to be read once per
  process, so editing `pool.txt`, `pool.json` or the bundled preset did nothing
  until a restart — and a slot whose model id had been retired failed every
  spawn routed to it. The plugin now watches the three file sources (`watchMs`,
  default 1s; `watchDebounceMs`, default 250ms; both configurable, `watchMs: 0`
  disables). When the resolved table actually changes it reassigns `s.slots`,
  re-binds the variant agents and provider whitelists from the same config
  object, and validates every slot with one real request — cooling or not. A
  provider answering "Model not found" is now a first-class outcome:
  `pool_recheck` benches that model for the quota cap (`model-missing`) so
  routing stops choosing it, and names it in the report. Given `models`,
  `pool_recheck` validates those even when they are not cooling; omitting
  `models` keeps the old, cheap "probe what is cooling" contract. The watcher is
  closed in `dispose`, so a torn-down plugin stops polling.

### Fixed

- **The bundled preset and the built-in fallback no longer name a withdrawn
  model.** `opencode-go/minimax-m3.1-flash-free` is `deprecated` on models.dev
  and is hidden from `opencode models`; it is replaced by
  `opencode-go/beam-free`, which is active, free and in a different model family.
  `tests/models-snapshot.json` was refreshed for the new slot.

- **A build no longer unloads the pool from a process that starts during it.**
  `npm run build` deleted `dist/` before rebuilding, so an opencode process that
  imported `file://…/dist/index.js` in that window failed to load LaCode at all
  and ran every `task` spawn on the caller's own model — `explore` appeared to
  ignore the pool. Each entry is now staged and renamed into place, and stale
  files are removed only after the live ones are in place.

- **A task spawn with no `subagent_type` is reported instead of silently
  bypassing the pool.** opencode runs the default subagent, which carries no
  pool model, so it inherits the caller's model; the hook cannot route it after
  the fact, but it now logs a warning naming the fix (`subagent_type: "explore"`
  or `"implement"`). An `@explore` mention or a direct session prompt has the
  same limitation: the plugin API exposes the model read-only, so it cannot be
  re-routed there either.

- **A provider limit the pool did not recognise left the task hanging until the
  watchdog found it.** opencode reports a limit in two shapes: an `action` block
  naming the provider and a reason, or — for every provider whose error body
  opencode does not know — a retry status carrying nothing but the provider's
  own words. The pool only read the first shape, and only when the reason
  happened to be one of its own, so a limit that said "limit reached" was not a
  limit to it: nothing was cooled, the session kept retrying the refused model,
  and the task waited out the watchdog's minutes before anything killed it.
  Worse, the retry went back to the same slot, because nothing had been put on
  cooldown for the pool to route around.

  The limit vocabulary now reads the provider's own phrasing — "limit reached",
  "daily limit reached", "usage limit exceeded" — and a retry status is read for
  its message as well as for its reason. The context family is deliberately
  excluded: "context limit reached" is a prompt that is too long, not a
  provider that has run out of allowance, and benching a model for it would take
  a healthy provider out of rotation over the user's own prompt.

  A limit that names its provider still benches the whole provider. A limit that
  does not name a provider cools only the model the session was running on — the
  one the refusal is evidence about — and either way the stalled session is
  aborted at once, so the caller retries onto a slot that answers instead of
  waiting for the watchdog.

- **A transient outage no longer benches a model as if it had run out of
  allowance.** "Endpoint is unavailable" is a provider that is briefly down, not
  one that has spent its quota: it lifts on its own. Reported in a retry
  status, it took the quota path — fifteen minutes off the rotation, filed
  under "rate-limited" — and it counted as a strike, so the next real limit on
  that model started at strike two and got a thirty-minute window. An outage now
  takes the flat one-minute window the assistant-error path has always given
  it, and it is never counted as a strike: the model is benched, the session is
  still killed, and the quota window that follows starts where it should.

- **Two processes could raise the same notification.** A notification is claimed
  with an exclusive create, so only the process that wins the claim raises it,
  and a claim older than its window may be taken over so a holder that died
  mid-popup cannot silence every later one. The takeover deleted the stale claim
  and then created its own — but the delete was unconditional and never
  re-checked that the file it removed was still the stale claim it had judged a
  moment earlier. Two processes that both saw the same stale claim both reached
  the takeover: the first replaced it with a fresh claim, the second deleted
  that fresh claim and made its own, and both returned "won", so both notified.
  The takeover is now a compare-and-swap: an exclusive takeover lock, an
  immediate refusal for whoever did not get it, and a re-read of the claim
  inside the lock, so the loser leaves a live holder's fresh claim untouched.
  The staleness rule itself is unchanged — a fresh claim is never stolen and a
  stale one is still reclaimed.

- **A `busy` session counted as you answering a prompt.** The five-second floor
  before a notification is raised exists so it does not land while you are
  already at the keyboard, and it is meant to be reset by real interaction.
  `session.status: busy` was counted as that interaction — but `busy` is raised
  whenever the session starts working, including when opencode resumes on its
  own, so the floor was refreshed without you touching anything and the popup
  you were owed could be suppressed. The signal is now a `message.updated` with
  the user's own role on it, plus the reply events for permissions and
  questions; `busy` no longer counts.

- **A tunnel unit could be installed with a preflight it cannot run.** The unit
  writer put `ExecStartPre=<preflight>` in unconditionally, so on a host where
  the preflight was never installed systemd failed the unit and the tunnel never
  came up — and the up-to-date check kept the broken unit because it demanded
  the line. The line is now written only when the preflight is installed, which
  degrades to "no preflight" rather than "no tunnel", and an already-broken unit
  is repaired on the next run. The up-to-date check no longer requires the line.

- **A strike for an unavailable provider is filed where it belongs.** An outage
  reported through the strike path could still be counted as a quota strike and
  handed the long window, because only one of the two call sites delegated to
  the outage handler. Both now do, and a strike never counts an outage. A limit
  that names a provider is also no longer overridden by the model the session
  happened to be running on.

- **Two acceptance criteria were corrected to match the shipped behaviour.**
  US-6 criterion 4 stated the "a full slot is not the next one" rule without its
  exception, so it contradicted the overflow path; it now says a full slot is
  next only when no other slot is available and under its ceiling. US-19
  criterion 3 stated a standing rule as if the product injected it, when it now
  lives in the repo-level `AGENTS.md`.

### Added

- **The limit vocabulary is read from one place.** `pool.limitReason()` names
  the limit a text reports, and the pool, the prober and the fail-over path all
  take the reason from it, so a log line and a cooldown file never spell the
  same fault two ways.

- **US-31 — a limit that hangs is killed, and the retry lands on a slot that
  answers.** The contract is written down as a user story with acceptance
  criteria in `docs/USER-STORIES.md`, and every criterion has a test in
  `tests/stories/`.

- **Two retention sweeps take the old rows away before they become the whole
  database.** `scripts/retire-old-sessions.mjs` archives then removes sessions
  past a window (30 days, 24 hours of grace) and
  `scripts/prune-old-events.mjs` deletes old transcript rows from `event`
  (7 days, 1 hour of grace), in chunks, ordering by id — the id carries the
  timestamp, so the primary-key index turns "older than" into a range scan
  instead of a full table walk. Both refuse to touch a row that something still
  depends on: a session an `event_sequence` cursor owns, a session bound to a
  workspace, and anything inside the grace window. Neither ever removes or
  resets a cursor. A session is written to a JSON archive before it is deleted,
  and the archive is the recovery path if the window was wrong.

  Both run by hand with `--dry-run`, support `--limit`, and the event prune also
  takes `--vacuum`; a window larger than the id's own era is clamped, so a
  mistyped number cannot be read as "delete everything". Each ships a systemd
  service and timer (daily; `Persistent=true`, with a randomized delay on the
  event prune so it does not run inside the session sweep's write window) and
  appends one JSONL line per real run to a log under the state directory.

- **US-32 and US-33 document the sweeps, and the coverage guard reads the root
  suites.** Both have acceptance criteria in `docs/USER-STORIES.md` and story
  markers on their tests. The guard now scans the root-level `tests/*-test.mjs`
  suites as well as `tests/stories/`, so a story whose tests legitimately live
  outside the story directory is counted instead of reported uncovered.

- **Every acceptance criterion that could not be falsified now has a test that
  fails when the behaviour regresses.** The audit found criteria whose tests
  would have passed for the opposite behaviour: the least-loaded slot under a
  full cooldown, a ceiling turn being skipped rather than consumed, a full slot
  left unmarked, a macOS prompt carrying no buttons, a question carrying none,
  a missing sound player costing only the sound, the bus path coming from the
  local user rather than the remote, the sound playing where the notice is
  rendered and never on the headless host, the self-update CLI, its argv and its
  state file, cost control with no price information, the cartographer carrying
  no model of its own, the map being reported rather than edited, an OmniRoute
  gateway leaving a user's pool alone, and the notification doc leading with the
  shipped path. Each new test was shown to fail by breaking the behaviour it
  covers.

## [0.10.0] — a notification waits for you instead of timing out, and a permission can be answered from the popup

### Added

- **A permission prompt can be answered from the notification itself.** The
  plugin reads the permission request id off opencode's `permission.asked`
  event and puts it in the helper's environment (`LACODE_REQUEST_ID`), so the
  notification carries three buttons: **Allow once**, **Always allow** and
  **Deny**. Their names are opencode's own reply values — `once`, `always` and
  `reject` ("reject" is the server's word for deny) — so a click is already a
  valid answer and nothing has to be translated on the way.

  The answer travels back over the same path the notification came. The desktop
  end is an ssh forced command, so its stdout comes back down the ssh
  connection and the plugin reads the chosen button's name off the helper's
  stdout — no new key, no listener, no HTTP server. The hop was one-way until
  now, and what made it two-way was a channel that was already there: the
  forced command's stdout is carried to whoever opened the connection, so the
  answer rides home on the connection that is already open. The plugin then
  answers the permission through opencode's own API, and a permission that was
  already answered in the terminal is recognised rather than reported as a
  failure.

  The wire payload is six newline-delimited fields on both wires —
  `title\nmessage\nurgency\nicon\nsound\nrequestID`, the request id last — and a
  payload with fewer than six fields carries no request id, so an older sender
  still works.

  Two limits, stated plainly. The scope is **permissions only**: a question is
  not answerable this way, because opencode's v1 SDK client — the one this
  plugin has — has no question API at all, and the v2 routes need a bound TCP
  socket that the default opencode TUI does not have. And the buttons are
  **Linux only**: `osascript` and `terminal-notifier` have no action support,
  so a macOS desktop still gets a plain notice, and the answer there still has
  to be given in the terminal.

### Changed

- **A desktop notification now waits for you instead of timing out on its own.**
  `notify-send` is called with `--expire-time=0` — the freedesktop "never
  expire" timeout — at all three call sites: `sendLocal` in
  `src/tunnel/index.ts`, the tunnel's forced command
  (`bin/oc-notify-receiver`), and `send_notify` in `bin/oc`. Without it the
  desktop daemon's own timer dismissed the popup by itself: measured on KDE
  Plasma 6.7.4, a normal-urgency notification is closed with reason 1
  ("expired") after about five seconds, so a notice the user had not acted on
  within that window was simply gone — the difference between a notice you can
  still act on and one you missed. A notification now stays on the desktop
  until you close it.

  Nothing else about it changed: the `--urgency` values are untouched (a
  question or a permission prompt is deliberately not `critical`, so it does
  not escalate to a modal on most desktops), and the whitelists and the
  cooldown behaviour are exactly as they were.

### Documented

- **The npm publish notice does not say which dist-tag a release lands on.** npm
  12 prints "Publishing to https://registry.npmjs.org/ with tag latest" for every
  publish, including one whose `publishConfig.tag` sends it to `beta`: the
  message reports the CLI's default, not the resolved tag. 0.9.0 was published
  that way and landed on `beta`, with `latest` still at 0.4.2. The registry is
  the authority, not the notice — after publishing, read
  `npm view @lawaty/lacode dist-tags` before assuming anything about where the
  release went.

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

[Unreleased]: https://github.com/lawaty/lacode/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/lawaty/lacode/compare/v0.11.0...v1.0.0
[0.11.0]: https://github.com/lawaty/lacode/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/lawaty/lacode/compare/v0.9.0...v0.10.0
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