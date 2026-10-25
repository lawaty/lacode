# Workflows

- [binding] A command is admitted, appended to the journal, then projected. — See `docs/ARCHITECTURE.md` §The two halves (verified 2026-10-26)
- [binding] Replay starts at the last checkpoint and reads forward. — See `docs/OPERATIONS.md` §Replay (verified 2026-10-26)
- [binding] Compaction rewrites the journal prefix and then updates the checkpoint. — See `docs/OPERATIONS.md` §Compaction (verified 2026-10-26)
- [binding] A read returns the last applied projection and never waits for replay. — See `docs/ARCHITECTURE.md` §Projector (verified 2026-10-26)
- [provisional] A failed projection is retried from the last checkpoint. — See `docs/OPERATIONS.md` §Replay (verified 2026-10-26)
