# Notifications

LaCode raises desktop notifications from three places: a session finishing or
asking something, a one-off `lacode notify`, and the desktop end of the SSH hop.
All three go through one local delivery path. This page describes the adapter
layer that renders a notification on the desktop, which adapter each platform
uses, and what each one can and cannot do.

## Architecture

The notification code has three layers, split so that policy, transport and
platform rendering can change independently:

- **Policy — `src/lib/notify.ts`.** Decides *whether* a notification is raised:
  the per-session cooldown and completion markers, the active/title/live stores,
  the request-id and correlation-key environment names, and the filesystem IO
  for the state directory (claim files, notification-id files, completion
  markers). It holds no platform-specific rendering and imports nothing from
  `src/plugins/`.
- **Transport — `src/tunnel/index.ts`.** Encodes and parses the seven-field SSH
  payload, chooses remote versus local delivery, and owns the `lacode` CLI
  surface (`notify`, `receive`, `doctor`). It re-exports the adapter primitives
  so the published `dist/tunnel.js` surface is unchanged.
- **Adapters — `src/lib/notify-adapter/`.** Own everything about *how* a
  notification appears on one platform: rendering (`notify()`), dismissal
  (`close()`), action buttons (returned as an action from `notify()`), and the
  declared `capabilities()`. The shared primitives live here too — `exec.ts`
  (the one process seam), `probe.ts`, `ids.ts`, `text.ts`, `sound.ts`,
  `registry.ts` (selection), `doctor.ts` (reporting) and `types.ts` — with the
  concrete adapters under `adapters/`: `freedesktop.ts`, `macos.ts`,
  `windows-toast.ts` and `none.ts`.

`sendLocal()` now dispatches through `selectAdapter()`: it handles a close
request first, then asks the registry for the adapter, plays the sound (which
runs even when the chosen adapter is `none`), and calls `adapter.notify()`.
`localChannel()` uses the same registry, so `lacode doctor` reports the channel
that would actually run rather than a second opinion.

## Platform matrix

| Platform / adapter | Actions | Close | Persistence | Sound | Notes |
| --- | --- | --- | --- | --- | --- |
| **Linux — freedesktop** (`notify-send`) | Yes — `Allow once`, `Always allow`, `Deny` | By correlation key (the recorded id is closed over D-Bus) | `--expire-time=0` asks the daemon not to auto-dismiss; actual persistence is daemon-dependent | `paplay` → `aplay` → `pw-play` | App name is `LaCode` (`--app-name=LaCode`). Capability caveats: GNOME banners may auto-dismiss regardless of the expiry flag, and Do Not Disturb behaviour is daemon-specific. `lacode doctor` reports capabilities; it never suppresses policy. |
| **macOS — `osascript`** (preferred), `terminal-notifier` (fallback) | No | No close-by-key in v1 | Plain notice | `afplay` | Text is passed as `argv` to an `on run argv` handler, never spliced into AppleScript source. No action buttons; a permission answer is still given in the terminal. |
| **Windows 10/11 — `powershell-toast`** | No | No — self-expiring, cannot be closed from this side | Self-expiring toast | `powershell-sound` (`System.Media.SoundPlayer`, `SystemSounds` fallback) | PowerShell 5.1 + WinRT toast. Non-actionable. The AUMID is PowerShell's own, so the sender shows **Windows PowerShell**. Title and body are written to a temp XML file and never appear in argv. `duration="long"` only for critical urgency. Focus Assist is respected automatically, but there is no read-back of whether the toast was shown. No new runtime dependencies. |
| **`none`** | No | No | No channel | Sound may still play | A real, reachable state (headless machine, or `LACODE_NOTIFY_ADAPTER=none`); a send returns a non-throwing failure with an explanation. |

## Selection and fallback

`selectAdapter()` walks a per-platform chain and picks the first adapter whose
`probe()` reports it available. The order is:

| Platform | Chain |
| --- | --- |
| `darwin` | `osascript` → `terminal-notifier` → `none` |
| `win32` | `powershell-toast` → `notify-send` → `none` |
| other (Linux, BSD, …) | `notify-send` → `none` |

Probes check whether the binary is on `PATH`: `where <command>` on Windows,
`sh -c 'command -v <command>'` everywhere else. `none` is always available, so
selection always returns something.

`LACODE_NOTIFY_ADAPTER` overrides selection. Set it to an adapter id in the
chain to force that adapter — including `none` to mute notifications while
leaving sound and policy untouched. An unknown id warns on stderr and falls
back to automatic selection.

## Doctor

`lacode doctor` reports the resolved adapter and its diagnostics. Alongside the
existing `channel` and `notifySend` fields it now prints:

| Key | Meaning |
| --- | --- |
| `adapter` | The adapter that would be selected here. |
| `adapterChain` | Each adapter in the chain with `available` / `unavailable`. |
| `capabilities` | The enabled capability names of the selected adapter, or `none`. |
| `sound` | The sound channel for this platform. |
| `stateDir` | The notification state directory. |
| `adapterNote` | Present only when selection had something to explain (for example an unknown override). |

Diagnostics are pure reporting: they never gate or suppress a notification.

## Remote / SSH

The transport payload is unchanged: one newline-delimited argument with seven
fields — `title`, `message`, `urgency`, `icon`, `sound`, `requestID`,
`correlationKey`. The desktop side selects the adapter; the remote host only
encodes and forwards the payload.

`lacode receive` is the cross-platform receiver: it parses and sanitizes the
payload at the trust boundary, then calls the same local adapter chain a local
send uses. The legacy bash `bin/oc-notify-receiver` remains Linux-only and
`notify-send`-only — it is the author's reverse-forward tooling, not part of the
published package. See [TUNNEL.md](TUNNEL.md) for the hop and the receiver
contract.

On Windows, the desktop end is an OpenSSH forced command. The `authorized_keys`
`command=` entry must point at a Windows-runnable `lacode receive` (the
installed CLI, with an absolute path if it is not on the forced command's
`PATH`); OpenSSH on Windows starts that command through the system shell, so
quoting and path spelling differ from the Linux example in TUNNEL.md. The
payload still arrives as a single string in `$SSH_ORIGINAL_COMMAND`, never as
positional parameters.

## Deferred

These are deliberately out of scope for v1:

- A tray / status-bar presence — needs native dependencies, which the package
  avoids.
- macOS grouping and close-by-key.
- Inline reply — the `inlineReply` capability is declared but no adapter
  implements it; the plumbing is dormant.
- Windows action buttons and close-by-key.
- WSL and BSD as first-class platforms (they take the `notify-send` fallback).

## Security and operations

- The Windows adapter invokes `powershell.exe` with `-NoProfile
  -NonInteractive -Command <script>`. A plain `-Command` script is
  ExecutionPolicy-immune and keeps the whole script in argv, where it is
  auditable; no profile code runs.
- Title and body are XML-escaped and written to a temporary `toast.xml` under
  the OS temp directory. Only the XML path is interpolated into the script; the
  user-controlled text never reaches argv. The temp directory is removed after
  the send.
- The AUMID trade-off: using PowerShell's own AUMID means no app registration,
  installer or registry write is needed, at the cost of the toast being branded
  **Windows PowerShell** rather than LaCode.
- AppLocker or antivirus policy may block `powershell.exe`. When the probe or
  the send fails, selection falls through to `notify-send` (if installed) and
  then `none`; a notification never fails the process that tried to send it.

## Testing

Adapter contract tests live in `tests/notify-adapter-test.mjs`. They inject
`platform` and an `exec` seam into every adapter, so Windows and macOS paths are
simulated on a Linux runner: argv is asserted exactly, the temp XML is read
from disk before cleanup, and probes are answered by fakes. No test reaches a
real desktop daemon, a speaker or a PowerShell process. The behavioural suites
`tests/stories/d-notifications.test.mjs` and
`tests/stories/e-remote-ssh.test.mjs` cover the policy and hop contracts.
