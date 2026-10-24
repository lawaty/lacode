// Self-contained config for the pool suites.
//
// WHY THIS EXISTS: the pool tests need a self-contained config. The author's
// personal `opencode.jsonc` is not in this repo, so reading it directly breaks
// for every consumer and on every fresh checkout.
//
// The package does not ship an `opencode.jsonc` at all: `src/index.ts` injects
// its agent set (`src/agents.ts` `buildAgentSet()`) into whatever config the user
// has. So the honest, self-contained stand-in for "the config the pool binds
// into" is exactly that injected set, laid over a minimal provider block --
// which is what `shippedConfig()` returns. Nothing here reads outside the repo.
//
// The fixture file (`opencode.json`) carries only what the package does NOT
// inject: the provider entries the bundled preset names (`opencode`,
// `opencode-go`) and the generic built-in subagents disabled -- the safety shape
// the suite pins. Everything agent-related comes from the package itself, so the
// fixture cannot silently drift out of sync with `src/agents.ts`.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { applyAgents, buildAgentSet } from "../../src/agents.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

/** The committed provider/built-in fixture. */
export const FIXTURE = join(HERE, "opencode.json")

/**
 * A fresh, mutable config: the fixture with the package's agent set injected,
 * exactly the way `src/index.ts`'s config hook does it for a real consumer.
 * Call a new one per pool instance -- the config hook mutates it in place.
 */
export const shippedConfig = () => {
  const cfg = JSON.parse(readFileSync(FIXTURE, "utf8"))
  applyAgents(cfg, buildAgentSet())
  return cfg
}
