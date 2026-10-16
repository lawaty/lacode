# Install and troubleshooting

Everything about getting LaCode loaded, and what to do when it silently is not. The one-line install is in the [README](../README.md#getting-started); this page is for the rest of it.

A plugin that fails to load is silent — opencode starts normally, prints nothing, logs nothing, and the agents are simply not there. Start at [If the agents are missing](#if-the-agents-are-missing).

## Where it is installed

opencode installs npm plugins itself, into one directory per specifier under its
cache — not into your project's `node_modules`, and not from anywhere a global
npm install put them. Ask opencode where that cache is instead of assuming,
because where it lives differs by platform:

```bash
opencode debug paths
```

It prints the directories opencode is using on this machine — config, data, log
and the rest. Find the **cache** line and append
`/packages/<specifier>/node_modules/` to the path it reports. On Linux with no
`XDG_CACHE_HOME` set, that comes out as, for example:

```
~/.cache/opencode/packages/@lawaty/lacode@latest/node_modules/
```

**That last line is an illustration of one platform's layout, not a path to
copy.** Where the same cache root sits on another operating system is not
something this document should guess at — read it from `opencode debug paths`
and use what it prints.

To inspect what a specifier actually resolved to, list its directory under that
cache root. An **empty** directory with no `node_modules` inside it means the
install failed — almost always an unpublished or misspelled package — and
opencode starts normally **without** the plugin. A **populated** directory there
means the install succeeded and tells you nothing at all about whether the
plugin was loaded; that is the next section, and telling those two apart is the
whole reason for reading it.


## If the agents are missing

A plugin that fails to load is silent: opencode starts normally, prints nothing,
logs nothing, and the agents are simply not there. Work down this. Every step
below is written to hold whichever opencode version you are running — none of
them depends on knowing the answer in advance.

**1 — Write the bare specifier and restart.**

```json
{ "plugin": ["@lawaty/lacode"] }
```

Nothing here hot-reloads, so the restart is part of the step, not a footnote.

**2 — Check whether the plugin loaded.**

```bash
opencode agent list | grep -E '^(explore|implement|context)'
```

A working install prints `explore`, `implement` and `context`, each with the
hidden `-1`..`-4` pool variants alongside. If the
grep returns nothing and the list holds only opencode's own built-ins, the plugin
did not load. Run it in the same shell environment opencode runs in — an
`agent list` under a different `HOME` or `XDG_CONFIG_HOME` tests a different
machine. **If the agents are listed, stop here: the one line above is the whole
install**, and nothing further in this section applies to you.

**3 — Decide which failure you are looking at.** Inspect the package directory
under the cache root from
[Where it is installed](#where-it-is-installed), and also check that `plugin`
really is in the config file opencode reads.

- **Empty** (no `node_modules` inside): the install failed — check the package
  name, and that it is published. There is nothing to load yet.
- **Populated**: the install worked and the loader dropped the plugin. Go to
  step 4. These two look identical from the outside, which is why this step
  exists.

**4 — If the install worked and the agents are still missing, point the loader
at the built file.** Add a second entry; leave the bare name in place:

```json
{
  "plugin": [
    "@lawaty/lacode",
    "file:///ABSOLUTE-PATH-FROM-debug-paths/packages/@lawaty/lacode@latest/node_modules/@lawaty/lacode/dist/index.js"
  ]
}
```

`ABSOLUTE-PATH-FROM-debug-paths` is a placeholder to be replaced, not a
directory: take the cache path `opencode debug paths` reports for **your**
machine and put it in front of `/packages/…`. It must be an absolute path with
`$HOME` already expanded and no `~` left in it. Re-derive it after a cache wipe
or a reinstall — the directory is keyed by specifier, so it moves when the
version does.

Why keep both entries instead of swapping the bare name out:

- The bare name is what makes opencode install the package into its cache, and
  therefore what creates the path the `file://` entry points at.
- The `file://` entry is what actually loads the plugin.
- They **cannot double-inject** on opencode 1.18.35, where the bare name
  contributes nothing at all: the pair loads the plugin exactly once. On any
  other version this is untested, which is precisely why step 4 is something you
  take *because* step 2 showed the agents missing, and never on the expectation
  that it would help.

**5 — Restart, and expect two restarts after a cache wipe.** The first start
installs the package and creates the path the `file://` entry points at, but a
path that does not exist at startup is a path that cannot be loaded in that same
run. The second start finds it and loads the plugin. After that it is steady
state.

This package also publishes `main` and an `exports["./server"]` entry pointing at
the same built file, because those are two of the shapes a plugin loader
resolving an entry point consults. They are forward-compatibility metadata and
they cost nothing — but they do **not** fix this on 1.18.35: adding either one to
the *installed* cache copy was tested there and the bare specifier still loaded
nothing. No other version has been observed where they help either. Use the
`file://` entry.


## Which opencode versions this is known on

Exactly one version has been measured, and the procedure above is deliberately
not built around that fact. Treat this table as the evidence it is, which is one
row wide.

| opencode version | bare spec loads? | `file://` needed? | evidence |
| --- | --- | --- | --- |
| 1.18.35 | No — installs the package, then silently drops it | Yes | **Verified** on 1.18.35: a populated cache directory, zero agents injected, no error and no log line; the `file://` entry loads the full agent set. |
| Any other version | **Unknown** | **Unknown** | **Untested.** No other opencode version has been run against this package in either direction. |

Every command quoted on this page was run against 1.18.35. **If your version is
not the one measured here, follow the procedure above rather than reading this
table as coverage of your build**: each step stands on its own, and step 2 tells
you which situation you are in before any version-specific advice is relevant.


## macOS

The plugin runs on macOS. It is plain JavaScript with no native dependency, and
what the package publishes is the built JavaScript rather than TypeScript
sources, so nothing about loading it is Linux-only. Use the procedure above
unchanged.

Three things differ, and all three are worth reading rather than assuming:

- **Paths.** Do not copy a cache path out of this document — the example under
  [Where it is installed](#where-it-is-installed) is one platform's layout. Run
  `opencode debug paths` and build the `file://` entry from what it reports.
  This page deliberately does not name a macOS cache root: where opencode keeps
  it on a Mac has not been established here, and a plausible-looking guess is
  worse than an instruction to look.
- **Notifications** are delivered through `osascript`, or through
  `terminal-notifier` when `osascript` is not installed, rather than through the
  Linux `notify-send` (US-26). `lacode doctor` reports which channel your machine
  would actually use.
- **The repository's shell scripts are Linux-only by design**, and are not in the
  published package. They drive one person's SSH topology, so each is on the side
  it belongs to:

- **Remote hosts are plain npm clients.** A remote host installs the plugin the
  same way (`opencode plugin @lawaty/lacode -g`); there is nothing to rsync. The
  notification hop is a direct ssh (`ControlMaster` + `ControlPersist`) set up
  once with `lacode tunnel setup` — no reverse forward, no listening port, no
  systemd unit. See [Remote hosts](../README.md#remote-hosts) and docs/TUNNEL.md.
- The repo still carries the author's personal, Linux-only tooling from the older
  reverse-forward setup (`bin/oc`, `bin/oc-notify`, `bin/oc-notify-receiver`,
  `bin/oc-sync`). None of it is in the published package, and none of it is needed
  for the npm-client path above.

**The test suite runs on macOS.** It is written to pass on a Mac as well as on
Linux, so "it works on a Mac" is a supported claim rather than an intention. The
few checks that exercise the Linux-only shell scripts above skip themselves on a
machine that cannot run them, naming the reason — a bash 3.2 with no `mapfile`,
or no GNU `timeout` — rather than passing silently or failing confusingly.


## The `lacode` CLI

The package also ships the `lacode` CLI (`notify`, `forward`, `doctor`, `version`,
`update`, `receive`, `tunnel setup`) — see
[Remote hosts](../README.md#remote-hosts). The plugin install does **not** put it on your
`PATH`; run it from the package's `node_modules/.bin`, or install just the CLI
globally with `npm i -g @lawaty/lacode` if you want the bare command. (That
global install is for the command only — it is still never what makes the plugin
load.)


## What the install gives you

Two things are worth knowing about what npm actually hands you:

- **`@opencode-ai/plugin` is a peer dependency.** It is not vendored into this
  package and never will be: a second copy of the SDK inside the tarball would
  mean opencode and the plugin holding two different module instances, and
  instance identity is what plugin state hangs on. npm installs the peer for you;
  if you install with a tool that does not, install `@opencode-ai/plugin` at the
  same version yourself.
- **You get compiled JavaScript, not TypeScript sources.** The tarball ships
  `dist/`, built from `src/` at pack time (`prepack` runs the build, so a stale
  `dist/` cannot be published). This is not a preference: node strips types
  natively from 22.18 but **refuses to for files under `node_modules`**, so a
  package that shipped `.ts` worked fine in a checkout and failed on install —
  `lacode --help` died with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. A
  published package cannot depend on its consumer's loader being lenient.
