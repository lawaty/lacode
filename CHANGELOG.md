# Changelog

All notable changes to LaCode are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions come from git release commits; the npm version is bumped in the same
commit as the changelog entry it describes.

## [Unreleased]

## [0.4.1] — refuse hand-named slot variants, and ship a changelog

### Added

- `CHANGELOG.md`, reconstructing all 13 published releases from their commits. It
  ships with the package, so an install can read what changed without the repo.

### Changed

- A pool slot variant named by hand (`explore-1`, `implement-2`, …) is now
  **refused** rather than counted. Naming one skipped both the round-robin
  rotation and the slot's ceiling, so six spawns of `explore-1` put six
  concurrent claims on a slot bounded at three. The refusal names the bare base
  to spawn instead, is logged, and escapes the routing catch — swallowed into
  "spawn unchanged" it would have admitted the spawn it forbids.
- Agent prompts dropped the long explanation of why a variant must not be named.
  It is enforced now, and the refusal carries the reason; the prompts keep only
  the bare-base rule and what to do on refusal. 1,012 characters removed across
  the `build`, `plan` and `explore` prompts.

### Documented

- `isAvailable` and `pickSlot` now say, in place, that the pool is deliberately
  fail-open in two places: a model absent from the catalog is not treated as
  unavailable, and when every slot is cooling they are re-admitted rather than
  the work refused. Both were previously only discoverable by reading the code.

## [0.4.0] — order-first weighted round-robin, and a reaper that can kill

### Changed

- **Slot selection is now order-first weighted round-robin.** Weight was both
  the priority and the ceiling, so the heaviest slot was re-prioritised on every
  spawn and refilled the moment a claim completed, while the others sat idle.
  Selection walks the slot list in order, each slot taking as many turns as its
  weight says, from a cursor persisted in the pool directory so the rotation is
  shared by every opencode process rather than restarting in each one. Weights
  `[3,2,1,1]` now produce the run `1,1,1,2,2,3,4`.
- The concurrency ceiling is unchanged: a slot still holds at most `weight`
  concurrent claims, and overflow still goes to the least-loaded slot.
- `pool_status` previews the next slot without advancing the rotation, so
  looking at the pool no longer shifts every spawn after it.

### Fixed

- **A hung subagent could not be killed.** The reaper detected the wedge, freed
  the claim, and then failed to abort the session — because the claim was
  released *before* the abort, so a failed kill orphaned the session with
  nothing left to retry it. Kills are verified against the response, retried
  three times, and only a confirmed kill releases the claim; a give-up names
  the session to kill by hand.
- A kill reported success for any HTTP response, including the gateway's
  `200` with body `true` for a session that does not exist.
- A claim that never bound to a child session was logged as `Infinitys of
  silence` and cooled the provider, though an unbound claim is no evidence that
  anything hung. It is now released without cooling, and a child created before
  its claim is bound at reap time instead of being lost.
- **A live task lost its slot past the TTL.** Claims now carry a heartbeat
  refreshed by message activity, and abandonment is measured from it. A task
  that ran past the 10-minute TTL previously stopped being counted while it
  kept working, so the slot was handed out again — a ceiling-3 slot ran five.

## [0.3.0] — a sound per notification outcome (US-29)

### Changed

- Notification outcomes are per-notification and sound, rather than one silent
  aggregate.

## [0.2.2] — stop capping gateway traffic at 5s

### Fixed

- `timeoutMs` no longer caps real provider traffic at 5s. It was documented as
  a probe budget only, but it was being applied to live completions too.

## [0.2.1] — OmniRoute registers the provider only

### Changed

- The OmniRoute integration registers the provider and nothing else; it writes
  no pool file and no variants.

## [0.2.0] — OmniRoute as the pool's primary slot

### Added

- OmniRoute, a local OpenAI-compatible gateway, as the pool's primary slot, with
  combo routing, sticky sessions and cooldown on usage limits.

## [0.1.10] — observable self-update outcome

### Changed

- The self-update reports its outcome instead of failing silently.

## [0.1.9] — reclaim update locks orphaned by a dead process

### Fixed

- An update lock left behind by a dead process is reclaimed rather than blocking
  every later update.

## [0.1.7] — self-update, hermetic tests

### Added

- Self-update on restart, and a hermetic test suite that does not read the
  developer's own `~/.config`.

## [0.1.6] — small implement asks, Step 5 Preview pool

### Changed

- Implementation asks are split into smaller units.
- `opencode-go/step-5-preview-free` added to the bundled pool preset.

## [0.1.5] — build/plan may spawn basic and expert

### Changed

- `build` and `plan` may spawn `basic` and `expert`, which are not pooled.

## [0.1.4] — flat pool.txt

### Changed

- The pool's user config is a flat `~/.config/lacode/pool.txt`, one model per
  line with an optional weight.

## [0.1.3] — ship the updated notification/remote docs

### Changed

- Notification and remote-control documentation brought up to date.

## [0.1.1]

### Added

- First published release: pooled subagents over a shared set of models.

[Unreleased]: https://github.com/lawaty/lacode/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/lawaty/lacode/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/lawaty/lacode/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lawaty/lacode/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/lawaty/lacode/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/lawaty/lacode/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lawaty/lacode/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/lawaty/lacode/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/lawaty/lacode/compare/v0.1.7...v0.1.9
[0.1.7]: https://github.com/lawaty/lacode/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/lawaty/lacode/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/lawaty/lacode/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lawaty/lacode/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lawaty/lacode/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/lawaty/lacode/releases/tag/v0.1.1