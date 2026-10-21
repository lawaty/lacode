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
  │                  │   \nrequestID            │  notify-send /         │
  │                  │                          │  osascript             │
  │      ▲           │ ◄─────────────────────── │                        │
  │                  │   the clicked button's   │                        │
  │                  │   name, on the forced    │                        │
  │                  │   command's stdout       │                        │
  └──────────────────┘                          └────────────────────────┘
```

**Direct ssh, one warm connection.** The hop is a plain `ssh` to the desktop with
`ControlMaster=auto` + `ControlPersist`, so the first notification opens the
connection and every later one rides it. There is no reverse forward, no
listening port, no systemd unit and nothing to sync: the plugin owns the
transport, and it exists only while opencode runs — which is the only time a
notification matters.

**One argument, not six.** ssh concatenates everything after the host into a
single command string, and a forced command starts with *no* positional
parameters. A sender that passes six quoted arguments arrives as the single
string `"a b c d e f"`; a receiver reading `$1..$6` sees six empty strings,
falls back to six defaults, and pops up a blank notification. So the payload
crosses as one newline-delimited argument:

```
title\nmessage\nurgency\nicon\nsound\nrequestID
```

Six fields — `title`, `message`, `urgency`, `icon`, `sound`, `requestID`.
`sound` is `none`, `done`, `question`, `permission` or `error`. The request id
is **last**, and it is opaque: it is never shown to you, never passed to a
command, and never used to build an argument — the only thing it decides is
whether the notification carries buttons. A sender that stops at `icon`
simply leaves the rest empty, and an empty or unrecognised name is `none`, so a
four-field payload is a valid one; a payload with fewer than six fields carries
no request id at all, and therefore no buttons, so an older sender still works
against a receiver that expects six.

Newline is safe as the delimiter because both ends strip control characters from
the free-text fields before assembling or reading it, and `urgency`, `icon` and
`sound` come from whitelists. No field can contain the delimiter, so a message
full of spaces, quotes or `*` survives intact.

## The way back

The hop was one-way until now: the notification went up to the desktop and
nothing came back, because there was nothing on the wire to carry an answer.
It is two-way now, and what made it two-way was not a new mechanism. **The
desktop end is an ssh forced command, so its stdout comes back down the same
ssh connection the notification went up.** That channel was already there and
nobody used it: a forced command's stdout is carried to whoever opened the
connection, so the answer rides home on the connection that is already open —
no second connection, no listener, no port, no new key, no HTTP server.

A permission notification that carries a request id is raised with three
buttons: **Allow once**, **Always allow** and **Deny**. `notify-send` waits
for the click and prints the chosen button's *name* on stdout — `once`,
`always` or `reject`, and "reject" is opencode's own word for deny, not ours.
The name needs no translation: it is already one of the values the server
accepts as a permission reply. The plugin reads it off the helper's stdout and
answers the permission through opencode's own reply route.

Two things follow from the shape. An **empty** stdout means the popup was
dismissed without a button being chosen: nothing is answered, and the
permission is left exactly as it was. And a permission that was **already
answered** — most often in the terminal — comes back as "not found" rather
than as a failure, because the user did what they had to do and clicking a
stale notification is not an error.

The wait is bounded: ten minutes on the desktop side, and the hop's own
deadline is stretched to outlast it, because an answer cut off by a timeout is
worse than no answer at all.

The buttons are **Linux-only**. `notify-send --action` is the only one of the
three channels that can offer one — `osascript` and `terminal-notifier` have no
action support — so a macOS desktop gets a plain notice, and the answer there
still has to be given in the terminal.

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
without a fifth word is correct.

`LACODE_REQUEST_ID` in the environment is the one thing that makes a send
actionable: it is the permission request id, it is opaque, and it is set on the
helper by the plugin rather than by you. A send with it carries the three
buttons on Linux and prints the name of the clicked one on stdout; a send
without it is an ordinary notice that prints nothing.

A plain `notify` is fire-and-forget by design. An unreachable desktop, a
missing key, no notifier installed at all — all of them print a warning on
stderr and exit 0. A notification must never be able to fail the process that
tried to send one; an agent must not go down because a laptop went to sleep.
`forward` is the exception: it exits with the remote's status, because its
caller wants to know. An **actionable** notify is the other exception, and it
is bounded rather than open-ended: it waits for the click, because the answer
is the whole point of it, and it still exits 0 whatever happens.

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

The buttons are the exception to that. Only `notify-send` can offer one, so a
payload with a request id is an actionable notification on Linux and a plain
notice — one that prints nothing — on macOS. What the receiver prints on stdout
is the chosen button's name, and that stdout is what carries the answer back up
the connection (see [The way back](#the-way-back)). The request id itself is
never passed to a command and never printed — only its emptiness is ever
tested.

It never forwards: `SSH_CLIENT` is set for a forced command as well, so it calls
the local channel directly rather than `notify()` (which would loop back).

It plays the sound too, and that is not decoration. The notification is rendered
on the desktop, so that is the only place a tone can be heard: the remote host
runs the session and has no speakers. The name is validated against the sound
whitelist at the same trust boundary as `urgency` and `icon`, and the receiver
looks the file up in the package's own `sounds/` directory — the sender's word
never becomes a path. `afplay` plays it on macOS, `paplay`, `aplay` or
`pw-play` on Linux, and a machine with none of them gets the notification
regardless.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OC_LOCAL_USER` | *(unset)* | The desktop user the hop authenticates as. **Required for the remote hop.** |
| `OC_LOCAL_HOST` | *(unset)* | Desktop hostname for the direct ssh hop. The default; set it and no reverse forward or port is used. |
| `OC_NOTIFY_KEY` | `~/.ssh/lacode_notify` | The dedicated key. Never a personal key. |
| `OC_CONNECT_TIMEOUT_MS` | `5000` | Ceiling on the hop. |
| `OC_SSH_TIMEOUT_MS` | `30000` | Ceiling on `forward`. |
| `OC_TUNNEL_PORT` | `10022` | Reverse-forward listener port. Used when `OC_LOCAL_HOST` is unset. |

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

`LACODE_REQUEST_ID` is absent for the same kind of reason, and it is not yours
to set either: the plugin puts the permission request id on the helper
process, and the helper carries it as the payload's sixth field. The hop only
ever asks whether it is there.

## The reverse forward

A host that sets `OC_TUNNEL_PORT` and leaves `OC_LOCAL_HOST` unset reaches the
desktop through a reverse forward: `sendRemote` falls back to an ssh call to
`localhost:<port>`, where a `systemd --user` unit on the desktop holds an
`ssh -R` forward open and delivers to a `notify-send`-only bash receiver
(`bin/oc-notify-receiver`). That receiver is the Linux end of the hop: it
delivers through `notify-send`, and libnotify is a Linux thing, so a Mac cannot
be this end of the tunnel.

The way back works the same way here: the receiver's stdout comes back down
the forward, on the connection the notification went up, so a click on one of
the three buttons is carried home the same way it is on the direct hop.
