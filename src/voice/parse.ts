export type ParsedOption = { label: string }
export type ParsedQuestion = { options: ParsedOption[]; multiple?: boolean; custom?: boolean }

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
}

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "for", "and", "or", "option", "choice"])

function normalise(utterance: string): string {
  let s = utterance.toLowerCase()
  s = s.replace(/&/g, " and ").replace(/\//g, " and ")
  s = s.replace(/^[^\w\s]+|[^\w\s]+$/g, "")
  s = s.replace(/\s+/g, " ").trim()
  return s
}

function stripPunct(w: string): string {
  return w.replace(/^[^\w']+|[^\w']+$/g, "")
}

function extractNumericTokens(utterance: string): string[] {
  const norm = normalise(utterance)
  const words = norm.split(/[\s,]+/)
  const tokens: string[] = []
  for (const raw of words) {
    const w = stripPunct(raw)
    if (w === "") continue
    if (/^\d+$/.test(w)) tokens.push(w)
    else if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w)) tokens.push(w)
    else if (w === "last") tokens.push(w)
  }
  return tokens
}

function matchLabel(norm: string, question: ParsedQuestion): number | null {
  if (norm === "") return null
  const opts = question.options
  const lower = (s: string) => s.toLowerCase().trim()

  for (let i = 0; i < opts.length; i++) {
    if (lower(opts[i].label) === norm) return i
  }

  for (let i = 0; i < opts.length; i++) {
    const lab = lower(opts[i].label)
    if (lab.length === 0) continue
    if (norm.startsWith(lab) || lab.startsWith(norm)) return i
  }

  const utteranceWords = new Set(
    norm
      .split(/[\s,]+/)
      .map((w) => stripPunct(w))
      .filter((w) => w.length > 0),
  )

  let best = -1
  let bestCount = 0
  for (let i = 0; i < opts.length; i++) {
    const sig = lower(opts[i].label)
      .split(/[\s\W]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    const unique = [...new Set(sig)]
    if (unique.length === 0) continue
    if (unique.every((w) => utteranceWords.has(w))) {
      if (unique.length > bestCount) {
        bestCount = unique.length
        best = i
      }
    }
  }
  return best === -1 ? null : best
}

export function parseSelection(utterance: string, question: ParsedQuestion): number[] {
  const norm = normalise(utterance)
  const options = question.options
  const n = options.length

  const words = norm.split(/[\s,]+/)

  let numericFound = false
  const rawIndices: number[] = []
  for (const raw of words) {
    const w = stripPunct(raw)
    if (w === "") continue
    if (/^\d+$/.test(w)) {
      numericFound = true
      rawIndices.push(parseInt(w, 10) - 1)
    } else if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w)) {
      numericFound = true
      rawIndices.push(NUMBER_WORDS[w] - 1)
    } else if (w === "last") {
      numericFound = true
      rawIndices.push(n - 1)
    }
  }

  let matched = false
  const indices: number[] = []
  const seen = new Set<number>()

  if (numericFound) {
    matched = true
    for (const idx of rawIndices) {
      if (idx >= 0 && idx < n && !seen.has(idx)) {
        seen.add(idx)
        indices.push(idx)
      }
    }
  } else if (/\b(all|everything|both|any)\b/.test(norm)) {
    matched = true
    if (question.multiple) {
      for (let i = 0; i < n; i++) {
        if (!seen.has(i)) {
          seen.add(i)
          indices.push(i)
        }
      }
    } else if (n > 0) {
      seen.add(0)
      indices.push(0)
    }
  } else if (/\b(none|nothing|skip|neither)\b/.test(norm)) {
    matched = true
  } else {
    const m = matchLabel(norm, question)
    if (m !== null) {
      matched = true
      if (m >= 0 && m < n && !seen.has(m)) {
        seen.add(m)
        indices.push(m)
      }
    }
  }

  let result = indices
  if (!question.multiple && result.length > 1) {
    result = result.length > 0 ? [result[0]] : []
  }

  if (result.length === 0 && !matched && question.custom === true) {
    return [-1]
  }
  return result
}

function mapSelection(sel: number[], question: ParsedQuestion, utterance: string): string[] {
  const out: string[] = []
  for (const idx of sel) {
    if (idx === -1) out.push(utterance.trim())
    else if (idx >= 0 && idx < question.options.length) out.push(question.options[idx].label)
  }
  return out
}

export function parseQuestionAnswers(utterance: string, questions: ParsedQuestion[]): string[][] {
  if (questions.length === 0) return []

  if (questions.length === 1) {
    const sel = parseSelection(utterance, questions[0])
    return [mapSelection(sel, questions[0], utterance)]
  }

  const tokens = extractNumericTokens(utterance)
  if (tokens.length === questions.length) {
    const res: string[][] = []
    for (let i = 0; i < questions.length; i++) {
      const sel = parseSelection(tokens[i], questions[i])
      res.push(mapSelection(sel, questions[i], utterance))
    }
    return res
  }

  const sel = parseSelection(utterance, questions[0])
  const res: string[][] = [mapSelection(sel, questions[0], utterance)]
  for (let i = 1; i < questions.length; i++) res.push([])
  return res
}

export function parsePermissionReply(utterance: string): "once" | "always" | "reject" | undefined {
  const norm = normalise(utterance)
  const padded = ` ${norm} `

  const alwaysPhrases = [
    "always",
    "always allow",
    "allow always",
    "never ask",
    "dont ask again",
    "don't ask again",
    "permanent",
    "permanently",
  ]
  const oncePhrases = [
    "yes",
    "yeah",
    "yep",
    "ok",
    "okay",
    "allow",
    "approve",
    "go",
    "go ahead",
    "proceed",
    "do it",
    "sure",
    "fine",
    "accept",
  ]
  const rejectPhrases = [
    "no",
    "nope",
    "nah",
    "deny",
    "reject",
    "refuse",
    "cancel",
    "stop",
    "abort",
    "decline",
    "don't",
    "do not",
  ]

  for (const p of alwaysPhrases) {
    if (padded.includes(` ${p} `)) return "always"
  }
  for (const p of oncePhrases) {
    if (padded.includes(` ${p} `)) return "once"
  }
  for (const p of rejectPhrases) {
    if (padded.includes(` ${p} `)) return "reject"
  }
  return undefined
}

// Whisper returns "." or "…" for silence; treat anything without a letter or digit as empty.
export const cleanTranscript = (text: string): string => (/[a-z0-9]/i.test(text) ? text.trim() : "")
