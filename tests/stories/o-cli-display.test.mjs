// Epic O -- CLI presentation contracts.
//
//   US-45  CLI display helpers keep machine-readable output clean and
//          human feedback on the right channel
//
// These tests pin observable CLI behavior: no ANSI escapes in piped output,
// NO_COLOR/FORCE_COLOR handling, progress on stderr, stdout purity for
// machine-consumed modes, and JSON modes staying parseable.

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const ANSI_RE = /\x1b\[/

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    input: options.input,
    timeout: options.timeout ?? 30000,
  })
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`
}

test("[US-45] piped CLI output has no ANSI escape codes", () => {
  const helpTargets = [
    ["scripts/score-models.mjs", "--help"],
    ["scripts/refresh-pool.mjs", "--help"],
  ]

  for (const args of helpTargets) {
    const result = runNode(args)
    assert.equal(result.status, 0, `${args.join(" ")} failed:\n${combinedOutput(result)}`)
    const output = combinedOutput(result)
    assert.doesNotMatch(output, ANSI_RE, `${args.join(" ")} emitted ANSI escapes:\n${output}`)
    assert.ok(output.length > 0, `${args.join(" ")} produced no output`)
  }
})

test("[US-45] NO_COLOR suppresses color", () => {
  const moduleUrl = pathToFileURL(join(ROOT, "scripts/cli-display.mjs")).href
  const code = `import { c } from ${JSON.stringify(moduleUrl)}; process.stdout.write(c.red("x"))`
  const env = { ...process.env, NO_COLOR: "1" }
  delete env.FORCE_COLOR
  const result = runNode(["--input-type=module", "-e", code], { env })

  assert.equal(result.status, 0, `child failed:\n${combinedOutput(result)}`)
  assert.equal(result.stdout, "x")
  assert.doesNotMatch(combinedOutput(result), ANSI_RE)
})

test("[US-45] FORCE_COLOR enables color", () => {
  const moduleUrl = pathToFileURL(join(ROOT, "scripts/cli-display.mjs")).href
  const code = `import { c } from ${JSON.stringify(moduleUrl)}; process.stdout.write(c.red("x"))`
  const result = runNode(["--input-type=module", "-e", code], {
    env: { FORCE_COLOR: "1" },
  })

  assert.equal(result.status, 0, `child failed:\n${combinedOutput(result)}`)
  assert.match(result.stdout, ANSI_RE, `expected ANSI output, got ${JSON.stringify(result.stdout)}`)
  assert.match(result.stdout, /x/)
})

test("[US-45] progress and headings go to stderr, not stdout", () => {
  const moduleUrl = pathToFileURL(join(ROOT, "scripts/cli-display.mjs")).href
  const code = [
    `import { createProgress } from ${JSON.stringify(moduleUrl)}`,
    "const progress = createProgress({ total: 2, label: 'x' })",
    "progress.update(1, 'step')",
    "progress.done('finished')",
  ].join("; ")
  const result = runNode(["--input-type=module", "-e", code])

  assert.equal(result.status, 0, `child failed:\n${combinedOutput(result)}`)
  assert.equal(result.stdout, "", `stdout should be empty, got ${JSON.stringify(result.stdout)}`)
  assert.match(result.stderr, /finished/, `stderr missing finished:\n${result.stderr}`)
})

test("[US-45] refresh-pool --print keeps stdout to pool text", () => {
  const home = mkdtempSync(join(tmpdir(), "us45-refresh-"))
  try {
    const conf = join(home, ".config", "lacode")
    mkdirSync(conf, { recursive: true })
    const scoresPath = join(conf, "model-scores.json")
    const poolPath = join(conf, "pool.txt")
    writeFileSync(
      scoresPath,
      JSON.stringify({
        generatedAt: "2026-11-06T03:41:14.089Z",
        providers: [],
        selection: [
          { model: "opencode-go/beam-free", weight: 4, context: 1048576 },
          { model: "opencode-go/crouton-alpha-free", weight: 4, context: 1048576 },
          { model: "opencode-go/iceman-contributor-free", weight: 4, context: 262144 },
          { model: "openrouter/cohere/north-mini-code:free", weight: 2, context: 256000 },
          { model: "console-openrouter/cohere/north-mini-code:free", weight: 2, context: 256000 },
          { model: "opencode/crouton-alpha-free", weight: 2, bucket: "opencode", context: 1048576 },
        ],
        warnings: [],
      }),
    )
    writeFileSync(poolPath, "# existing pool\nopencode-go/old  4\n")

    const result = runNode([
      "scripts/refresh-pool.mjs",
      "--print",
      "--from-scores",
      "--scores",
      scoresPath,
      "--pool",
      poolPath,
    ], { env: { HOME: home } })

    assert.equal(result.status, 0, `refresh-pool --print failed:\n${combinedOutput(result)}`)
    assert.match(result.stdout, /opencode-go\/beam-free\s+4/, `stdout missing pool slot:\n${result.stdout}`)
    assert.doesNotMatch(result.stdout, /Refreshing pool|Writing pool/, `stdout contains human heading:\n${result.stdout}`)
    assert.match(result.stderr, /--print: proposed/, `stderr missing print summary:\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, ANSI_RE, `stdout emitted ANSI:\n${result.stdout}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("[US-45] provider-status --json remains valid JSON", (t) => {
  const result = runNode(["scripts/provider-status.mjs", "--json"], { timeout: 20000 })

  if (result.status !== 0) {
    const output = combinedOutput(result)
    if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|fetch failed/i.test(output)) {
      t.skip(`provider-status needs network: ${output.slice(0, 200)}`)
      return
    }
  }

  assert.equal(result.status, 0, `provider-status --json failed:\n${combinedOutput(result)}`)
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    const output = combinedOutput(result)
    if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|fetch failed/i.test(output)) {
      t.skip(`provider-status needs network: ${output.slice(0, 200)}`)
      return
    }
    throw error
  }
  assert.equal(typeof parsed, "object")
  assert.ok(parsed !== null)
})

test("[US-45] context-map-fixture --json remains valid JSON", (t) => {
  const result = runNode(["scripts/context-map-fixture.mjs", "small", "--json"], { timeout: 60000 })

  if (result.status !== 0) {
    const output = combinedOutput(result)
    if (/ERR_UNKNOWN_FILE_EXTENSION|ERR_MODULE_NOT_FOUND|Cannot find module|loader|tsx|ts-node/i.test(output)) {
      t.skip(`context-map-fixture requires TS loader in this environment: ${output.slice(0, 200)}`)
      return
    }
  }

  assert.equal(result.status, 0, `context-map-fixture --json failed:\n${combinedOutput(result)}`)
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    const output = combinedOutput(result)
    if (/ERR_UNKNOWN_FILE_EXTENSION|ERR_MODULE_NOT_FOUND|Cannot find module|loader|tsx|ts-node/i.test(output)) {
      t.skip(`context-map-fixture requires TS loader in this environment: ${output.slice(0, 200)}`)
      return
    }
    throw error
  }
  assert.equal(typeof parsed, "object")
  assert.ok(parsed !== null)
  assert.doesNotMatch(result.stdout, /=== small ===/, `stdout contains styled heading:\n${result.stdout}`)
})
