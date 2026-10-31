/**
 * lacode voice TUI plugin: voice input for prompts and pending requests.
 *
 * Register it in tui.json:
 * ```json
 * { "plugin": [["file:///home/lawaty/Projects/lacode/dist/tui.js", { "dictation": true, "answers": true }]] }
 * ```
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { PluginOptions } from "@opencode-ai/plugin"
import { createRecorder, type Recorder } from "../voice/recorder.ts"
import { resolveGroqKey, transcribe } from "../voice/groq.ts"
import { parseQuestionAnswers, parsePermissionReply, cleanTranscript } from "../voice/parse.ts"
import { decodeWavPcm, hasSpeech, isSilenceHallucination } from "../voice/audio.ts"
import type { ParsedQuestion } from "../voice/parse.ts"
import { createVoiceClient } from "../voice/transport.ts"
import { VOICE_PROTOCOL_VERSION } from "../voice/protocol.ts"
import timelineMod from "./timeline.tsx"

export type VoiceOptions = {
  enabled?: boolean
  dictation?: boolean
  answers?: boolean
  submit?: boolean
  model?: string
  language?: string
  vocabulary?: string
  maxSeconds?: number
  dictateKey?: string
  answerKey?: string
  useDaemon?: boolean
  daemonPort?: number
  daemonHost?: string
  intent?: "auto" | "insert" | "answer"
  recorder?: Recorder | (() => Recorder)
  createRecorder?: (deps?: { maxSeconds?: number }) => Recorder
}

const DEFAULT_MODEL = "whisper-large-v3-turbo"
const DEFAULT_LANGUAGE = "en"
const DEFAULT_MAX_SECONDS = 120
const DEFAULT_DICTATE_KEY = "<leader>v"
const DEFAULT_ANSWER_KEY = "<leader>a"
const DEFAULT_DAEMON_PORT = 8765
const DEFAULT_DAEMON_HOST = "127.0.0.1"

const SETUP_HINT = 'Set GROQ_KEY or create ~/.config/lacode/voice.json with {"groqKey":"..."}'

type ResolvedOptions = {
  enabled: boolean
  dictation: boolean
  answers: boolean
  submit: boolean
  model: string
  language: string
  vocabulary: string | undefined
  maxSeconds: number
  dictateKey: string
  answerKey: string
  useDaemon: boolean
  daemonPort: number
  daemonHost: string
  intent: "auto" | "insert" | "answer"
}

type QuestionInfo = {
  question: string
  header: string
  options: Array<{ label: string; description?: string }>
  multiple?: boolean
  custom?: boolean
}

type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
}

type PendingRequest =
  | { kind: "question"; request: QuestionRequest }
  | { kind: "permission"; request: PermissionRequest }

type ToastInput = {
  message: string
  title?: string
  variant?: "info" | "success" | "warning" | "error"
  duration?: number
}

type VoiceCommand = {
  name: string
  title: string
  category: string
  namespace: "palette"
  run: (ctx: unknown) => Promise<void>
}

// Module-level daemon connection flag, shared across the plugin instance.
let daemonConnected = false

// The host keeps only one toast, so a recording indicator is kept alive by
// re-showing it on an interval until the recording phase ends.
let recordingPulse: ReturnType<typeof setInterval> | undefined

// One recorder for the whole plugin. `phase` and `activeMode` make a second
// press finish the recording that is already in flight instead of starting one.
let recorder: Recorder | undefined
let phase: "idle" | "recording" = "idle"
let activeMode: "dictate" | "answer" | undefined
let activeRequest: PendingRequest | undefined

function resetState(): void {
  phase = "idle"
  activeMode = undefined
  activeRequest = undefined
}

function resolveOptions(options: PluginOptions | undefined): ResolvedOptions {
  const o = (options ?? {}) as VoiceOptions
  const intent =
    o.intent === "insert" || o.intent === "answer" || o.intent === "auto" ? o.intent : "auto"
  return {
    enabled: o.enabled !== false,
    dictation: o.dictation !== false,
    answers: o.answers !== false,
    submit: o.submit === true,
    model: typeof o.model === "string" && o.model.length > 0 ? o.model : DEFAULT_MODEL,
    language: typeof o.language === "string" && o.language.length > 0 ? o.language : DEFAULT_LANGUAGE,
    vocabulary: typeof o.vocabulary === "string" && o.vocabulary.length > 0 ? o.vocabulary : undefined,
    maxSeconds:
      typeof o.maxSeconds === "number" && Number.isFinite(o.maxSeconds) && o.maxSeconds > 0
        ? o.maxSeconds
        : DEFAULT_MAX_SECONDS,
    dictateKey:
      typeof o.dictateKey === "string" && o.dictateKey.length > 0 ? o.dictateKey : DEFAULT_DICTATE_KEY,
    answerKey:
      typeof o.answerKey === "string" && o.answerKey.length > 0 ? o.answerKey : DEFAULT_ANSWER_KEY,
    useDaemon: o.useDaemon !== false,
    daemonPort:
      typeof o.daemonPort === "number" && Number.isFinite(o.daemonPort) && o.daemonPort > 0
        ? o.daemonPort
        : DEFAULT_DAEMON_PORT,
    daemonHost:
      typeof o.daemonHost === "string" && o.daemonHost.length > 0 ? o.daemonHost : DEFAULT_DAEMON_HOST,
    intent,
  }
}

function toast(api: TuiPluginApi, input: ToastInput): void {
  api.ui.toast(input)
}

const stopRecordingIndicator = (): void => {
  if (!recordingPulse) return
  clearInterval(recordingPulse)
  recordingPulse = undefined
}

const startRecordingIndicator = (api: TuiPluginApi, message = "● Recording…"): void => {
  stopRecordingIndicator()
  const show = (): void => {
    try {
      toast(api, { variant: "info", title: "lacode voice", message, duration: 5000 })
    } catch {
      // An indicator must never break the plugin or the recording.
    }
  }
  show()
  recordingPulse = setInterval(show, 4000)
  recordingPulse.unref?.()
}

function readableError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

// The SDK client can be configured to return either the data directly or the
// `{ data, error }` envelope; accept both so the plugin works with either.
function unwrapList(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === "object") {
    const envelope = result as { data?: unknown; error?: unknown }
    if (envelope.error !== undefined && envelope.error !== null) {
      throw new Error(readableError(envelope.error))
    }
    if (Array.isArray(envelope.data)) return envelope.data
  }
  return []
}

// A client with `throwOnError: false` returns failures as `{ error }` instead
// of rejecting; surface those as exceptions so the command's catch reports them.
function ensureOk(result: unknown): void {
  if (!result || typeof result !== "object" || !("error" in result)) return
  const error = (result as { error?: unknown }).error
  if (error !== undefined && error !== null) throw new Error(readableError(error))
}

async function fetchPending(api: TuiPluginApi): Promise<PendingRequest[]> {
  const [questions, permissions] = await Promise.all([
    api.client.question.list(),
    api.client.permission.list(),
  ])
  const pending: PendingRequest[] = []
  for (const request of unwrapList(questions)) {
    pending.push({ kind: "question", request: request as QuestionRequest })
  }
  for (const request of unwrapList(permissions)) {
    pending.push({ kind: "permission", request: request as PermissionRequest })
  }
  return pending
}

async function stillPending(api: TuiPluginApi, request: PendingRequest): Promise<boolean> {
  const pending = await fetchPending(api)
  return pending.some((entry) => entry.request.id === request.request.id)
}

function toParsedQuestions(request: QuestionRequest): ParsedQuestion[] {
  return (request.questions ?? []).map((question) => ({
    options: (question.options ?? []).map((option) => ({ label: option.label })),
    multiple: question.multiple,
    custom: question.custom,
  }))
}

async function stopAndComplete(
  api: TuiPluginApi,
  opts: ResolvedOptions,
): Promise<void> {
  const mode = activeMode
  const request = activeRequest
  stopRecordingIndicator()
  toast(api, { variant: "info", title: "lacode voice", message: "Transcribing…", duration: 1500 })
  try {
    const bytes = await recorder!.stop()
    if (mode === "dictate") {
      await finishDictate(api, opts, bytes)
    } else if (mode === "answer" && request) {
      await finishAnswer(api, opts, bytes, request)
    }
  } finally {
    stopRecordingIndicator()
    resetState()
  }
}

async function finishDictate(
  api: TuiPluginApi,
  opts: ResolvedOptions,
  bytes: Uint8Array | undefined,
): Promise<void> {
  if (!bytes || bytes.length === 0) {
    toast(api, { variant: "warning", message: "No audio captured" })
    return
  }

  const decoded = decodeWavPcm(bytes)
  if (!decoded || !hasSpeech(decoded.pcm, { sampleRate: decoded.sampleRate })) {
    api.ui.toast({ variant: "warning", title: "lacode voice", message: "No speech detected" })
    return
  }

  const resolved = resolveGroqKey()
  if (!resolved) {
    toast(api, { variant: "warning", message: SETUP_HINT })
    return
  }

  const text = cleanTranscript(await transcribe({
    audio: bytes,
    key: resolved.key,
    model: opts.model,
    language: opts.language,
    prompt: opts.vocabulary,
  }))

  if (isSilenceHallucination(text, (decoded.pcm.length / decoded.sampleRate) * 1000)) {
    api.ui.toast({ variant: "warning", title: "lacode voice", message: "No speech detected" })
    return
  }

  if (text.trim().length === 0) {
    toast(api, { variant: "warning", message: "Nothing transcribed" })
    return
  }

  await api.client.tui.appendPrompt({ text })
  if (opts.submit) await api.client.tui.submitPrompt()
  toast(api, { variant: "success", message: text.slice(0, 60) })
}

async function finishAnswer(
  api: TuiPluginApi,
  opts: ResolvedOptions,
  bytes: Uint8Array | undefined,
  request: PendingRequest,
): Promise<void> {
  if (!bytes || bytes.length === 0) {
    toast(api, { variant: "warning", message: "No audio captured" })
    return
  }

  const decoded = decodeWavPcm(bytes)
  if (!decoded || !hasSpeech(decoded.pcm, { sampleRate: decoded.sampleRate })) {
    api.ui.toast({ variant: "warning", title: "lacode voice", message: "No speech detected" })
    return
  }

  const resolved = resolveGroqKey()
  if (!resolved) {
    toast(api, { variant: "warning", message: SETUP_HINT })
    return
  }

  const text = cleanTranscript(await transcribe({
    audio: bytes,
    key: resolved.key,
    model: opts.model,
    language: opts.language,
    prompt: opts.vocabulary,
  }))

  if (isSilenceHallucination(text, (decoded.pcm.length / decoded.sampleRate) * 1000)) {
    api.ui.toast({ variant: "warning", title: "lacode voice", message: "No speech detected" })
    return
  }

  await answerWithText(api, opts, text, request)
}

async function insertText(
  api: TuiPluginApi,
  opts: ResolvedOptions,
  text: string,
): Promise<void> {
  await api.client.tui.appendPrompt({ text })
  if (opts.submit) await api.client.tui.submitPrompt()
  toast(api, { variant: "success", message: text.slice(0, 60) })
}

async function answerWithText(
  api: TuiPluginApi,
  opts: ResolvedOptions,
  text: string,
  request: PendingRequest,
): Promise<void> {
  if (request.kind === "permission") {
    const reply = parsePermissionReply(text)
    if (!reply) {
      toast(api, { variant: "warning", message: "Couldn't match yes / always / no" })
      return
    }
    if (!(await stillPending(api, request))) {
      toast(api, { variant: "warning", message: "Request is no longer pending" })
      return
    }
    ensureOk(await api.client.permission.reply({ requestID: request.request.id, reply }))
    toast(api, { variant: "success", message: `Permission: ${reply}` })
    return
  }

  const answers = parseQuestionAnswers(text, toParsedQuestions(request.request))
  const allEmpty = answers.every((answer) => !answer || answer.length === 0)
  if (allEmpty) {
    toast(api, { variant: "warning", message: "Couldn't match an option" })
    return
  }
  if (!(await stillPending(api, request))) {
    toast(api, { variant: "warning", message: "Request is no longer pending" })
    return
  }
  ensureOk(await api.client.question.reply({ requestID: request.request.id, answers }))
  const labels = answers
    .map((answer) => answer.join(", "))
    .filter((answer) => answer.length > 0)
    .join("; ")
  toast(api, { variant: "success", message: labels })
}

const tui: TuiPlugin = async (api, options) => {
  const opts = resolveOptions(options)
  if (!opts.enabled) return

  daemonConnected = false
  resetState()
  const rawOptions = (options ?? {}) as VoiceOptions
  let activeRecorder: Recorder
  if (typeof rawOptions.recorder === "function") {
    activeRecorder = (rawOptions.recorder as () => Recorder)()
  } else if (rawOptions.recorder && typeof (rawOptions.recorder as Recorder).start === "function") {
    activeRecorder = rawOptions.recorder as Recorder
  } else if (typeof rawOptions.createRecorder === "function") {
    activeRecorder = rawOptions.createRecorder({ maxSeconds: opts.maxSeconds })
  } else {
    activeRecorder = createRecorder({ maxSeconds: opts.maxSeconds })
  }
  recorder = activeRecorder
  api.lifecycle.onDispose(() => activeRecorder.abort())
  api.lifecycle.onDispose(() => stopRecordingIndicator())

  let forcedIntent: "insert" | "answer" | undefined

  const handleTranscript = async (text: string, source: "wake" | "manual"): Promise<void> => {
    const cleaned = cleanTranscript(text)
    if (cleaned.length === 0) return

    let intent: "insert" | "answer" | "auto"
    if (forcedIntent) {
      intent = forcedIntent
      forcedIntent = undefined
    } else if (opts.intent === "insert" || opts.intent === "answer") {
      intent = opts.intent
    } else {
      intent = "auto"
    }

    try {
      const pending = await fetchPending(api)

      if (intent === "answer") {
        if (pending.length === 0) {
          await insertText(api, opts, cleaned)
          return
        }
        if (pending.length > 1) {
          toast(api, {
            variant: "warning",
            message: "Several requests are pending — answer with the keyboard",
          })
          return
        }
        await answerWithText(api, opts, cleaned, pending[0])
        return
      }

      if (intent === "auto") {
        if (pending.length === 1) {
          await answerWithText(api, opts, cleaned, pending[0])
          return
        }
        await insertText(api, opts, cleaned)
        return
      }

      await insertText(api, opts, cleaned)
    } catch (err) {
      toast(api, { variant: "error", title: "lacode voice", message: readableError(err) })
    }
  }

  // Daemon support (primary path when available).
  let daemon: ReturnType<typeof createVoiceClient> | undefined
  if (opts.useDaemon) {
    daemon = createVoiceClient({
      port: opts.daemonPort,
      host: opts.daemonHost,
      onMessage: (message) => {
        try {
          if (message.t === "state") {
            if (message.phase === "recording") {
              startRecordingIndicator(api)
            } else if (message.phase === "transcribing") {
              stopRecordingIndicator()
              toast(api, {
                variant: "info",
                title: "lacode voice",
                message: "Transcribing…",
                duration: 1500,
              })
            } else if (message.phase === "idle") {
              stopRecordingIndicator()
            }
          } else if (message.t === "transcript") {
            void handleTranscript(message.text, message.source)
          } else if (message.t === "error") {
            stopRecordingIndicator()
            toast(api, { variant: "error", title: "lacode voice", message: message.message })
          }
        } catch (err) {
          stopRecordingIndicator()
          toast(api, { variant: "error", title: "lacode voice", message: readableError(err) })
        }
      },
      onConnectionChange: (connected) => {
        daemonConnected = connected
        if (connected && daemon) {
          daemon.send({ t: "hello", v: VOICE_PROTOCOL_VERSION, client: "tui" })
        }
      },
    })
    daemon.start()
    api.lifecycle.onDispose(() => daemon!.stop())
  }

  const runDictate = async (): Promise<void> => {
    try {
      if (!opts.dictation) {
        toast(api, { variant: "warning", message: "Voice dictation is disabled" })
        return
      }
      if (daemonConnected && daemon) {
        forcedIntent = "insert"
        daemon.send({ t: "toggle" })
        return
      }
      if (phase === "recording") {
        await stopAndComplete(api, opts)
        return
      }

      const resolved = resolveGroqKey()
      if (!resolved) {
        toast(api, { variant: "warning", message: SETUP_HINT })
        return
      }

      recorder!.start()
      phase = "recording"
      activeMode = "dictate"
      activeRequest = undefined
      startRecordingIndicator(api, "● Recording… press the key again to stop")
    } catch (err) {
      stopRecordingIndicator()
      resetState()
      toast(api, { variant: "error", title: "lacode voice", message: readableError(err) })
    }
  }

  const runAnswer = async (): Promise<void> => {
    try {
      if (!opts.answers) {
        toast(api, { variant: "warning", message: "Voice answers are disabled" })
        return
      }
      if (daemonConnected && daemon) {
        const pending = await fetchPending(api)
        if (pending.length === 0) {
          toast(api, { variant: "warning", message: "No pending question or permission" })
          return
        }
        forcedIntent = "answer"
        daemon.send({ t: "toggle" })
        return
      }
      if (phase === "recording") {
        await stopAndComplete(api, opts)
        return
      }

      const pending = await fetchPending(api)
      if (pending.length === 0) {
        toast(api, { variant: "warning", message: "No pending question or permission" })
        return
      }
      if (pending.length > 1) {
        toast(api, {
          variant: "warning",
          message: "Several requests are pending — answer with the keyboard",
        })
        return
      }

      activeRequest = pending[0]
      recorder!.start()
      phase = "recording"
      activeMode = "answer"
      startRecordingIndicator(api, "● Recording… press the key again to stop")
    } catch (err) {
      stopRecordingIndicator()
      resetState()
      toast(api, { variant: "error", title: "lacode voice", message: readableError(err) })
    }
  }

  const runCheck = async (): Promise<void> => {
    try {
      const resolved = resolveGroqKey()
      const daemonStatus = daemonConnected
        ? `daemon: connected (${opts.daemonPort})`
        : `daemon: not running (${opts.daemonPort})`
      if (resolved) {
        toast(api, { variant: "success", message: `Groq key found (${resolved.source}); ${daemonStatus}` })
        return
      }
      toast(api, { variant: "warning", message: `${SETUP_HINT}; ${daemonStatus}` })
    } catch (err) {
      toast(api, { variant: "error", title: "lacode voice", message: readableError(err) })
    }
  }

  const commands: VoiceCommand[] = [
    {
      name: "lacode.voice.dictate",
      title: "Voice: dictate",
      category: "Voice",
      namespace: "palette",
      run: async () => runDictate(),
    },
    {
      name: "lacode.voice.answer",
      title: "Voice: answer question or permission",
      category: "Voice",
      namespace: "palette",
      run: async () => runAnswer(),
    },
    {
      name: "lacode.voice.check",
      title: "Voice: check setup",
      category: "Voice",
      namespace: "palette",
      run: async () => runCheck(),
    },
  ]

  const bindings: Array<{ key: string; cmd: string; desc: string }> = []
  if (opts.dictation) {
    bindings.push({ key: opts.dictateKey, cmd: "lacode.voice.dictate", desc: "Voice dictate" })
  }
  if (opts.answers) {
    bindings.push({ key: opts.answerKey, cmd: "lacode.voice.answer", desc: "Voice answer" })
  }

  api.keymap.registerLayer({ mode: "base", commands, bindings } as any)

  const timelineOpts = (options ?? {}) as { timeline?: boolean | { enabled?: boolean } }
  const timelineOff =
    timelineOpts.timeline === false ||
    (typeof timelineOpts.timeline === "object" && timelineOpts.timeline !== null && timelineOpts.timeline.enabled === false)
  if (!timelineOff) {
    try {
      await timelineMod.tui(api, options)
    } catch {
      // A broken sidebar must never cost dictation.
    }
  }
}

const mod: TuiPluginModule = {
  id: "lacode.voice",
  tui,
}

export default mod
