# Backlog

Deferred work, with the reason it is deferred. Shipped behaviour belongs in
[CHANGELOG.md](CHANGELOG.md); promises belong in
[docs/USER-STORIES.md](docs/USER-STORIES.md). This file is for things that are
real, wanted, and not yet safe to ship.

## Background sessions dirty the session list

**Wanted.** Automated subagents — chiefly the cartographer that
`context-autoupdate` spawns — should not appear in the user's main session list.
They accumulate (112 cartographer sessions on one machine) and bury real work.

Notifications are already handled: `src/lib/notify.ts` lists `context (auto` in
`INTERNAL_TITLE_PREFIXES` and `shouldNotify` returns `internal session`. Only the
list is still a problem.

**Why it is not simply fixed.** opencode's session list filters to root sessions:
735 roots against 2,584 children on one machine, and a user sees roughly ten
cartographer sessions rather than the 1,022 subagent ones. The cartographer
appears precisely *because* `context-autoupdate` creates it with no `parentID`
(`src/plugins/context-autoupdate.ts:247`) — it cannot nest, so it reads as a
root.

The obvious fix — pass the triggering session as `parentID` — is unsafe today.
`pool.bindChild` binds a freshly created child to any claim whose
`s === parentID && !c.g` (src/lib/pool.ts). A root holds exactly such claims
while its own `explore` tasks are in flight, since `acquire` records the owner
session and leaves `g` unset until a child binds. A cartographer nested under a
busy root would therefore be adopted by an unrelated in-flight claim, and the
reaper would abort it as though it were the hung task. That is a worse failure
than a dirty list.

**Options, in the order they should be tried.**

1. Teach `bindChild` to skip an internal child. Needs a signal it can trust —
   the creating event's title prefix is one, and is exactly the coupling
   `INTERNAL_TITLE_PREFIXES` already represents.
2. Archive rather than nest. `session.time_archived` exists in the schema, but
   1.18.34's SDK exposes no archive method and `session.list` takes only
   `directory`, so there is nothing to call. Re-check on upgrade.
3. Delete the cartographer session once it completes, after exporting it. Fully
   hides it and keeps it inspectable, but adds an export to preserve a record
   nobody asked to keep forever.

Whichever is chosen needs a test that a cartographer never appears in the list,
and one that a root with an in-flight claim does not adopt it.

## No helper-spawn bound on the notification path

`src/plugins/notify.ts` spawns one detached, unref'd helper per notification
(`bin/oc-notify` → `bin/oc` → an ssh attempt). Blocking outcomes — question,
permission, error — deliberately bypass the cooldown, which three `[US-11]` and
`[US-25]` tests pin, so a failure storm can spawn a subprocess per event with
nothing reaping them.

The notification semantics must not change: a blocked session must never be
silenced. The fix belongs in the spawn itself — a cap on helpers in flight and
a timeout on the helper — not in which notifications are decided.

Not the cause of the MLBB memory crash: the captured processes were Node's test
runner, not this path. It is still an unbounded spawn.

## Session memory has no user story

`docs/USER-STORIES.md` has no requirement covering a long-running session
staying bounded in memory. The pruning work (pool `activity`/`children`, the
notifier's per-session bookkeeping, OmniRoute's sticky table) exists because of
incidents, not because anything asked for it — which is why the cartographer's
session-size behaviour and opencode's append-only event log were invisible until
they caused a 4 GB database.

Two facts worth keeping: a tool output is persisted permanently as a
`message.part.updated` event, so reading a large file is a storage decision and
not only a context-window one; and opencode's `event` table is append-only with
no retention policy, so it only shrinks if something prunes it.