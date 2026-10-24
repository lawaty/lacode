import { BASES } from "./pool.ts"

/**
 * Remove literal pool slot-variant names from text handed to a model.
 *
 * A prompt that names a variant teaches the model that name, and a model that
 * has seen it will type it. The variant name is an internal routing detail; the
 * model must only ever see the bare base. This scrubs the assembled system
 * prompt so a stale prompt file cannot keep leaking names.
 */
const SLOT = new RegExp(`\\b(${BASES.join("|")})(?:-[1-9][0-9]*)+\\b`, "g")

export function scrubSlotNames(text: string): string {
  return text.replace(SLOT, "$1")
}
