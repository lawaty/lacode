# Conventions

- [binding] Never project a journal entry before it is durable. — See `docs/ARCHITECTURE.md` §Journal (verified 2026-10-26)
- [binding] Never write the journal from the projector. — See `docs/ARCHITECTURE.md` §Projector (verified 2026-10-26)
- [binding] Every command enters through the API boundary. — See `src/api.ts` (verified 2026-10-26)
- [binding] Order journal entries by sequence number, not by wall-clock time. — See `docs/ARCHITECTURE.md` §Journal (verified 2026-10-26)
- [binding] Compaction must preserve the live tail. — See `docs/OPERATIONS.md` §Compaction (verified 2026-10-26)
- [provisional] Prefer batched writes when admission load grows. — See `src/api.ts` (verified 2026-10-26)
