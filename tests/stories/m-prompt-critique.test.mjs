import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { ROOT, cleanupAll, stubInput } from "./_harness.mjs"

import {
  PROMPT_CRITIQUE_INSTRUCTION,
  PROMPT_CRITIQUE_MARKER,
} from "../../src/lib/prompt-critique.ts"

test.after(cleanupAll)

const LaCode = (await import(join(ROOT, "src", "index.ts"))).default
const ALLOWED = new Set(["build", "plan", "basic", "expert"])

async function injected(options, seed = {}) {
  const stub = stubInput()
  const hooks = await LaCode(stub.input, options)
  const cfg = { agent: { ...seed } }
  await hooks.config(cfg)
  await hooks.dispose()
  return cfg
}

test("[US-42] prompt critique is off by default and no prompt carries the marker", async () => {
  const cfg = await injected()
  for (const [name, def] of Object.entries(cfg.agent)) {
    assert.ok(
      !String(def.prompt ?? "").includes(PROMPT_CRITIQUE_MARKER),
      `${name} must not carry the critique marker when the option is absent`,
    )
  }
})

test("[US-42] when enabled it prefixes build and plan and keeps their original text", async () => {
  const cfg = await injected({ promptCritique: true })
  for (const name of ["build", "plan"]) {
    assert.ok(cfg.agent[name], `${name} must be injected`)
    assert.ok(
      cfg.agent[name].prompt.startsWith(PROMPT_CRITIQUE_MARKER),
      `${name} must start with the critique marker`,
    )
    assert.ok(
      cfg.agent[name].prompt.length > PROMPT_CRITIQUE_INSTRUCTION.length,
      `${name} must still carry its original prompt after the prefix`,
    )
  }
})

test("[US-42] when enabled it prefixes user-defined planner agents basic and expert", async () => {
  const cfg = await injected({ promptCritique: true }, {
    basic: { description: "basic", mode: "primary", prompt: "BASIC ORIGINAL" },
    expert: { description: "expert", mode: "primary", prompt: "EXPERT ORIGINAL" },
  })
  assert.ok(cfg.agent.basic.prompt.startsWith(PROMPT_CRITIQUE_MARKER))
  assert.match(cfg.agent.basic.prompt, /BASIC ORIGINAL$/)
  assert.ok(cfg.agent.expert.prompt.startsWith(PROMPT_CRITIQUE_MARKER))
  assert.match(cfg.agent.expert.prompt, /EXPERT ORIGINAL$/)
})

test("[US-42] when enabled subagents and pooled variants are left untouched", async () => {
  const cfg = await injected({ promptCritique: true })
  for (const [name, def] of Object.entries(cfg.agent)) {
    if (ALLOWED.has(name)) continue
    assert.ok(
      !String(def.prompt ?? "").includes(PROMPT_CRITIQUE_MARKER),
      `${name} must not carry the critique marker`,
    )
  }
})

test("[US-42] running the config hook twice does not duplicate the instruction", async () => {
  const stub = stubInput()
  const hooks = await LaCode(stub.input, { promptCritique: true })
  const cfg = { agent: {} }
  await hooks.config(cfg)
  const once = cfg.agent.build.prompt
  await hooks.config(cfg)
  assert.equal(cfg.agent.build.prompt, once, "the second config pass must be a no-op")
  assert.equal(
    cfg.agent.build.prompt.split(PROMPT_CRITIQUE_MARKER).length - 1,
    1,
    "the marker must appear exactly once",
  )
  await hooks.dispose()
})
