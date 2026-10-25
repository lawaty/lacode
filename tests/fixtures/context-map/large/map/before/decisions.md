# Decisions

## Decision 1 — subsystem rule 1

**Context:** the team needed to decide how subsystem 1 behaves under load.

**Decision:** subsystem 1 follows rule 1.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 2 — subsystem rule 2

**Context:** the team needed to decide how subsystem 2 behaves under load.

**Decision:** subsystem 2 follows rule 2.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 3 — subsystem rule 3

**Context:** the team needed to decide how subsystem 3 behaves under load.

**Decision:** subsystem 3 follows rule 3.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 4 — subsystem rule 4

**Context:** the team needed to decide how subsystem 4 behaves under load.

**Decision:** subsystem 4 follows rule 4.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 5 — subsystem rule 5

**Context:** the team needed to decide how subsystem 5 behaves under load.

**Decision:** subsystem 5 follows rule 5.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 6 — subsystem rule 6

**Context:** the team needed to decide how subsystem 6 behaves under load.

**Decision:** subsystem 6 follows rule 6.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 7 — subsystem rule 7

**Context:** the team needed to decide how subsystem 7 behaves under load.

**Decision:** subsystem 7 follows rule 7.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 8 — subsystem rule 8

**Context:** the team needed to decide how subsystem 8 behaves under load.

**Decision:** subsystem 8 follows rule 8.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 9 — subsystem rule 9

**Context:** the team needed to decide how subsystem 9 behaves under load.

**Decision:** subsystem 9 follows rule 9.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 10 — subsystem rule 10

**Context:** the team needed to decide how subsystem 10 behaves under load.

**Decision:** subsystem 10 follows rule 10.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 11 — subsystem rule 11

**Context:** the team needed to decide how subsystem 11 behaves under load.

**Decision:** subsystem 11 follows rule 11.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 12 — subsystem rule 12

**Context:** the team needed to decide how subsystem 12 behaves under load.

**Decision:** subsystem 12 follows rule 12.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

- Entry 1: subsystem 1 owns its own state and exposes one boundary.
- Entry 2: subsystem 2 owns its own state and exposes one boundary.
- Entry 3: subsystem 3 owns its own state and exposes one boundary.
- Entry 4: subsystem 4 owns its own state and exposes one boundary.
- Entry 5: subsystem 5 owns its own state and exposes one boundary.
- Entry 6: subsystem 6 owns its own state and exposes one boundary.
- Entry 7: subsystem 7 owns its own state and exposes one boundary.
- Entry 8: subsystem 8 owns its own state and exposes one boundary.
- Entry 9: subsystem 9 owns its own state and exposes one boundary.
- Entry 10: subsystem 10 owns its own state and exposes one boundary.
- Entry 11: subsystem 11 owns its own state and exposes one boundary.
- Entry 12: subsystem 12 owns its own state and exposes one boundary.
- Entry 13: subsystem 13 owns its own state and exposes one boundary.
- Entry 14: subsystem 14 owns its own state and exposes one boundary.
- Entry 15: subsystem 15 owns its own state and exposes one boundary.
- Entry 16: subsystem 16 owns its own state and exposes one boundary.

## Decision 13 — subsystem rule 13

**Context:** the team needed to decide how subsystem 13 behaves under load.

**Decision:** subsystem 13 follows rule 13.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 14 — subsystem rule 14

**Context:** the team needed to decide how subsystem 14 behaves under load.

**Decision:** subsystem 14 follows rule 14.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 15 — subsystem rule 15

**Context:** the team needed to decide how subsystem 15 behaves under load.

**Decision:** subsystem 15 follows rule 15.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Decision 16 — subsystem rule 16

**Context:** the team needed to decide how subsystem 16 behaves under load.

**Decision:** subsystem 16 follows rule 16.

**Consequences:** the boundary is explicit; the implementation is longer.

**Alternatives:** a single process was rejected because replay would block admission.

## Empirical findings

1. The p99 admission latency is 12 ms.
2. The journal can be replayed twice without duplicating a projection.
3. The record lengths are parsed from the header.
4. Batching commands reduced write amplification.
5. The query service can lag the projector.
6. A checkpoint is cheap to rebuild.
7. Compaction is safe while the tail is live.
8. The separate-service design was refuted by the replay test.

## Record lengths

| Record | Length |
| --- | --- |
| header | 4 |
| entry | 12 |
| checkpoint | 8 |

## Gotchas

- The retired ADR text survives only here.
- The split is documented in `docs/ADR-0007.md` §The split.

- [binding] The split is documented in `docs/ADR-0007.md` §The split. — See `docs/ADR-0007.md` §The split (verified 2025-01-01)
- [binding] The p99 admission latency is 12 ms. — See `docs/ARCHITECTURE.md` §Measurements (verified 2025-01-01)
- Do not project before the journal entry is durable.

### No decision yet

- The retention window might change.
- The query service might move behind the API.

- [provisional] The p99 latency target may be revisited. — See `docs/ARCHITECTURE.md` §Measurements (verified 2025-01-01)
- [binding] The journal stays append-only. — See `docs/ARCHITECTURE.md` §Journal (verified 2025-01-01)
