# Atlas operations

## Replay

Replay starts at the last checkpoint and reads the journal forward. It can be
stopped and resumed without losing a projection.

## Compaction

Compaction rewrites the journal prefix and updates the checkpoint. It never
touches the live tail.
