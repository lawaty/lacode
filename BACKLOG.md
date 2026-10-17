# Backlog

Deferred work, with the reason it is deferred. Shipped behaviour belongs in
[CHANGELOG.md](CHANGELOG.md); promises belong in
[docs/USER-STORIES.md](docs/USER-STORIES.md). This file is for things that are
real, wanted, and not yet safe to ship.

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