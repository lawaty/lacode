#!/usr/bin/env node
// sync-hosts.mjs — after `npm publish`, install the exact published version on
// every remote host and normalize that host's opencode config.
//
// The host list is the same one oc-sync uses:
//
//   OC_HOSTS                 env var, comma/space/newline separated
//   $HOME/.config/opencode/.env  an OC_HOSTS=... line (repo .env as fallback)
//   $HOME/.oc-hosts          one host per line
//
// OC_SYNC_ENV_FILE and OC_HOSTS_FILE override the two file locations. A host
// that is down, has no opencode, or has an unparseable config never fails the
// publish: the run always exits 0 unless LACODE_SYNC_STRICT=1.
//
// Remote hosts do not have `opencode` on the non-interactive PATH. It lives at
// $HOME/.opencode/bin/opencode, so the install call resolves OC first.
//
// `opencode plugin ... -g -f` APPENDS the new specifier to the config's plugin
// array; it does not replace an existing `file://.../lacode/dist/index.js`
// entry. So the config is rewritten locally into exactly one LaCode entry,
// carrying over the options object (omniroute credentials/configuration) from
// whichever LaCode entry was already there.
//
// This file is author-local and is not part of the published package.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(SCRIPT_DIR, "..")
const PACKAGE = "@lawaty/lacode"
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]
const INSTALL_TIMEOUT_MS = 120000
const SSH_TIMEOUT_MS = 30000
const VIEW_TIMEOUT_MS = 30000
const WAIT_INTERVAL_MS = 15000
const DEFAULT_WAIT_SECONDS = 600
const DETAIL_LIMIT = 160
const DISABLED_VALUES = new Set(["0", "false", "off", "no"])

const REMOTE_CONFIG = "$HOME/.config/opencode/opencode.jsonc"
const REMOTE_READ = `cat "${REMOTE_CONFIG}"`
const REMOTE_BACKUP = `cp -a "${REMOTE_CONFIG}" "${REMOTE_CONFIG}.bak-lacode-sync"`
const REMOTE_WRITE = `cat > "${REMOTE_CONFIG}"`

const REMOTE_PLUGINS_DIR = "$HOME/.config/opencode/plugins"
const REMOTE_LIST_PLUGINS = `find "${REMOTE_PLUGINS_DIR}" -maxdepth 1 -type f -printf '%f\\n' 2>/dev/null`

// After the install and config normalization: can this host actually run the
// published helper? A `~/bin/lacode` wrapper is accepted as-is; otherwise the
// system node must be >= 22 (the ESM bundle cannot be parsed by node 12).
const REMOTE_HELPER_CHECK =
  'if [ -x "$HOME/bin/lacode" ]; then echo HELPER_OK; ' +
  'else n=$(command -v node >/dev/null 2>&1 && node --version || echo none); ' +
  'case "$n" in v1[0-9].*|v2[01].*|none) echo "HELPER_UNUSABLE node=$n";; *) echo HELPER_OK;; esac; fi'

/** The exact remote script: resolve opencode, then install this version. */
function installRemote(version) {
  return `OC="\${OC:-$HOME/.opencode/bin/opencode}"; if [ ! -x "$OC" ]; then echo NO_OPENCODE; else "$OC" plugin "${PACKAGE}@${version}" -g -f; fi`
}

/** The node version string the capability check reported, or a fallback. */
function helperDetail(output) {
  const match = /HELPER_UNUSABLE[ \t]*(\S+)/.exec(output)
  return match ? match[1] : "unknown"
}

/** Strip ANSI escape sequences (CSI color/style codes and similar) from a string. */
function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
}

/**
 * The remote config is `opencode.jsonc`, not JSON: comments and trailing commas
 * are valid and common. `JSON.parse` rejects both, which marked a perfectly good
 * host as "unparseable" and skipped it. This is a small JSONC reader for the two
 * extensions opencode uses; it deliberately does NOT accept JavaScript values
 * (single-quoted strings, unquoted keys), because those are not JSONC.
 */
function stripJsonComments(text) {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (char === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 1
      continue
    }
    out += char
  }
  return out
}

function stripTrailingCommas(text) {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "}" || text[j] === "]") {
        i = j - 1
        continue
      }
    }
    out += char
  }
  return out
}

/** Parse an `opencode.jsonc` body. Exported so the suite can pin the JSONC cases. */
export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(String(text))))
}

/** The last non-empty line of the install's stderr, or stdout when stderr is empty.
 *  ANSI escape sequences are stripped before a line is considered, and lines that
 *  become empty after stripping are skipped. */
function installDetail(result) {
  const stderr = String(result.stderr || "")
  const stdout = String(result.stdout || "")
  const source = stderr.trim() ? stderr : stdout
  const lines = source
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
  if (lines.length === 0) return ""
  return lines[lines.length - 1].slice(0, DETAIL_LIMIT)
}

/** The remote cleanup command issued after a failed install attempt. */
function cleanupRemote(version) {
  return `rm -rf "$HOME/.cache/opencode/packages/@lawaty/lacode@${version}" "$HOME"/.bun/install/cache/@lawaty* 2>/dev/null || true`
}

/**
 * npm publish returns 202 while the tarball is still being processed, so the
 * exact version is not resolvable for a while afterwards. Poll the registry
 * until it is, rather than sending every host into a 404.
 */
function registryHasVersion(version) {
  const result = spawnSync("npm", ["view", `${PACKAGE}@${version}`, "version"], {
    encoding: "utf8",
    timeout: VIEW_TIMEOUT_MS,
  })
  if (result.error || result.status !== 0) return false
  return String(result.stdout || "").trim() === version
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitSeconds(env) {
  const raw = env.LACODE_SYNC_WAIT_SECONDS
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_WAIT_SECONDS
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_WAIT_SECONDS
  return Math.floor(seconds)
}

function noWait(env) {
  return String(env.LACODE_SYNC_NO_WAIT ?? "").trim() === "1"
}

function waitForRegistry(version, seconds) {
  if (registryHasVersion(version)) return true

  console.log(`waiting for ${PACKAGE}@${version} in the registry (up to ${seconds}s)`)
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    sleepSync(Math.min(WAIT_INTERVAL_MS, deadline - Date.now()))
    if (registryHasVersion(version)) return true
  }

  console.log(`warn: ${version} not in the registry after ${seconds}s; attempting anyway`)
  return false
}

function readPackageVersion(env = process.env) {
  const fromNpm = env.npm_package_version
  if (fromNpm && fromNpm.trim()) return fromNpm.trim()
  const pkg = JSON.parse(readFileSync(path.join(REPO_DIR, "package.json"), "utf8"))
  return pkg.version
}

function envFileDefault() {
  const preferred = path.join(homedir(), ".config", "opencode", ".env")
  return existsSync(preferred) ? preferred : path.join(REPO_DIR, ".env")
}

/** Read an OC_HOSTS=... line the way sourcing .env would. Last line wins. */
function readEnvHosts(file) {
  if (!existsSync(file)) return null
  let value = null
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?OC_HOSTS\s*=\s*(.*)$/.exec(line)
    if (match) value = parseShellValue(match[1])
  }
  return value
}

/** Read a single NAME=value line from an env file. Last line wins. */
function readEnvValue(file, name) {
  if (!existsSync(file)) return null
  let value = null
  let seen = false
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = new RegExp("^\\s*(?:export\\s+)?" + name + "\\s*=\\s*(.*)$").exec(line)
      if (match) {
        value = parseShellValue(match[1])
        seen = true
      }
    }
  } catch {
    return null
  }
  if (!seen) return null
  return value
}

function parseShellValue(rest) {
  const raw = rest.trim()
  if (raw.startsWith('"')) {
    let out = ""
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i]
      if (ch === "\\" && i + 1 < raw.length) {
        out += raw[++i]
        continue
      }
      if (ch === '"') return out
      out += ch
    }
    return out
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1)
    return end === -1 ? raw.slice(1) : raw.slice(1, end)
  }
  if (raw.startsWith("`")) {
    const end = raw.indexOf("`", 1)
    return end === -1 ? raw.slice(1) : raw.slice(1, end)
  }
  return raw.replace(/#.*$/, "").trim()
}

/** Split a host source, dropping comments, blanks and duplicates. */
function splitHosts(raw) {
  if (!raw) return []
  const hosts = []
  const seen = new Set()
  for (const line of String(raw).split(/\r?\n/)) {
    const uncommented = line.replace(/#.*$/, "")
    for (const token of uncommented.split(/[\s,]+/)) {
      const host = token.trim()
      if (!host || seen.has(host)) continue
      seen.add(host)
      hosts.push(host)
    }
  }
  return hosts
}

function hostList(env = process.env) {
  // An OC_HOSTS that is present -- even empty -- is the chosen source. Falling
  // through on an empty value would make `OC_HOSTS=` silently sync a stale
  // ~/.oc-hosts list instead of reporting "no hosts configured".
  if (Object.prototype.hasOwnProperty.call(env, "OC_HOSTS")) {
    return splitHosts(env.OC_HOSTS)
  }

  const envFile = env.OC_SYNC_ENV_FILE || envFileDefault()
  const fromEnvFile = readEnvHosts(envFile)
  if (fromEnvFile !== null) return splitHosts(fromEnvFile)

  const hostsFile = env.OC_HOSTS_FILE || path.join(homedir(), ".oc-hosts")
  if (existsSync(hostsFile)) return splitHosts(readFileSync(hostsFile, "utf8"))
  return []
}

function specifierOf(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return null
}

function isLacodeSpecifier(specifier) {
  if (!specifier) return false
  return (
    specifier === PACKAGE ||
    specifier.startsWith(PACKAGE + "@") ||
    /^file:\/\/.*\/lacode\/dist\/index\.js$/.test(specifier)
  )
}

function isLacodeEntry(entry) {
  return isLacodeSpecifier(specifierOf(entry))
}

/**
 * The options of a LaCode entry, or undefined. Only a non-empty plain object
 * counts: an empty object is the same thing as no options for our purposes,
 * and the normalized entry is then the plain specifier string.
 */
function optionsOf(entry) {
  if (!Array.isArray(entry) || entry.length < 2) return undefined
  const options = entry[1]
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined
  return Object.keys(options).length > 0 ? options : undefined
}

/**
 * Return a config with exactly one LaCode plugin entry at @lawaty/lacode@version.
 * Returns null when the parsed value is not a config object.
 */
export function normalizeConfig(config, version) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null

  const expected = `${PACKAGE}@${version}`
  const originalPlugin = Array.isArray(config.plugin) ? config.plugin : []
  let firstIndex = -1
  let options
  const kept = []

  for (let i = 0; i < originalPlugin.length; i++) {
    const entry = originalPlugin[i]
    if (isLacodeEntry(entry)) {
      if (firstIndex === -1) {
        firstIndex = i
        options = optionsOf(entry)
      }
    } else {
      kept.push(entry)
    }
  }

  const normalizedEntry = options ? [expected, options] : expected
  if (firstIndex === -1) kept.push(normalizedEntry)
  else kept.splice(firstIndex, 0, normalizedEntry)

  return { ...config, plugin: kept }
}

function sshArgs(host, remote) {
  return [...SSH_OPTS, host, remote]
}

function formatSsh(host, remote) {
  return `ssh ${SSH_OPTS.join(" ")} ${host} '${remote}'`
}

function runSsh(host, remote, input, timeout = SSH_TIMEOUT_MS) {
  const result = spawnSync("ssh", sshArgs(host, remote), {
    input: input === undefined ? "" : input,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output: (result.stdout || "") + (result.stderr || ""),
  }
}

function disableShims(host) {
  const listing = runSsh(host, REMOTE_LIST_PLUGINS)
  const names = listing.ok
    ? listing.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : []
  const shims = names.filter((name) => /lacode/i.test(name))
  const disabled = []
  const epoch = Math.floor(Date.now() / 1000)
  for (const name of shims) {
    const move = runSsh(
      host,
      `mv "$HOME/.config/opencode/plugins/${name}" "$HOME/.config/opencode/lacode-plugin-shim.disabled-${epoch}-${name}"`,
    )
    if (move.ok) disabled.push(name)
  }
  return disabled
}

// Remote python helper: reads/writes ~/.local/share/opencode/auth.json under the
// remote $HOME. The JSON envelope arrives on stdin, so provider keys never touch
// the command line (where they would land in a remote process table/history).
// This string must stay free of single quotes: it is wrapped in them for `-c`.
const AUTH_HELPER = `import json, os, sys, shutil, time

envelope = json.load(sys.stdin)
replace = envelope.get("replace", [])
providers = envelope.get("providers", {})
dry_run = bool(envelope.get("dryRun", False))

replace_set = set(replace)

auth_path = os.path.expanduser("~/.local/share/opencode/auth.json")

try:
    with open(auth_path) as fh:
        cur = json.load(fh)
    if not isinstance(cur, dict):
        cur = {}
except FileNotFoundError:
    cur = {}
except Exception:
    cur = {}

updated = []
added = []
kept = []
new_cur = dict(cur)

for pid, val in providers.items():
    if not isinstance(val, dict) or not val.get("key"):
        continue
    if pid in cur:
        if pid in replace_set and cur.get(pid) != val:
            new_cur[pid] = val
            updated.append(pid)
        else:
            kept.append(pid)
    else:
        new_cur[pid] = val
        added.append(pid)

changed = bool(updated or added)

if not changed:
    # Nothing to write. Report a kept provider the allowlist does not own, so a
    # run that only has host-local credentials still says what it protected;
    # otherwise the answer is just IDENTICAL.
    for pid in sorted(kept):
        if pid not in replace_set:
            print("KEPT:" + pid)
    print("IDENTICAL")
    raise SystemExit(0)

if dry_run:
    for pid in sorted(updated):
        print("WOULD-UPDATE:" + pid)
    for pid in sorted(added):
        print("WOULD-ADD:" + pid)
    for pid in sorted(kept):
        print("KEPT:" + pid)
    raise SystemExit(0)

auth_dir = os.path.dirname(auth_path)
try:
    os.makedirs(auth_dir, exist_ok=True)
except Exception as e:
    print("REJECT:could not create auth dir (%s)" % e)
    raise SystemExit(0)

if os.path.exists(auth_path):
    try:
        shutil.copy2(auth_path, auth_path + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
    except Exception:
        pass

tmp = auth_path + ".tmp"
try:
    with open(tmp, "w") as fh:
        json.dump(new_cur, fh, indent=2)
        fh.write(chr(10))
    os.chmod(tmp, 0o600)
    os.replace(tmp, auth_path)
except Exception as e:
    try:
        os.remove(tmp)
    except OSError:
        pass
    print("REJECT:write failed (%s)" % e)
    raise SystemExit(0)

for pid in sorted(updated):
    print("UPDATED:" + pid)
for pid in sorted(added):
    print("ADDED:" + pid)
for pid in sorted(kept):
    print("KEPT:" + pid)
`

/** Read the local auth store once per run. Missing file -> null (auth skipped). */
function loadLocalAuth(env = process.env) {
  const file = env.OC_AUTH_FILE || path.join(homedir(), ".local", "share", "opencode", "auth.json")
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const out = {}
  for (const key of Object.keys(parsed)) {
    const value = parsed[key]
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.key === "string" && value.key) {
      out[key] = value
    }
  }
  return out
}

/** Sync provider credentials for one host. Returns { ok, text }. */
function syncAuth(host, auth, opts = {}) {
  const dryRun = !!(opts && opts.dryRun)
  const replace = (opts && Array.isArray(opts.replace))
    ? opts.replace
    : String((process.env.OC_AUTH_PROVIDERS || "opencode-go opencode")).split(/\s+/).filter(Boolean)
  const envelope = { replace: replace, providers: auth || {}, dryRun: dryRun }
  const result = runSsh(host, `python3 -c '${AUTH_HELPER}'`, JSON.stringify(envelope))
  if (!result.ok) {
    const detail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).filter(Boolean)
    const last = detail.length ? detail[detail.length - 1].slice(0, DETAIL_LIMIT) : ""
    return { ok: false, text: last ? `auth: ssh failed: ${last}` : "auth: ssh failed" }
  }
  const lines = String(result.output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const updated = []
  const added = []
  const kept = []
  const wouldUpdate = []
  const wouldAdd = []
  let identical = false
  let reject = ""
  for (const line of lines) {
    if (line.indexOf("UPDATED:") === 0) updated.push(line.slice("UPDATED:".length))
    else if (line.indexOf("ADDED:") === 0) added.push(line.slice("ADDED:".length))
    else if (line.indexOf("KEPT:") === 0) kept.push(line.slice("KEPT:".length))
    else if (line.indexOf("WOULD-UPDATE:") === 0) wouldUpdate.push(line.slice("WOULD-UPDATE:".length))
    else if (line.indexOf("WOULD-ADD:") === 0) wouldAdd.push(line.slice("WOULD-ADD:".length))
    else if (line === "IDENTICAL") identical = true
    else if (line.indexOf("REJECT:") === 0) reject += " " + line.slice("REJECT:".length)
  }
  if (reject.trim()) {
    return { ok: false, text: `auth: ${reject.trim()}` }
  }
  if (result.status !== 0) {
    return { ok: false, text: "auth: helper failed" }
  }
  const confirmed =
    identical ||
    kept.length > 0 ||
    updated.length > 0 ||
    added.length > 0 ||
    wouldUpdate.length > 0 ||
    wouldAdd.length > 0
  if (!confirmed) {
    return { ok: false, text: "auth: helper produced no confirmation; treat as not applied" }
  }
  const pu = dryRun ? wouldUpdate : updated
  const pa = dryRun ? wouldAdd : added
  const verb = dryRun ? "would update" : "updated"
  const verbAdd = dryRun ? "would add" : "added"
  let parts = ""
  if (pu.length > 0) parts = `${verb} ${pu.join(" ")}`
  if (pa.length > 0) parts = parts ? `${parts}; ${verbAdd} ${pa.join(" ")}` : `${verbAdd} ${pa.join(" ")}`
  if (parts) return { ok: true, text: `auth: ${parts}` }
  return { ok: true, text: "auth: already identical" }
}

function syncHost(host, version, auth, opts = {}) {
  if (auth === undefined) auth = loadLocalAuth(process.env)
  const firstInstall = runSsh(host, installRemote(version), undefined, INSTALL_TIMEOUT_MS)
  if (firstInstall.output.includes("NO_OPENCODE")) return { host, status: "skipped", reason: "no opencode" }
  if (firstInstall.timedOut) return { host, status: "failed", reason: "install timed out" }

  let install = firstInstall
  let retried = false
  if (!install.ok) {
    // One cleanup, then a single retry. Never pre-clean on a healthy host.
    runSsh(host, cleanupRemote(version), undefined, SSH_TIMEOUT_MS)
    const retry = runSsh(host, installRemote(version), undefined, INSTALL_TIMEOUT_MS)
    retried = true
    install = retry
    if (retry.output.includes("NO_OPENCODE")) return { host, status: "skipped", reason: "no opencode", retried }
    if (retry.timedOut) return { host, status: "failed", reason: "install timed out", retried }
  }

  if (install.output.includes("NO_OPENCODE")) return { host, status: "skipped", reason: "no opencode", retried }
  if (install.timedOut) return { host, status: "failed", reason: "install timed out", retried }
  if (!install.ok) {
    const detail = installDetail(install)
    const exitReason = `install exit ${install.status ?? "unknown"}`
    return { host, status: "failed", reason: detail ? `${exitReason}: ${detail}` : exitReason, retried }
  }

  const disabledShims = disableShims(host)

  const read = runSsh(host, REMOTE_READ)
  if (!read.ok) return { host, status: "failed", reason: "cannot read config", shims: disabledShims, retried }
  let config
  try {
    config = parseJsonc(read.output)
  } catch {
    return { host, status: "failed", reason: "config not normalized (unparseable)", shims: disabledShims, retried }
  }

  const next = normalizeConfig(config, version)
  if (!next) return { host, status: "failed", reason: "config not normalized (unparseable)", shims: disabledShims, retried }
  if (JSON.stringify(config) !== JSON.stringify(next)) {
    const backup = runSsh(host, REMOTE_BACKUP)
    if (!backup.ok) return { host, status: "failed", reason: "backup failed", shims: disabledShims, retried }
    const body = JSON.stringify(next, null, 2) + "\n"
    const write = runSsh(host, REMOTE_WRITE, body)
    if (!write.ok) return { host, status: "failed", reason: "write failed", shims: disabledShims, retried }
  }

  const verify = runSsh(host, REMOTE_READ)
  if (!verify.ok) return { host, status: "failed", reason: "verification failed", shims: disabledShims, retried }
  let after
  try {
    after = parseJsonc(verify.output)
  } catch {
    return { host, status: "failed", reason: "verification failed (unparseable)", shims: disabledShims, retried }
  }

  const expected = `${PACKAGE}@${version}`
  const plugin = after && Array.isArray(after.plugin) ? after.plugin : []
  const lacode = plugin.filter(isLacodeEntry)
  if (lacode.length !== 1 || specifierOf(lacode[0]) !== expected) {
    return { host, status: "failed", reason: "verification failed", shims: disabledShims, retried }
  }

  let authText = null
  let authFailed = false
  if (auth) {
    const replace = (opts && Array.isArray(opts.replace))
      ? opts.replace
      : String((process.env.OC_AUTH_PROVIDERS || "opencode-go opencode")).split(/\s+/).filter(Boolean)
    const authResult = syncAuth(host, auth, { replace: replace, dryRun: !!(opts && opts.dryRun) })
    authText = authResult.text
    authFailed = !authResult.ok
  }

  if (authFailed) {
    return { host, status: "warn", reason: authText, shims: disabledShims, retried, auth: null }
  }

  const capability = runSsh(host, REMOTE_HELPER_CHECK)
  if (capability.output.includes("HELPER_OK")) return { host, status: "ok", shims: disabledShims, retried, auth: authText }
  if (capability.output.includes("HELPER_UNUSABLE")) {
    return {
      host,
      status: "warn",
      reason: `helper cannot run: ${helperDetail(capability.output)}; install node>=22 or a ~/bin/lacode wrapper`,
      shims: disabledShims,
      retried,
      auth: authText,
    }
  }
  return {
    host,
    status: "warn",
    reason: "helper cannot run: capability check failed; install node>=22 or a ~/bin/lacode wrapper",
    shims: disabledShims,
    retried,
    auth: authText,
  }
}

function printDryRun(hosts, version) {
  for (const host of hosts) {
    console.log(`${host}: would run`)
    console.log(`  ${formatSsh(host, installRemote(version))}`)
    console.log(`  ${formatSsh(host, REMOTE_READ)}`)
    console.log(`  ${formatSsh(host, REMOTE_BACKUP)}`)
    console.log(`  ${formatSsh(host, REMOTE_WRITE)}`)
    console.log(`  ${formatSsh(host, REMOTE_READ)}`)
    console.log(`  ${formatSsh(host, REMOTE_LIST_PLUGINS)}`)
    console.log(`  ${formatSsh(host, 'mv "$HOME/.config/opencode/plugins/<shim>" "$HOME/.config/opencode/lacode-plugin-shim.disabled-<epoch>-<shim>"')}`)
    console.log(`  ${formatSsh(host, "python3 -c '<auth helper>'")}`)
    console.log(`  ${formatSsh(host, REMOTE_HELPER_CHECK)}`)
  }
  console.log(`dry run: ${hosts.length} host${hosts.length === 1 ? "" : "s"}, nothing was run`)
}

export { cleanupRemote }
export { loadLocalAuth, syncAuth, syncHost, hostList, splitHosts, readEnvHosts, readEnvValue }

export function main(env = process.env) {
  const disabled = env.LACODE_SYNC
  if (disabled !== undefined && DISABLED_VALUES.has(String(disabled).trim().toLowerCase())) {
    console.log(`lacode sync: disabled (LACODE_SYNC=${disabled})`)
    return 0
  }

  const hosts = hostList(env)
  if (hosts.length === 0) {
    console.log("lacode sync: no hosts configured")
    return 0
  }

  const auth = loadLocalAuth(env)

  const version = readPackageVersion(env)
  if (!version) {
    console.log("lacode sync: package version is unknown; skipping")
    return 0
  }

  const envFile = env.OC_SYNC_ENV_FILE || envFileDefault()
  const authProviders = env.OC_AUTH_PROVIDERS ?? readEnvValue(envFile, "OC_AUTH_PROVIDERS") ?? "opencode-go opencode"
  const replace = authProviders.split(/\s+/).filter(Boolean)

  const seconds = waitSeconds(env)

  if (env.LACODE_SYNC_DRY_RUN === "1") {
    if (noWait(env)) {
      console.log(`dry run: would not wait for ${PACKAGE}@${version} in the registry (LACODE_SYNC_NO_WAIT=1)`)
    } else {
      console.log(`dry run: would wait for ${PACKAGE}@${version} in the registry (up to ${seconds}s)`)
    }
    printDryRun(hosts, version)
    // A dry run must not touch a host. It used to call `syncAuth()` for every
    // host whenever a local auth store existed, which opened real SSH
    // connections and sent provider credentials under a "runs nothing" banner.
    // Print the local half of the plan instead; provider NAMES only, never keys.
    if (auth) {
      const providers = Object.keys(auth).sort()
      console.log(
        `auth: would sync ${providers.length} provider${providers.length === 1 ? "" : "s"} (${providers.join(", ") || "none"}); dry run contacts no host`,
      )
    } else {
      console.log("auth: no local auth store; nothing would be synced")
    }
    return 0
  }

  if (!noWait(env)) waitForRegistry(version, seconds)

  const results = hosts.map((host) => syncHost(host, version, auth, { replace: replace }))

  console.log("")
  for (const result of results) {
    if (Array.isArray(result.shims)) {
      const shims = result.shims
      if (shims.length > 0) {
        for (const name of shims) console.log(`${result.host}: shim disabled: ${name}`)
      } else {
        console.log(`${result.host}: no stale shim`)
      }
    }
    if (result.status === "ok") {
      console.log(`${result.host}: ok`)
      if (result.retried) console.log(`${result.host}: retried after clearing the installer cache`)
      if (result.auth) console.log(`${result.host}: ${result.auth}`)
    } else if (result.status === "warn") {
      console.log(`${result.host}: warn (${result.reason})`)
      if (result.auth) console.log(`${result.host}: ${result.auth}`)
    } else if (result.status === "skipped") console.log(`${result.host}: skipped (${result.reason})`)
    else console.log(`${result.host}: failed (${result.reason})`)
  }

  const ok = results.filter((result) => result.status === "ok").length
  const warn = results.filter((result) => result.status === "warn").length
  const skipped = results.filter((result) => result.status === "skipped").length
  const failed = results.filter((result) => result.status === "failed").length
  console.log(
    `summary: ${ok} ok, ${warn} warn, ${skipped} skipped, ${failed} failed (${results.length} host${results.length === 1 ? "" : "s"})`,
  )

  return failed > 0 && env.LACODE_SYNC_STRICT === "1" ? 1 : 0
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    process.exitCode = main()
  } catch {
    // Never print the thrown value: a JSON.parse error can quote the config,
    // and the config can contain provider credentials. A publish also must not
    // fail on an unexpected error unless the caller asked for strict mode.
    console.log("lacode sync: failed (unexpected error)")
    process.exitCode = process.env.LACODE_SYNC_STRICT === "1" ? 1 : 0
  }
}
