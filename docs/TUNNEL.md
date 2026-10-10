# Notifications from remote hosts

opencode runs on your laptop. It also runs on the remote hosts you ssh into. A
notification raised on a remote host has nowhere to go: that machine has no
desktop, no session bus, and possibly no `notify-send`. This is the hop that
gets it back.

## The shape

```
  remote host                                   your desktop
  ┌──────────────────┐                          ┌────────────────────────┐
  │ opencode session │                          │ oc-notify-receiver     │
  │      │           │  ssh (reverse forward)   │  (forced command,      │
  │      ▼           │ ───────────────────────► │   restrict)            │
  │ bin/lacode      │  ONE argument:            │      │                 │
  │   notify         │  title\nmessage\n         │      ▼                 │
  │                  │  urgency\nicon            │  notify-send           │
  └──────────────────┘                          └────────────────────────┘
```

Two things are load-bearing here.

**The reverse forward.** The remote opens an SSH connection to *your* machine
and asks sshd on the desktop to listen on a port. A notification is then an ssh
call to `localhost:<port>` with a dedicated key that is authorized to run
exactly one command. It is not a login, it is not a shell, and it does not
depend on which terminal connected first.

**One argument, not four.** ssh concatenates everything after the host into a
single command string, and a forced command starts with *no* positional
parameters. A sender that passes four quoted arguments arrives as the single
string `"a b c d"`; a receiver reading `$1..$4` sees four empty strings, falls
back to four defaults, and pops up a blank notification. So the payload crosses
as one newline-delimited argument:

```
title\nmessage\nurgency\nicon
```

Newline is safe as the delimiter because both ends strip control characters from
the free-text fields before assembling or reading it, and `urgency` and `icon`
come from whitelists. No field can contain the delimiter, so a message full of
spaces, quotes or `*` survives intact.

## Sending

The CLI picks the transport by where it is running — `SSH_CLIENT` or `SSH_TTY`
means remote, so it forwards; otherwise it calls `notify-send` directly.

```bash
lacode notify "build finished" "lapode: 4 files changed" normal dialog-information
lacode notify "question" "which database should I use?" critical dialog-warning
lacode forward web-01 -- systemctl --user status oc-tunnel
lacode doctor
```

`notify` is fire-and-forget by design. An unreachable desktop, a missing key, a
missing `notify-send` — all of them print a warning on stderr and exit 0. A
notification must never be able to fail the process that tried to send one; an
agent must not go down because a laptop went to sleep. `forward` is the
exception: it exits with the remote's status, because its caller wants to know.

`lacode doctor` prints what the environment resolves to and never gates on it.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OC_LOCAL_USER` | *(unset)* | The desktop user the tunnel authenticates as. **Required for the remote hop.** |
| `OC_TUNNEL_PORT` | `10022` | Reverse-forward listener port on the desktop. Give each remote host its own. |
| `OC_NOTIFY_KEY` | `~/.ssh/lacode_notify` | The dedicated key. Never a personal key. |
| `OC_CONNECT_TIMEOUT_MS` | `5000` | Ceiling on the hop. |
| `OC_SSH_TIMEOUT_MS` | `30000` | Ceiling on `forward`. |

`OC_LOCAL_USER` is read rather than probed on purpose. `id -un` on a remote
account frequently returns `root`, and a dbus path built from that reaches
nobody's desktop. Guessing the desktop user is worse than failing.

## Setting the tunnel up on the desktop

The receiver runs on the machine with the desktop, as an `authorized_keys`
forced command restricted to that one script:

```
restrict,command="/home/you/.local/bin/lacode-notify-receiver" ssh-ed25519 AAAA… oc-notify tunnel auth
```

`restrict` is doing the security work: no shell, no PTY, no agent forwarding, no
port forwarding. The key can do exactly one thing and nothing else.

The receiver must satisfy this contract:

1. read the payload from **`$SSH_ORIGINAL_COMMAND`**, never from `$1`..`$4`;
2. **never** `eval` it, never hand it to `sh -c`, never splice it into an
   argument list — it is attacker-controlled, because it is whatever the remote
   user typed;
3. split it on newlines into title / message / urgency / icon, each with a
   default;
4. whitelist `urgency` against `low|normal|critical` and `icon` against the six
   supported names, both of which become command-line flags;
5. resolve `DISPLAY` / `DBUS_SESSION_BUS_ADDRESS` for the session it is running
   in, then `exec notify-send "$TITLE" "$MSG" --urgency=… --icon=…`.

> **Note.** The published package ships the built CLI (`dist/lacode.js`, linked
> as `lacode`) and the tunnel behind it (`dist/tunnel.js`, importable as
> `@lawaty/lacode/tunnel`), not a receiver script. The receiver is the
> desktop-side half and is yours to install — keep it out of your shell's
> `$PATH` reach and pinned in `authorized_keys`.

If the two halves disagree you get a blank popup, which points nowhere. A
receiver that sees a payload with no newline in it should say so on stderr
rather than silently defaulting everything.

## Holding the forward open

The tunnel has to exist whenever a notification is sent. Anything that survives
your logout works: a `--user` systemd unit is the usual choice, one per remote
host, each with its own port.

```ini
# ~/.config/systemd/user/oc-tunnel@<host>.service
[Service]
ExecStart=/usr/bin/ssh -NT -R 10022:localhost -o ClearAllForwardings=yes -o ExitOnForwardFailure=yes \
          -i %h/.ssh/lacode_notify you@localhost
```

Then `systemctl --user enable --now oc-tunnel@web-01`.

Two details that matter:

- **`-o ExitOnForwardFailure=yes`** — without it, ssh stays up with no forward
  and the notifications fail silently.
- **`-o ClearAllForwardings=yes`** on every *other* ssh call that touches that
  host, including rsync's `-e`. A `RemoteForward` in `~/.ssh/config` competes
  for the same port, and a half-claimed listener starves the one session that
  needed it.

Do not hold the forward open with a `RemoteForward` line in `~/.ssh/config`. It
is per-connection: the port exists only while some terminal is open, and it is
claimed by whichever terminal connects first.