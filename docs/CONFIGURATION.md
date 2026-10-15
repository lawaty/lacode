# Configuration reference

The plugin options, where the model pool gets its slots, and exactly what LaCode writes into your config. The short version is in the [README](../README.md#configure).

## Pool preset resolution

The slot list is the first of these that yields usable slots:

1. plugin options — `models` in the [tuple](../README.md#configure)
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


## Which models run which agent

Only the **pool** writes a model onto a pooled agent, from whichever source wins
above. The pooled bases (`explore`, `implement`, `context`)
and their hidden `-1`..`-4` variants therefore carry no model of their own: a
model written next to an agent would be a second source of truth that silently
wins whenever routing falls through. Spawn a base and let the pool route it.


## ⚠️ Per-agent tool grants must be in your own config

**LaCode cannot grant tools to its agents, and this is not an oversight you can
work around by configuring it.** If you keep a global `"tools"` block in your
config — for example `"tools": { "playwright_*": false }` — then the pooled
exploration and implementation bases (`explore` and `implement`, plus their
hidden `-1`..`-4` pool variants) lose browser access, and **nothing tells them why**: the tool call is simply
refused mid-task. `context` gets no grant either, which is correct — it
writes the context map and has no business in a browser.

opencode folds an agent's `tools` into its permission list **at config-load
time**, while decoding the config — before any plugin runs. A plugin's `config`
hook mutates the already-decoded config, so the fold never re-runs and anything
it puts in `agent.tools` is inert. (Verified on opencode 1.18.34/1.18.35 with
`opencode debug agent explore`: a grant written in your own config shows two
`playwright_*` entries — `deny` then `allow`, last one winning — while the same
grant injected by the plugin shows only the `deny`.) LaCode's other injected
fields are not affected; `permission`, `prompt`, `model`, `description`,
`temperature`, `mode` and `hidden` are all read after the plugin hook runs.

**So if you use a global `"tools"` block, declare the grants yourself:**

```jsonc
{
  "tools": { "playwright_*": false },
  "agent": {
    "explore": { "tools": { "playwright_*": true } },
    "implement": { "tools": { "playwright_*": true } }
  }
}
```

The hidden pool variants (`explore-1`, `implement-2`, …) inherit
nothing here — add a line per variant, or drop the global
deny and scope it to the agents that should not have browser access instead.
Note that you cannot *spawn* a variant by name: the pool refuses
`explore-1` and friends and points you at the bare base, so per-variant
permissions only ever apply to a spawn the plugin routed itself.

Nothing hot-reloads: after editing your config, restart every running opencode
process.


## What gets injected

**17 agent keys**: the 5 bases `build`, `plan`, `explore`, `implement`,
`context`, plus one hidden
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

One **field** is deliberately not injected either: `tools`, for the
load-time-folding reason explained above. Nothing else the plugin writes into
an agent is subject to it.

**Installation merges, it does not clobber** (US-16). An agent, command or
instruction is added only when that key is absent from your config. A
user-defined agent of the same name is left byte-identical — not patched, not
partially merged. Skips are counted and logged once.

**`enabled: false` turns all of it off** (US-17). No pool model rewriting, no
agent injection, no command injection, no reaper timer armed, no
`~/.config/lacode` directory created.

These three are specified in [docs/USER-STORIES.md](USER-STORIES.md) as
US-7, US-16 and US-17, and each has tests.
