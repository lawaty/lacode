import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, cleanupAll, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const LaCode = (await import(join(ROOT, "src", "index.ts"))).default

async function injected() {
  const stub = stubInput()
  const hooks = await LaCode(stub.input)
  const cfg = { agent: {} }
  await hooks.config(cfg)
  await hooks.dispose()
  return cfg
}

const WEB_AGENTS = ["build", "plan", "explore", "implement", "instructions"]

test("[US-44] build, plan, explore, implement, instructions grant webfetch and websearch", async () => {
  const cfg = await injected()
  for (const name of WEB_AGENTS) {
    const agent = cfg.agent[name]
    assert.ok(agent, `${name} must be injected`)
    assert.equal(agent.permission?.webfetch, "allow", `${name}.permission.webfetch must be allow`)
    assert.equal(agent.permission?.websearch, "allow", `${name}.permission.websearch must be allow`)
  }
})

test("[US-44] build prompt requires explicit per-request web permission and does not claim web is denied", async () => {
  const cfg = await injected()
  const prompt = String(cfg.agent.build?.prompt ?? "")
  assert.match(prompt, /webfetch/, "build prompt must name webfetch")
  assert.match(prompt, /websearch/, "build prompt must name websearch")
  assert.match(prompt, /explicitly grants?\s+permission\s+for\s+the\s+current\s+request/i, "build prompt must require explicit per-request permission")
  assert.doesNotMatch(prompt, /cannot fetch\s*\n?\s*or search the web\. Those tools are denied by configuration/i, "build prompt must not claim web is denied")
  assert.doesNotMatch(prompt, /cannot\s+fetch\s+or\s+search\s+the\s+web/i, "build prompt must not claim web cannot be used")
})

test("[US-44] .opencode/prompts/build.txt requires explicit per-request web permission", () => {
  const prompt = readFileSync(join(ROOT, ".opencode", "prompts", "build.txt"), "utf8")
  assert.match(prompt, /webfetch/, "build.txt must name webfetch")
  assert.match(prompt, /websearch/, "build.txt must name websearch")
  assert.match(prompt, /explicitly grants?\s+permission\s+for\s+the\s+current\s+request/i, "build.txt must require explicit per-request permission")
  assert.doesNotMatch(prompt, /cannot\s+fetch\s+or\s+search\s+the\s+web/i, "build.txt must not claim web is denied")
})

test("[US-44] web access does not broaden read/glob/grep/list for root agents", async () => {
  const cfg = await injected()
  for (const name of ["build", "plan"]) {
    const agent = cfg.agent[name]
    assert.ok(agent, `${name} must be injected`)
    for (const tool of ["read", "glob", "grep", "list"]) {
      assert.equal(agent.permission?.[tool], "deny", `${name}.permission.${tool} must remain deny`)
    }
  }
})
