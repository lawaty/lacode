// Feedback hint hook factory. It runs ONCE when the plugin loads, shows at
// most one local toast, and returns no hooks -- like the self-update check it
// has nothing to do on config, event or dispose. No network, no telemetry.
//
// Fire-and-forget: the hint must never block or delay startup, and a failure
// is silence, not a feature the user has to know about.

import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { maybeShowFeedbackHint, type FeedbackHintDeps } from "../lib/feedback.ts"

type FeedbackOptions = {
  enabled?: boolean
  feedbackHint?: boolean
}

export async function feedbackHooks(
  input: PluginInput,
  options?: PluginOptions,
  deps: FeedbackHintDeps = {},
): Promise<Hooks> {
  const opts = (options ?? {}) as FeedbackOptions
  if (opts.enabled === false || opts.feedbackHint === false) return {}

  // No test doubles here: a real TUI sink is the gate. A run with no TUI (a
  // headless `opencode run`, a piped session, a client without the toast API)
  // passes no `show`, so the library returns "unavailable" and writes no flag.
  // The previous optional-chain always resolved, consumed the flag, and showed
  // nothing -- the one failure the user could never see.
  const tui = input.client.tui
  const show =
    deps.show ??
    (tui?.showToast
      ? async (message: string) => {
          await tui.showToast!({
            body: { title: "lacode", message, variant: "info", duration: 8000 },
          })
        }
      : undefined)

  void maybeShowFeedbackHint({
    enabled: opts.enabled,
    feedbackHint: opts.feedbackHint,
    env: deps.env,
    statePath: deps.statePath,
    interactive: deps.interactive,
    show,
  }).catch(() => {})

  return {}
}
