# Decisions

## Decision 1 — split the gateway from the store

**Context:** admission and persistence change for different reasons.

**Decision:** split them.

**Consequences:** two modules, one boundary.

**Alternatives:** a single module was rejected because replay would block admission.

### No decision yet

- The retention window might change.

## Record lengths

| Record | Length |
| --- | --- |
| header | 4 |
| entry | 12 |

The record lengths are parsed from the header.

This is the only place the retired ADR text remains.

- The split is described in `docs/ADR-0007.md` §The split.

- [binding] The split is described in `docs/ADR-0007.md` §The split. — See `docs/ADR-0007.md` §The split (verified 2025-01-01)
- [binding] The record lengths are parsed from the header. — See `docs/DESIGN.md` §Record lengths (verified 2025-01-01)

- [provisional] The retention window may change. — See `docs/DESIGN.md` §Retention (verified 2025-01-01)
- [binding] The gateway stays stateless. — See `docs/DESIGN.md` §The two halves (verified 2025-01-01)
