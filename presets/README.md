# Pool presets

A preset is the pool's slot list: which models your pooled subagents share, and
how many concurrent sessions each one gets. It is one JSON file.

## Resolution chain

LaCode reads the first source that yields usable slots, in this order:

| # | Source | Where |
|---|--------|-------|
| 1 | plugin options | `["@lawaty/lacode", { "models": { "slots": [...] } }]` |
| 2 | user config | `~/.config/lacode/pool.json` |
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

Nothing is hot-reloaded. Change a preset, then restart every running opencode
process.

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
| `weight` | no | soft ceiling on concurrent claims, and priority. Absent = 1 |

`$comment` is a JSON-legal array of strings and is ignored by the loader; the
bundled preset uses it to explain itself in place.

## Validation — structure only

The loader checks shape and nothing else:

- `slots` must be a non-empty array
- each `model` must contain a `/`
- models must be distinct across slots
- `weight` must be a number in `(0, 100]`; a bad one **warns and uses 1** rather
  than dropping the slot, because losing a model to a typo in a count costs real
  capacity
- at most `MAX_SLOTS` (4) slots; extra entries are **dropped with a warning**,
  because one hidden variant agent per base per slot exists and a fifth slot
  would route at an agent that does not exist
- `tier` is accepted as a deprecated alias for `weight` (`primary` → 2,
  `overflow` → 1) and warns

**Cost is never validated.** Any provider/model-id string is accepted, including
paid and proprietary models. There is no free-tier allowlist anywhere in the
package — a preset of frontier models is exactly as valid as the bundled one. The
bundled preset is built from 0/0-cost models because that is a good default, not
because the pool requires it.

## Weight, precisely

A weight is a count of concurrent sessions, used as both a ceiling and a
priority:

1. the **highest-weight** slot still under its own ceiling takes the next spawn
2. so slot 1 fills to its number before slot 2 sees any work at all
3. once **every** slot is at its ceiling, overflow goes to the least loaded slot —
   a burst past the summed ceilings degrades to even spreading and never blocks

Equal weights give a plain round robin in list order. List order is the
tie-break, so put the models you want busiest first and treat the bottom of the
list as reserve capacity.

Spreading at least two providers across the slots is worth doing deliberately: a
provider-wide rate limit takes out every slot on that provider at once.

## Writing your own

Copy `free-tier.json`, change the slots, and put it at
`~/.config/lacode/pool.json` — or skip the file entirely and pass `models`
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