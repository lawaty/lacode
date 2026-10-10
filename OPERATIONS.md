# Operations runbook

Design and rationale live in [README.md](README.md). This file is the day-to-day
reference: what runs where, what needs a restart, how to check the pool is healthy,
and how the pieces are distributed.

## Components

| Path | Role |
|---|---|
| `presets/free-tier.json` | the bundled default pool: models and weights. Resolution chain: plugin `models` option > `~/.config/lacode/pool.json` > this file. See `presets/README.md` |
| `opencode.jsonc` | 21 agents (3 pooled bases + 12 hidden variants + 6 unpooled), permissions, provider whitelists. The 12 variants declare **no model**: it is injected from `presets/free-tier.json` |
| `src/lib/pool.ts` | shared state and the slot decision; imported by both plugins, exports no plugin |
| `src/lib/writer-rule.ts` | startup check that the one-writer permission rule actually fires; imported by `context-autoupdate.ts` |
| `src/plugins/agent-pool.ts` | task routing, limit detection, 30s hang reaper, `pool_status` |
| `src/plugins/context-autoupdate.ts` | keeps `.opencode/context/` current; borrows a pool slot |
| `.opencode/prompts/` | 7 prompts shared by 21 agents |
| `tests/` | 9 offline suites, no network, no running server |

## Health checks

```bash
opencode run "pool_status"          # live load, cooldowns, watchdog liveness
tail -f ~/.local/share/opencode/log/opencode.log | grep -E "routed|cooling|hung|reaper"
```

`pool_status` is the authoritative check. Three things to look for:

- `watchdog alive: last sweep Ns ago (every 30s)` — if this exceeds ~60s the reaper
  is not running and hung tasks will hold their slot. It is the only positive signal;
  the reaper logs nothing when it finds nothing.
- `COOLING` on a slot — expected during rate limiting, and the pool routes around it.
- `hung … auto-aborted` — the reaper recovering a wedged task. Fine occasionally;
  repeatedly means a model or provider is unhealthy.

Log lines worth knowing: `routed <base> -> <variant>` on every pooled spawn,
`borrowed pool slot N … for auto update` when the cartographer runs,
`reaper armed` once per process at startup.

## Changing the pool models

Edit `presets/free-tier.json` (or drop a `pool.json` in `~/.config/lacode/`, or pass `models` in the plugin tuple — the chain is documented in `presets/README.md`) — one entry per slot, array position is the slot number:

```json
{ "slots": [
  { "model": "opencode-go/longcat-2.5-preview-free", "weight": 3 },
  { "model": "opencode/space-bunny-free", "weight": 2 },
  { "model": "opencode/big-pickle", "weight": 1 },
  { "model": "opencode/longcat-2.5-preview-free", "weight": 1 }
] }
```

At most **4 slots**: `opencode.jsonc` declares one hidden variant per base per slot, so a
fifth entry would route spawns at an agent that does not exist. Entries past the fourth are
dropped with a warning, not silently ignored.

`weight` is a **soft ceiling on how many concurrent sessions one slot runs**, and that same
number is its priority. Two rules, in order:

1. the **highest-weight slot still under its ceiling** takes the spawn, so the main model
   gets its 3 sessions to itself before slot 2 sees any work
2. once **every** slot is at its ceiling, the overflow goes to the least loaded slot, so a
   burst past the summed ceilings equalises instead of piling up or blocking

So `3,2,1,1` produces `1,1,1,2,2,3,4,…` — ordered preference, with the bottom of the list as
reserve. Weights are dynamic and deliberately unequal, so this is never a share calculation:
a slot either has room under its ceiling or it does not. Equal weights give a round robin in
list order, and `2,2,1,1` reproduces the old primary/overflow cycle exactly.

Raise a weight to let a model run more sessions at once, lower it to make it more of a
reserve. No weight means `1`; anything that is not a number in `(0, 100]` warns and means `1`.
The old `tier` key is still read as a deprecated alias — `primary` is weight 2, `overflow` is
weight 1 — with a warning, so a host that has not picked up this file keeps two slots' worth
of headroom.

Do **not** also edit the variant agents in `opencode.jsonc` — they carry no `model` on
purpose. The plugin's config hook writes `<base>-<slot>` for `explore-fast`,
`implement-fast` and `context-manager` from this file, and adds any missing provider
whitelist entry. A `model` that reappears on a variant is stale: the plugin logs
`still hard-codes … presets/free-tier.json wins` on every start.

Keep the provider configured in `opencode.jsonc` and the models free and tool-call
capable — check with `curl -sS https://models.dev/api.json` or `opencode models
<provider>`. Then restart every opencode process and confirm what is actually live:

```bash
opencode debug agent explore-fast-1   # model it resolved
opencode run "pool_status"            # slots, load/weight, ceilings, cooldowns
```

Failure modes are logged, never silent: a bad entry (no `provider/model-id`, a repeated
model, a fifth slot) is dropped with a warning and the other slots still route; a bad
`weight` is only a preference, so it warns and keeps the slot at weight 1; a file that
yields nothing usable falls back to the built-in defaults. All of them appear in the log as
`presets/free-tier.json …`, so check
`tail -f ~/.local/share/opencode/log/opencode.log | grep pool-models` when a spawn
resolves to the wrong model or lands on an unexpected slot. If the plugin is disabled
(`opencode --pure`) the variants have no model at all and inherit the session's — check the
plugin is loading before debugging a wrong model.

## Restarts

**Plugins are not hot-reloaded.** Any change to `presets/free-tier.json`, `opencode.jsonc`,
`src/lib/`, or `plugins/` requires restarting every opencode process. Servers are foreground processes with no
systemd unit or tmux session, so each is restarted from its own terminal.

This bites in a specific way: a config change is invisible until restart, so a fix can
look applied and still not be running. Swapping a pool model is where it matters most:
the file says one thing, a long-running server keeps routing to the old one. Always check `ps -eo pid,lstart,comm | grep opencode`
against the file mtime before concluding a change is live.

## Why opencode.jsonc is ~800 lines

Audited, and most of it is structural rather than redundant:

- **12 of the 21 agents are pool variants** (`explore-fast-1..4`, `implement-fast-1..4`,
  `context-manager-1..4`). Each must be a distinct agent because each must resolve a
  distinct model, and opencode has no agent inheritance, so each repeats its base's
  prompt and permission block. Generating them from the plugin does not work: an agent
  created in the `config` hook is not registered by opencode (`opencode debug agent` for
  a hook-created name returns "not found"), which is why they are declared here.
- **Task rules use globs** (`explore-fast*`), because opencode compiles a permission
  pattern to an anchored regex with `*` → `.*` and the longest match wins. Listing all
  four variants per base meant adding a line to two agents for every new slot.
- **The models are not here at all** — `presets/free-tier.json` owns them and the plugin
  injects them.
- Playwright stays: the explore and implement agents may drive a browser even though
  no prompt says so. The per-agent grant uses the deprecated `tools` field on purpose.
  The schema points at `permission`, but `permission` has no entry for MCP tools, and
  `opencode debug agent` never lists MCP tools at all -- so neither it nor the schema can
  confirm a working grant. Verified end to end instead: `explore-fast-3` reports all 26
  `playwright_browser_*` tools, and the top-level `tools.playwright_*: false` keeps them
  away from every other agent. This grant lives here, in this file, and must stay here:
  opencode folds `agent.tools` into the permission list at config-load time, while
  decoding the config, so a `tools` value a plugin writes from its `config` hook is never
  read by anything. Do not move it into `src/agents.ts` -- see the NOT INJECTED note in
  that file's header.
- `explore`, `general` and `implement` are disabled. These are opencode's built-in
  generic subagents; they would always be spawnable, cost a full-price model, and bypass
  `explore-fast*` / `implement-fast*` entirely. Only `basic`, `expert`, the pool bases and
  their variants, and the deep agents remain. `pool-test.mjs` pins this, so an opencode
  upgrade that reintroduces a built-in fails there rather than quietly doubling the
  delegation paths.
| `bin/oc`, `bin/oc-sync` | the `oc` launcher and the deploy script, both in the repo; `~/bin/oc` and `~/bin/oc-sync` are symlinks to them |
| `.env` / `.env.example` | host list and deploy overrides — `.env` is gitignored, `.env.example` documents every variable |
| `~/.local/share/opencode/agent-pool/` | live cross-process claims + cooldowns |
| `~/.local/share/opencode/auth.json` | credentials — deliberately **outside** this repo |
| `.opencode/context/` | this project's context map — derived, not in git (see below) |

## Deploying to the other hosts

```bash
bin/oc-sync                    # every host in $OC_HOSTS, config included
bin/oc-sync --dry-run          # preview, writes nothing
bin/oc-sync --host <alias>     # one host
bin/oc-sync --scripts-only     # only `oc`, NOT the config
```

Pushes `oc`, `oc-notify`, the tunnel key, `opencode.jsonc`, `src/`, `presets/`, `plugins/`,
`.opencode/`, `AGENTS.md`, `commands/`, `rules/` — with a remote backup first.

**The config is the default, not an opt-in.** Plain `bin/oc-sync` used to ship only `oc`,
which meant a fix to `AGENTS.md` stayed on this machine while hosts kept the old rules.
The run looked successful. Use `--scripts-only` when you genuinely want just the
launcher.

**`AGENTS.md`, `commands/` and `rules/` are not optional extras.** `AGENTS.md` is the
global instruction file opencode auto-loads into every session, and `commands/` +
`rules/` are what it points at. A host missing them runs agents that were never told
`.opencode/context/` exists, and they will report skipping the map while claiming the
protocol was loaded. That is exactly what happened: one host carried a 368-byte stub
`AGENTS.md` claiming the protocol arrived via `instructions` in `opencode.jsonc` — a key
that was never added — while another had no `AGENTS.md` at all. Both were in git and in
`OPERATIONS.md`, so the bug was invisible locally. If a host's agents ever deny reading
the map, diff the remote's `AGENTS.md` byte count against the local one before touching
anything else.

A failed transfer is a failure, not a detail: every rsync's exit status is checked
before its output is filtered, and the host is listed under `failed` with the
directory left behind so you know what state it is in. `--dry-run` writes nothing at
all, locally or on the remote — it reports the `~/bin` PATH line, `OC_LOCAL_USER` and
`authorized_keys` entries it *would* add. `.opencode/context/` is excluded from the
transfer: it is the derived map of whatever projects a host works on, so each host
regenerates its own.

`oc-sync` passes `ClearAllForwardings=yes` to every ssh and rsync it makes. Each of its
~12 calls per host would otherwise compete for the tunnel ports and print `remote port
forwarding failed`; a half-claimed listener can also block the session that actually
needs the tunnel to notify you. The script itself never needs a forward — the
`oc-tunnel@<host>` units below hold those, and they are the only thing that should.

### Desktop notifications from a remote session

A notification raised on a host has to travel back to the desktop. The desktop is
behind NAT, so a direct ssh back times out and the return path must be a reverse
tunnel — but *who owns that tunnel* is the part that used to be wrong.

`oc-sync` installs one **systemd --user unit per host**, `oc-tunnel@<alias>`, holding
`ssh -N -T -R <port>:localhost:22 <alias>` with `Restart=always` and `enable-linger`.
Each host gets its own port, derived from its name. On the desktop side the
provisioning is the same as before: a dedicated `~/.ssh/oc_notify` keypair (never your
personal key — this private half is on every host) whose `authorized_keys` entry
carries `restrict` plus `command=`, so a host can raise a notification and nothing
else.

```bash
systemctl --user status 'oc-tunnel@<alias>'   # is the tunnel up?
cat ~/.config/opencode/remote.env             # this host's desktop user + port
```

Four things that each broke this before, worth knowing if it fails again:

- **The tunnel must not belong to a login session.** It used to be a
  `RemoteForward` line in `~/.ssh/config`, so the listener existed only while whichever
  ssh connection won the port race was alive. On dev-host a session started at 13:54
  and the tunnel's owner at 15:19: five tasks finished in between and notified a port
  that did not exist. Nothing said so, because the local end is a forced command — it
  simply had nothing listening. The unit fixes the lifetime; `oc-sync` now removes the
  config lines (backed up to `~/.ssh/config.ocsync-backup`) so they cannot win the port
  back and then drop it when you close that terminal.
- **The desktop user must not come from the rc files.** `OC_LOCAL_USER` is exported
  from `.bashrc`/`.profile`, which covers an interactive ssh and nothing else. The
  notify plugin calls `oc-notify` as a *detached child of an already-running server*,
  so it was unset, the fallback was `id -un` = `root`, and the hop died with
  `root@localhost: Permission denied (publickey,password)`. Hence
  `~/.config/opencode/remote.env`: readable by anything, rewritten on every sync. `oc`
  refuses to guess a username rather than produce a confusing publickey failure.
- **The dbus path must be the *local* uid.** The old script built the notify command on
  the host, where `id -u` is `0` for root, producing `/run/user/0/bus` — which does not
  exist on the desktop. Every notification vanished silently.
- **One alias per machine in `.env`.** `dev-host` and `192.0.2.10` are the same host;
  listing both installs two units and flaps `remote.env` between ports on every sync.

Verify end to end, in the *worst* environment — a bare env is exactly how the plugin
calls it, so if this passes the plugin's path works:

```bash
ssh <alias> 'env -i HOME="$HOME" PATH=/usr/bin:/bin SSH_CLIENT="1.2.3.4 0 22"   setsid ~/bin/oc-notify "tunnel check" "post-sync smoke"'
```

No output means it landed. A failure now says which of the three things is missing.
See `tests/oc-test.mjs` for the checks that keep this wired.

### When a session needs you

`src/plugins/notify.ts` raises a notification when a session needs you, named after the
session, so a long task does not need a watched terminal. It is auto-discovered from
`plugins/` — no config entry — and the policy lives in `src/lib/notify.ts`, pure and
testable without a running server.

```
opencode — Fix the login redirect     Task finished, waiting for your review
opencode — Deploy run                  Awaiting your response — Which option?
opencode — Deploy run                  Failed                        (critical)
```

Both are about what *you* must do, not about what opencode did. "Session finished" was
the old wording and it overstated things twice over: the session is still open, and
there was no name on it.

What is deliberately **not** notified:

- **Session start.** It interrupts to say nothing — no result, no title, nothing to act
  on. A notification you learn to dismiss on sight is one you dismiss when it matters.
  `oc` no longer sends one either.
- **Subagents.** `parentID` is set, so ten delegated `explore-fast` children raise
  zero notifications. The value is one notice per thing you asked for.
- **The cartographer.** `context-autoupdate` spawns `context-manager` through the
  session API with no `parentID`, so it is indistinguishable from a root session by
  structure alone; it is matched by title prefix instead. Without this, every file
  edit would announce the map update.
- **Compaction.** It idles the session but no task finished.
- **Sessions that never went busy.** Opening opencode is not completing work.
- **The idle that follows a question.** The task is parked, not finished, so it is one
  blocked moment reported once — and once you answer, the real completion notifies again.

A 5s cooldown per session per outcome absorbs queued-message and retry bursts. Two
outcomes exempt themselves: **errors**, and **questions** — both report a session that
is *blocked*, and gating those on a cooldown strands you on a prompt you were never
told about.

Delivery goes through `bin/oc-notify`, spawned detached so a notification can never
hold the server open, and there is deliberately no second implementation of the return
trip. **`oc-notify`'s exit status is the delivery signal**, and the plugin only logs
`notified` when it is genuinely zero with empty stderr. That is the check that would
have caught this section's first two bugs: both produced `message=notified` in the log
while nothing reached the desktop.

Restart opencode to load a plugin change; plugins are not hot-reloaded. A long-running
session on a host keeps the old plugin until it is restarted.

**Host details live in `.env`, not in the repo.** The repo is public, so `bin/oc-sync`
carries no names, addresses or usernames: it reads `OC_HOSTS` (whitespace, comma or
newline separated) and optional overrides from `.env`, which `.gitignore` keeps out of
git. `.env.example` is the template. With no `.env`, the script falls back to the legacy
`~/.oc-hosts`. `.env` is sourced before the script's defaults, so it wins over exported
variables. `~/bin/oc` and `~/bin/oc-sync` are symlinks into the repo, so both spellings
work.
Two ordering and scope rules that are easy to get wrong:

- **`src/` must land before `plugins/`.** The files in `plugins/` are one-line
  re-export shims over `src/plugins/`, and those import `../lib/`; a plugins-first sync
  leaves them unable to resolve on next restart. `presets/` must land too, or the host
  silently falls back to the pool's built-in defaults instead of the intended models.
- **No module under `src/` may export a plugin except `src/index.ts`.** opencode calls
  every export of every file in `plugins/` as a plugin and uses the return value as a
  hooks object, so a helper left there is a broken plugin. One did exactly that
  (`verifyWriterRule`) and opencode stopped starting. The published package follows the
  same rule with a single entry point that merges the three hook factories.
- **`node_modules`, `package-lock.json`, and `tests/` are not synced.** Each host keeps
  its own install and SDK version. Consequence: the `1.18.34` pin in `package.json` is
  **not** enforced anywhere — it is documentation, not a constraint. Verify the SDK
  version on a host before assuming parity, and keep it equal to that host's opencode
  binary version.

Remotes are plain rsync copies with no `.git`, so they carry no history. Local is the
only place edits are made; a remote-side change is untracked and will be overwritten by
the next sync.

## The context map

`context-autoupdate` maintains a five-file map per project at `.opencode/context/`,
resolved from the session's own directory (`path.resolve(directory)`). So
`/home/yourname` gets `~/.opencode/context/`, and a different project gets its own.

It is deliberately **not** in git and **not** synced to the other hosts. The map is a
derived artifact — an index regenerated from the source by `context-manager`, not source
itself — and it is scoped to one machine's filesystem. Syncing it would push a
description of this host's projects onto hosts that have different ones, and committing it
would churn on every session that touches a file. Git holds the rules that generate it
(`AGENTS.md`, `commands/context-*.md`, `rules/browser.md`, the plugin, the tests) and all
of those now ship to the remotes; the map itself is rebuilt on demand by the next
cartographer run.

There is no `rules/context-protocol.md` anymore. It duplicated the global `AGENTS.md`
while nothing loaded it, so it was deleted; `rules/browser.md` survives because its
Playwright anti-loop rules exist nowhere else and are now loaded through the
`instructions` key in `opencode.jsonc`. The context map is deliberately **not** in
`instructions` — that would inject all five files into every session and every pooled
subagent, defeating the read-one-file rule `AGENTS.md` states.

Trigger: a root session goes idle after editing files outside the map. It borrows a pool
slot, spawns `context-manager`, and applies changes. `context-manager` is the single
writer; other agents read the map but never write it.

Two operational rules:

- **A `finished` log line is not evidence the map changed.** A run blocked from writing
  resolves identically to a successful one. The plugin now reports `changed: N`, counts
  files that actually moved on disk, and warns at `changed: 0`.
- **If the map goes stale, check the one-writer permission rule first.** opencode evaluates
  file permissions against the path **relative to the project root**, not the absolute path
  the tool was handed — a write of `/repo/.opencode/context/architecture.md` is evaluated as
  `.opencode/context/architecture.md`. Patterns are anchored, so neither spelling covers
  every project on its own: `.opencode/context/**` fires for a normally-rooted project but
  not when the project root is `/`, and `*/.opencode/context/**` fires *only* when it is.
  **Both are required.** A relative-only rule was silently broken first; "fixing" it to the
  absolute form (`6f6af0a`) silently broke it again, because the detector was checking the
  absolute path too. `src/lib/writer-rule.ts` now checks the form that applies to the running
  project's root and logs an error naming the offending rule; `tests/permission-test.mjs`
  pins both directions, including against the real `opencode.jsonc`.

Force a run with `/context-update` rather than waiting for the idle trigger.

## Version control

This repo (`~/.config/opencode`) is a git repository, public at
`github.com/lawaty/lacode`, tracking `origin/master`.

Not covered by git:

- **The context map** (`~/.opencode/context/`) — intentionally outside git and not synced.
  Derived, per-project, and rebuilt on demand; see [The context map](#the-context-map).
- `~/bin/oc-hosts` and `.env` — host-specific, deliberately outside version control.
  `bin/oc-sync` reads the host list from `.env`; `~/.oc-hosts` remains only as a
  fallback for when `.env` is absent.
- The remote hosts — rsync copies, no history.

Before publishing anything here, note that the repo is **public**: treat every tracked
file as public. Keep host names, IPs, and credentials out of it, and keep `auth.json`
in `~/.local/share/opencode/` where it is.

## Troubleshooting

**A pooled spawn went to an unexpected model.** Read the `routed` log line for the `slot=`,
`weight=` and `ceiling=` fields, then check for a `limit.<provider>__<model>.json` file — a
stale one with a future `until` will keep diverting work. If the model is right but the slot
is not the one you expected, that is the weight: routing takes the heaviest slot still under
its ceiling, not the emptiest one.

**Everything routes to one provider.** Check for `limit.*.json` files cooling the other.
A provider-wide `free_tier_limit` cools every slot on that provider at once, which is
intentional: the alternative is a hang.

**The map is stale / the cartographer reports success but nothing changed.** Look for
`context map is not writable` in the log first, then confirm the map files' mtimes.

**Suspected hang.** Run `pool_status`. If a claim is older than 5m with 3m of silence it
is aborted automatically within ~30s; if the watchdog line shows no recent sweep, restart
the process — the timer is not running.

**A plugin change appears to have no effect.** It is almost certainly not reloaded. Check
process start time against file mtime.