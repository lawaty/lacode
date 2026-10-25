# Contexts

- [binding] Journal: append-only log; start at `src/journal.ts`; never collapse it into the projector. — See `docs/ARCHITECTURE.md` §Journal (verified 2026-10-26)
- [binding] Projector: replay and projection; start at `src/projector.ts`; it must not write the journal. — See `docs/ARCHITECTURE.md` §Projector (verified 2026-10-26)
- [binding] API: admission; start at `src/api.ts`; it must not apply projections. — See `docs/ARCHITECTURE.md` §Subsystems (verified 2026-10-26)
- [binding] Retention: compaction; start at `src/retention.ts`; it must not touch the live tail. — See `docs/OPERATIONS.md` §Compaction (verified 2026-10-26)
- [binding] Query: read models; start at `src/query.ts`; it must not be a write path. — See `docs/ARCHITECTURE.md` §Subsystems (verified 2026-10-26)
- [binding] Checkpoint: replay position; start at `src/checkpoint.ts`; it must not advance before compaction commits. — See `src/checkpoint.ts` (verified 2026-10-26)
- [provisional] A dedicated command service may replace the API module. — See `docs/ARCHITECTURE.md` §Subsystems (verified 2026-10-26)
