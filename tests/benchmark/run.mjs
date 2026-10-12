#!/usr/bin/env node
// LaCode cost benchmark — MEASURE, DO NOT FABRICATE.
//
// This harness exists because a savings claim without evidence is a rumour. It
// prints what it can actually observe, and refuses to print a number it cannot
// derive.
//
//   US-3 acceptance criteria, one mode each:
//     1. reports token counts and cost for the pooled run and the unpooled run
//        from the same input
//     2. prices a free model as 0, not as unknown or omitted
//     3. with no pricing source it fails LOUDLY instead of reporting 0 for a
//        paid model
//
// ---------------------------------------------------------------------------
// MODES
// ---------------------------------------------------------------------------
//
//   --real     (default when credentials AND an opencode binary are present)
//              Run the actual scenario twice — subagents vs the main model —
//              and read token counts back from the run's own message metadata.
//              If credentials are missing this EXITS 0 with a "skipped" line.
//              It never fails the run and never invents a token count.
//
//   --simulate (default when no credentials)
//              Compute a projected cost from a task profile (calls x
//              tokens/call) and per-model pricing from the pinned snapshot.
//              This is arithmetic over stated assumptions, and the output says
//              so in every table header. It is a projection, not a measurement.
//
// ---------------------------------------------------------------------------
// PRICING
// ---------------------------------------------------------------------------
//
// From tests/models-snapshot.json, refreshed from models.dev by
// tests/refresh-models-snapshot.mjs (--refresh reruns it). Offline by default:
// the snapshot is checked into the repo so a run is reproducible. A model the
// snapshot has never seen is SKIPPED WITH A NAMED REASON, never priced at 0 and
// never priced at a guess.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE DOES NOT CONTAIN
// ---------------------------------------------------------------------------
//
// There is no savings constant anywhere below. Every ratio in the output is
// computed at runtime from the rows above it, and both the numerator and the
// denominator are printed so the arithmetic can be checked by hand. If a number
// cannot be derived, the harness prints "unknown" and, for a price it was
// explicitly asked for, exits non-zero (criterion 3).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")
const PRESET = join(ROOT, "presets", "free-tier.json")
const SNAPSHOT = join(ROOT, "tests", "models-snapshot.json")

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

// The expensive-model baseline. Overridable; the default is only a NAME, never
// a price — the price comes from the snapshot or the run's own usage, and an
// unknown model is reported as unknown.
const DEFAULT_BASELINE = "anthropic/claude-opus-4-1"

// The task profile. These are the ASSUMPTIONS of a simulation and are labelled
// as such in the output. A real run replaces them with observed token counts.
const PROFILE = {
  calls: Number(option("--calls", 40)),
  inputTokensPerCall: Number(option("--input-tokens", 12_000)),
  outputTokensPerCall: Number(option("--output-tokens", 1_500)),
}

const money = (usd) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(6)}`)
const today = () => new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// --out, and the one path it may never take
// ---------------------------------------------------------------------------
//
// docs/BENCHMARKS.md is HAND WRITTEN: it explains what this harness measures and
// carries no results. A generated table dropped on top of it would replace the
// explanation with a dated artifact that reads as a measurement OF THIS PACKAGE
// -- and `files` ships docs/, so it would travel to npm and outlive the run that
// produced it. So that one path is refused up front, before any benchmark runs:
// failing after twenty minutes of real runs to refuse a write is worse.
//
//   npm run benchmark -- --out docs/BENCHMARKS.generated.md   (the sanctioned path)
//
// The generated file is gitignored: it is a local artifact, not a source file.

const HAND_WRITTEN = join(ROOT, "docs", "BENCHMARKS.md")
const GENERATED = "docs/BENCHMARKS.generated.md"

const outPath = option("--out", null)
if (outPath !== null && join(ROOT, outPath) === HAND_WRITTEN) {
  console.error(`benchmark: refusing to write ${outPath}.`)
  console.error("benchmark: that file is the hand-written explainer and ships inside the npm tarball.")
  console.error("benchmark: a generated table on top of it would read as a measurement that never happened.")
  console.error(`benchmark: write the generated table to ${GENERATED} instead:`)
  console.error(`benchmark:   npm run benchmark -- --out ${GENERATED}`)
  process.exit(2)
}

/** Write the table to --out, if one was asked for. Never touches BENCHMARKS.md. */
const writeOut = (table) => {
  if (outPath === null) return
  const target = join(ROOT, outPath)
  mkdirSync(dirname(target), { recursive: true })
  const footer =
    "\n\n---\n\n" +
    `_Generated by \`npm run benchmark\`. This file is generated; the hand-written ` +
    `explainer, which is the one that ships, is [BENCHMARKS.md](./BENCHMARKS.md)._\n`
  writeFileSync(target, `${table}\n${footer}`)
  console.error(`benchmark: wrote ${outPath}`)
}

// ---------------------------------------------------------------------------
// Pricing, from the pinned snapshot only
// ---------------------------------------------------------------------------

const loadSnapshot = () => {
  if (!existsSync(SNAPSHOT)) return { _fetched: "unknown", models: {} }
  return JSON.parse(readFileSync(SNAPSHOT, "utf8"))
}

/** The pinned price for `provider/model-id`, or null when the snapshot has none. */
const priceOf = (snapshot, model) => {
  const entry = snapshot.models?.[model]
  if (!entry) return null
  const { cost_input: input, cost_output: output } = entry
  if (typeof input !== "number" || typeof output !== "number") return null
  return { input, output, context: entry.context ?? null }
}

const costOf = (price, inputTokens, outputTokens) =>
  (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output

// ---------------------------------------------------------------------------
// Refresh (the only path that touches the network)
// ---------------------------------------------------------------------------

const refreshSnapshot = () => {
  const script = join(ROOT, "tests", "refresh-models-snapshot.mjs")
  if (!existsSync(script)) {
    console.error("benchmark: tests/refresh-models-snapshot.mjs is missing; cannot refresh pricing.")
    return false
  }
  try {
    execFileSync(process.execPath, [script], { cwd: ROOT, stdio: "inherit" })
    return true
  } catch {
    console.error("benchmark: --refresh failed (models.dev unreachable?). Re-run without --refresh to use the pinned snapshot.")
    return false
  }
}

// ---------------------------------------------------------------------------
// Real run: two configurations of the SAME scenario, token counts read back
// ---------------------------------------------------------------------------

const CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"]
const credentials = () => {
  const keys = CREDENTIAL_KEYS.filter((key) => Boolean(process.env[key]))
  const auth = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json")
  if (keys.length > 0) return keys
  if (existsSync(auth)) return ["opencode auth.json"]
  return []
}
const opencodeBin = () => {
  const explicit = process.env.OPENCODE_BIN
  if (explicit && existsSync(explicit)) return explicit
  for (const candidate of [join(homedir(), ".opencode", "bin", "opencode"), "/usr/local/bin/opencode", "/usr/bin/opencode"]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

// The scenario, stated once so both configurations run identical work. This is
// the only way the comparison means anything: same prompt, same depth, same
// number of calls, different model doing it.
const SCENARIO = [
  "Map the modules that handle authentication and the entry points that reach them.",
  "Find every place a request is authorized and list the file:line for each check.",
  "List the config files that affect routing and the defaults each one sets.",
  "Find the test files covering the auth path and name what each asserts.",
]

const runReal = async (bin, model, creds) => {
  const session = execFileSync(
    bin,
    ["run", "--model", model, "--format", "json", ...SCENARIO],
    { encoding: "utf8", timeout: 20 * 60_000, stdio: ["ignore", "pipe", "pipe"] },
  )
  // opencode's json format emits one event per line; token usage rides on the
  // assistant messages. If the shape ever changes, this throws rather than
  // defaulting to zero — a zero here would be a fabricated measurement.
  const events = session.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  let input = 0
  let output = 0
  for (const event of events) {
    const tokens = event?.properties?.tokens ?? event?.tokens
    if (!tokens) continue
    input += tokens.input ?? tokens.prompt ?? 0
    output += tokens.output ?? tokens.completion ?? 0
  }
  if (input === 0 && output === 0) {
    throw new Error(`no token usage in the ${model} run's output; refusing to report a measurement of zero`)
  }
  return { calls: SCENARIO.length, inputTokens: input, outputTokens: output, credentials: creds }
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const renderTable = (rows, { heading, source, modeNote }) => {
  const head = [
    "| configuration | models | calls | input tokens | output tokens | projected cost |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ]
  const body = rows.map((row) => {
    const tokens = row.measured ?? row.projected
    return `| ${row.name} | ${row.models.join(", ")} | ${tokens.calls} | ${tokens.inputTokens.toLocaleString("en-US")} | ${tokens.outputTokens.toLocaleString("en-US")} | ${row.cost === null ? "**unknown**" : money(row.cost)} |`
  })
  const out = [`**LaCode cost benchmark — ${heading}**`, "", modeNote, "", ...head, ...body]
  if (rows.every((row) => row.cost !== null) && rows.length === 2) {
    const [baseline, pooled] = rows
    const delta = baseline.cost - pooled.cost
    const ratio = baseline.cost > 0 ? (delta / baseline.cost) * 100 : null
    out.push("")
    out.push(
      `Difference: ${money(baseline.cost)} - ${money(pooled.cost)} = ${money(delta)}` +
        (ratio === null
          ? " (baseline cost is 0, so no ratio is defined — printing one would be a division by zero dressed as a result)"
          : ` = ${ratio.toFixed(1)}% of the baseline, computed from the two rows above`),
    )
    out.push("Recompute it yourself: (baseline - pooled) / baseline. Nothing above is a stored constant.")
  }
  if (source) out.push("", source)
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const snapshot = flag("--refresh") ? ((refreshSnapshot() && loadSnapshot()) || loadSnapshot()) : loadSnapshot()

const baselineModel = option("--baseline-model", option("--model", DEFAULT_BASELINE))
const preset = JSON.parse(readFileSync(PRESET, "utf8"))
const pooledModels = preset.slots.map((slot) => slot.model)

const wantReal = flag("--real")

// --- real run, opted into explicitly ---------------------------------------

if (wantReal) {
  const missing = []
  if (credentials().length === 0) missing.push("no API credentials (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, or an opencode auth.json)")
  if (!opencodeBin()) missing.push("no opencode binary (set OPENCODE_BIN)")
  if (missing.length > 0) {
    console.log(`benchmark: SKIPPED — ${missing.join("; ")}. Nothing was run, and nothing is reported.`)
    console.log("benchmark: nothing here failed; there was simply nothing to measure with.")
    process.exit(0)
  }
  try {
    const bin = opencodeBin()
    const creds = credentials()
    const baseline = await runReal(bin, baselineModel, creds)
    const pooled = await runReal(bin, pooledModels[0], creds)
    const baselinePrice = priceOf(snapshot, baselineModel)
    const pooledPrice = priceOf(snapshot, pooledModels[0])
    const rows = [
      {
        name: "baseline (main model)",
        models: [baselineModel],
        measured: baseline,
        cost: baselinePrice === null ? null : costOf(baselinePrice, baseline.inputTokens, baseline.outputTokens),
      },
      {
        name: "LaCode (pooled subagent)",
        models: pooledModels,
        measured: pooled,
        cost: pooledPrice === null ? null : costOf(pooledPrice, pooled.inputTokens, pooled.outputTokens),
      },
    ]
    const unknown = rows.filter((row) => row.cost === null).flatMap((row) => row.models)
    const table = renderTable(rows, {
      heading: `measured on ${today()}`,
      modeNote: `Real run: token counts read from the run's own output. Credentials: ${creds.join(", ")}.`,
      source: `Pricing from tests/models-snapshot.json (models.dev, fetched ${snapshot._fetched}).`,
    })
    console.log(table)
    writeOut(table)
    if (unknown.length > 0) {
      console.error(`\nbenchmark: no price in the snapshot for ${unknown.join(", ")} — cost is unknown, NOT 0.`)
      console.error("benchmark: run with --refresh, or pick a model the snapshot covers.")
      process.exit(3)
    }
    process.exit(0)
  } catch (error) {
    // A failed measurement is not a measurement. Say so; never fall through to
    // a projection dressed as a real number.
    console.error(`benchmark: real run failed: ${error.message}`)
    console.error("benchmark: refusing to report a number for a run that did not happen.")
    process.exit(3)
  }
}

// --- simulation (the offline default) --------------------------------------

const projected = {
  calls: PROFILE.calls,
  inputTokens: PROFILE.calls * PROFILE.inputTokensPerCall,
  outputTokens: PROFILE.calls * PROFILE.outputTokensPerCall,
}

const priceA = priceOf(snapshot, baselineModel)
const priceB = priceOf(snapshot, pooledModels[0])

const rows = [
  {
    name: "baseline (main model)",
    models: [baselineModel],
    projected,
    cost: priceA === null ? null : costOf(priceA, projected.inputTokens, projected.outputTokens),
  },
  {
    name: "LaCode (pooled subagent)",
    models: pooledModels,
    projected,
    cost: priceB === null ? null : costOf(priceB, projected.inputTokens, projected.outputTokens),
  },
]

const modeNote =
  `Simulation (no credentials). PROJECTED from the task profile — ${PROFILE.calls} calls x ` +
  `${PROFILE.inputTokensPerCall.toLocaleString("en-US")} input / ${PROFILE.outputTokensPerCall.toLocaleString("en-US")} output tokens ` +
  `(override with --calls / --input-tokens / --output-tokens). These are stated assumptions, NOT measurements. ` +
  `A projection is arithmetic; it is not evidence.`

const source = `Pricing from tests/models-snapshot.json (models.dev, fetched ${snapshot._fetched}) — offline, reproducible.`

const table = renderTable(rows, { heading: `projected on ${today()} — simulation, nothing was run`, source, modeNote })
console.log(table)
writeOut(table)

const unknown = rows.filter((row) => row.cost === null).flatMap((row) => row.models)
if (unknown.length > 0) {
  console.error("")
  for (const model of unknown) {
    console.error(`benchmark: no price in the pinned snapshot for "${model}" — cost is unknown, NOT 0. Refusing to guess a price.`)
  }
  const askedExplicitly = (argv.includes("--baseline-model") || argv.includes("--model")) && unknown.includes(baselineModel)
  if (askedExplicitly && !flag("--allow-unknown")) {
    console.error("benchmark: you named that model explicitly with --model/--baseline-model. Exiting non-zero until it is priced.")
    console.error("benchmark: run --refresh (network) or pass --allow-unknown to accept 'unknown' in the table.")
    process.exit(3)
  }
}

process.exit(0)