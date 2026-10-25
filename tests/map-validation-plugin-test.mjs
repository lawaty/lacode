// Integration test for the map contract in the REAL autoupdate hook.
//
// Unit tests (tests/map-schema-test.mjs) pin the validator and the lifecycle as
// pure functions. This file pins the wiring that a pure function cannot:
//
//   * a completed cartographer run is followed by the per-file lifecycle sweep
//     and a validation pass;
//   * a validation failure is a LOUD error in the log, not a silent success;
//   * the validator is REPORT-ONLY: corrupt map content on disk is still there
//     after the run, because it may be the only copy and the page owner has to
//     resolve the disagreement;
//   * the old provisional entry is removed by the sweep while the binding one
//     survives -- the active-backlog window generalised to every map file;
//   * the user message the cartographer is handed repeats the entry contract.
//
// Mirrors the boot in tests/active-backlog-plugin-test.mjs: the real factory, a
// stub client, a temp project root, a temp HOME (so the pool never touches the
// developer's data dir) and modelsFile pinned to the bundled preset.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { contextAutoUpdateHooks } from "../src/plugins/context-autoupdate.ts"
import { PRESET, cleanupAll, scratch, settle, stubInput } from "./stories/_harness.mjs"

test.after(cleanupAll)

const DAY_MS = 24 * 60 * 60 * 1000
const TODAY = new Date().toISOString().slice(0, 10)
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)

const withHome = async (home, fn) => {
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
}

const write = (root, name, text) => {
  const file = join(root, name)
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, text)
}

/** A conforming map, so the only violations in the run are the ones we inject. */
const validMap = () => ({
  "architecture.md": [
    "# Architecture",
    "",
    `- [binding] The app has one entry point and one store. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    `- [binding] The entry point never writes durable state. — See \`src/app.ts\` (verified ${TODAY})`,
    `- [binding] The store is the only writer. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    `- [binding] The boundary between the two must not be collapsed. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    "",
  ].join("\n"),
  "contexts.md": [
    "# Contexts",
    "",
    `- [binding] Entry point: admission only; start at \`src/app.ts\`. — See \`src/app.ts\` (verified ${TODAY})`,
    `- [binding] Store: durable state only. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    `- [binding] The boundary must not be collapsed. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    "",
  ].join("\n"),
  "conventions.md": [
    "# Conventions",
    "",
    `- [binding] Read the owning page before changing a boundary. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    `- [binding] Never write durable state from the entry point. — See \`src/app.ts\` (verified ${TODAY})`,
    `- [binding] Keep the store the only writer. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    "",
  ].join("\n"),
  "workflows.md": [
    "# Workflows",
    "",
    `- [binding] A request is admitted then applied by the store. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    `- [binding] The store applies the mutation, never the entry point. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    "",
  ].join("\n"),
  "decisions.md": [
    "# Decisions",
    "",
    `- [binding] The app stays split so the entry point can be replaced. — See \`docs/DESIGN.md\` §The shape (verified ${TODAY})`,
    `- [provisional] The boundary may be revisited after the first release. — See \`docs/DESIGN.md\` §The shape (verified ${daysAgo(45)})`,
    "",
  ].join("\n"),
  "active.md": ["# Active backlog", "", "## 2026-W43", "", "- [ ] Ship the split — opened 2026-W43", ""].join("\n"),
})

test("a completed run applies the lifecycle, validates, reports and never rewrites a disagreement", async () => {
  const root = scratch("map-plugin-proj-")
  const map = join(root, ".opencode", "context")
  mkdirSync(map, { recursive: true })
  write(root, "docs/DESIGN.md", "# Design\n\n## The shape\n\nThe entry point admits requests and the store applies mutations.\n")
  write(root, "src/app.ts", "export const admit = (request: string) => request\n")
  const stub = stubInput({ sessions: { root: { id: "root", title: "main" } }, directory: root })
  const home = scratch("map-plugin-home-")
  const hooks = await withHome(home, () => contextAutoUpdateHooks(stub.input, { modelsFile: PRESET }))

  // Write the map AFTER boot: the factory applies the lifecycle at boot, and a
  // fixture written earlier would be pruned there, hiding the post-run sweep
  // this test is about.
  for (const [name, text] of Object.entries(validMap())) writeFileSync(join(map, name), text)

  // Simulate the cartographer: it writes a map with a table (restatement), a
  // dangling pointer (unarchived) and archive-of-record language. The lifecycle
  // must still drop the expired provisional entry in decisions.md.
  stub.client.session.prompt = async (input) => {
    stub.prompts.push(input)
    writeFileSync(
      join(map, "architecture.md"),
      [
        "# Architecture",
        "",
        "| Field | Length |",
        "| --- | --- |",
        "| a | 4 |",
        "",
        `- [binding] A retired fact survives only here. — See \`docs/GONE.md\` §Gone (verified ${TODAY})`,
        "",
      ].join("\n"),
    )
    return { data: { info: {} } }
  }

  await hooks.event({ event: { type: "file.edited", properties: { file: "src/app.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await settle(150)

  const text = stub.text().join("\n")
  assert.ok(text.includes("context map validation failed"), `validation must fail loudly:\n${text}`)
  const failure = stub.lines.find((line) => line.message.startsWith("context map validation failed"))
  assert.equal(failure.level, "error")
  const issues = failure.extra.issues.join("\n")
  assert.ok(issues.includes("[restatement]"), `the table must be reported:\n${issues}`)
  assert.ok(issues.includes("[dangling]"), `the missing source must be reported:\n${issues}`)
  assert.ok(issues.includes("[archive]") || issues.includes("[unarchived]"), `archive/unarchived must be reported:\n${issues}`)

  // REPORT-ONLY: the corrupt content is still on disk. Deleting it would destroy
  // the only copy; the owner of the page resolves the contradiction.
  const architecture = readFileSync(join(map, "architecture.md"), "utf8")
  assert.ok(architecture.includes("| Field | Length |"), "the validator must not rewrite the map")
  assert.ok(architecture.includes("docs/GONE.md"), "a dangling entry must be kept")
  assert.ok(architecture.includes("retired fact survives only here"), "unarchived content must be kept")

  // The lifecycle did run: the 45-day-old provisional entry is gone, the
  // binding constraint stays.
  const decisions = readFileSync(join(map, "decisions.md"), "utf8")
  assert.ok(!decisions.includes("may be revisited"), "an expired provisional entry must be dropped")
  assert.ok(decisions.includes("The app stays split"), "a binding constraint is exempt from age")
  assert.ok(text.includes("map lifecycle: dropped 1 expired provisional entry from decisions.md"), text)

  // The user message repeats the contract, so a resumed run is told the shape.
  assert.ok(stub.prompts.length === 1)
  const prompt = stub.prompts[0].body.parts[0].text
  assert.ok(prompt.includes("[binding|provisional|disputed]"), prompt)
  assert.ok(prompt.includes("drift pass"), prompt)
})
