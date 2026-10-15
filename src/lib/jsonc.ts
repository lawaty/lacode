// JSONC -> JSON, shared by every module that reads the user's opencode config.
//
// Extracted from writer-rule.ts rather than re-implemented for `lacode version`:
// a second stripper is a second set of edge cases, and the two readers would
// eventually disagree about the same file. One fact, one file.

/**
 * Strip `//` and slash-star comments, then trailing commas, so a .jsonc file
 * parses as JSON. String-aware on both counts: a `//` inside a description or a
 * `"*"` inside a quoted pattern is content, not syntax, and truncating there
 * would turn a real config into an unparseable one.
 */
export const stripJsonc = (raw: string) => {
  let out = ""
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"') {
      out += ch
      i++
      while (i < raw.length) {
        out += raw[i]
        if (raw[i] === "\\") {
          out += raw[i + 1] ?? ""
          i += 2
          continue
        }
        if (raw[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++
      continue
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/** Parse a .jsonc document, or undefined when it is not JSON at all. */
export const parseJsonc = (raw: string): unknown => {
  try {
    return JSON.parse(stripJsonc(raw))
  } catch {
    return undefined
  }
}