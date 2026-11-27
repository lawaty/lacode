// Shared notification text/normalization/whitelist helpers for the adapter
// layer. The freedesktop adapter needs these without importing the transport,
// so they live here rather than in src/tunnel/index.ts.
//
// This module is pure: it imports nothing from `src/tunnel` or `src/plugins`.

import type { Icon, Sound, Urgency } from "./types.ts"

/** The icon whitelist. Everything else collapses to the default. */
export const ICONS: readonly Icon[] = [
  "utilities-terminal",
  "dialog-information",
  "dialog-error",
  "dialog-warning",
  "system-run",
  "emblem-default",
] as const

/**
 * The sound whitelist. The sender passes a name, the receiver maps it to a
 * bundled WAV asset; this is data, never a path or a command.
 */
export const SOUNDS: readonly Sound[] = [
  "none",
  "done",
  "question",
  "permission",
  "error",
] as const

export function normalizeUrgency(raw: string | undefined): Urgency {
  return raw === "low" || raw === "critical" || raw === "normal" ? raw : "normal"
}

export function normalizeIcon(raw: string | undefined): Icon {
  return ICONS.includes(raw as Icon) ? (raw as Icon) : "utilities-terminal"
}

export function normalizeSound(raw: string | undefined): Sound {
  return SOUNDS.includes(raw as Sound) ? (raw as Sound) : "none"
}

// Strip control characters and cap the length: both values are user-visible text
// that lands on a desktop, and a session title is not trusted input.
//
// The \u0000-\u001f range includes \n, and the following collapse turns every
// run of whitespace into one space. That is what makes the wire payload
// unambiguous: no field it writes can contain the newline it joins on.
export const safeText = (raw: string, fallback: string, max: number) => {
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  if (!clean) return fallback
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export const safeTitle = (raw: string | undefined) => safeText(raw ?? "", "LaCode", 120)
export const safeMessage = (raw: string | undefined) => safeText(raw ?? "", "", 400)

/**
 * The request id, sanitized.
 *
 * Opaque and never handed to a command: it decides only whether the
 * notification carries buttons. It is stripped of control characters and
 * capped like every other field, so it can never contain the newline the
 * payload is delimited with -- an id that could smuggle a delimiter would
 * split the payload and let a sender forge a field.
 *
 * An absent or empty id yields undefined, which is what "no request id" means:
 * a notification without one is not actionable.
 */
export const safeRequestId = (raw: string | undefined): string | undefined => {
  const clean = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!clean) return undefined
  return clean.length > 128 ? clean.slice(0, 128) : clean
}

/**
 * The correlation key, sanitized for the wire.
 *
 * Opaque like the request id: it says which session a popup belongs to, it is
 * never shown to the user and it never builds a command argument. It is
 * stripped of control characters exactly like the free-text fields, so it can
 * never contain the newline the payload is delimited with -- a key that could
 * smuggle a delimiter would split the payload and let a sender forge a field.
 *
 * The `close:` marker is part of this field and survives the sanitizing
 * unchanged, so a close request is still recognizable on the other end.
 */
export const wireCorrelationKey = (raw: string | undefined): string => safeText(raw ?? "", "", 200)

/**
 * The correlation key of a request, or undefined when it carries none.
 *
 * An absent key and an empty one mean the same thing: the notification is not
 * tracked, no id is captured, and nothing is written to disk.
 */
export const presentCorrelationKey = (raw: string | undefined): string | undefined => {
  const clean = wireCorrelationKey(raw)
  return clean ? clean : undefined
}
