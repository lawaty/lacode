// Regression: `bind()` (and the config hook) must never await `provider.list`.
//
// Previously `bind()` called `await refreshProviders(true)`, which invoked
// `client.provider.list` during opencode's config hook and deadlocked startup.
// That call is gone; this test fails if it (or any awaited provider.list during
// config) comes back.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { shippedConfig } from "./fixtures/config.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, "..", "src", "plugins", "agent-pool.ts")
const cfg = shippedConfig()

const { agentPoolHooks: AgentPool } = await import(PLUGIN)

test("config hook does not await provider.list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-bind-hang-"))
  let providerListCalls = 0
  const logs = []
  const client = {
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      abort: async () => ({ data: true, response: { ok: true, status: 200 }, error: undefined, request: undefined }),
    },
    provider: {
      list: () => {
        providerListCalls++
        // A promise that never resolves: if the config hook awaits it, the race
        // below times out and the test fails.
        return new Promise(() => {})
      },
    },
  }

  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, { id: "bind-hang", dir })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("config hook hung on provider.list")), 1000)
  })

  try {
    await Promise.race([hooks.config(cfg), timeout])
    assert.equal(providerListCalls, 0, "config must not call provider.list at all")
  } finally {
    clearTimeout(timer)
    try {
      await hooks.dispose()
    } catch {
      /* best-effort teardown */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
