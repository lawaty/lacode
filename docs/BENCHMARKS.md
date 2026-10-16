# Cost benchmarks

**This file contains no results.** It explains how to produce your own. The table
below is empty on purpose, and the harness refuses to invent a number to fill it
in.

There is no published savings figure for LaCode, because none has been
independently measured. A number in a README is a claim about somebody's
workload, and yours is not that workload. The plugin changes two things: *which
model does the bulk exploration work*, and *how much of that work has to be done
at all* — agents start from the maintained context map in [CONTEXT.md](CONTEXT.md)
instead of re-deriving the structure of your repository on every task. What that
is worth in money depends entirely on your token mix and on what you compare the
pooled run against. So the harness exists to let you compute the number for
yourself rather than to hand you one to believe.

## What the harness measures

`tests/benchmark/run.mjs` runs one scenario twice — once on your main model, once
on a pooled model — and prints tokens and cost for both.

The comparison only means something because both runs do *identical* work. The
scenario is stated once in the harness and passed to both configurations: the
same four prompts, the same number of calls, a different model doing them.

```
Map the modules that handle authentication and the entry points that reach them.
Find every place a request is authorized and list the file:line for each check.
List the config files that affect routing and the defaults each one sets.
Find the test files covering the auth path and name what each asserts.
```

It is a small, deliberately mechanical scenario. It is not a representative
workload for you, and the harness does not claim it is. Its only job is to make
the two sides of the ratio comparable.

## Commands

| Command | What it does |
| --- | --- |
| `npm run benchmark` | Simulation (the offline default). No credentials, no network. |
| `npm run benchmark -- --real` | Runs both configurations for real against the `opencode` binary and reads token counts back out of the runs. |
| `npm run benchmark -- --refresh` | Rebuilds `tests/models-snapshot.json` from models.dev first (network), then proceeds as usual. |
| `npm run benchmark -- --out docs/BENCHMARKS.generated.md` | Writes the generated table to the *generated* filename. See below. |

Useful flags for both modes:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--baseline-model` / `--model` | `anthropic/claude-opus-4-1` | Which model plays "what it would have cost without LaCode". A **name**, never a price. |
| `--calls` | `40` | Simulation only. Number of delegated calls in the task profile. |
| `--input-tokens` | `12000` | Simulation only. Input tokens per call. |
| `--output-tokens` | `1500` | Simulation only. Output tokens per call. |
| `--allow-unknown` | off | Accepts `unknown` in the cost column for a model you named explicitly. Without it the run exits non-zero. |

`--real` additionally honours `OPENCODE_BIN` to locate the opencode binary, and
reads credentials from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`OPENROUTER_API_KEY` / `OPENCODE_API_KEY` or from the opencode `auth.json`.

## Simulation vs real

They are different kinds of claim, and the output says which one you are looking
at in every table header.

**Simulation** (the default) is arithmetic over stated assumptions. It takes the
task profile above, multiplies it out, and prices it from the pinned snapshot.
Nothing is executed and nothing is observed. It is a projection, and it is
useful for exactly one thing: seeing how the two rows compare when you change
the profile or the models.

**Real** runs the scenario twice and reads the token counts back out of each
run's own output. That is a measurement of the harness scenario on your machine
on that day. It is still not a measurement of your work.

`--real` degrades rather than failing when it cannot run: with no credentials or
no binary it prints `SKIPPED`, exits 0, and reports nothing. A real run that
fails mid-way exits 3 and refuses to fall through to a projection. If the runs
report no token usage at all, that is an error, not a cost of zero.

## Pricing

Prices come from `tests/models-snapshot.json`, checked in so a run is
reproducible and offline. Regenerate it with `npm run benchmark -- --refresh`
(or `node tests/refresh-models-snapshot.mjs`) when you want current figures.

A model the snapshot has never seen is **skipped with a named reason**. It is
never priced at 0 and never priced at a guess. If you name such a model
explicitly with `--model` / `--baseline-model`, the run exits non-zero and tells
you to refresh or to pass `--allow-unknown`.

This is why the results table below is empty. The pinned snapshot covers the
bundled free preset only; the default baseline model is not in it, so the
default offline run cannot produce an honest ratio.

## Results

Run it yourself and put the output here.

| configuration | models | calls | input tokens | output tokens | cost |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline (main model) | — | not yet measured | — | — | — |
| LaCode (pooled subagent) | — | not yet measured | — | — | — |

Difference: not yet measured — run it yourself.

Nothing in this repository asserts a savings percentage. There is no constant
anywhere in the harness: every ratio in the output is computed at runtime from
the rows printed above it, with both the numerator and the denominator shown, so
the arithmetic can be checked by hand. If a number cannot be derived, the
harness prints `unknown`.

## Why the generated table is a separate file

`--out` writes to `docs/BENCHMARKS.generated.md`. It **refuses**
`--out docs/BENCHMARKS.md` and exits 2.

That refusal is the point. This file ships inside the npm tarball (`files`
includes `docs`) and is the hand-written explainer. A generated table is a
measurement of one machine on one day, not a claim about the package, so the
explainer is protected and the generated output — which carries a footer
pointing back here — goes to its own gitignored filename.

```bash
npm run benchmark -- --out docs/BENCHMARKS.generated.md
```