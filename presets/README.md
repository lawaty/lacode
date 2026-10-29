# Pool presets

A preset is the pool's slot list: which models your pooled subagents share, and
how many concurrent sessions each one gets. It is one JSON file.

## Resolution chain

LaCode reads the first source that yields usable slots, in this order:

| # | Source | Where |
|---|--------|-------|
| 1 | plugin options | `["@lawaty/lacode", { "models": { "slots": [...] } }]` |
| 2 | user config | `~/.config/lacode/pool.txt` (flat, preferred) or `~/.config/lacode/pool.json` (JSON) |
| 3 | bundled preset | `presets/free-tier.json` |
| 4 | built-in fallback | hardcoded in `src/lib/pool.ts`, so routing always works |

The same logic lives in `resolveModels()` in `src/lib/pool.ts`, and it is the
single place it is implemented.

Missing, unreadable, or structurally broken falls **through to the next link**
and logs one warning. Nothing here ever throws into opencode — a pool that cannot
route takes every parallel spawn in the process down with it. Source 2's parent
directory (`~/.config/lacode/`) is created at plugin startup so you can drop a
file in without `mkdir` first.

Sources 1 and 2 win outright: if they parse, the bundled preset is never read.
Source 3 is a default, not a floor.

The pool files are not frozen at startup: the running process watches them,
reloads the slot table, re-binds the variant agents and validates every slot, so a
change here takes effect without a restart. Plugin CODE still needs one.

## The flat pool file (recommended)

`~/.config/lacode/pool.txt` is one model per line — edit a model id or a weight
in place, no JSON and no objects:

```text
# provider/model-id                       weight
opencode/big-pickle                       3
opencode-go/beam-free       2
opencode/deepseek-v4.1-flash-free         1
opencode/glm-5.3-flash-free               1
```

`#` starts a comment (whole-line or trailing), blank lines are ignored, and the
weight is optional (default 1). The rules are exactly the same as the JSON form
below: any number of slots, a model may repeat on another line, split on the
first slash only. The loader accepts either shape in the same file, so a leading
`{` means JSON and anything else means the flat form.

## Schema

```jsonc
{
  "slots": [
    { "model": "provider/model-id", "weight": 3 },
    { "model": "provider/another-id" }        // weight defaults to 1
  ]
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `model` | yes | `provider/model-id`, split on the **first** slash only |
| `weight` | no | active-session budget; the pool's capacity is the sum of the weights. Absent = 1 |

`$comment` is a JSON-legal array of strings and is ignored by the loader; the
bundled preset uses it to explain itself in place.

## Validation — structure only

The loader checks shape and nothing else:

- `slots` must be a non-empty array
- each `model` must contain a `/`
- a model may appear on more than one line; each line is its own slot with its
  own load counter and weight
- `weight` must be a number in `(0, 100]`; a bad one **warns and uses 1** rather
  than dropping the slot, because losing a model to a typo in a count costs real
  capacity
- there is no slot cap: one hidden variant agent is declared per base per
  resolved slot, and the watcher declares a variant if a reload grows the table
- `tier` is accepted as an alias for `weight` (`primary` → 2,
  `overflow` → 1) and warns

**Cost is never validated.** Any provider/model-id string is accepted, including
paid and proprietary models. There is no free-tier allowlist anywhere in the
package — a preset of frontier models is exactly as valid as the bundled one. The
bundled preset is built from 0/0-cost models because that is a good default, not
because the pool requires it.

## Weight, precisely

A weight is a slot's active-session budget: the number of concurrent claims it
may hold before the next slot is preferred. The pool's capacity is the **sum of
the weights**, so a weight-3 slot may hold 3 concurrent sessions and listing a
model on two lines gives it two independent budgets.

Routing is one pass:

1. fill each usable slot up to its weight, in declaration order

A slot is skipped when it is cooling or unavailable. When every usable slot is
at its weight, the pool is at capacity and overflow goes to the least loaded
usable slot; the pool never refuses work.

Live claims decide the next slot: a released claim immediately reopens its
slot, and there is no stored position.

Equal weights give a plain pass in list order. List order is preference, so
put the slots you want preferred first at the top of the list.

Spreading at least two providers across the slots is worth doing deliberately: a
provider-wide rate limit takes out every slot on that provider at once.

## Writing your own

Write `~/.config/lacode/pool.txt` (the flat form above) — that is the whole job.
Or put the same slots in a JSON `~/.config/lacode/pool.json`, or pass `models`
inline from `opencode.jsonc` when you want the list version-controlled beside
the rest of your config:

```jsonc
{
  "plugin": [
    ["@lawaty/lacode", {
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

Whichever provider a slot names must be configured in your own opencode config,
or the model cannot resolve. The pool appends the model id to that provider's
`whitelist` if it has one — the whitelist is an allowlist, so opencode deletes
the model from the provider without it and the agent silently resolves to
nothing — but it cannot invent a provider, and it never writes a whitelist you
did not already have: an absent one already allows every model the provider
offers.

Check what it did with the `pool_status` tool: it prints the resolved source,
each slot with its weight and live load, and which slot the next spawn takes.