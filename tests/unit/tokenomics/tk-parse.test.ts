import { describe, it, expect } from 'vitest'
import { parseClaudeUsageLine, extractCwdFromLine, codexEventsFromRollout } from '../../../src/main/tokenomics/tk-parse'

const PRICE_KEYS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'gpt-5.5']

describe('parseClaudeUsageLine', () => {
  it('extracts tokens + ids + ts from an assistant line', () => {
    const line = JSON.stringify({
      type: 'assistant', timestamp: '2026-06-01T10:00:00.000Z', sessionId: 's1', requestId: 'req_1',
      cwd: 'F:\\proj', message: { id: 'msg_1', model: 'claude-opus-4-8-20260101',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } },
    })
    const ev = parseClaudeUsageLine(line, PRICE_KEYS)
    expect(ev).toEqual({
      dedupKey: 'c:msg_1:req_1', sessionId: 's1', provider: 'claude',
      model: 'claude-opus-4-8-20260101', priceModel: 'claude-opus-4-8',
      ts: Date.parse('2026-06-01T10:00:00.000Z'), cwd: 'F:\\proj',
      inTok: 10, outTok: 20, cacheReadTok: 5, cacheCreateTok: 3,
    })
  })

  it('returns null for non-assistant lines (fast path)', () => {
    expect(parseClaudeUsageLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }), PRICE_KEYS)).toBeNull()
  })

  it('returns null for assistant lines without usage', () => {
    expect(parseClaudeUsageLine(JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'x' } }), PRICE_KEYS)).toBeNull()
  })

  it('falls back to messageId-only dedupKey when requestId absent', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1',
      message: { id: 'msg_9', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } } })
    expect(parseClaudeUsageLine(line, PRICE_KEYS)?.dedupKey).toBe('c:msg_9:')
  })

  it('returns null on malformed JSON without throwing', () => {
    expect(parseClaudeUsageLine('{not json', PRICE_KEYS)).toBeNull()
  })
})

describe('extractCwdFromLine', () => {
  it('reads top-level cwd', () => {
    expect(extractCwdFromLine(JSON.stringify({ type: 'user', cwd: 'F:\\proj' }))).toBe('F:\\proj')
  })
  it('returns null when no cwd present', () => {
    expect(extractCwdFromLine(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull()
  })
})

describe('codexEventsFromRollout', () => {
  it('emits one delta event per token_count turn (first=total, rest=last_token_usage)', () => {
    const text = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-06-01T09:00:00Z', payload: { id: 'cx1', cwd: 'F:\\cx', model: '' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-06-01T09:01:00Z', payload: { type: 'token_count',
        info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 165 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-06-01T09:02:00Z', payload: { type: 'token_count',
        info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 30, output_tokens: 120, reasoning_output_tokens: 10, total_tokens: 460 },
                last_token_usage: { input_tokens: 200, cached_input_tokens: 20, output_tokens: 70, reasoning_output_tokens: 5, total_tokens: 295 } } } }),
    ].join('\n')
    const evs = codexEventsFromRollout(text, PRICE_KEYS, 0)
    expect(evs).toHaveLength(2)
    // outTok excludes reasoning_output_tokens: it is a SUBSET of output_tokens
    // (real rollouts show total_tokens == input + output exactly).
    expect(evs[0]).toMatchObject({ dedupKey: 'x:cx1:0', provider: 'codex', model: 'gpt-5.5', priceModel: 'gpt-5.5',
      cwd: 'F:\\cx', inTok: 90, cacheReadTok: 10, outTok: 50, cacheCreateTok: 0 })
    expect(evs[1]).toMatchObject({ dedupKey: 'x:cx1:1', inTok: 180, cacheReadTok: 20, outTok: 70 })
  })

  it('supports startOrdinal for incremental tail (skips already-ingested turns)', () => {
    const text = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-06-01T09:00:00Z', payload: { id: 'cx1', cwd: 'F:\\cx' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 } } } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 220 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 } } } }),
    ].join('\n')
    const evs = codexEventsFromRollout(text, PRICE_KEYS, 1)
    expect(evs).toHaveLength(1)
    expect(evs[0].dedupKey).toBe('x:cx1:1')
  })
})
