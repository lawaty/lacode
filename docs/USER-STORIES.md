# LaCode — User Stories

> Ultimate opencode setup for Go users

Every story below is a behavioural contract, not a feature wish. Each one is
traceable to a pain point the author actually hit, and each carries acceptance
criteria written so that a test can assert them mechanically. Every row of the
Coverage table has a test file.

**Reading the criteria.** Every criterion is written as *Given … When … Then …
* so that it maps to one test case. "Given" is a state or fixture, "When" is a
single action (usually a hook invocation or a script run), "Then" is an
observable result — a routing decision, a file on disk, an exit status, a log
line. Criteria that cannot be observed without a running server are not in this
document; everything here is testable offline with a stub client and a
`mkdtempSync` state directory.

**Terminology.** A *slot* is one entry in `presets/free-tier.json`, carrying a
model and a `weight`. A *base* is a pooled agent type (`explore`), and its slot
holders are `<base>-<slot>`, hidden in `opencode.jsonc`. A *claim* is a running
spawn recorded in `claims.<pid>.json`. A *context map* is the five-file
`.opencode/context/` codemap described in Epic G.

---

## Epics and the pains behind them

| Epic | Pain point it solves |
| --- | --- |
| **A — Cost control** | Quota exhaustion. Routine work (grep, reading, cartography) consumes the same expensive budget as design work, and the main model is spent on file listing. |
| **B — Provider resilience** | Provider limits. Free-tier quotas are per-provider and per-minute, so a long session hard-fails the moment one provider's window closes, even while three other providers sit idle. |
| **C — Hang recovery** | Hangs. A wedged or silently-stalled subagent holds its slot forever; one bad task stalls the session with no error and no timeout. |
| **D — Notifications** | Parallel sessions. With several sessions open, work finishing — or a question blocking — is invisible unless you happen to be looking at that terminal. |
| **E — Remote hosts** | Remote SSH notification. Work runs on remote hosts, so notifications raised there die on that host's nonexistent desktop instead of reaching the local one. |
| **F — Adoption and safety** | Installability. A personal config cannot be adopted safely: it either clobbers what you already have, or needs manual surgery before it runs. |
| **G — Context and cost** | Cold exploration. Every task starts by re-discovering the structure of the codebase from scratch, so the same layout is re-read — and re-paid for — on every single run. |

---

## Epic A — Cost control (route bulk work off the expensive model)

### US-1: Bulk exploration runs on cheap/free subagents
**As an** opencode user paying per token, **I want** file reading and searching delegated to cheap subagents, **so that** my main model's budget goes to design work instead of grep.

**Story ID(s) for tests:** US-1
**Acceptance criteria:**
- [ ] Given the root agent `build` with read/glob/grep denied, When a read-family tool is invoked, Then the call is denied and the agent is pointed at an exploration base rather than executing inline.
- [ ] Given a pooled base such as `explore` is spawned, When the plugin rewrites the spawn, Then the concrete model selected is a slot declared in `presets/free-tier.json`.
- [ ] Given a pool whose slots are all zero-cost, When N exploration spawns run, Then none of them is dispatched to a paid model.

### US-2: One knob selects the exploration/implementation model
**As a** user, **I want** to change which model handles delegated work without editing prompts, **so that** I can change cost strategy in one place.

**Story ID(s) for tests:** US-2
**Acceptance criteria:**
- [ ] Given the pool preset is edited to swap a slot's model, When a pooled spawn is routed, Then the new model is used with no change to any agent prompt in `opencode.jsonc`.
- [ ] Given `opencode.jsonc` hard-codes a model for a pooled agent, When the plugin boots, Then it warns that the hard-coded value is overridden and that `presets/free-tier.json` wins.
- [ ] Given a slot declares an invalid `weight`, When the pool loads, Then it falls back to weight 1 and warns, rather than dropping the slot.

### US-3: Reproducible cost benchmark
**As a** maintainer, **I want** a script that measures the token/cost of a representative task with and without the pool, **so that** any savings claim is measured rather than asserted.

**Story ID(s) for tests:** US-3
**Acceptance criteria:**
- [ ] Given the benchmark script is run against a fixed task prompt, When it executes, Then it reports token counts and cost for the pooled run and the unpooled run from the same input.
- [ ] Given a slot's model is free, When the benchmark prices it, Then its cost is 0 rather than unknown or omitted.
- [ ] Given the benchmark runs with no network access, When it cannot reach a pricing source, Then it fails loudly instead of reporting 0 cost for a paid model.

### US-23: The pool takes any model; free is the shipped default, not an enforced rule
**As a** user, **I want** the pool to accept whatever models I give it and only default to free ones, **so that** I keep full control of what the pool runs on instead of being second-guessed about it.

**Story ID(s) for tests:** US-23

This is the policy behind US-1 and it does not contradict US-7. The pool exists to take **mechanical** work — reading, searching, mechanical edits, cartography — off the main model, so the bundled preset ships free models: that is what those tokens cost when you have not said otherwise. It is a **default, not a restriction**. LaCode holds no opinion about which models a user may run: no whitelist, no filter, no per-model rule beyond the structural `provider/model-id` shape a slot must have to be addressable at all. There is no cost advisory either — a plugin that guesses what a model costs from a pinned snapshot it does not ship would be advisory theatre, so the shipped default is expressed once, in `presets/free-tier.json`, where a user reads it and edits it.

The reconciliation with US-7 is that **acceptance and endorsement are different claims**: the pool accepts anything, and the preset states what it is for.

**Acceptance criteria:**
- [ ] Given the bundled preset, When its slots are priced against the pinned models.dev snapshot, Then every slot is free or very cheap, and any slot the snapshot cannot price is named as unknown rather than assumed to be free.
- [ ] Given a pool configured with any arbitrary `provider/model-id` string — a paid one, an exotic one, an invented one — When the plugin boots and a spawn is routed, Then the model binds verbatim and runs, with no warning about it, no rejection of it, and no special-casing of it.
- [ ] Given the shipped preset, When a user reads it, Then it says the pool is for mechanical work, and says they MAY substitute their own list via `~/.config/lacode/pool.json`, so the free default never reads as a prohibition.
- [ ] Given no price information exists for a configured model, When the plugin boots, Then it is silent: the pool does not inspect, fetch, or infer prices at all, because a default is expressed in the preset and not enforced at runtime.
- [ ] Given a paid or exotic model is configured in the pool, When a spawn is routed, Then it is routed to that model exactly as any other slot would be, because rejecting it would break US-7.

---

## Epic B — Provider resilience (weighted model pool)

### US-4: Automatic failover when a provider rate-limits
**As a** user on free tiers that hit per-provider limits, **I want** subagents to move to a different provider automatically, **so that** long sessions do not fail.

**Story ID(s) for tests:** US-4
**Acceptance criteria:**
- [ ] Given a spawn fails with a rate-limit-shaped error, When the error is serialized and matched, Then the offending model is marked cooling and a cooldown file is written for it.
- [ ] Given model A is cooling, When the next spawn is routed, Then the pick is a different model and the spawn is never refused outright.
- [ ] Given every model is cooling, When a spawn is routed, Then the least-loaded slot is chosen anyway (degrade, never block).
- [ ] Given a limit error names a reset time, When the cooldown is recorded, Then the stated reset is used instead of a guessed backoff.

### US-5: Weighted round-robin gives every slot a turn per cycle
**As a** user, **I want** weights to say how many turns each slot takes per rotation cycle, **so that** no provider is drained to its limit while the others sit idle.

**Story ID(s) for tests:** US-5
**Acceptance criteria:**
- [ ] Given a heavy slot and a light slot, When spawns are routed below both ceilings, Then the rotation walks the list in order with each slot taking as many consecutive turns as its weight says, rather than the heavy slot being filled and refilled first.
- [ ] Given a slot is at its ceiling (twice its weight) or cooling, When its turn comes up in the rotation, Then the turn is skipped and the rotation resumes at the following turn.
- [ ] Given every slot is at its ceiling, When another spawn is routed, Then it goes to the least-loaded slot as overflow.
- [ ] Given all slots carry equal weight, When spawns are routed, Then the picks round-robin in declaration order.
- [ ] Given per-slot load is read, When it is asserted, Then a slot's load never exceeds its ceiling (twice its weight) except by overflow.

### US-6: Live pool visibility
**As a** user, **I want** to see per-slot load and which model is cooling and why, **so that** I understand where my subagents are going.

**Story ID(s) for tests:** US-6
**Acceptance criteria:**
- [ ] Given claims are held by several processes, When the status view is requested, Then it shows every process's claims and the aggregate load per slot.
- [ ] Given a model is cooling with a stated reason, When the status view is requested, Then the model is listed as cooling together with that reason.
- [ ] Given a claim file is older than the dead-file threshold, When the status view is computed, Then the stale claim is pruned rather than counted.
- [ ] Given a slot is at its ceiling, When the status view is requested, Then it is not marked as the slot the next spawn would take, because the rotation's turns are skipped for a full slot until it frees a claim — unless no other slot is available and under its ceiling, in which case that full slot is the next one.

### US-7: Non-free models still work
**As a** user who wants a paid model in the pool, **I want** to supply any model list, **so that** the pool is not restricted to free tiers.

**Story ID(s) for tests:** US-7
**Acceptance criteria:**
- [ ] Given a slot names a paid model, When the pool loads, Then the slot is accepted and routed to without a free-tier filter rejecting it.
- [ ] Given a model id contains a vendor prefix with slashes (e.g. `openrouter/nvidia/model:free`), When it is split into provider and model id, Then the split is on the first slash only and the id tail is preserved.
- [ ] Given more slots are declared than the pool allows, When the pool loads, Then the surplus entries are dropped with a warning naming the cap.
- [ ] Given a provider configured with **no** `whitelist` key, When the config hook binds a slot on that provider, Then no `whitelist` is written for it, because an absent whitelist already allows every model the provider offers.
- [ ] Given a provider the pool never names a slot on, When the config hook runs, Then that provider entry is left exactly as it was, with no `whitelist` key added.
- [ ] Given a provider that already carries a `whitelist`, When the config hook binds a slot model on it, Then the model id is appended and every entry the user wrote is preserved in order.
- [ ] Given any provider after the config hook has run, When its whitelist is inspected, Then it is either absent or non-empty, because an empty allowlist names no model at all and opencode deletes the provider outright.

`provider.<name>.whitelist` is an **allowlist**, not a to-do list: opencode
deletes every model a provider offers that the whitelist does not name, and
deletes the provider itself if nothing survives. An absent whitelist is the open
form — everything is allowed. That makes writing one where the user had none the
single most destructive thing the plugin could do, since a list holding only the
pool's models silently deletes everything else they run there. So appending is
correct exactly when a whitelist exists (it is a real restriction, and the pool
models would otherwise resolve to nothing) and is not merely unnecessary when one
does not.

### US-28: A local gateway (OmniRoute) is registered as an ordinary provider
**As a** user running a local OpenAI-compatible gateway, **I want** LaCode to register it so its models are selectable and I can name one in my pool, **so that** *I* decide whether pooled work drains through it instead of the bundled models.

**Story ID(s) for tests:** US-28
**Acceptance criteria:**
- [ ] Given `omniroute.enabled` with a reachable gateway, When the config hook runs, Then LaCode registers a `provider.omniroute` entry exposing the gateway's models (everything it lists, or filtered by `models`/`combo`), and writes NOTHING into the pool.
- [ ] Given any pool source (bundled preset, `pool.json`, `pool.txt`, or `options.models`), When OmniRoute is enabled and healthy, Then every slot resolves exactly as it would without the integration — the slot list is unchanged, so opting in means the user lists `omniroute/<model>` themselves.
- [ ] Given a pool slot naming an `omniroute/<model>`, When the pool resolves and binds, Then that slot routes as an ordinary slot, and the pool does not warn the provider is missing, because OmniRoute registers the provider before the pool's config hook runs.
- [ ] Given OmniRoute is disabled, enabled with an invalid block, unhealthy, or returns no usable models, When the config hook runs, Then no provider is registered, no pool slot changes, and a failure is warned about once.
- [ ] Given the gateway is unreachable, When pooled work runs, Then the only thing affected is a slot that names `omniroute/<model>`; every other slot keeps working, because the plugin never put an `omniroute` slot in the pool.

### US-31: A limit that hangs is killed, and the retry lands on a slot that answers
**As a** user whose provider has run out of allowance, **I want** the stalled task killed and the retry sent to a slot that is not on cooldown, **so that** one exhausted provider does not strand the session.

A limit does not always arrive as an error. Sometimes the provider accepts the request and then says nothing, and opencode keeps retrying the refused model — so the task is neither done nor failed, and the session waits on a provider that has already said no. The plugin has to end that wait itself: abort the stalled session, cool the model that was refused, and let the retry pick a slot that answers. When the provider names itself, the whole provider is benched; when it does not, only the model the session was running on is cooled — that is the one the refusal is evidence about.

**Story ID(s) for tests:** US-31
**Acceptance criteria:**
- [ ] Given a pooled session's provider reports a limit in a retry status that names no provider, When the status is handled, Then the model that session is running on is cooled and a cooldown file is written for it.
- [ ] Given a pooled session reports a limit and then goes silent, When the limit is handled, Then that session is aborted and its claim is released, so the slot is not held by a task that will never answer.
- [ ] Given the refused model is cooling, When the caller retries the spawn, Then the retry is routed to a different slot whose model is not on cooldown.
- [ ] Given a limit names its provider, When the limit is handled, Then every slot on that provider is cooled and a slot on another provider is not.
- [ ] Given a limit-shaped error whose text is exactly `limit reached` and which carries no status code, When the error is matched, Then the model is cooled and the in-flight session is aborted.
- [ ] Given an error whose text is `context limit reached`, When the error is matched, Then nothing is cooled and nothing is aborted, because a prompt that is too long is not a provider quota.
- [ ] Given a session stalls with no limit signal at all, When the reaper sweeps, Then the session is aborted, its model cooled, and the next spawn routes to a slot that is not on cooldown.
- [ ] Given a provider reports a transient upstream outage rather than a limit, When the status is handled, Then the model is cooled for one short flat window instead of the quota window, and the session is still aborted, because an outage lifts on its own and must not bench a healthy model.
- [ ] Given a transient outage was cooled, When the same model later fails with a real limit, Then the cooldown starts at the first strike rather than an escalated one, because an outage lifts on its own and must not make the next quota window longer.

---

## Epic C — Hang detection and auto-recovery

### US-8: Wedged subagent is detected and aborted
**As a** user with many parallel sessions, **I want** a silent or stuck subagent killed automatically, **so that** one bad task cannot stall my session forever.

**Story ID(s) for tests:** US-8
**Acceptance criteria:**
- [ ] Given a claim has exceeded its TTL and produced no recent activity, When the reaper sweeps, Then that claim's process is aborted.
- [ ] Given the reaper is idle, When its timer interval elapses, Then a sweep runs on its own, and a sweep also runs on the next pooled spawn without waiting for the timer.
- [ ] Given a claim is young and active, When the reaper sweeps, Then it is left alone.
- [ ] Given a claim is swept, When the sweep completes, Then the total reaped count increases and a greppable log line names the reaped claim.

### US-9: Capacity recovers without restart
**As a** user, **I want** the aborted slot returned to the pool, **so that** throughput returns without restarting opencode.

**Story ID(s) for tests:** US-9
**Acceptance criteria:**
- [ ] Given a claim is reaped, When the next routing decision is made, Then the freed capacity is available and is not still counted as in use.
- [ ] Given a claim file's owning process is gone, When claims are read, Then the file is pruned as dead and its capacity returned.
- [ ] Given an orphaned temporary claim file exists, When claims are read, Then the orphan is cleaned up rather than counted.
- [ ] Given a reaper sweep empties the backlog, When routing resumes, Then no manual intervention or restart is required.

### US-10: Hangs are surfaced, not silent
**As a** user, **I want** to know a hang happened and was reaped, **so that** I can investigate rather than wonder why an agent vanished.

**Story ID(s) for tests:** US-10
**Acceptance criteria:**
- [ ] Given a claim is reaped, When the reaper reports, Then the log names the reaped session and the reason (hung past TTL with no activity).
- [ ] Given the reaper is armed, When it starts, Then a single greppable line records that it is armed and on what interval.
- [ ] Given a reaper sweep fails internally, When the sweep is reported, Then the failure is reported through the app log and never thrown out of the hook.

---

## Epic D — Notifications for parallel sessions

### US-11: Notification when a session finishes
**As a** user running many parallel sessions, **I want** a desktop notification when a session goes idle or errors, **so that** I can work elsewhere and know when to return.

**Story ID(s) for tests:** US-11
**Acceptance criteria:**
- [ ] Given a session went busy and is now idle, When the idle event fires, Then a `done` notification is delivered and stays on the desktop until the user closes it.
- [ ] Given a session ends with an unrecognized error, When the error event fires, Then an `error` notification is delivered, it bypasses the duplicate-suppression cooldown, and it carries the error's own message.
- [ ] Given a recognized rate-limit or quota error, or a user abort, When a session error event fires, Then no failure notification is raised — the pool already handles the former and the user already knows the latter.
- [ ] Given a session that never went busy, When it goes idle, Then no notification is sent.
- [ ] Given a subagent session or a cartographer session, When it goes idle, Then it is suppressed.
- [ ] Given the notify helper exits non-zero or writes to stderr, When the result is evaluated, Then the delivery is reported as failed rather than sent.

### US-12: Notification when a question is asked
**As a** user, **I want** to be notified when opencode is blocked waiting on my input, **so that** a pending prompt is never silently blocking a session.

**Story ID(s) for tests:** US-12
**Acceptance criteria:**
- [ ] Given a question is asked, When the event fires, Then a `question` notification is delivered that includes the question's text.
- [ ] Given a session has a parked question, When the idle event that follows fires, Then no duplicate "finished" notification is sent.
- [ ] Given a parked question is replied to, rejected, or the session errors, When that event fires, Then the pending entry is cleared and the next real completion notifies again.
- [ ] Given a question and a completion occur inside the same cooldown window, When both are evaluated, Then they are not deduplicated against each other.

### US-25: Notification when opencode asks for permission
**As a** user, **I want** to be notified when opencode is blocked asking me for permission — including permission to reach a directory outside the worktree — **so that** a silent permission prompt is never mistaken for a hung agent, and so that I can allow or deny it where the notification reaches me instead of going back to the terminal.

**Story ID(s) for tests:** US-25
**Acceptance criteria:**
- [ ] Given a permission is requested, When the `permission.asked` event fires, Then exactly one notification is delivered naming the permission type and the path or pattern being requested.
- [ ] Given opencode asks to reach a directory outside the worktree, When the prompt fires, Then the notification names that directory, resolved from `metadata.parentDir`/`metadata.filepath` and with the trailing glob trimmed, because a glob is not something the user can judge.
- [ ] Given the permission is granted, denied, or dismissed, When `permission.replied` fires, Then no notification is sent — the prompt was the thing worth interrupting for, not the answer — and only the parked-session block is cleared.
- [ ] Given a session is parked on a permission prompt, When the idle event fires, Then no "finished" notification is sent, because nothing finished.
- [ ] Given the plugin observes a permission prompt, When it handles the event, Then it registers no `permission.ask` hook and mutates nothing in the payload — that hook's `output.status` is the permission decision itself, and deciding a prompt inside a handler is not the same as answering the one the user was asked for. A permission is answered through the server's own reply route, and only when the user says which answer they meant.
- [ ] Given a `permission` notification is raised, When it is evaluated against the cooldown, Then it bypasses it, since an unannounced block is the failure this story exists to remove.
- [ ] Given a permission prompt on Linux, When the notification is delivered, Then it is exactly one notification carrying three buttons — **Allow once**, **Always allow** and **Deny** — and the click raises no second notification.
- [ ] Given one of those buttons is clicked, When the answer comes back over the hop the notification came up, Then the permission is answered with that button's meaning through the server's reply route; the button names are opencode's own reply values (`once`, `always` and `reject` — the server's word for deny), so a click needs no translation to become an answer.
- [ ] Given the popup is dismissed without a button being chosen, When the notification returns, Then nothing is answered and the permission is left exactly as it was.
- [ ] Given the permission was already answered in the terminal, When a button is clicked, Then the reply is a no-op and is not reported as a failure.
- [ ] Given the desktop is a macOS one, When the same prompt is delivered, Then it is a plain notice with no buttons, because `osascript` and `terminal-notifier` have no action support and the answer still has to be given in the terminal there.
- [ ] Given a question is asked, When its notification is delivered, Then it carries no buttons and answers nothing, because a question is not a permission: the v1 client this plugin has has no question API at all, and the v2 routes need a bound socket the default TUI does not have.

### US-29: Notification sounds distinguish outcomes and can be switched off
**As a** user running many parallel sessions, **I want** each notification to arrive with its own sound, **so that** I can tell a finished session from a question or a permission prompt without looking at the popup.

**Story ID(s) for tests:** US-29
**Acceptance criteria:**
- [ ] Given any of the four outcomes, When its notification is delivered, Then it carries that outcome's own sound name — `done`, `question`, `permission` or `error` — and no two share one, so the four are distinguishable by ear alone.
- [ ] Given a notification raised on a remote host, When it reaches the desktop, Then the sound plays where the notification is delivered and never on the opencode host, because a headless host has no speakers for you to hear.
- [ ] Given no sound player is installed, or the player cannot start, When the notification is delivered, Then the notification is delivered unchanged and only the sound is skipped, because a missing audio tool must never cost you the alert itself.
- [ ] Given a machine with no notification channel at all, When a notification is raised, Then its sound still plays, because on such a desktop the tone is the only alert there is.
- [ ] Given the plugin option `sound` is `false`, or `LACODE_SOUND` is `0`, `false`, `off` or `no`, When a notification is delivered, Then its sound is `none`; when both are set the environment wins over the option, and any other value — a typo included — leaves sound on, because a misspelt variable must not be how you get silence.
- [ ] Given a sound name that is not one of `none`, `done`, `question`, `permission` or `error`, When it arrives, Then it is treated as `none` and never becomes a path or a command, because the hop carries data only (see US-18).

### US-30: A notification fades once you are working in that chat
**As a** user with several sessions open, **I want** the popup of the session I am working in to close itself, **so that** a notice I have already dealt with stops sitting on my screen waiting for an X I was never going to press.

A popup the user is already looking past has said everything it is going to say: once they answer the permission, answer the question, or type into that session's chat, the answer is on their screen already. So the popup fades on its own — but never sooner than five seconds after it was raised, because a notice nobody could read is no notice, and a popup nobody touched still waits for them, exactly as before.

The popup belongs to its session: working in one chat closes that chat's popup and no other. The close is the **helper's** job, never the plugin's, because the popup lives on the desktop and only the desktop knows the notification id the daemon gave it. One code path, two topologies: the helper closes locally, or over the hop where the popup was actually raised.

**Story ID(s) for tests:** US-30
**Acceptance criteria:**
- [ ] Given a notification has been delivered, When the user answers a permission, answers a question, or types into that session's chat, Then that session's notification closes by itself, without the user clicking the popup's close button.
- [ ] Given a notification was delivered less than five seconds ago, When the user works in that chat, Then the notification stays until five seconds have passed, because a notice nobody could read is no notice.
- [ ] Given the user works in one session's chat, When another session still has a popup up, Then that popup stays: a notification belongs to its session, and only that session's user is looking at it.
- [ ] Given the user never works in that chat, When the notification was delivered, Then it stays until the user closes it, exactly as before.
- [ ] Given a permission popup is closed this way, When the permission was already answered in the terminal, Then nothing is answered twice: the close takes the popup down and answers nothing.
- [ ] Given the notification was delivered by a session on a remote host and reached the desktop over the tunnel, When the user works in that chat, Then the popup on the desktop closes too, because the popup lives on the desktop and only the desktop knows its notification id.

---

## Epic E — Remote hosts over SSH

### US-13: Notification reaches the local desktop from a remote host
**As a** user working on a remote machine over SSH, **I want** notifications from remote sessions delivered to my local desktop, **so that** remote work still notifies me.

**Story ID(s) for tests:** US-13
**Acceptance criteria:**
- [ ] Given a notification is raised on a remote host, When it is delivered, Then the local desktop shows it.
- [ ] Given the remote host has no desktop session of its own, When the notification is delivered, Then the username and bus path come from the local-user marker, never from the remote `id -u`/`id -un`.
- [ ] Given the notification travels to the forced-command receiver, When it arrives, Then its urgency and icon are validated against a whitelist before `notify-send` is invoked.
- [ ] Given the notification is sent, When it crosses the hop, Then it is passed as a single self-delimiting argument and never interpolated into a shell string (see US-18 for why it cannot be four).
- [ ] Given the session outlives the terminal it was started from, When the tunnel's original owner disconnects, Then notifications still arrive because the tunnel is a supervised unit rather than a login side effect.

### US-14: Tunnel degrades safely
**As a** user, **I want** the tunnel to fail silently when unreachable rather than blocking or erroring, **so that** a flaky connection never breaks my session.

**Story ID(s) for tests:** US-14
**Acceptance criteria:**
- [ ] Given the remote host is unreachable, When a notification is attempted, Then it fails without blocking or throwing out of the hook.
- [ ] Given the notification helper is missing, When the plugin looks for it, Then it warns once and continues working.
- [ ] Given the sync script runs many ssh calls while a tunnel is live, When each call is made, Then forwardings are cleared on that call so it does not compete for the tunnel port.
- [ ] Given a notification arrives at the receiver with an argument that is not whitelisted, When it is validated, Then it is rejected rather than forwarded to `notify-send`.

### US-18: Notification content survives the SSH hop intact
**As a** user on a remote host, **I want** the notification's text to arrive on my local desktop whole, **so that** a hop which fails quietly is not also a hop that delivers nothing.

**Story ID(s) for tests:** US-18
**Acceptance criteria:**
- [ ] Given the notification crosses the hop, When it is passed, Then it is one newline-delimited argument, because ssh concatenates everything after the host into a single command string and starts the forced command with no positional parameters.
- [ ] Given the forced command is started, When the payload arrives, Then it is read from `$SSH_ORIGINAL_COMMAND` and never from `$1`–`$4`, which are always empty over ssh.
- [ ] Given a body containing spaces, punctuation or glob characters, When it arrives at `notify-send`, Then it is byte-identical to what the remote sent.
- [ ] Given a payload containing shell metacharacters (`$(…)`, backticks, `;`, `&&`) or extra fields, When the receiver handles it, Then it is parsed as data only: nothing is executed and the argument list passed to `notify-send` is unchanged.
- [ ] Given a payload that cannot be understood at all, When it arrives, Then the receiver still exits 0 and pops up what it received, rather than failing the hop.

### US-26: A local notification is delivered on macOS, not only on Linux
**As a** user whose desktop is a Mac, **I want** a notification to actually appear when a session finishes, **so that** installing the package on macOS is not the same as getting no notifications at all.

**Story ID(s) for tests:** US-26
**Acceptance criteria:**
- [ ] Given the notification is raised on macOS, When it is delivered locally, Then it goes to `osascript` — or to `terminal-notifier` if `osascript` is not installed — and not to `notify-send`, which does not exist there.
- [ ] Given the channel is chosen, When it is picked, Then it is decided by `process.platform` and by which binary is actually installed, never by guessing, and every platform other than macOS keeps the `notify-send` call it has always made.
- [ ] Given the title and the body reach `osascript`, When the script runs, Then they are passed as arguments to an `on run argv` handler and never concatenated into the script source, because both fields are attacker-influenced text — a session title, a file path, a command.
- [ ] Given a body containing `"`, `'`, `;`, `$(…)` or backticks, When the macOS send runs, Then it reaches `display notification` byte-for-byte as data and nothing is executed.
- [ ] Given a machine has no notifier for its platform, When a notification is sent, Then the result is a failed delivery with a reason and no exception, and `lacode doctor` names the channel that would run — or reports that there is none — instead of reporting a binary that is not used there.
- [ ] Given the CLI runs on macOS, When the send does not complete, Then it is still bounded by a timeout, exactly as on Linux.
- [ ] Given the notification hop, When it is documented, Then the doc leads with the shipped path — the npm-installed plugin, a direct ssh hop (`ControlMaster`) set up by `lacode tunnel setup`, and the portable `lacode receive` forced command that delivers through the platform channel (`notify-send` or `osascript`) — and marks the reverse-forward scripts (`bin/oc`, `bin/oc-notify`, `bin/oc-notify-receiver`, `bin/oc-sync`) as the author's legacy tooling, so a Mac user is not sent to debug a script that was never meant to run on their machine.
- [ ] Given a machine without GNU `timeout` or with bash older than 4.0, When `bin/oc-sync` runs, Then it refuses **before** touching anything, names each missing prerequisite, and names the `lacode` subcommand to use instead. It must never report a misleading cause: the host list is read with `mapfile`, so without it the run dies at "no hosts configured" — a confident wrong answer that sends the reader to edit `.env`.
- [ ] Given `bin/oc-notify-receiver` runs where `notify-send` does not exist, When it is invoked, Then it exits non-zero and names both the missing channel and the portable path, because its stderr reaches whoever opened the ssh connection and nobody else, and a bare "command not found" reads as a desktop that quietly stopped notifying.
- [ ] Given the payload is parsed, When the receiver splits `$SSH_ORIGINAL_COMMAND`, Then it splits on newlines only using constructs that exist in bash 3.2 as well as bash 5, and the suite **proves the split by running the receiver** rather than by finding the word `mapfile` in the file. Under bash 3.2 — the version macOS ships — a bash-4-only builtin leaves every field at its default, so the popup says "LaCode" with an empty body and no error anywhere: the same silent blank notification the argv bug causes, reached through a different door.
- [ ] Given the whole suite, When it runs on macOS, Then it passes there too. Checks that exercise the Linux-only shell scripts **skip** on a machine that cannot run them, each naming the specific missing prerequisite (a bash version below 4.0, an absent GNU `timeout`) rather than passing silently.
- [ ] Given the local notification channel differs by platform, When a test asserts on the notifier's argv, Then it reads **every** channel's stub rather than only `notify-send`. A Mac picks `osascript` and never invokes `notify-send` at all, so a suite that stubbed only `notify-send` would pass on Linux, read an empty log on a Mac, and in the process invoke the runner's real `osascript` against a desktop session that is not there.

---

## Epic F — Adoption and safety

### US-15: One-line install with sane defaults
**As a** new user, **I want** installing LaCode to require one config line and no manual setup, **so that** I get value immediately.

**Story ID(s) for tests:** US-15
**Acceptance criteria:**
- [ ] Given a fresh machine with no LaCode config, When the install runs, Then one config line is sufficient and no further manual step is required.
- [ ] Given no configuration is present at all, When LaCode boots, Then it falls back to shipped defaults and still functions.
- [ ] Given the plugin package is installed, When its peer dependency is unmet, Then the requirement is declared rather than silently duplicated inside the package.
- [ ] Given the published manifest, When a plugin loader looks for an entry point, Then it finds one in both shapes a resolver may consult — a top-level `main` and `exports["./server"]` — while `exports["."]` keeps pointing at the same built plugin, and the documentation states plainly that these are forward-compatibility metadata and **not** a fix for opencode 1.18.35, where the bare specifier still loads nothing.
- [ ] Given an opencode that does not load the bare specifier, When the reader follows the install documentation, Then the README offers a numbered procedure that holds **whichever version they run** — write the bare specifier and restart, verify with `opencode agent list`, and only if the agents are still missing while the package is installed, add a `file://` entry and restart — rather than instructions scoped to one build. Each step is justified by what the previous step showed, not by what the reader's version is known to do.
- [ ] Given a version nobody has tested, When the reader checks the version table, Then **every** row other than the measured one is marked untested or unknown, the README claims no loading behaviour for any version it has not run, and it tells the reader to follow the procedure rather than to read the table as coverage of their build. The one row that does claim behaviour records the evidence behind it, and says that installing the package and then silently dropping it is what was measured.
- [ ] Given any operating system, When the reader needs the package directory to build a `file://` entry, Then the path comes from `opencode debug paths` rather than a hardcoded root, and any literal path in the document is marked as an illustration of one platform's layout instead of a value to copy. Where a platform's cache root has not been established, the README says so rather than guessing it.
- [ ] Given a macOS user, When they look for what works on their machine, Then the README documents macOS: the plugin runs there, notifications are delivered through `osascript` or `terminal-notifier`, paths still come from `opencode debug paths` with no asserted macOS cache root, and the remote-host and tunnel scripts are marked Linux-only rather than implied to run there.
- [ ] Given a user whose cache holds an installed package, When the plugin's agents are nevertheless absent, Then the README distinguishes that from a failed install (an empty cache directory) and points at the loader workaround, so "installed" and "loaded" are never reported as the same fact.

### US-16: Merges, never clobbers
**As a** user with an existing opencode config, **I want** LaCode to add its agents/commands only where absent and never overwrite my own definitions, **so that** installing it cannot break my setup.

**Story ID(s) for tests:** US-16
**Acceptance criteria:**
- [ ] Given an agent of the same name already exists in the user's config, When LaCode merges, Then the user's definition is left untouched.
- [ ] Given a command of the same name already exists, When LaCode merges, Then the user's definition is left untouched.
- [ ] Given a merge adds an agent, When it is written back, Then every pre-existing key in the file survives the round trip unchanged.
- [ ] Given merging runs twice in a row, When the second run completes, Then the result is identical to the first (idempotent).

### US-17: Single off switch
**As a** user, **I want** one option to disable LaCode's config injection entirely, **so that** I can recover instantly if something misbehaves.

**Story ID(s) for tests:** US-17
**Acceptance criteria:**
- [ ] Given the off switch is set, When LaCode boots, Then no agent, command, or rule is injected into the user's config.
- [ ] Given the off switch is set, When the bootstrap runs, Then it makes no writes at all.
- [ ] Given the off switch is unset, When LaCode boots, Then injection behaves exactly as before — disabling is the only behavioural difference.

### US-24: Tool grants are documented, not injected, because a plugin cannot set them
**As a** user who keeps a global `"tools"` block, **I want** to know that per-agent tool grants must be declared in my own config, **so that** browser automation is not silently denied on the agents that need it.

A plugin cannot set per-agent tool grants. opencode folds an agent's `tools` into its permission list **at config-load time**, inside the schema decode that runs before any plugin is called; a plugin's `config` hook mutates the already-decoded object, so the fold never re-runs and any injected `tools` value is read by nothing. A `tools: { "playwright_*": true }` grant on the exploration and implementation tiers would therefore be dead code asserting a rescue it never performs. The fix is not to inject it — it is to tell the truth about it and document the one-line fix the user can apply themselves.

**Story ID(s) for tests:** US-24
**Acceptance criteria:**
- [ ] Given the config hook runs on a config that globally disables a tool namespace, When the agent set is injected, Then no injected agent carries a `tools` field at all — not on the four exploration and implementation tiers, and not on any hidden pool variant.
- [ ] Given a config with a global `"tools"` block, When LaCode is asked to inject, Then every other agent field it does own — `permission`, `prompt`, `description`, `temperature`, `mode`, `hidden` — is still written, so the removal is scoped to the one field the host folds before the plugin runs.
- [ ] Given the README, When a reader looks for what the plugin injects, Then the tool-grant limitation is stated plainly, above the injection list rather than buried under it, and a minimal copy-pasteable example of declaring the grants in the user's own config is shown.
- [ ] Given a reader who has never seen the source, When they read the README section, Then the load-time-folding reason is given in one sentence, so the grant is not re-added on the belief that it is merely missing.

---

### US-27: The package keeps itself current, without npm and without being asked
**As a** user who installed LaCode once, **I want** each new release to reach my machine automatically, **so that** I never have to learn that opencode freezes the plugin version and hand-clear a cache to upgrade.

opencode's plugin cache is **write-once**. It resolves `@lawaty/lacode` to an exact version once and never re-resolves — not on restart, not with `opencode plugin -g -f`, not with a range pin, not with a tagged config spec (all four verified against opencode 1.18.34). A published release therefore reaches a client only when something installs it into that cache again, and nothing in opencode ever does. The plugin has to do it itself, and it may assume only one tool: the opencode binary the code already runs inside.

**Story ID(s) for tests:** US-27
**Acceptance criteria:**
- [ ] Given a client runs the plugin and the registry reports a newer version, When the check runs, Then the plugin reinstalls its own cache entry in the background and logs one line naming the old and new version, and startup is never blocked on the registry.
- [ ] Given the check ran recently, When the plugin loads again within the interval, Then the registry is consulted at most once per interval, so a session start never waits on npm and npm is not hammered.
- [ ] Given a machine with neither npm nor bun, When an update runs, Then it is performed by the opencode binary alone, because that is the one tool every client is guaranteed to have.
- [ ] Given an update is installed, When the running session continues, Then it keeps its loaded code and the new version takes effect on the next start, and the log line says exactly that.
- [ ] Given two opencode processes start together and both find an update, When they race, Then a cross-process lock ensures only one performs the install.
- [ ] Given `selfUpdate: false` in the plugin options or `LACODE_NO_SELFUPDATE=1` in the environment, When the plugin loads, Then it performs no check at all.
- [ ] Given the registry is unreachable, When the check runs, Then it is silent, records nothing that would suppress a later retry forever, and never throws into opencode.
- [ ] Given a plain source checkout rather than an opencode cache install, When the check runs, Then it does not attempt to reinstall, so a development tree is never overwritten.
- [ ] Given `lacode update` or `lacode update --check`, When it is run, Then it reports (or installs) the update for this machine and exits non-zero only on a real failure — a missing registry, no cache to update, or a failed install.

---

## Epic G — Context and cost (a maintained map instead of cold exploration)

Every task opens by exploring the repository from scratch. The same directory
layout, the same entry points and the same layering are rediscovered — and
re-paid for — on every run, and nothing written down survives the session that
learned it. LaCode keeps a five-file codemap at `.opencode/context/` and makes
agents read it before they explore, then keeps it current on its own.

### US-19: Curated map replaces cold exploration
**As a** user, **I want** agents to start from a maintained map of the codebase, **so that** each task spends fewer tokens on re-discovering structure that is already written down.

**Story ID(s) for tests:** US-19
**Acceptance criteria:**
- [ ] Given a config that defines none of LaCode's agents, When the config hook runs, Then a `context` subagent is injected, and it carries no model of its own, because the pool is the only thing that decides which model runs it.
- [ ] Given the injected agent set, When the slot variants are built, Then a hidden `context-<slot>` variant exists for every slot the pool can hand out, so a cartography run borrows shared capacity instead of a dedicated model.
- [ ] Given the shipped agent prompts and the context agent, When they are inspected, Then they carry the standing context-map rule — naming all five map files, checking with `ls` and never the `glob` tool, reading only the file relevant to the task, and starting from the canonical entry points the map lists — because that rule now lives in the repo-level `AGENTS.md` rather than being injected into the user's `instructions` array.
- [ ] Given the injected `context`, When its prompt is inspected, Then it names the five files it owns, requires a short "Start here" list of canonical files per significant subsystem, and forbids file inventories — the map answers "what should I look at first?", never "tell me everything".

### US-20: The map stays current without being asked
**As a** user, **I want** the map refreshed automatically after a session that edited code, **so that** agents are never misled by stale documentation.

**Story ID(s) for tests:** US-20
**Acceptance criteria:**
- [ ] Given a file inside the project was edited, When the root session next goes idle, Then a `context` session is created and prompted with the edited paths listed, rather than nothing happening.
- [ ] Given `.opencode/context/` does not exist, When the automatic run fires, Then it is told to bootstrap the map; given that the directory exists, Then it is told to make an incremental update.
- [ ] Given an idle event with no pending edit, or one from a subagent session, or one following an edit inside the map itself or inside a build directory, Then no cartographer is spawned.
- [ ] Given an automatic run borrowed a pool slot, When it completes, Then the slot is released and the cartographer session going idle does not spawn a second run.
- [ ] Given an automatic run that changed nothing on disk, When it reports, Then it says the map was not changed rather than reporting success, so a cartographer that was blocked from writing is distinguishable from one that had nothing to do.
- [ ] Given an automatic run that failed, When it reports, Then the paths it was given are queued again, so a failed run does not strand the work.

### US-21: One writer keeps the map coherent
**As a** user, **I want** exactly one agent allowed to write the map, **so that** concurrent sessions cannot fight over it or produce contradictory versions.

**Story ID(s) for tests:** US-21

Enforcement is split deliberately, and the split matters: **what the permission table enforces** is that `context` can write the map and that *no other agent can*; **what the prompt enforces** is that every other agent knows to report map-relevant findings instead of making them. The permission half is the load-bearing one — it holds regardless of what the model decides to do — but it cannot tell an agent what it *should* have done, so the instruction is not redundant and is not going away.

**Acceptance criteria:**
- [ ] Given the injected agent set, When every agent's `edit` permission is evaluated against a path inside `.opencode/context/`, Then `context` is the only agent whose winning rule for that path is `allow`, and every agent that may otherwise write files carries a `deny` on both spellings of the map path — so the map is closed to non-cartographers by permission, not only by instruction.
- [ ] Given an agent's `edit` rules are evaluated the way opencode evaluates them, When the narrow map `deny` is declared before a broad `"*": "allow"`, Then the broad rule wins and the agent is reported as a second writer; so the deny is required to be the LAST entry, and the shipped table must be declared in that order.
- [ ] Given the `context` permission rule, When it is evaluated for a normally-rooted project and for a project rooted at `/`, Then both spellings of the map path are allowed, because opencode evaluates file permissions relative to the project root.
- [ ] Given a config whose one-writer rule allows neither spelling, When the writer rule is verified, Then it reports which rules it saw, that the map is not writable, and that both forms are required — instead of leaving a map that silently never updates.
- [ ] Given a config in which a non-cartographer agent would be granted the map, When the writer rule is verified, Then it reports that agent by name together with the rule that wins for it, and the report is silent once the deny is narrowed and placed last.
- [ ] Given an agent other than `context` finishes work, When the standing rule reaches it, Then it is told never to edit the map itself and to report what belongs in it instead, so that a denied agent knows what to do rather than only that it was refused.
- [ ] Given `edit` is denied for the map, When the same agents read the map, Then reading is unaffected: the rule narrows the `edit` tool only, so the map stays readable by exactly the agents that are told to check it.

### US-22: On-demand map operations
**As a** user, **I want** `/context-init`, `/context-update` and `/context-review`, **so that** I can bootstrap, refresh, or audit the map whenever I don't trust it.

**Story ID(s) for tests:** US-22
**Acceptance criteria:**
- [ ] Given a config that defines none of LaCode's commands, When the config hook runs, Then `/context-init`, `/context-update` and `/context-review` are injected, each targeting `context` as a subtask.
- [ ] Given an injected command template, When opencode substitutes `$ARGUMENTS`, Then `/context-update` carries the user's focus text in the placeholder's place and the procedure around it is unchanged.
- [ ] Given the three commands have been injected, When their templates are inspected, Then each names the procedure it delegates to (bootstrap, incremental update, or review) and none carries an unsubstituted placeholder other than `/context-update`'s single `$ARGUMENTS`.
- [ ] Given the user's config already defines one of the three commands, When the config hook runs, Then that command is left byte-identical while the other two are still added.
- [ ] Given the commands are injected, When each one's target agent is resolved against the same config object, Then all three resolve to an agent that actually exists there — a command must never point at a missing agent.

---

## Epic H — Retention (sweeps)

### US-32: Retire old sessions
**As an** opencode user whose session list only ever grows, **I want** a sweep that retires sessions past a retention window together with everything that belongs to them, **so that** the database stays usable and I keep a compact record of what went.

**Story ID(s) for tests:** US-32
**Acceptance criteria:**
- [ ] Given sessions whose `time_created` is older than `--days` (default 30) and whose `time_updated` is older than `--grace-hours` (default 24), When the sweep runs, Then those sessions are retired together with their messages, parts, todos, shares, inputs, context epochs and event rows.
- [ ] Given a session that is old but was touched inside the grace window, When the sweep runs, Then it is left alone, because the grace window is a stop, not a speed.
- [ ] Given an old parent session with a child, When the sweep runs, Then the child is retired together with the parent, so no orphan remains.
- [ ] Given `--directory D`, When the sweep runs, Then only sessions rooted in that directory are selected, and a child in another directory goes with its parent.
- [ ] Given `--limit N`, When the sweep runs, Then at most N top-level sessions (with their descendants) are retired.
- [ ] Given `--dry-run`, When the sweep runs, Then it reports what would go and changes nothing on disk.
- [ ] Given `--no-events`, When the sweep runs, Then the event rows of the retired sessions are kept.
- [ ] Given `--vacuum`, When the sweep runs, Then the database is rewritten afterwards so the freed pages go back to the filesystem.
- [ ] Given sessions are retired, When the sweep completes, Then a compact record (id, title, directory, project, created, updated) is written under the session archive, which is the recovery path.

### US-33: Prune the event log
**As an** opencode user whose `event` table grows without bound, **I want** a sweep that deletes event rows older than a window except those belonging to protected sessions, **so that** the database stops growing while the transcript and sync stay intact.

**Story ID(s) for tests:** US-33
**Acceptance criteria:**
- [ ] Given event rows whose id is older than `--days` (default 7), When the sweep runs, Then those rows are candidates and newer rows are not, because the id carries the row's creation time.
- [ ] Given a session that takes part in session sync (`event_sequence.owner_id` set), When the sweep runs, Then none of its event rows are pruned.
- [ ] Given a session that belongs to a workspace, When the sweep runs, Then none of its event rows are pruned.
- [ ] Given a session touched inside the grace window (`--grace-hours`, default 1), When the sweep runs, Then all of its event rows are kept.
- [ ] Given an event whose session row is gone, When the sweep runs, Then that event is pruned, because it is garbage.
- [ ] Given `--dry-run`, When the sweep runs, Then it reports the counts and deletes nothing, and still writes one JSON line to the run log.
- [ ] Given `--limit N`, When the sweep runs, Then at most N rows are deleted, oldest first, and the remainder is reported for a later run.
- [ ] Given a window longer than the id era, When the sweep runs, Then the window is clamped to the era and the table is not wiped, and the operator is warned.
- [ ] Given candidate rows, When they are deleted, Then deletion happens in chunks and a failure mid-run leaves the rest for a later run.
- [ ] Given `--vacuum` (and not `--dry-run`), When the sweep runs, Then the database is rewritten afterwards.
- [ ] Given the sweep runs, When it completes, Then the `event_sequence` and `session` tables are never changed.
- [ ] Given a run, When it completes, Then one JSON line is appended to `~/.local/share/opencode/lacode/event-prune.jsonl` carrying ts, days, graceHours, cutoff, rows, bytes, aggregates, dryRun and elapsedMs.

---

## Coverage

Every story below has at least one behavioural test. The story suites live in
`tests/stories/`, and the root-level suites `tests/*-test.mjs` are scanned too
(US-32, US-33), so `tests/stories/coverage.test.mjs` enforces coverage in both
directions:
it fails if a story here has no test, and it fails if a test names a story this
document does not define. The acceptance criteria above are unchanged; only this
table was filled in.

| Story | Epic | Test file |
| --- | --- | --- |
| US-1 | A | `tests/stories/a-cost-control.test.mjs` |
| US-2 | A | `tests/stories/a-cost-control.test.mjs` |
| US-3 | A | `tests/stories/a-cost-control.test.mjs` (harness: `tests/benchmark/run.mjs`) |
| US-23 | A | `tests/stories/a-cost-control.test.mjs` |
| US-4 | B | `tests/stories/b-provider-resilience.test.mjs`, `tests/pool-limits-test.mjs` |
| US-5 | B | `tests/stories/b-provider-resilience.test.mjs`, `tests/pool-test.mjs`, `tests/pool-models-test.mjs` |
| US-6 | B | `tests/stories/b-provider-resilience.test.mjs` |
| US-7 | B | `tests/stories/b-provider-resilience.test.mjs`, `tests/pool-models-test.mjs` |
| US-28 | B | `tests/stories/i-omniroute.test.mjs` |
| US-31 | B | `tests/stories/b-provider-resilience.test.mjs`, `tests/stories/c-hang-recovery.test.mjs` |
| US-8 | C | `tests/stories/c-hang-recovery.test.mjs`, `tests/pool-hang-test.mjs` |
| US-9 | C | `tests/stories/c-hang-recovery.test.mjs`, `tests/pool-hang-test.mjs`, `tests/pool-shared-test.mjs` |
| US-10 | C | `tests/stories/c-hang-recovery.test.mjs`, `tests/pool-hang-test.mjs`, `tests/pool-timer-test.mjs` |
| US-11 | D | `tests/stories/d-notifications.test.mjs`, `tests/notify-test.mjs` |
| US-12 | D | `tests/stories/d-notifications.test.mjs`, `tests/notify-test.mjs` |
| US-25 | D | `tests/stories/d-notifications.test.mjs` |
| US-29 | D | `tests/stories/d-notifications.test.mjs` |
| US-30 | D | `tests/stories/d-notifications.test.mjs`, `tests/stories/e-remote-ssh.test.mjs`, `tests/oc-test.mjs` |
| US-13 | E | `tests/stories/e-remote-ssh.test.mjs`, `tests/notify-test.mjs`, `tests/oc-test.mjs` |
| US-14 | E | `tests/stories/e-remote-ssh.test.mjs`, `tests/oc-test.mjs` |
| US-18 | E | `tests/stories/e-remote-ssh.test.mjs`, `tests/oc-test.mjs` |
| US-26 | E | `tests/stories/e-remote-ssh.test.mjs`, `tests/oc-test.mjs` |
| US-15 | F | `tests/stories/f-adoption-safety.test.mjs` |
| US-16 | F | `tests/stories/f-adoption-safety.test.mjs` |
| US-17 | F | `tests/stories/f-adoption-safety.test.mjs` |
| US-24 | F | `tests/stories/f-adoption-safety.test.mjs` |
| US-27 | F | `tests/stories/h-self-update.test.mjs` |
| US-19 | G | `tests/stories/g-context-management.test.mjs` |
| US-20 | G | `tests/stories/g-context-management.test.mjs` |
| US-21 | G | `tests/stories/g-context-management.test.mjs`, `tests/permission-test.mjs` |
| US-22 | G | `tests/stories/g-context-management.test.mjs` |
| US-32 | H | `tests/retire-old-sessions-test.mjs` |
| US-33 | H | `tests/prune-old-events-test.mjs` |

The nine suites under `tests/` are unit-style; the `tests/stories/` suites are
the behavioural layer, written one epic per file with every test name carrying
its story id. Run everything with `npm test`.

**No story is uncovered.** The guard reports 33 stories, 325 test cases, and
33/33 stories with at least one behavioural test; US-1, US-2, US-3, US-6, and
all of epic F have tests, and the coverage guard fails the build if any of them
loses one. The scan covers the `tests/stories/` suites and the root-level
`tests/*-test.mjs` suites.