import { describe, it, expect } from 'vitest'
import {
  scanTranscriptMessages,
  type TranscriptMessage,
} from '../../../src/main/github/session/transcript-scanner'

describe('scanTranscriptMessages', () => {
  it('extracts #NNN, GH-NNN, and GitHub URLs', () => {
    const msgs: TranscriptMessage[] = [
      {
        role: 'user',
        text: 'Fix #247 and see GH-100 also https://github.com/a/b/pull/12',
        ts: 1,
      },
    ]
    const refs = scanTranscriptMessages(msgs)
    expect(refs.map((r) => r.number).sort((a, b) => a - b)).toEqual([12, 100, 247])
  })

  it('only reads last 50 messages', () => {
    const msgs: TranscriptMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: 'user' as const,
      text: `#${i}`,
      ts: i,
    }))
    const refs = scanTranscriptMessages(msgs)
    expect(refs.every((r) => r.number >= 50)).toBe(true)
  })

  it('ignores non-user/assistant roles', () => {
    const msgs = [
      { role: 'tool_call' as const, text: '#999', ts: 1 },
    ] as unknown as TranscriptMessage[]
    expect(scanTranscriptMessages(msgs)).toEqual([])
  })

  it('never includes message text excerpt in output (privacy invariant)', () => {
    const msgs: TranscriptMessage[] = [
      { role: 'user', text: 'SECRET_LEAK_STRING #42', ts: 1 },
    ]
    const refs = scanTranscriptMessages(msgs)
    expect(JSON.stringify(refs)).not.toContain('SECRET_LEAK_STRING')
  })

  it('distinguishes URL kind between /issues/ and /pull/', () => {
    const msgs: TranscriptMessage[] = [
      {
        role: 'user',
        text: 'https://github.com/a/b/issues/5 https://github.com/a/b/pull/6',
        ts: 1,
      },
    ]
    const refs = scanTranscriptMessages(msgs)
    expect(refs.find((r) => r.number === 5)?.kind).toBe('issue')
    expect(refs.find((r) => r.number === 6)?.kind).toBe('pr')
  })

  it('tolerates non-string text fields', () => {
    const msgs = [
      { role: 'user' as const, text: null, ts: 1 },
      { role: 'user' as const, text: undefined, ts: 2 },
    ] as unknown as TranscriptMessage[]
    expect(scanTranscriptMessages(msgs)).toEqual([])
  })
})
