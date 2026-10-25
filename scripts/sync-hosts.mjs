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

function syncHost(host, version) {
  const install = runSsh(host, installRemote(version), undefined, INSTALL_TIMEOUT_MS)
  if (install.output.includes("NO_OPENCODE")) return { host, status: "skipped", reason: "no opencode" }
  if (install.timedOut) return { host, status: "failed", reason: "install timed out" }
  if (!install.ok) return { host, status: "failed", reason: `install exit ${install.status ?? "unknown"}` }

  const disabledShims = disableShims(host)

  const read = runSsh(host, REMOTE_READ)
  if (!read.ok) return { host, status: "failed", reason: "cannot read config", shims: disabledShims }

  let config
  try {
    config = JSON.parse(read.output)
  } catch {
    return { host, status: "failed", reason: "config not normalized (unparseable)", shims: disabledShims }
  }

  const next = normalizeConfig(config, version)
  if (!next) return { host, status: "failed", reason: "config not normalized (unparseable)", shims: disabledShims }

  if (JSON.stringify(config) !== JSON.stringify(next)) {
    const backup = runSsh(host, REMOTE_BACKUP)
    if (!backup.ok) return { host, status: "failed", reason: "backup failed", shims: disabledShims }

    const body = JSON.stringify(next, null, 2) + "\n"
    const write = runSsh(host, REMOTE_WRITE, body)
    if (!write.ok) return { host, status: "failed", reason: "write failed", shims: disabledShims }
  }

  const verify = runSsh(host, REMOTE_READ)
  if (!verify.ok) return { host, status: "failed", reason: "verification failed", shims: disabledShims }

  let after
  try {
    after = JSON.parse(verify.output)
  } catch {
    return { host, status: "failed", reason: "verification failed (unparseable)", shims: disabledShims }
  }

  const expected = `${PACKAGE}@${version}`
  const plugin = after && Array.isArray(after.plugin) ? after.plugin : []
  const lacode = plugin.filter(isLacodeEntry)
  if (lacode.length !== 1 || specifierOf(lacode[0]) !== expected) {
    return { host, status: "failed", reason: "verification failed", shims: disabledShims }
  }

  const capability = runSsh(host, REMOTE_HELPER_CHECK)
  if (capability.output.includes("HELPER_OK")) return { host, status: "ok", shims: disabledShims }
  if (capability.output.includes("HELPER_UNUSABLE")) {
    return {
      host,
      status: "warn",
      reason: `helper cannot run: ${helperDetail(capability.output)}; install node>=22 or a ~/bin/lacode wrapper`,
      shims: disabledShims,
    }
  }
  return {
    host,
    status: "warn",
    reason: "helper cannot run: capability check failed; install node>=22 or a ~/bin/lacode wrapper",
    shims: disabledShims,
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
    console.log(`  ${formatSsh(host, REMOTE_HELPER_CHECK)}`)
  }
  console.log(`dry run: ${hosts.length} host${hosts.length === 1 ? "" : "s"}, nothing was run`)
}

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

  const version = readPackageVersion(env)
  if (!version) {
    console.log("lacode sync: package version is unknown; skipping")
    return 0
  }

  if (env.LACODE_SYNC_DRY_RUN === "1") {
    printDryRun(hosts, version)
    return 0
  }

  const results = hosts.map((host) => syncHost(host, version))

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
    if (result.status === "ok") console.log(`${result.host}: ok`)
    else if (result.status === "warn") console.log(`${result.host}: warn (${result.reason})`)
    else if (result.status === "skipped") console.log(`${result.host}: skipped (${result.reason})`)
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
