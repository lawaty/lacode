# Context-map fixtures

Two consumer repositories for the cartographer contract:

- `small/` — two subsystems, one page, a defective map and its conforming target.
- `large/` — a realistic multi-subsystem ledger whose defective map exceeds every
  budget and carries the observed defects (decision records, restatements, drift,
  archive language, mixed provenance).

Each fixture has `map/before/` (what the old generator produced) and `map/after/`
(the compact map the new contract requires). The fixture runner copies the tree
to a scratch directory before doing anything; the fixture itself is never edited.

Run `node scripts/context-map-fixture.mjs` for the report, or
`node --test tests/context-map-fixture-test.mjs` for the assertions.
