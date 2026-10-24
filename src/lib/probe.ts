import {
  clearCooldowns,
  isLimitText,
  isModelMissingText,
  limitReason,
  markProbe,
  MODEL_MISSING_COOLDOWN_MS,
  MODEL_MISSING_REASON,
  readLimits,
  recordStrike,
  splitModel,
  statedCooldown,
  unmarkProbe,
  type State,
} from "./pool.ts"

// Probes a cooled model by actually USING it.
//
// The cooldown files are a COMPUTED GUESS about when a provider reopens. A
// provider-wide quota runs on a curve that reaches six hours, and a window guessed
// long is a slot that stays out of the pool long after the provider recovered —
// while every delegated spawn queues behind the survivors. Nothing in the pool can
// tell the difference, because the only evidence it has is the failure it already
// recorded.
//
// So this asks the provider instead: one real request, on that exact model, with a
// prompt whose cheapest possible answer is one word. That is a fact where the
// cooldown was an inference. It settles the only question that matters — can this
// slot be used right now — and it is the whole reason this module exists rather
// than a timer that un-benches models on schedule.
//
// It matters most for the case where the cooldown is exactly right: a provider's
// daily quota really is spent, the model really is unusable, and the answer that
// comes back is "still limited" rather than a guess about when that stops. Equally,
// it is what lets a QUOTA RESET BY HAND IN THE PROVIDER'S OWN CONSOLE take effect
// without waiting out the window the plugin guessed for it.
//
// What a probe never does:
//
//   * count its own failure as evidence. A probe that 429s re-cooling the model a
//     little further every cycle would drive the window to the six-hour cap and
//     make the model unrecoverable by any probe at all — the opposite of the point.
//     So the strike recorder ignores probe sessions (see State.probes), and a
//     failed probe leaves the existing window alone. The ONE thing it may update is
//     a window the provider itself stated ("resets in 12min"), because that is the
//     provider correcting us rather than us guessing again. The exception is a
//     model the provider does not serve at all ("Model not found"): that is not a
//     guess about recovery, it is the provider saying the id is gone, so it is
//     benched for the quota cap instead of being re-probed every cycle.
//   * bench a whole provider. One 429 from one probe request says nothing about the
//     other slots on that provider, so the provider-wide path is skipped for probe
//     sessions too (see the note on State.probes).
//   * hold a slot. A probe is not work: it acquires no claim, never counts as load,
//     and is deleted as soon as it answers. It is a question, not a task.
//
// Probes run ONE AT A TIME. probeCooling() asks only about models that are
// actually cooling; probeModels() is the validation path and asks about explicit
// slots, cooling or not. Firing several requests at once is how a pool gets
// itself rate-limited in the first place.

// The prompt is the cheapest honest probe there is, and `system` REPLACES the
// agent's own rather than appending to it — the point is to pay a handful of tokens
// per check, not to ship a subagent's instructions to a provider to learn whether
// it is awake. No `agent` is named, so no pooled agent definition and no claim is
// involved. `noReply` is deliberately NOT set: an unanswered reply is the one
// outcome this must not mistake for success.
const PROBE_SYSTEM = "You are a connection health check. Reply with the single word: ok"
const PROBE_PROMPT = "ok"

/**
 * How long one probe may take before it counts as no answer.
 *
 * A provider that still has quota answers in seconds. A rate-limited one does not
 * answer at all: opencode retries upstream before it surfaces the error, so the
 * request can sit for minutes while it exhausts its own retry budget. Without a
 * deadline a single probe could hold the run open long enough to overlap the next
 * one, which is why this bounds it and why the run is also guarded by `probing`.
 */
export const PROBE_TIMEOUT_MS = 45_000

/** What one probe settled. */
export type ProbeOutcome = {
  model: string
  /** True only when the model actually produced a reply. */
  ok: boolean
  /** Why it is reported this way: "answered", or the failure in a few words. */
  reason: string
  /** How much of its cooldown was left when the probe started. */
  hadSeconds: number
  /** What is left after the probe. Zero means it answered and was re-admitted. */
  leftSeconds: number
}

export type ProbeReport = {
  /** Every model this run touched, in probe order. */
  outcomes: ProbeOutcome[]
  /** Models that answered and are back in the pool. */
  cleared: string[]
  /** Models still limited after the probe, with the window they kept. */
  kept: string[]
  /** Models the provider says it does not serve; benched for the quota cap. */
  missing: string[]
  /** True when anything at all changed — what a report is worth sending for. */
  changed: boolean
}

// Only what a probe uses, so a test can hand this a stub instead of a server. The
// cast at the call site is the honest boundary: opencode's client is generated from
// the server's own routes, and a probe must never be able to break because a route
// grew a field.
export type ProbeClient = {
  session: {
    create: (options: unknown) => Promise<{ data?: { id?: string } }>
    prompt: (options: unknown) => Promise<{ error?: unknown; data?: { info?: { error?: unknown } } }>
    abort: (options: unknown) => Promise<unknown>
    delete: (options: unknown) => Promise<unknown>
  }
}

export type ProbeOptions = {
  state: State
  directory: string
  /** Narrow the run to these models. Omit to probe every model that is cooling. */
  models?: string[]
  timeoutMs?: number
  /** Injected clock, so a test can age a cooldown without waiting for it. */
  now?: () => number
}

/** The failure as the pool already understands it: one string to match and parse. */
const failureText = (error: unknown): string => {
  if (error === undefined || error === null) return ""
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * A failed probe's reason, shortened to a word or two.
 *
 * This lands in a toast and a log line, so it reuses the pool's own vocabulary —
 * the same matcher limit detection uses — instead of inventing a second spelling of
 * "rate limited" that nobody would be able to grep for.
 */
const shortReason = (text: string): string => {
  if (!text) return "failed"
  if (isModelMissingText(text)) return MODEL_MISSING_REASON
  return limitReason(text) ?? (isLimitText(text) ? "limit" : "failed")
}

/** Probe one model and settle its cooldown. Never throws. */
const probeOne = async (client: ProbeClient, opts: ProbeOptions, model: string, leftSeconds: number): Promise<ProbeOutcome> => {
  const { state: s, directory } = opts
  const { provider, id: modelID } = splitModel(model)
  const settle = (ok: boolean, reason: string, left: number): ProbeOutcome => ({
    model,
    ok,
    reason,
    hadSeconds: leftSeconds,
    leftSeconds: left,
  })

  const created = await client.session
    .create({ body: { title: `pool probe (${model})` }, query: { directory } })
    .then((r) => r?.data?.id)
    .catch(() => undefined)
  if (!created) return settle(false, "no probe session", leftSeconds)

  // Registered before the prompt, not after: the failure this is watching for
  // arrives as an event, and an event for a session that is not yet marked would be
  // counted as real work.
  markProbe(s, created)
  // Deliberately NOT unref'd: this timer is what unblocks the await below, so
  // unref'ing it would let an otherwise-idle process exit with a probe in flight.
  // It is always cleared in the finally, on every path.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
    const clock = opts.now ?? Date.now
    let timedOut = false

    // The deadline RACES the request rather than merely arming an abort. A rate-limited
    // request does not fail — it hangs, because opencode retries upstream before it
    // surfaces the error — so awaiting the prompt alone would hold this run open for
    // however long the provider's own retry budget takes, and the next pass would
    // overlap it. Aborting is still the right thing to do at the deadline; the race is
    // what makes the run move on.
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        void client.session.abort({ path: { id: created }, query: { directory } }).catch(() => {})
        resolve(undefined)
      }, timeoutMs)
    })
    // A throw is still an answer — the request did not complete — and attaching the
    // rejection handler here is what keeps an abandoned post-deadline rejection from
    // surfacing as an unhandled one.
    const answer = client.session
      .prompt({
        path: { id: created },
        query: { directory },
        body: {
          model: { providerID: provider, modelID },
          system: PROBE_SYSTEM,
          parts: [{ type: "text", text: PROBE_PROMPT }],
        },
      })
      .then(
        (result) => result,
        (error) => ({ error }),
      )

    const result = await Promise.race([answer, deadline])

    // prompt() resolves when the turn ends, including when it ends in an abort or an
    // error, so a resolved promise is NOT a working model. Both shapes are checked,
    // the same way the cartographer checks its own run.
    const failure = result?.error ?? result?.data?.info?.error
    if (!timedOut && failure === undefined && result?.data?.info !== undefined) {
      // It answered. This is the fact the whole module exists to obtain.
      clearCooldowns(s, [model])
      return settle(true, "answered", 0)
    }

    const text = failureText(failure)
    if (isModelMissingText(text)) {
      // The provider does not serve this model id. Unlike a quota this does not
      // lift on its own, so bench it for the quota cap instead of leaving a dead
      // slot in the pool; a later probe re-admits it if it comes back.
      recordStrike(s, model, MODEL_MISSING_REASON, MODEL_MISSING_COOLDOWN_MS)
    } else {
      // A window the provider STATED is the provider correcting a guess, so it is
      // worth recording. Anything else leaves the existing window exactly as it was:
      // a probe must never lengthen a cooldown, or the model it is checking could
      // never pass the check.
      const stated = statedCooldown(text)
      if (stated !== undefined) recordStrike(s, model, shortReason(text), stated)
    }
    const still = readLimits(s).get(model)
    return settle(
      false,
      timedOut ? `no answer in ${Math.round(timeoutMs / 1000)}s` : shortReason(text),
      still && still.until > clock() ? Math.ceil((still.until - clock()) / 1000) : 0,
    )
  } finally {
    if (timer) clearTimeout(timer)
    // Delete BEFORE unmarking, and keep the mark if the delete fails.
    //
    // The mark is what tells every other hook that this session is not work: limit
    // detection skips its failures, and the cartographer's idle trigger skips the
    // session going idle. It has to hold for the WHOLE life of the session, and
    // dropping it first leaves a window in which the session still exists but no
    // longer identifies itself — an idle event landing there starts a context run
    // nobody asked for. Once the delete succeeds nothing can emit for the session
    // again, so the mark can go; if the delete fails the session outlives the mark,
    // which is the safe way round: a stale id in the set costs a few bytes, while a
    // probe mistaken for real work costs a slot and an edit of the map.
    //
    // The session itself is a question that has been answered; leaving it would put
    // a "pool probe" row in the user's session list on every cycle.
    const deleted = await client.session
      .delete({ path: { id: created }, query: { directory } })
      .then(() => true, () => false)
    if (deleted) unmarkProbe(s, created)
  }
}

/**
 * Probe the given models whether or not they are cooling: the slot VALIDATION
 * path.
 *
 * probeCooling() asks "has this benched model recovered?". This asks "does this
 * slot's model still exist?", which is the question a changed slot table poses.
 * A healthy model answers and nothing changes; a cooling one is re-admitted; a
 * model the provider does not serve is benched (see probeOne). It shares the
 * `s.probing` guard with probeCooling, so the two can never run together.
 */
export async function probeModels(client: ProbeClient, opts: ProbeOptions & { models: string[] }): Promise<ProbeReport> {
  const s = opts.state
  const now = opts.now ?? Date.now
  const empty: ProbeReport = { outcomes: [], cleared: [], kept: [], missing: [], changed: false }
  if (s.probing) return empty
  const models = [...new Set(opts.models)]
  if (models.length === 0) return empty

  const cooling = readLimits(s)
  const at = now()
  const wasCooling = new Set([...cooling.values()].filter((strike) => strike.until > at).map((strike) => strike.model))

  s.probing = true
  const outcomes: ProbeOutcome[] = []
  try {
    for (const model of models) {
      const strike = cooling.get(model)
      outcomes.push(await probeOne(client, opts, model, strike && strike.until > at ? Math.ceil((strike.until - at) / 1000) : 0))
    }
  } finally {
    s.probing = false
    s.lastProbe = Date.now()
  }

  // `cleared` is only the models that were ACTUALLY benched before the run: a
  // healthy model answering is not a change, so it must not be reported as one.
  const reAdmitted = outcomes.filter((o) => o.ok && wasCooling.has(o.model)).map((o) => o.model)
  const missing = outcomes.filter((o) => o.reason === MODEL_MISSING_REASON).map((o) => o.model)
  const stillLimited = outcomes.filter((o) => !o.ok && o.reason !== MODEL_MISSING_REASON)
  return {
    outcomes,
    cleared: reAdmitted,
    kept: stillLimited.map((o) => o.model),
    missing,
    changed: reAdmitted.length > 0 || missing.length > 0 || stillLimited.some((o) => o.leftSeconds !== o.hadSeconds),
  }
}

/**
 * Probe every cooled model, one at a time, and report what changed.
 *
 * Returns an empty report — no probes, no change — when nothing is cooling, which
 * is the normal case and must cost nothing. A run already in flight is refused the
 * same way rather than doubling up on the providers it is checking.
 */
export async function probeCooling(client: ProbeClient, opts: ProbeOptions): Promise<ProbeReport> {
  const s = opts.state
  const now = opts.now ?? Date.now
  const empty: ProbeReport = { outcomes: [], cleared: [], kept: [], missing: [], changed: false }
  if (s.probing) return empty
  const cooling = readLimits(s)
  const at = now()
  const wanted = opts.models && opts.models.length > 0 ? new Set(opts.models) : undefined
  const candidates = [...cooling.values()].filter(
    (strike) => strike.until > at && (wanted === undefined || wanted.has(strike.model)),
  )
  if (candidates.length === 0) return empty

  s.probing = true
  const outcomes: ProbeOutcome[] = []
  try {
    // Sorted so the slot with the least left to wait is checked first: it is the
    // one whose recovery the pool is actually waiting on, and the run has a
    // deadline in practice even though each probe is individually bounded.
    for (const strike of candidates.sort((a, b) => a.until - b.until)) {
      outcomes.push(await probeOne(client, opts, strike.model, Math.ceil((strike.until - at) / 1000)))
    }
  } finally {
    s.probing = false
    s.lastProbe = Date.now()
  }

  const reAdmitted = outcomes.filter((o) => o.ok).map((o) => o.model)
  const missing = outcomes.filter((o) => o.reason === MODEL_MISSING_REASON).map((o) => o.model)
  const stillLimited = outcomes.filter((o) => !o.ok && o.reason !== MODEL_MISSING_REASON)
  return {
    outcomes,
    cleared: reAdmitted,
    kept: stillLimited.map((o) => o.model),
    missing,
    // A window the provider restated is a change too: the pool now waits a
    // different length than it did, and the user is the one who set that.
    changed: reAdmitted.length > 0 || missing.length > 0 || stillLimited.some((o) => o.leftSeconds !== o.hadSeconds),
  }
}