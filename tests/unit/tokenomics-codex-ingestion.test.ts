import { describe, it, expect } from 'vitest'
import { backfillTokenomicsProvider } from '../../src/main/tokenomics-manager'
import type { TokenomicsData } from '../../src/shared/types'

describe('backfillTokenomicsProvider', () => {
  it('tags untyped sessions as claude', () => {
    const data: TokenomicsData = {
      sessions: { 's1': { sessionId: 's1', model: 'sonnet' } as any },
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: true,
    }
    const mutated = backfillTokenomicsProvider(data)
    expect(mutated).toBe(true)
    expect((data.sessions['s1'] as any).provider).toBe('claude')
  })

  it('leaves typed sessions untouched and reports not mutated', () => {
    const data: TokenomicsData = {
      sessions: { 's2': { sessionId: 's2', model: 'gpt-5.5', provider: 'codex' } as any },
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: true,
    }
    const mutated = backfillTokenomicsProvider(data)
    expect(mutated).toBe(false)
    expect((data.sessions['s2'] as any).provider).toBe('codex')
  })

  it('handles mixed batches (some typed, some not)', () => {
    const data: TokenomicsData = {
      sessions: {
        's1': { sessionId: 's1', model: 'sonnet' } as any,
        's2': { sessionId: 's2', model: 'gpt-5.5', provider: 'codex' } as any,
        's3': { sessionId: 's3', model: 'opus' } as any,
      },
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: true,
    }
    const mutated = backfillTokenomicsProvider(data)
    expect(mutated).toBe(true)
    expect((data.sessions['s1'] as any).provider).toBe('claude')
    expect((data.sessions['s2'] as any).provider).toBe('codex')
    expect((data.sessions['s3'] as any).provider).toBe('claude')
  })
})
