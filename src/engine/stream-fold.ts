/**
 * Streaming transcript folding: accumulate assistant text chunks from a
 * session event log, resuming after a caller-owned index.
 * @module dsh-ace-harness/engine
 */

/** Minimal structural view of a session event for streaming purposes. */
export interface StreamEventLike {
  type?: string
  chunk?: unknown
}

/** Appendable folded text with the resume index for the next call. */
export interface TextFold {
  text: string
  index: number
}

/** Extract text from one assistant chunk of unknown shape. */
function chunkText(chunk: unknown): string {
  if (typeof chunk !== 'object' || chunk === null) return ''
  const record = chunk as { type?: string; text?: string; delta?: unknown }
  if (record.type === 'text' && typeof record.text === 'string') return record.text
  if (typeof record.delta === 'string') return record.delta
  return ''
}

/**
 * Fold `assistant/chunk` text events from `fromIndex` onward.
 * @returns the accumulated text (relative to the last fold) and the next index.
 */
export function foldAssistantText(
  events: readonly StreamEventLike[],
  fromIndex: number,
): TextFold {
  let text = ''
  let index = fromIndex
  for (; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'assistant/chunk') continue
    text += chunkText(event.chunk)
  }
  return { text, index }
}
