import { describe, expect, it } from 'vitest'
import { foldAssistantText, type StreamEventLike } from '../src/engine/stream-fold.js'

const events: StreamEventLike[] = [
  { type: 'turn/start' },
  { type: 'assistant/chunk', chunk: { type: 'text', text: '你好' } },
  { type: 'assistant/chunk', chunk: { type: 'text', text: '，世界' } },
  { type: 'tool/call' },
  { type: 'assistant/chunk', chunk: { type: 'tool-call-delta' } },
]

describe('foldAssistantText', () => {
  it('accumulates text chunks from the resume index', () => {
    expect(foldAssistantText(events, 0)).toEqual({ text: '你好，世界', index: events.length })
  })

  it('resumes after the previous index without duplicating text', () => {
    const first = foldAssistantText(events, 0)
    const second = foldAssistantText(events, first.index)
    expect(second.text).toBe('')
  })

  it('skips non-chunk events and non-text chunks', () => {
    const fold = foldAssistantText(events, 0)
    expect(fold.text).not.toContain('tool-call')
  })

  it('handles empty logs and out-of-range indexes', () => {
    expect(foldAssistantText([], 0)).toEqual({ text: '', index: 0 })
    expect(foldAssistantText(events, 99)).toEqual({ text: '', index: 99 })
  })
})
