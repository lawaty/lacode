# LaCode

> Ultimate opencode setup for Go users

LaCode is an opencode plugin. It routes delegated work onto a weighted pool of
cheap models instead of the expensive one, reaps subagents that hang without
telling anyone, keeps a maintained map of your repository so agents stop
exploring it cold on every task, and tells you when a parallel session finishes
or is waiting on you — including sessions running on remote hosts over SSH,
where the desktop notification would otherwise die on a machine that has no
desktop.

Install it with one config line. It adds agents and commands it finds missing,
and it never overwrites one you already defined.

## Why

| Capability | The problem it solves |
| --- | --- |
| Weighted model pool | An expensive main model burns through its quota doing file listing. |
| Per-model cooldowns and failover | A provider rate-limits mid-session and the whole thing hard-fails, while other providers sit idle. |
| Hang reaper | A wedged subagent holds its slot forever, so the session stalls with no error and no timeout. |
| Desktop notifications | With several sessions open you cannot see which one finished, or which is blocked on a question. |
| SSH notification tunnel | Work on a remote host raises its notification on that host, which has no desktop. |
| Repository context map | Every task starts by exploring your codebase cold, and every agent re-discovers the same layout, the same entry points and the same boundaries — paid for again on every run. |

## Install

Add one line to your opencode config — `~/.config/opencode/opencode.json`, or
the `.jsonc` beside it:

```json
{ "plugin": ["@lawaty/lacode"] }
```

**That is the entire install.** opencode resolves an npm plugin specifier itself
and installs it at startup, so there is no `npm install` to run first and no
directory to create. Do not run `npm i -g @lawaty/lacode`: a global npm install
is never consulted by opencode, so it changes nothing about whether the plugin
loads.

To install it explicitly instead — or to install it once for every project on
the machine rather than per config — use the CLI, which does the same thing:

```bash
opencode plugin @lawaty/lacode        # this project
opencode plugin @lawaty/lacode -g     # global, for every project on the machine
```

**Restart opencode afterwards.** Nothing here hot-reloads: the `plugin` array is
read at startup, so without a restart the change does not take effect and the
agent set will look stale for no visible reason.

### Where it is installed

opencode installs npm plugins itself, into one directory per specifier under
its cache — not into your project's `node_modules`, and not from anywhere a
global npm install put them:

```
$XDG_CACHE_HOME/opencode/packages/<specifier>/node_modules/
# ~/.cache/opencode/packages/@lawaty/lacode@latest/node_modules/ by default
```

`$XDG_CACHE_HOME` defaults to `~/.cache`; set it if you keep a cache elsewhere.
To inspect what a specifier actually resolved to, list its directory under
`~/.cache/opencode/packages/`. An empty directory with no `node_modules` inside
it means the install failed — almost always an unpublished or misspelled package
— and opencode starts normally **without** the plugin.

### Verifying the install

A plugin that fails to install is silent: there is no error, opencode starts,
and it simply does not have the agents. Check for them:

```bash
opencode agent list | grep -E '^(explore-fast|implement-fast|explore-deep|implement-deep)'
```

A working install prints `explore-fast`, `implement-fast`, `explore-deep` and
`implement-deep`, each with the hidden `-1`..`-4` pool variants alongside. If the
grep returns nothing but opencode's built-ins, the plugin did not load: check the
cache directory above, and check that `plugin` is in the config file opencode
actually reads. Run this in the same shell environment opencode runs in — an
`agent list` under a different `HOME` or `XDG_CONFIG_HOME` tests a different
machine.

### The `lacode` CLI

The package also ships the `lacode` CLI (`notify`, `forward`, `doctor`) — see
[Remote hosts](#remote-hosts). The plugin install does **not** put it on your
`PATH`; run it from the package's `node_modules/.bin`, or install just the CLI
globally with `npm i -g @lawaty/lacode` if you want the bare command. (That
global install is for the command only — it is still never what makes the plugin
load.)

### What the install gives you

Two things are worth knowing about what npm actually hands you:

- **`@opencode-ai/plugin` is a peer dependency.** It is not vendored into this
  package and never will be: a second copy of the SDK inside the tarball would
  mean opencode and the plugin holding two different module instances, and
  instance identity is what plugin state hangs on. npm installs the peer for you;
  if you install with a tool that does not, install `@opencode-ai/plugin` at the
  same version yourself.
- **You get compiled JavaScript, not TypeScript sources.** The tarball ships
  `dist/`, built from `src/` at pack time (`prepack` runs the build, so a stale
  `dist/` cannot be published). This is not a preference: node strips types
  natively from 22.18 but **refuses to for files under `node_modules`**, so a
  package that shipped `.ts` worked fine in a checkout and failed on install —
  `lacode --help` died with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. A
  published package cannot depend on its consumer's loader being lenient.

## Configuration

Plugin options are a tuple — the package name, then an options object. Every
option is optional:

```jsonc
{
  "plugin": [
    ["@lawaty/lacode", {
      "enabled": true,
      "models": {
        "slots": [
          { "model": "anthropic/claude-sonnet-4-5", "weight": 2 },
          { "model": "opencode/big-pickle", "weight": 1 }
        ]
      }
    }]
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | The single off switch. `false` injects nothing at all and does no writes. |
| `models` | — | An inline slot list. Highest-priority source. |
| `modelsFile` | — | An explicit slot file; short-circuits the chain below. |
| `deepModel` | — | A `provider/model-id` pinned onto `explore-deep` and `implement-deep`. |
| `reapMs` | `30000` | Hang-reaper interval. |

### Pool preset resolution

The slot list is the first of these that yields usable slots:

1. plugin options — `models` in the tuple above
2. `~/.config/lacode/pool.json` (its parent directory is created for you)
3. the bundled `presets/free-tier.json`
4. a built-in fallback, so routing always works

A missing, unreadable or structurally broken source falls through to the next and
logs one warning; nothing here throws into opencode. Nothing hot-reloads —
change a preset, then restart every opencode process.

**Any model list is accepted, including paid ones** (US-7). There is no free-tier
allowlist anywhere in the package, and no cost check of any kind: only the
structure is validated. The bundled preset is built from free models because
that is a sensible default, not because the pool requires it.

### Which models run which agent

Only the **pool** writes a model onto a pooled agent, from whichever source wins
above. The pooled bases (`explore-fast`, `implement-fast`, `context-manager`)
and their hidden `-1`..`-4` variants therefore carry no model of their own: a
model written next to an agent would be a second source of truth that silently
wins whenever routing falls through. Spawn a base and let the pool route it.

`explore-deep` and `implement-deep` are **not** pooled — they are the deliberate
escalation above a pooled tier — so nothing routes them and nothing writes their
model. Left alone they fall through to your default model, which turns "I am
stuck, escalate" into an unannounced jump to the most expensive model in your
setup. Set `deepModel` to pin them:

```jsonc
"plugin": [["@lawaty/lacode", { "deepModel": "your-provider/your-deep-model" }]]
```

It is an option and not a literal in the package because which model to escalate
onto is a property of your providers, not of LaCode. LaCode also adds the pinned
model to that provider's whitelist for you: opencode drops any model a provider
offers that is not whitelisted, so an unlisted pin would resolve to nothing at
all. With `deepModel` unset, no model is written and the deep tiers use your
default model — the behaviour of earlier versions.

### What gets injected

**19 agent keys**: the 7 bases `build`, `plan`, `explore-fast`, `explore-deep`,
`implement-fast`, `implement-deep`, `context-manager`, plus one hidden
`<base>-1`..`-4` pool variant for each of the 3 pooled bases.

`build` and `plan` exist in opencode as built-ins, so on a stock config those
two keys are already taken and merge-without-clobber keeps the built-in — the
LaCode definitions of `build` and `plan` are what you get if you remove the
built-ins of those names first.

**Five keys are deliberately not injected.** `basic` is a byte-for-byte
duplicate of `plan` apart from a pinned model, and `plan` is injected instead.
`expert` pins a specific model and carries a personal benchmark note in its
description — a package cannot ship someone else's provider, quota or benchmark
results — though its escalation ladder still resolves, because the two deep
tiers it escalates to *are* injected. And `explore`, `general` and `implement`
are only `{ "disable": true }` stubs in the author's own config: turning off
opencode's built-in agents is a decision about one person's configuration, not
a default a package should impose on a stranger.

The four exploration and implementation tiers carry `tools: {"playwright_*": true}`.
A grant for a tool namespace you have not installed is a no-op, whereas omitting
it from a user who *has* installed Playwright and globally disabled it — as the
author's own config does — silently strips browser access from exactly the
agents whose prompts drive a browser. `context-manager` gets no grant; it writes
the context map.

**Installation merges, it does not clobber** (US-16). An agent, command or
instruction is added only when that key is absent from your config. A
user-defined agent of the same name is left byte-identical — not patched, not
partially merged. Skips are counted and logged once.

**`enabled: false` turns all of it off** (US-17). No pool model rewriting, no
agent injection, no command injection, no reaper timer armed, no
`~/.config/lacode` directory created.

These three are specified in [docs/USER-STORIES.md](docs/USER-STORIES.md) as
US-7, US-16 and US-17, and each has tests.

## Context map

Agents are stateless between tasks, and exploring your repository is the most
expensive part of any task — so every agent pays for it again, re-deriving the
same layout, entry points and boundaries from scratch. LaCode keeps a short,
maintained map of the repository in `.opencode/context/` (five files:
`architecture`, `contexts`, `conventions`, `workflows`, `decisions`) and injects
a standing rule that every agent reads the relevant file before exploring and
starts from the canonical entry points it lists. The map holds conclusions, not
inventories: it answers "what should I look at first?" and nothing else, which
is what makes reading it cheaper than the exploration it replaces.

It keeps itself current. When a session that edited code goes idle, LaCode
starts a `context-manager` run that borrows a slot from the same pool every
other subagent uses and updates the map from the changed paths and their
architectural neighbourhood — defaulting to *no edit*, since a changed file is
not a changed fact. Only that one agent ever writes the map; everything else
reports what belongs in it, so concurrent sessions cannot contradict each other.
You can also drive it by hand, which is the move when you do not trust what you
are reading:

```bash
/context-init      # build the map, or verify and refresh an existing one
/context-update    # incremental refresh; accepts a focus, e.g. /context-update src/payments
/context-review    # audit it for staleness, contradictions, duplication and bloat
```

The map is local and untracked — it describes your checkout on your machine, so
it is not committed and not synced. If it is missing, agents check, find
nothing and carry on as before. What this buys is tokens not spent
re-discovering structure; as with everything else here, no savings percentage is
published, because none has been independently measured. The mechanism, the
permission rule that makes one writer possible, and what the log lines mean are
in [docs/CONTEXT.md](docs/CONTEXT.md).

## Cost

The mechanism is specific and small: bulk exploration, implementation and
repository cartography run on pooled cheap or free subagents instead of the main
model. There are **two separate effects** here, and they are worth telling apart
because only one of them is about money per token:

1. **The tokens are spent on a cheaper model.** A read, a grep, or a mechanical
   edit performed by a near-free subagent costs per-token approximately nothing,
   where the same call on your main model does not. This is the effect people
   usually mean when they say the pool saves money.
2. **The main model's context is never filled with file contents it does not
   need.** A delegated explorer returns a conclusion and a `file:line`, not
   forty tool calls' worth of source. The expensive model spends its attention
   on design work instead of on reconstructing a directory tree, and its context
   window — a hard, non-renewable budget — is spent on reasoning rather than on
   raw file text.

The second is the larger of the two, and it is not a cost-per-token effect at
all: it is a capacity effect. It holds even when the pooled model is not free,
and it is why the pool is scoped to *mechanical* work. Work that needs real
judgement belongs to the main model regardless of what the pool is running,
because pulling a difficult conclusion back through a subagent costs more
context on the far side than reading the file directly would have.

That scoping is why the bundled preset is free: pooled work is work you would
not have wanted the main model to do anyway. **Free is the shipped default, not
an enforced restriction.** The pool is open — it accepts any model you give it,
free, cheap or expensive, and never inspects, prices, warns about, filters or
rewrites one. The only per-model rule is structural: a slot must be written
`provider/model-id` so it is addressable at all. That default lives in exactly one
place, `presets/free-tier.json`, where you can read it and change it (US-7, US-23).

Agents start from the maintained context map above rather than exploring cold, so
the structure of your codebase is written down once instead of re-derived on
every task. Load is counted per model across every agent type and every process,
so a slot cannot hide behind its own dedicated model while another idles, and a
model that just rate-limited one project is skipped by all of them.

**No savings percentage is published here, because none has been independently
measured.** What the mechanism is worth in money depends entirely on the token
mix of your tasks and on the models you compare the pooled run against. A figure
from someone else's workload is not a claim about yours.

The harness exists so you can produce your own number:

```bash
npm run benchmark          # offline simulation from the pinned price snapshot
npm run benchmark -- --real   # runs both sides for real and reads back the tokens
```

Both print tokens and cost for the same scenario run two ways, and both refuse
to emit a number they cannot derive — an unpriced model reports `unknown`, never
`0`. How the two modes differ is in [docs/BENCHMARKS.md](docs/BENCHMARKS.md),
which explains the harness and deliberately contains no results.

## Remote hosts

Notifications raised on a remote host need a way back to your desktop. The
reverse SSH forward is what carries them:

```bash
lacode notify "build finished" "4 files changed"      # local desktop, or forwarded if remote
lacode doctor                                        # what the environment resolves to
```

`lacode notify` is fire-and-forget and always exits 0 — an unreachable desktop
must never be able to fail the process that tried to notify you. `lacode forward
HOST -- COMMAND` runs a command on another host over ssh and exits with its
status.

Configuration, the payload format, the receiver contract and holding the forward
open are in [docs/TUNNEL.md](docs/TUNNEL.md).

## User stories

Twenty-three stories across seven epics, each written as a behavioural contract
with acceptance criteria a test can assert mechanically — the pains behind them,
the Given/When/Then criteria, and the story-to-test mapping are in
[docs/USER-STORIES.md](docs/USER-STORIES.md).

## Development

```bash
npm run build          # esbuild -> dist/ (what the tarball ships)
npm test               # node --test tests/ — offline, no network, no running server
npm run benchmark      # the cost harness; see docs/BENCHMARKS.md
```

Node ≥ 22.18.

`npm run build` compiles each entry point in `package.json` (`exports` and
`bin`) into `dist/` with esbuild, one bundle per entry point, so nothing in
`src/` has to be renamed to satisfy node's ESM resolver. `@opencode-ai/plugin`
and the node builtins are external — see the header of `scripts/build.mjs` for
why a peer dependency must never be inlined. `dist/` is generated and
gitignored; `prepack` builds it, so `npm pack` cannot produce a stale tarball.

The sources are TypeScript and the tests import `src/` directly (node strips the
types outside `node_modules`, which is exactly where the tests live), so the
loop stays: edit `src/`, run `npm test`. Only the packaging fixtures build, and
they call the same `scripts/build.mjs` the tarball does.

`tests/stories/` holds the story suites and `tests/stories/coverage.test.mjs`
is the guard: it reads the `### US-N:` headings out of `docs/USER-STORIES.md`
and the `[US-N]` markers out of the test names and fails if they disagree, in
either direction. **A test that covers a story must have the id at the start of
its name** — `test("[US-7] a paid model is accepted")` — or CI's guard fails it.
A story with no test is as much a failure as a test naming a story that does not
exist.

## License

MIT licensed. Based on work by [lawaty](https://github.com/lawaty/lacode).