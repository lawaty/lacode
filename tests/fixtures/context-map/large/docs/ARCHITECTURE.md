# Atlas architecture

## The two halves

Atlas is split into a write side (the journal) and a read side (the projector)
because replay must never block admission.

## Subsystems

The API admits commands. The journal is append-only. The projector replays it.
Retention compacts the journal prefix. A query service reads projections.

## Journal

The journal is append-only and is the only writable source of truth. A
projection is derived state.

## Projector

The projector replays the journal from the last checkpoint. It never writes
the journal.

## Retention

Compaction keeps the last 30 days of journal entries.

## Record lengths

None of the record lengths are parsed; the header is ignored.

## Measurements

The p99 admission latency is 20 ms.
