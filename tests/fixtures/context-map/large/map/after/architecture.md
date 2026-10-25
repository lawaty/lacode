# Architecture

- [binding] The journal/projector split exists because replay must never block admission. — See `docs/ARCHITECTURE.md` §The two halves (verified 2026-10-26)
- [binding] Only the journal is writable, and it is append-only. — See `docs/ARCHITECTURE.md` §Journal (verified 2026-10-26)
- [binding] The projector is derived state and is rebuilt by replay. — See `docs/ARCHITECTURE.md` §Projector (verified 2026-10-26)
- [binding] The API is the admission boundary and owns command parsing. — See `src/api.ts` (verified 2026-10-26)
- [binding] Retention owns compaction of the journal prefix. — See `src/retention.ts` (verified 2026-10-26)
- [binding] The query service reads projections only. — See `src/query.ts` (verified 2026-10-26)
- [binding] The checkpoint is the replay start and is updated only after compaction commits. — See `src/checkpoint.ts` (verified 2026-10-26)
- [binding] Compaction keeps the last 30 days of journal entries. — See `docs/ARCHITECTURE.md` §Retention (verified 2026-10-26)
- [provisional] The query service may be extracted from the projector process. — See `docs/ARCHITECTURE.md` §Subsystems (verified 2026-10-26)
- [provisional] Command batching may become the default admission path. — See `src/api.ts` (verified 2026-10-26)
