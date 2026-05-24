import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock saveData FIRST so applyAttributionPayload doesn't touch real disk.
// (T5/I1: mock saveData per plan correction). Belt-and-braces: the
// __resetTokenomicsForTests hook ALSO flips an internal save-skip flag so
// the in-module saveData call is a no-op regardless of mock interception
// semantics.
vi.mock('../../../src/main/tokenomics-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/tokenomics-manager')>()
  return { ...actual, saveData: vi.fn() }
})

import {
  applyAttributionPayload,
  __resetTokenomicsForTests,
  __seedTokenomicsForTests,
} from '../../../src/main/tokenomics-manager'
import type { TokenomicsSessionRecord } from '../../../src/shared/types'

const base: TokenomicsSessionRecord = {
  sessionId: '',
  projectDir: '/p',
  model: 'sonnet',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalCostUsd: 0,
  messageCount: 0,
  firstTimestamp: '2026-01-01T00:00:00Z',
  lastTimestamp: '2026-01-01T00:00:00Z',
}

describe('applyAttributionPayload', () => {
  beforeEach(() => {
    __resetTokenomicsForTests()
    __seedTokenomicsForTests([
      { ...base, sessionId: 's1' },
      { ...base, sessionId: 's2' },
      { ...base, sessionId: 's3', accountEmail: 'pre@existing.com' },
    ])
  })

  it('assigns an email to listed sessions, canonicalising case', () => {
    applyAttributionPayload({ sessionIds: ['s1', 's2'], assignment: { type: 'email', email: 'Alice@Example.COM' } })
    const data = __seedTokenomicsForTests.read()
    expect(data.sessions.s1.accountEmail).toBe('alice@example.com')
    expect(data.sessions.s2.accountEmail).toBe('alice@example.com')
  })

  it('marks listed sessions as mixed', () => {
    applyAttributionPayload({ sessionIds: ['s1'], assignment: { type: 'mixed' } })
    expect(__seedTokenomicsForTests.read().sessions.s1.attributionMixed).toBe(true)
  })

  it('clears attribution on listed sessions', () => {
    applyAttributionPayload({ sessionIds: ['s3'], assignment: { type: 'clear' } })
    const r = __seedTokenomicsForTests.read().sessions.s3
    expect(r.accountEmail).toBeUndefined()
    expect(r.attributionMixed).toBeUndefined()
  })

  it('ignores session ids not in the store', () => {
    expect(() => applyAttributionPayload({ sessionIds: ['nope'], assignment: { type: 'email', email: 'x@y.com' } })).not.toThrow()
  })
})
