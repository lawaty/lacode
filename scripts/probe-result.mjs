/**
 * Did a direct /chat/completions probe actually produce an answer?
 *
 * A reasoning model can return HTTP 200 with a well-formed `choices` array and
 * an empty `message.content` (all its budget spent on hidden reasoning under a
 * tiny max_tokens). That is not an answer: the pool would route real work to a
 * model that emits nothing. Returning `true` when the shape cannot be judged
 * keeps the scan forgiving -- only a positively empty completion fails.
 */
export function hasDirectAnswer(parsed) {
  const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
  const message = choice && choice.message
  if (!message) return true
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true
  const content = message.content
  if (typeof content === "string") return content.trim() !== ""
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (typeof part === "string") return part.trim() !== ""
      if (part && typeof part.text === "string") return part.text.trim() !== ""
      return false
    })
  }
  return true
}

/**
 * Did an opencode session probe actually produce an answer? The response is a
 * message with `parts`; a blank text part with no tool call is the same empty
 * completion the direct probe now rejects. A response with no `parts` array
 * cannot be judged and is not failed.
 */
export function hasSessionAnswer(parsed) {
  const parts = parsed && parsed.parts
  if (!Array.isArray(parts)) return true
  return parts.some((part) => {
    if (!part) return false
    if (part.type === "tool") return true
    if (part.type === "text" && typeof part.text === "string") return part.text.trim() !== ""
    return false
  })
}
