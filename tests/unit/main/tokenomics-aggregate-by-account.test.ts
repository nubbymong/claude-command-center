import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { StatuslineData, TokenomicsSessionRecord } from '../../../src/shared/types'

// Importing tokenomics-manager pulls in claude-account-identity (handleStatuslineUpdate
// reads the spawn capture). Mock it with empty maps -- attribution here comes from the
// seeded records' own accountEmail, not the live capture.
vi.mock('../../../src/main/claude-account-identity', () => ({
  getClaudeAccount: () => null,
  getClaudeAccountMap: () => new Map(),
  getClaudeProfileId: () => undefined,
}))

// eslint-disable-next-line import/first -- after vi.mock so the mock applies
import {
  handleStatuslineUpdate,
  __resetTokenomicsForTests,
  __seedTokenomicsForTests,
} from '../../../src/main/tokenomics-manager'

function rec(over: Partial<TokenomicsSessionRecord>): TokenomicsSessionRecord {
  return {
    sessionId: 's', projectDir: '/p', model: 'sonnet',
    totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    totalCostUsd: 0, messageCount: 0,
    firstTimestamp: '2026-03-03T10:00:00Z', lastTimestamp: '2026-03-03T10:00:00Z',
    ...over,
  }
}

describe('rebuildAggregates -- byAccount axis', () => {
  beforeEach(() => { __resetTokenomicsForTests() })

  it('buckets each day cost by account email', () => {
    __seedTokenomicsForTests([
      rec({ sessionId: 'sA', accountEmail: 'alice@example.com', totalCostUsd: 2, totalInputTokens: 100, totalOutputTokens: 10 }),
      rec({ sessionId: 'sB', accountEmail: 'bob@example.com', totalCostUsd: 5, totalInputTokens: 200, totalOutputTokens: 20 }),
    ])
    // An identity-only tick on an already-attributed session re-affirms its cost and
    // forces a rebuild without perturbing the seeded values (first-identity-wins).
    handleStatuslineUpdate({ sessionId: 'sB', costUsd: 5 } as StatuslineData)

    const day = __seedTokenomicsForTests.read().dailyAggregates['2026-03-03']
    expect(day.byAccount?.['alice@example.com']).toEqual({ costUsd: 2, inputTokens: 100, outputTokens: 10 })
    expect(day.byAccount?.['bob@example.com']).toEqual({ costUsd: 5, inputTokens: 200, outputTokens: 20 })
  })

  it('buckets unattributed sessions under a sentinel key so the axis reconciles to the day total', () => {
    __seedTokenomicsForTests([
      rec({ sessionId: 'sU', totalCostUsd: 3, totalInputTokens: 50, totalOutputTokens: 5 }), // no accountEmail
    ])
    handleStatuslineUpdate({ sessionId: 'sU', costUsd: 3 } as StatuslineData)

    const day = __seedTokenomicsForTests.read().dailyAggregates['2026-03-03']
    expect(day.byAccount?.['__unattributed__']).toEqual({ costUsd: 3, inputTokens: 50, outputTokens: 5 })
  })

  it('folds cache tokens into the account inputTokens (matches byModel accounting)', () => {
    __seedTokenomicsForTests([
      rec({ sessionId: 'sC', accountEmail: 'carol@example.com', totalCostUsd: 1,
        totalInputTokens: 10, totalCacheReadTokens: 7, totalCacheWriteTokens: 3, totalOutputTokens: 4 }),
    ])
    handleStatuslineUpdate({ sessionId: 'sC', costUsd: 1 } as StatuslineData)

    const day = __seedTokenomicsForTests.read().dailyAggregates['2026-03-03']
    expect(day.byAccount?.['carol@example.com']).toEqual({ costUsd: 1, inputTokens: 20, outputTokens: 4 })
  })
})
