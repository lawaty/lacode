// OmniRoute: register a locally-run, OpenAI-compatible gateway as an opencode
// provider, so a user who runs one gets `omniroute/<model-id>` in the model
// picker without hand-writing a provider block, an api key and a model list
// into opencode.jsonc.
//
// The integration is OPTIONAL and OFF by default. A user with no `omniroute`
// block gets an EMPTY hooks object -- no warning, no probe, no startup cost --
// which is the silent-disabled contract ../lib/omniroute.ts gives parseConfig,
// honoured one layer up.
//
// This module is a HOOK FACTORY, not a plugin -- see the note at the top of
// ./agent-pool.ts. It imports the pure library and owns everything
// opencode-facing: the config hook, the HTTP calls and the logging. The library
// imports nothing from here.
//
// DEGRADE IS THE WHOLE DESIGN. Nothing in this file may take the process down
// and nothing may route through a gateway the operator did not choose:
//
//   * disabled           -> {} , absolutely silent.
//   * invalid            -> {} and ONE warning naming every problem.
//   * unhealthy/shut     -> ONE warning, then lacode's normal behaviour for the
//     rest of this run. There is deliberately no retry loop: re-probing a
//     gateway nobody is running on every config hook is noise, not resilience,
//     and `disabled` is per-run so a gateway that comes back is picked up again
//     on the next start.
//   * no usable models   -> the same fallback, with the reason named.
//
// The provider block is written ONLY where the key is absent, which is the same
// merge-without-clobber rule agents and commands follow: an operator who already
// defines `provider.omniroute` keeps theirs untouched and is told once.
//
// No whitelist/blacklist is ever written onto any provider (the pool's
// allowlist-in-a-whitelist reasoning does not apply here: lacode is not the
// author of this provider's model list), and `cfg.model` is left alone -- this
// factory registers a destination, it never chooses one.

import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import * as omni from "../lib/omniroute.ts"
import * as pool from "../lib/pool.ts"

const SERVICE = "omniroute"

export type OmniRouteOptions = { omniroute?: unknown }

/** Injectable seams. `env` defaults to `process.env`; tests supply their own. */
export type OmniRouteDeps = {
  fetchImpl?: omni.FetchLike
  env?: Record<string, string | undefined>
  now?: () => number
}

/** The config object opencode hands to the `config` hook. */
type ConfigArg = Parameters<NonNullable<Hooks["config"]>>[0]

export const omniRouteHooks = async (
  input: Pick<PluginInput, "client">,
  options?: PluginOptions,
  deps: OmniRouteDeps = {},
): Promise<Hooks> => {
  const opts = (options ?? {}) as OmniRouteOptions
  const parsed = omni.parseConfig(opts.omniroute, deps.env ?? process.env)

  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    input.client.app.log({ body: { service: SERVICE, level, message } }).catch(() => {})

  // Same dedupe as the pool's: one identical warning per process, however many
  // hooks fire. Without it a gateway that is down turns every config hook into
  // another copy of the same line.
  const warned = new Set<string>()
  const warnOnce = async (message: string) => {
    if (warned.has(message)) return
    warned.add(message)
    await log("warn", message)
  }

  // Disabled is SILENT: an absent or `enabled: false` block is the normal state
  // of a user who does not run OmniRoute, and warning about "not configured"
  // would cry wolf on every startup.
  if (!parsed.enabled) return {}

  // Enabled but unusable. One line naming every problem rather than one per
  // problem: the whole block is down, and five warnings for one bad field is
  // noise that buries the real signal in a busy log.
  if (parsed.config === null) {
    await warnOnce(`omniroute is enabled but unusable: ${parsed.problems.join("; ")}`)
    return {}
  }

  const config = parsed.config

  const cache = omni.createModelCache({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  })
  // The selector is the library's owner of the candidate list and of the
  // per-model health/cooldown state that goes with it. Only its ordered
  // candidate list is read here today; it is created through the library rather
  // than as a local array so there is exactly one place a candidate can come
  // from, and so cooldown arithmetic is already keyed the same way.
  const selector = omni.createSelector(config, { now: deps.now })

  // Per-run fallback flag. Nothing is persisted, so "disabled" means "not for
  // this process" and a recovered gateway is picked up on the next start.
  let disabled = false

  // The model this integration will prepend as the pool's PRIMARY slot, decided
  // once the gateway has answered. Null means "do not touch the pool".
  let poolModel: string | null = null

  // The probe itself: at most one per factory run, and lazy -- the factory never
  // touches the network, so a user with the block disabled pays nothing and an
  // enabled one pays exactly one probe per start.
  const probe = async () => {
    if (config.healthCheck) {
      const healthy = await omni.checkHealth({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        fetchImpl: deps.fetchImpl,
      })
      if (!healthy) {
        disabled = true
        await warnOnce(`omniroute health check failed at ${config.baseURL}; falling back to lacode's normal behaviour for this run`)
        return
      }
    }

    let ids: string[]
    try {
      ids = await cache.get()
    } catch (error) {
      // The library's HTTP helpers never put the key in an error message, and
      // redactApiKey is applied anyway: this text reaches a log file.
      disabled = true
      await warnOnce(
        omni.redactApiKey(
          `omniroute is unreachable at ${config.baseURL}: ${error instanceof Error ? error.message : String(error)}; falling back for this run`,
          config.apiKey,
        ),
      )
      return
    }

    // What survives is the routing order: the hard allowlist applied to what the
    // gateway actually advertises, then the operator's tier preference over the
    // survivors.
    const candidates = omni.orderByTier(omni.filterModels(ids, config), config.tiers)
    if (candidates.length === 0) {
      disabled = true
      await warnOnce(`omniroute returned no usable models at ${config.baseURL}; falling back for this run`)
      return
    }

    selector.setCandidates(candidates)
    // The pool target: the combo when one is named, else the first allowlisted
    // model, else OmniRoute's own zero-config `auto` router -- so `enabled: true`
    // alone is enough to make the gateway the pool's primary slot.
    const chosen = config.combo ?? (config.models !== undefined && config.models.length > 0 ? candidates[0] : "auto")
    poolModel = `omniroute/${chosen}`
    await log("info", `omniroute: ${candidates.length} model(s) from ${config.baseURL}: ${candidates.join(", ")}`)
  }

  // The probe is MEMOISED as a promise rather than guarded by a bare boolean.
  // opencode can call `config` more than once, and two overlapping calls must
  // share ONE probe: a boolean would let the second caller fall straight through
  // while the first is still waiting on the gateway, and it would then inject a
  // provider built from a candidate list that has not been fetched yet -- worse,
  // it would inject one at all on the fallback path, because `disabled` is still
  // false at the moment it checks. A settled probe is cached too, which is what
  // makes the fallback sticky for the rest of this run.
  let started: Promise<void> | null = null
  const initialize = (): Promise<void> => (started ??= probe())

  // Registers `provider.omniroute`. Local and unexported: it is one step of the
  // config hook, and nothing else needs to reach it.
  const injectProvider = async (cfg: ConfigArg, warn: (message: string) => Promise<void>): Promise<void> => {
    const providers = ((cfg as Record<string, unknown>).provider ??= {}) as Record<string, { [key: string]: unknown }>

    // Merge-without-clobber: a provider block the user already wrote is never
    // overwritten, patched or partially merged. Their gateway, their key, their
    // model list -- this factory exists to save typing, not to take a decision
    // away.
    if (providers.omniroute !== undefined) {
      await warn("omniroute provider is already defined in your config; lacode left it untouched")
      return
    }

    // opencode's provider contract is `{ <model-id>: { name } }`. The candidate
    // order (combo first, then tiers) is reproduced so the preferred models lead
    // the picker; opencode 1.18.34 has no hook to force a session's model, so
    // this is presentation, not a routing decision.
    const exposed = selector.candidates()
    // The pool target must itself be selectable, even when it is `auto` and the
    // gateway did not advertise it.
    const target = poolModel !== null ? poolModel.slice("omniroute/".length) : null
    const ids = target !== null && !exposed.includes(target) ? [target, ...exposed] : exposed
    const models: Record<string, { name: string }> = {}
    for (const id of ids) models[id] = { name: id }

    providers.omniroute = {
      name: "OmniRoute",
      // The documented opencode registration mechanism for a gateway speaking
      // the OpenAI `/v1` API: opencode loads this package itself from the user's
      // own install, so lacode needs no dependency to expose OmniRoute. No
      // `capabilities` are declared on purpose -- opencode ignores custom
      // capabilities for openai-compatible providers, so writing one would be
      // decoration that reads like a promise.
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: config.baseURL,
        // Absent rather than blank: an empty bearer on a keyless gateway is a
        // 401 that looks like a configuration error.
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        timeout: config.timeoutMs,
      },
      models,
    }

    // Make this gateway the pool's PRIMARY slot -- slot 1, the one the pool takes
    // first -- replacing that slot's model in place so pooled mechanical work
    // drains here before it reaches the bundled (zen) models. Written into the
    // shared pool state -- the same state object the pool's config hook reads on
    // this same pass, which is why this hook runs before it (see src/index.ts).
    if (poolModel !== null) {
      const ps = pool.state((options ?? {}) as { id?: string; dir?: string; modelsFile?: string; models?: unknown })
      pool.setPrimarySlot(ps, { model: poolModel })
    }
  }

  return {
    config: async (cfg) => {
      try {
        await initialize()
        if (disabled) return
        await injectProvider(cfg, warnOnce)
      } catch (error) {
        // Nothing escapes a hook. An unexpected failure here means "no OmniRoute
        // provider this run", which is the same outcome every other branch of
        // this factory reaches.
        await warnOnce(
          omni.redactApiKey(
            `omniroute config injection failed: ${error instanceof Error ? error.message : String(error)}`,
            config.apiKey,
          ),
        )
      }
    },
  }
}
