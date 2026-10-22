# OmniRoute gateway integration

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is a local OpenAI-compatible gateway that routes a request across many providers with fallback and "combos". LaCode can register it as an opencode provider. It is **off by default**. The summary is in the [README](../README.md#configure); this page is the full reference, including a combo ordered for latency that is worth applying on a new client.

## Configuring OmniRoute

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is a local
OpenAI-compatible AI gateway (default `http://localhost:20128/v1`) that routes a
request across many providers with fallback and "combos". LaCode can register it
as an opencode provider for you. It is **off by default**: if you do not set
`omniroute.enabled: true`, nothing below happens and LaCode makes no request.

**Setting it up on a client machine.** Four steps, in this order:

1. Install OmniRoute, then make it stay up: run `omniroute autostart enable`
   once. That writes a systemd user unit in a headless session, or an XDG
   autostart entry in a graphical one, and OmniRoute supervises itself from
   there on. Its gateway listens on `http://localhost:20128/v1`. The gateway's
   lifecycle is **the client's responsibility**: LaCode never starts, supervises
   or stops it, it only probes it. The gateway must therefore already be
   running **before** you start opencode — one that is down at startup is
   disabled for that run, and the integration is per-run.
2. Add the plugin block to your opencode config:
   `["@lawaty/lacode", { "omniroute": { "enabled": true, "apiKey": "<your omniroute key>", "combo": "auto", "models": [] } }]`
   `auto` is the zero-config default, but on a free tier it often resolves to a
   slow chain. [A tested fast combo](#a-tested-fast-combo-free-mix) below is
   ordered for latency and is worth applying on a new client.
3. Optionally, to route pooled work through it, add an `omniroute/<id>` slot to
   `~/.config/lacode/pool.txt` exactly as you would any other provider. The
   integration gives it no special precedence, priority or weight — its place and
   weight in the pool are whatever you configure. `pool.txt` is optional user
   config; the bundled default preset does **not** include OmniRoute.
4. **Restart opencode.** Nothing here hot-reloads.

With `models: []` and `combo: "auto"`, the plugin registers exactly one model,
`omniroute/auto`, which then appears in the model picker for any agent — no
hand-maintained model list.

The full option set, for reference:

```jsonc
{
  "plugin": [
    ["@lawaty/lacode", {
      "omniroute": {
        "enabled": true,
        "baseURL": "http://localhost:20128/v1",
        "apiKey": "sk_omniroute",          // optional; OMNIROUTE_API_KEY overrides it
        "combo": "static-best-free",        // optional: let OmniRoute do the routing
        "models": ["cc/claude-sonnet-4-6", "gemini-3-flash"], // hard allowlist
        "tiers": {
          "primary": ["cc/claude-sonnet-4-6"],
          "backup": ["gemini-3-flash"]
        },
        "stickyPerSession": true,
        "healthCheck": true,
        "timeoutMs": 5000
      }
    }]
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Turns the integration on. |
| `baseURL` | `http://localhost:20128/v1` | Gateway base URL, normalised to exactly one `/v1`. |
| `apiKey` | — | Bearer key. **`OMNIROUTE_API_KEY` overrides this value.** The key is never logged. |
| `combo` | — | An OmniRoute combo id (or `auto`) to expose as a selectable model even though the gateway does not list it. It leads the provider's own model list — an OmniRoute-side detail, unrelated to pool order. |
| `models` | — | A **hard allowlist**: only these ids are ever exposed, even if the gateway lists more. |
| `tiers` | — | `{ "primary": [...], "backup": [...] }` preference order over models the allowlist already permits. |
| `stickyPerSession` | `true` | Keep a session on one model while that model is healthy. |
| `healthCheck` | `true` | Probe `GET /models` at startup; a failed check disables the integration for that run only. |
| `timeoutMs` | `5000` | Budget for LaCode's own probe and model-cache calls to the gateway. It is not written into the provider options, so it does not bound real traffic — opencode's own default applies there. |

An enabled but invalid block (bad `baseURL`, a non-array `models`, …) is rejected
as a whole: LaCode logs one warning naming the problem and continues exactly as
if the integration were off. It never crashes opencode.

**What it registers.** On the first `config` pass LaCode health-checks the
gateway, reads `GET /models`, filters it through your `models` allowlist (or
exposes everything the gateway lists when no allowlist is set), and writes a
`provider.omniroute` entry — `npm: "@ai-sdk/openai-compatible"` with your
`baseURL` / `apiKey` — so `omniroute/<model-id>` becomes selectable. If you
already have a `provider.omniroute` block, LaCode leaves it completely untouched
and warns; it also never adds a `whitelist`. Because opencode loads
`@ai-sdk/openai-compatible` itself, no extra dependency is installed.

**Combo vs. allowlist.** Set `combo` and OmniRoute does the fallback for you
(let it route): the combo leads the exposed models, so opencode can hand a failed
request to the gateway's own fallback chain. Without a combo, LaCode exposes the
allowlist ordered by `tiers` (primary first). Candidate order is `filterModels`
(combo first, then the hard allowlist) followed by `orderByTier`, and that is
all — LaCode picks which model is exposed and in what order; it does not measure
latency or error rate at runtime, and it does not skip a model because it
failed.

**Using OmniRoute in the pool.** The integration only *registers* the provider —
it never touches your pool, and it does not place a slot for you. To route pooled
work (exploration, implementation, cartography) through the gateway, add an
`omniroute/<id>` slot to your pool like any other model:

```
# ~/.config/lacode/pool.txt
omniroute/free-mix
opencode/big-pickle
opencode-go/beam-free
```

OmniRoute is a provider like any other: the pool decides its place and weight,
and neither the pool nor this integration gives it any built-in precedence or
priority — where it sits and how many turns it takes are whatever you configure.
Any `omniroute/<id>` works, provided the id is exposed — by `combo`/`models`, or
the whole catalog when neither is set. Because the plugin writes the pool
nothing, the only thing that changes when the gateway is down is that
`omniroute/<id>` fails; every other slot keeps working. See
[docs/USER-STORIES.md](USER-STORIES.md) US-28.


## A tested fast combo: `free-mix`

`combo: "auto"` is the zero-configuration default, but `auto` inherits whatever
the gateway chooses, and on a busy free tier that is frequently the slowest
chain available. The combo below is ordered for latency rather than for
breadth. Apply it during the "Setting it up on a client machine" steps above
and pooled work is usable straight away, instead of starting from a gateway that
queues for half a minute per call.

```jsonc
{
  "name": "free-mix",
  // Order decides. Do NOT use "weighted" here — weights let the gateway
  // re-shuffle a model that is returning 429 into first position again.
  "strategy": "priority",
  "models": [
    { "model": "gemini/gemini-3.1-flash-lite",                      "providerId": "gemini" },
    { "model": "gemini/gemini-3.8-flash",                           "providerId": "gemini" },
    { "model": "gemini/gemini-3.7-flash",                           "providerId": "gemini" },
    { "model": "gemini/gemini-3-flash-preview",                     "providerId": "gemini" },
    { "model": "openrouter/nvidia/nemotron-3-super-120b-a12b:free",  "providerId": "openrouter" },
    { "model": "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",  "providerId": "openrouter" },
    { "model": "openrouter/nvidia/nemotron-3.5-lightning:free",     "providerId": "openrouter" },
    { "model": "openrouter/cohere/north-mini-code:free",            "providerId": "openrouter" },
    { "model": "openrouter/poolside/laguna-s-2.1:free",             "providerId": "openrouter" },
    { "model": "openrouter/dots-studio/dots-3-note-preview:free",   "providerId": "openrouter" }
  ]
}
```

Why this order — it is the two free-tier failure modes, a hard reject and a
slow queue-budget timeout:

| Model | Behaviour on a busy free tier | Position |
| --- | --- | --- |
| `gemini/gemini-3.1-flash-lite` | succeeds on the large majority of calls, ~4.5s median | **first** |
| `gemini-3.8-flash` / `3.7-flash` / `3-flash-preview` | succeed intermittently, but **stall ~30s** on a `503` queue-budget timeout when they do not | next |
| `openrouter/*:free` | **mostly `429`**, but fail *fast* (~1.8s) and occasionally succeed | last, as a cheap final fallback |
| `gemini-2.5-flash`, `gemini-2.5-flash-lite` | **`404` on every attempt** — dead ids | **omitted entirely** |

The ordering matters because a combo pays for *every* step it walks past. Put the
reliable model first and the common case is a single hop; the 30s models sit
behind it where they cost nothing, and the 429s sit last where they give up in
under two seconds.

These free-tier endpoints change availability constantly, so treat the ordering
as a **starting point to re-measure, not a permanent truth**. Re-check it with
OmniRoute's own call logs before assuming it still holds:

```bash
# one timed request through the gateway
curl -o /dev/null -w '%{http_code} %{time_starttransfer}s\n' \
  -X POST http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"free-mix","messages":[{"role":"user","content":"Say OK"}],"max_tokens":10}'

# per-model status + duration, straight from OmniRoute's logs
python3 - <<'PY'
import json, glob, collections
d = "/home/<user>/.omniroute/call_logs/<YYYY-MM-DD>"
g = collections.defaultdict(collections.Counter)
for f in glob.glob(d + "/*.json"):
    try: s = json.load(open(f))["summary"]
    except Exception: continue
    g[s.get("comboStepId")][s.get("status")] += 1
for k, v in sorted(g.items(), key=lambda x: str(x[0])):
    print(f"{str(k)[:44]:44} {dict(v)}")
PY
```

Apply it with the bundled CLI (`PUT /api/combos/<id>` updates in place, so the
combo is never briefly missing):

```bash
omniroute api combos get-api-combos-id- --id <combo-id> --json > free-mix.json
# edit name/strategy/models in free-mix.json, then:
omniroute api combos put-api-combos-id- --id <combo-id> --body @free-mix.json
```

**A note on mid-session switching.** opencode 1.18.34 exposes no hook to change
an agent's main model mid-request, so LaCode cannot swap models inside a running
session; use an OmniRoute `combo` (or `auto`) if you want per-request fallback.
LaCode's selection engine decides which models are exposed and in what order, and
its cooldown/backoff rules are unit-tested.

**Getting a key.** Open the OmniRoute dashboard, go to API Manager / API Keys and
copy a key into `OMNIROUTE_API_KEY` (recommended) or `omniroute.apiKey`. On a
local instance with `REQUIRE_API_KEY=false`, the literal placeholder
`sk_omniroute` is accepted.

**Troubleshooting**

| Symptom | Cause | Fix |
| --- | --- | --- |
| `omniroute health check failed` at startup | Gateway not running, wrong `baseURL`, or a startup race | Start OmniRoute on `http://localhost:20128` and restart opencode; `omniroute autostart enable` makes that durable across restarts. The integration is disabled for that run only, not permanently. |
| `omniroute health check failed` at startup, then a repeating `cooling omniroute/<id> (hang)` and `Model not found` churn on one slot | OmniRoute was started *after* opencode, and `pool.txt` names an `omniroute/<id>` slot | The integration is off for that run, but the pool still routes to the slot: the request hangs, the reaper cools it for 600s, and the cycle repeats. Start OmniRoute, then restart opencode. |
| `ProviderModelNotFoundError: Model not found` on an id the gateway serves | The id is a valid OmniRoute route but is not in the plugin's `models` allowlist, so the plugin never exposed it | Add the id to `models`, or set it as `combo` — `combo` is registered whether or not the gateway advertises it, so a valid gateway route works there too. A valid gateway route is not automatically an exposed model. |
| `no usable models` | The gateway returned an empty list, or every id was filtered out by `models` | `curl -H "Authorization: Bearer $OMNIROUTE_API_KEY" http://localhost:20128/v1/models` and check `models`/`combo` against the returned ids. |
| `401` / `Invalid API key` | `REQUIRE_API_KEY=true` and the key is missing or wrong | Create a key in the dashboard, export `OMNIROUTE_API_KEY`, or set `REQUIRE_API_KEY=false` locally and use `sk_omniroute`. |
| `404` on a URL containing `/v1/v1/` | A `baseURL` that already carried `/v1` was given twice | LaCode normalises this, so it should not come from LaCode; check a hand-written `provider.omniroute` block, which LaCode leaves untouched. |
| Provider registered but models are missing | You already had `provider.omniroute` | Remove it and let LaCode write it, or add the models yourself — LaCode never modifies an existing provider. |
| Pooled work still runs on the bundled models | The gateway was unhealthy/disabled at startup, or you have no `omniroute/…` slot in your pool | Check the startup log for `omniroute health check failed` / `no usable models`, then add `omniroute/<model>` to `pool.txt` (or `pool.json`) to route pooled work through the gateway. |
