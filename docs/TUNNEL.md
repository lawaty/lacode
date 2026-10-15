# Notifications from remote hosts

opencode runs on your laptop. It also runs on the remote hosts you ssh into. A
notification raised on a remote host has nowhere to go: that machine has no
desktop, no session bus, and possibly no `notify-send`. This is the hop that
gets it back.

## The shape

```
  remote host                                   your desktop
  ┌──────────────────┐   direct ssh             ┌────────────────────────┐
  │ opencode session │   (ControlPersist)       │  lacode receive        │
  │      │           │ ───────────────────────► │  (authorized_keys      │
  │      ▼           │   ONE argument:          │   forced command)      │
  │ lacode notify    │   title\nmessage\n       │      │                 │
  │                  │   urgency\nicon\nsound   │      ▼                 │
  │                  │                          │  notify-send /         │
  │                  │                          │  osascript             │
  └──────────────────┘                          └────────────────────────┘
```

**Direct ssh, one warm connection.** The hop is a plain `ssh` to the desktop with
`ControlMaster=auto` + `ControlPersist`, so the first notification opens the
connection and every later one rides it. There is no reverse forward, no
listening port, no systemd unit and nothing to sync: the plugin owns the
transport, and it exists only while opencode runs — which is the only time a
notification matters.

**One argument, not five.** ssh concatenates everything after the host into a
single command string, and a forced command starts with *no* positional
parameters. A sender that passes five quoted arguments arrives as the single
string `"a b c d e"`; a receiver reading `$1..$5` sees five empty strings, falls
back to five defaults, and pops up a blank notification. So the payload crosses
as one newline-delimited argument:

```
title\nmessage\nurgency\nicon\nsound
```

Five fields, and only the last one is new: `sound` is `none`, `done`,
`question`, `permission` or `error`. A sender that stops at `icon` simply
leaves it empty, and an empty or unrecognised name is `none`, so a four-field
payload is still a valid one.

Newline is safe as the delimiter because both ends strip control characters from
the free-text fields before assembling or reading it, and `urgency`, `icon` and
`sound` come from whitelists. No field can contain the delimiter, so a message
full of spaces, quotes or `*` survives intact.

## Setting it up

Once, on the **remote host** (where opencode runs):

```bash
lacode tunnel setup
```

It generates the dedicated key (`~/.ssh/lacode_notify` by default) and prints the
environment to export there, and the single `authorized_keys` line to add on the
desktop:

```
OC_LOCAL_USER=<desktop user>
OC_LOCAL_HOST=<desktop hostname>
OC_NOTIFY_KEY=~/.ssh/lacode_notify
```

On the **desktop**, add the printed line to `~/.ssh/authorized_keys`:

```
restrict,command="lacode receive" ssh-ed25519 AAAA… lacode-notify
```

`restrict` does the security work: no shell, no PTY, no agent forwarding, no port
forwarding. The key can do exactly one thing — hand one notification to
`lacode receive` — and nothing else. Use the absolute path to `lacode` if it is
not on the forced command's `PATH`.

## Sending

The CLI picks the transport by where it is running — `SSH_CLIENT` or `SSH_TTY`
means remote, so it forwards; otherwise it delivers locally through whichever
desktop notifier this platform has: `notify-send` on Linux, `osascript` on macOS,
with `terminal-notifier` as the macOS fallback when `osascript` is missing.

```bash
lacode notify "build finished" "4 files changed" normal dialog-information
lacode notify "question" "which database should I use?" critical dialog-warning done
lacode forward web-01 -- systemctl --user status something
lacode doctor
```

SOUND is optional and last: `none`, `done`, `question`, `permission` or `error`,
one bundled tone per outcome. Leave it off and nothing plays; the line above
without a fifth word is still correct.

`notify` is fire-and-forget by design. An unreachable desktop, a missing key, no
notifier installed at all — all of them print a warning on stderr and exit 0. A
notification must never be able to fail the process that tried to send one; an
agent must not go down because a laptop went to sleep. `forward` is the
exception: it exits with the remote's status, because its caller wants to know.

On macOS the text is passed to `osascript` as arguments to an `on run argv`
handler, never spliced into the script source — a session title is not trusted
input. `lacode doctor` prints the channel that would actually run, so it is
useful on a Mac rather than reporting only whether a Linux binary is installed.

## The desktop side: `lacode receive`

`lacode receive` is the forced command. It reads the newline payload from
`$SSH_ORIGINAL_COMMAND`, sanitizes each field again at the trust boundary, and
delivers locally through the platform channel — `notify-send` on Linux,
`osascript`/`terminal-notifier` on macOS. Because it delegates to the same local
channel as a local send, **the desktop half is not Linux-only**: a Mac desktop
receives notifications too.

It never forwards: `SSH_CLIENT` is set for a forced command as well, so it calls
the local channel directly rather than `notify()` (which would loop back).

It plays the sound too, and that is not decoration. The notification is rendered
on the desktop, so that is the only place a tone can be heard: the remote host
runs the session and has no speakers. The name is validated against the sound
whitelist at the same trust boundary as `urgency` and `icon`, and the receiver
looks the file up in the package's own `sounds/` directory — the sender's word
never becomes a path. `afplay` plays it on macOS, `paplay`, `aplay` or
`pw-play` on Linux, and a machine with none of them still gets the notification.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OC_LOCAL_USER` | *(unset)* | The desktop user the hop authenticates as. **Required for the remote hop.** |
| `OC_LOCAL_HOST` | *(unset)* | Desktop hostname for the direct ssh hop. The default; set it and no reverse forward or port is used. |
| `OC_NOTIFY_KEY` | `~/.ssh/lacode_notify` | The dedicated key. Never a personal key. |
| `OC_CONNECT_TIMEOUT_MS` | `5000` | Ceiling on the hop. |
| `OC_SSH_TIMEOUT_MS` | `30000` | Ceiling on `forward`. |
| `OC_TUNNEL_PORT` | `10022` | **Legacy** reverse-forward listener port. Used only when `OC_LOCAL_HOST` is unset. |

`OC_LOCAL_USER` is read rather than probed on purpose. `id -un` on a remote
account frequently returns `root`, and a dbus path built from that reaches
nobody's desktop. Guessing the desktop user is worse than failing.

`LACODE_SOUND` is deliberately absent from that table, and not by oversight:
every `OC_*` name above is read by the hop — either by `lacode notify` or by the
ssh call it makes — and `lacode tunnel setup` prints what it exports. Sound is
not that. It is a plugin-level mute switch read by the process running opencode
(`sound: false` is the same switch in the config), so listing it here would send
you to export a variable into a hop environment where nothing looks at it. It is
documented with the other plugin options in the README. Set it to `0`, `false`,
`off` or `no` to silence notifications; anything else — a typo included — leaves
sound on, because a misspelt variable must not be how you turn a feature off.

## Legacy: the reverse forward

The original design opened a reverse forward (`ssh -R`) held by a `systemd --user`
unit on the desktop, and delivered to a `notify-send`-only bash receiver
(`bin/oc-notify-receiver`). It is kept only for hosts that still set
`OC_TUNNEL_PORT` and leave `OC_LOCAL_HOST` unset: `sendRemote` falls back to an
ssh call to `localhost:<port>`. New setups should use the direct ssh above. See
the git history for the old systemd unit shape.
