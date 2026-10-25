# Decisions

- [binding] The journal is the only writable source of truth; the projector is derived. — See `docs/ARCHITECTURE.md` §Journal (verified 2026-10-26)
- [binding] The two halves are split so replay cannot block admission. — See `docs/ARCHITECTURE.md` §The two halves (verified 2026-10-26)
- [binding] Compaction keeps the last 30 days of entries. — See `docs/ARCHITECTURE.md` §Retention (verified 2026-10-26)
- [binding] Record lengths are not parsed; the header is ignored. — See `docs/ARCHITECTURE.md` §Record lengths (verified 2026-10-26)
- [binding] The query service is a read path and never writes the journal. — See `docs/ARCHITECTURE.md` §Subsystems (verified 2026-10-26)
- [binding] A checkpoint never advances before compaction commits. — See `docs/OPERATIONS.md` §Compaction (verified 2026-10-26)
- [provisional] The query service may move to its own process. — See `docs/ARCHITECTURE.md` §Subsystems (verified 2026-10-26)
