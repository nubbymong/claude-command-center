import { describe, it, expect } from 'vitest'
import { applyIdentityAtFlush } from '../../../src/main/tokenomics-manager'
import type { TokenomicsData, AccountIdentity } from '../../../src/shared/types'

describe('applyIdentityAtFlush', () => {
  function makeData(records: any[]): TokenomicsData {
    const sessions: Record<string, any> = {}
    for (const r of records) sessions[r.sessionId] = r
    return {
      sessions,
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: true,
    } as TokenomicsData
  }

  const identity: AccountIdentity = { email: 'alice@example.com', provider: 'claude' }

  it('stamps accountEmail on Claude session records missing one', () => {
    const data = makeData([{ sessionId: 's1', provider: 'claude' }])
    applyIdentityAtFlush(data, identity, new Map())
    expect(data.sessions.s1.accountEmail).toBe('alice@example.com')
  })

  it('does NOT overwrite an existing accountEmail', () => {
    const data = makeData([{ sessionId: 's1', provider: 'claude', accountEmail: 'pre@existing.com' }])
    applyIdentityAtFlush(data, identity, new Map())
    expect(data.sessions.s1.accountEmail).toBe('pre@existing.com')
  })

  it('uses Codex spawn-time identity from map when provider=codex', () => {
    const data = makeData([{ sessionId: 'sCodex', provider: 'codex' }])
    const codexMap = new Map<string, AccountIdentity>([
      ['sCodex', { email: 'codex@example.com', provider: 'codex' }],
    ])
    applyIdentityAtFlush(data, identity, codexMap)
    expect(data.sessions.sCodex.accountEmail).toBe('codex@example.com')
  })

  it('does NOT stamp Codex sessions when map has no entry (avoid wrong attribution)', () => {
    const data = makeData([{ sessionId: 'sCodex', provider: 'codex' }])
    applyIdentityAtFlush(data, identity, new Map())
    expect(data.sessions.sCodex.accountEmail).toBeUndefined()
  })

  it('canonicalises email (lowercases + trims)', () => {
    const data = makeData([{ sessionId: 's1', provider: 'claude' }])
    applyIdentityAtFlush(data, { email: '  Alice@Example.COM  ', provider: 'claude' }, new Map())
    expect(data.sessions.s1.accountEmail).toBe('alice@example.com')
  })

  it('passes through null identity safely (no-op)', () => {
    const data = makeData([{ sessionId: 's1', provider: 'claude' }])
    applyIdentityAtFlush(data, null, new Map())
    expect(data.sessions.s1.accountEmail).toBeUndefined()
  })
})
