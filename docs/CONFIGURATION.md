# Configuration reference

The plugin options, where the model pool gets its slots, and exactly what LaCode writes into your config. The short version is in the [README](../README.md#configure).

## Pool preset resolution

The slot list is the first of these that yields usable slots:

1. plugin options — `models` in the [tuple](../README.md#configure)
2. `~/.config/lacode/pool.txt` — flat `model [weight] [b:<bucket>] [c:<context>] [notify:on|off]` per line, preferred
3. `~/.config/lacode/pool.json` (its parent directory is created for you)
4. the bundled `presets/free-tier.json`
5. a built-in fallback, so routing always works

A missing, unreadable or structurally broken source falls through to the next and
logs one warning; nothing here throws into opencode. Sources 2–4 are watched: a
change reloads the slot table, re-binds the variant agents and validates every
slot (one real request per model) without a restart. Only a change to the
plugin's own code needs one.

**Any model list is accepted, including paid ones** (US-7). There is no free-tier
allowlist anywhere in the package, and no cost check of any kind: only the
structure is validated. The bundled preset is built from free models because
that is a sensible default, not because the pool requires it.

A slot's `weight` (default 1) is both its concurrency budget and its cap. The
pool fills slots in declaration order in one pass; there is no slot cap, and a
model may appear on more than one line — each line is its own slot with its own
weight. A `tier` key is the deprecated spelling of `weight`.

A slot may also declare a shared quota bucket with `b:<name>` on the line (or a
`bucket` field in JSON). A limit on any member benches the whole bucket, because
the sibling would spend the same exhausted window; without one, the model is its
own bucket. `pool_status` shows each shared bucket's effective capacity.

`c:<context>` is the model's context window in tokens; the router uses it to prefer the smallest model that fits the task, and it is optional for hand-written lines.

Each slot gets a `notify` flag that controls the desktop "rate-limit reset"
notice raised when a slot that was cooling for a quota/rate-limit reason becomes
usable again. The default is **provider-based**: on for `opencode` and
`opencode-go` slots, off for every other provider. On a `pool.txt` line, set
`notify:on` to opt a quiet provider's slot into the notice, or `notify:off` to
silence an `opencode`/`opencode-go` slot; `notify:on`/`notify:off` are accepted
explicitly. In `pool.json`, set `"notify": true` or `"notify": false`
(booleans; `on/off/1/0/yes/no` strings are also accepted). If the same model
appears on several lines, it is announced if **any** of its slots has `notify`
on — to fully silence a model, set `notify:off` on all of its lines. An
invalid `notify` value falls back to the provider default and produces a
warning. The flag gates only the desktop reset notice, not pool routing or
status, and pool files are hot-reloaded so changes take effect without a
restart.

## Modes

Two runtime modes live on the lacode plugin entry and can be toggled from the TUI:

| Command | Effect |
| --- | --- |
| `/yolo` | Toggle YOLO. Every permission request that would `ask` is approved automatically; an explicit `deny` still wins. |
| `/ykb` | Toggle YKB (You Know Better). The agent is told not to ask questions and to continue with its recommendation. A question that still appears is answered with its `(Recommended)` option, or its first option when none is marked. |
| `/modes` | Show both switches. |

```jsonc
{
  "plugin": [
    ["@lawaty/lacode", { "yolo": true, "ykb": false }]
  ]
}
```

The toggles edit the `yolo` / `ykb` options on the lacode plugin entry in your global opencode config (`~/.config/opencode/opencode.jsonc`, or `$XDG_CONFIG_HOME/opencode/opencode.jsonc`), preserving comments. The server reads that file on the next decision — no restart. Turning a mode on also answers requests that are already pending. The lacode plugin entry must already exist in the global config; a project-only entry cannot be toggled. A free-text question with no options is left for the user, since there is no option to choose.


## Which models run which agent

Only the **pool** writes a model onto a pooled agent, from whichever source wins
above. The pooled bases (`explore`, `implement`, `context`)
and their hidden `<base>-<slot>` variants therefore carry no model of their own: a
model written next to an agent would be a second source of truth that silently
wins whenever routing falls through. Spawn a base and let the pool route it.


## ⚠️ Per-agent tool grants must be in your own config

**LaCode cannot grant tools to its agents, and this is not an oversight you can
work around by configuring it.** If you keep a global `"tools"` block in your
config — for example `"tools": { "playwright_*": false }` — then the pooled
exploration and implementation bases (`explore` and `implement`, plus their
hidden `<base>-<slot>` pool variants, one per resolved slot) lose browser access, and **nothing tells them why**: the tool call is simply
refused mid-task. `context` gets no grant either, which is correct — it
writes the context map and has no business in a browser.

opencode folds an agent's `tools` into its permission list **at config-load
time**, while decoding the config — before any plugin runs. A plugin's `config`
hook mutates the already-decoded config, so the fold never re-runs and anything
it puts in `agent.tools` is inert. On opencode 1.18.34/1.18.35, a grant
written in your own config shows two `playwright_*` entries — `deny` then
`allow`, last one winning — while the same grant injected by the plugin shows
only the `deny`. LaCode's other injected
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
Note that you cannot *spawn* a variant by name: the pool rewrites
`explore-1` and friends to their base and routes them, so per-variant
permissions only ever apply to a spawn the plugin routed itself.

The pool files are the exception to the restart rule: editing `pool.txt`,
`pool.json` or the bundled preset is picked up live — the table reloads, the
variant agents re-bind and every slot is validated. A change to `opencode.jsonc`
itself, or to the plugin's code, still needs a restart.

**The delegation path matters.** The pool routes `task` tool calls whose
`subagent_type` is `explore`, `implement` or `context`. A spawn with no
`subagent_type`, an `@explore`/`@implement` mention, or a direct session prompt
naming a base agent does not pass through that hook: it runs opencode's
default/subagent path and inherits the caller's model. Spawn the bare base
through the task tool (`subagent_type: "explore"`), not by mention or variant
name. The plugin logs a warning for the no-`subagent_type` case; the
mention/direct-session case cannot be detected before it runs.


## What gets injected

**One key per base, plus a variant per slot**: the 5 bases `build`, `plan`,
`explore`, `implement`, `context`, one hidden `<base>-<slot>` pool variant per
resolved slot for each of the 3 pooled bases, and the hidden `instructions`
agent — the one writer of the project's root `AGENTS.md`, reachable only from
the `/agent-instructions` command.

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
are only `{ "disable": true }` stubs: turning off opencode's built-in agents
is a decision about one person's configuration, not a default a package should
impose on a stranger.

One **field** is deliberately not injected: `tools`, for the load-time-folding
reason explained above. Nothing else the plugin writes into an agent is subject
to it.

**Installation merges, it does not clobber** (US-16). An agent, command or
instruction is added only when that key is absent from your config. A
user-defined agent of the same name is left byte-identical — not patched, not
partially merged. Skips are counted and logged once.

**`enabled: false` turns all of it off** (US-17). No pool model rewriting, no
agent injection, no command injection, no reaper timer armed, no
`~/.config/lacode` directory created.

These three are specified in [docs/USER-STORIES.md](USER-STORIES.md) as
US-7, US-16 and US-17, and each has tests.
