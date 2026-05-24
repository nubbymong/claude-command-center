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

  // Copilot review on PR #31 (p9.17): applyIdentityAtFlush is now
  // Codex-only. Claude attribution moved to handleStatuslineUpdate
  // (per-session, from the live statusline payload) so seed/sync no
  // longer blanket-stamps historic/other-account Claude records.

  it('uses Codex spawn-time identity from map when provider=codex', () => {
    const data = makeData([{ sessionId: 'sCodex', provider: 'codex' }])
    const codexMap = new Map<string, AccountIdentity>([
      ['sCodex', { email: 'codex@example.com', provider: 'codex' }],
    ])
    applyIdentityAtFlush(data, codexMap)
    expect(data.sessions.sCodex.accountEmail).toBe('codex@example.com')
  })

  it('does NOT stamp Codex sessions when map has no entry (avoid wrong attribution)', () => {
    const data = makeData([{ sessionId: 'sCodex', provider: 'codex' }])
    applyIdentityAtFlush(data, new Map())
    expect(data.sessions.sCodex.accountEmail).toBeUndefined()
  })

  it('does NOT overwrite an existing accountEmail', () => {
    const data = makeData([{ sessionId: 'sCodex', provider: 'codex', accountEmail: 'pre@existing.com' }])
    const codexMap = new Map<string, AccountIdentity>([
      ['sCodex', { email: 'codex@example.com', provider: 'codex' }],
    ])
    applyIdentityAtFlush(data, codexMap)
    expect(data.sessions.sCodex.accountEmail).toBe('pre@existing.com')
  })

  it('canonicalises the Codex email (lowercases + trims)', () => {
    const data = makeData([{ sessionId: 'sCodex', provider: 'codex' }])
    const codexMap = new Map<string, AccountIdentity>([
      ['sCodex', { email: '  Codex@Example.COM  ', provider: 'codex' }],
    ])
    applyIdentityAtFlush(data, codexMap)
    expect(data.sessions.sCodex.accountEmail).toBe('codex@example.com')
  })

  it('does NOT touch Claude records, even if a same-id entry is in the map', () => {
    // The map is Codex-only by construction; guard against a stray entry
    // hitting a Claude record.
    const data = makeData([{ sessionId: 's1', provider: 'claude' }])
    const strayMap = new Map<string, AccountIdentity>([
      ['s1', { email: 'codex@example.com', provider: 'codex' }],
    ])
    applyIdentityAtFlush(data, strayMap)
    expect(data.sessions.s1.accountEmail).toBeUndefined()
  })

  it('leaves historic unattributed Claude records alone (wizard back-fills them)', () => {
    const data = makeData([
      { sessionId: 'hist1', provider: 'claude' },
      { sessionId: 'hist2' }, // no provider field (legacy)
    ])
    applyIdentityAtFlush(data, new Map())
    expect(data.sessions.hist1.accountEmail).toBeUndefined()
    expect(data.sessions.hist2.accountEmail).toBeUndefined()
  })
})
