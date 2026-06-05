import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TokenomicsData, AccountIdentity } from '../../../src/shared/types'

// The Claude attribution pass inside applyIdentityAtFlush reads the
// per-session spawn-time capture via getClaudeAccountMap(). Mock the module
// so the test controls the map without touching the live ~/.claude.json.
const claudeAccountMap = new Map<string, string>()
vi.mock('../../../src/main/claude-account-identity', () => ({
  getClaudeAccount: (sessionId: string) => claudeAccountMap.get(sessionId) ?? null,
  getClaudeAccountMap: () => claudeAccountMap,
}))

// eslint-disable-next-line import/first -- import after vi.mock so the mock is hoisted/applied
import { applyIdentityAtFlush } from '../../../src/main/tokenomics-manager'

describe('applyIdentityAtFlush', () => {
  beforeEach(() => {
    claudeAccountMap.clear()
  })

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

  it('leaves historic unattributed Claude records alone when capture map is empty (wizard back-fills them)', () => {
    const data = makeData([
      { sessionId: 'hist1', provider: 'claude' },
      { sessionId: 'hist2' }, // no provider field (legacy)
    ])
    applyIdentityAtFlush(data, new Map())
    expect(data.sessions.hist1.accountEmail).toBeUndefined()
    expect(data.sessions.hist2.accountEmail).toBeUndefined()
  })

  // ── Claude spawn-time capture pass ──

  it('stamps a Claude record (no accountEmail) from the Claude spawn capture map', () => {
    const data = makeData([{ sessionId: 'sClaude', provider: 'claude' }])
    claudeAccountMap.set('sClaude', 'claude@example.com')
    applyIdentityAtFlush(data, new Map())
    expect(data.sessions.sClaude.accountEmail).toBe('claude@example.com')
  })

  it('canonicalises the captured Claude email (lowercase + trim)', () => {
    const data = makeData([{ sessionId: 'sClaude', provider: 'claude' }])
    claudeAccountMap.set('sClaude', '  Claude@Example.COM  ')
    applyIdentityAtFlush(data, new Map())
    expect(data.sessions.sClaude.accountEmail).toBe('claude@example.com')
  })

  it('does NOT overwrite an already-attributed Claude record (first-identity-wins)', () => {
    const data = makeData([{ sessionId: 'sClaude', provider: 'claude', accountEmail: 'pre@existing.com' }])
    claudeAccountMap.set('sClaude', 'claude@example.com')
    applyIdentityAtFlush(data, new Map())
    expect(data.sessions.sClaude.accountEmail).toBe('pre@existing.com')
  })

  it('only stamps Claude-provider records from the Claude capture map (leaves Codex untouched)', () => {
    const data = makeData([{ sessionId: 'sCodex', provider: 'codex' }])
    // A stray entry keyed by a Codex session id must not be stamped by the
    // Claude pass (the Codex pass owns Codex records).
    claudeAccountMap.set('sCodex', 'claude@example.com')
    applyIdentityAtFlush(data, new Map())
    expect(data.sessions.sCodex.accountEmail).toBeUndefined()
  })

  it('does NOT touch a Claude session id absent from the capture map', () => {
    const data = makeData([{ sessionId: 'sClaude', provider: 'claude' }])
    applyIdentityAtFlush(data, new Map())
    expect(data.sessions.sClaude.accountEmail).toBeUndefined()
  })

  it('Codex pass is unaffected by the Claude pass (both stamp their own records)', () => {
    const data = makeData([
      { sessionId: 'sCodex', provider: 'codex' },
      { sessionId: 'sClaude', provider: 'claude' },
    ])
    const codexMap = new Map<string, AccountIdentity>([
      ['sCodex', { email: 'codex@example.com', provider: 'codex' }],
    ])
    claudeAccountMap.set('sClaude', 'claude@example.com')
    applyIdentityAtFlush(data, codexMap)
    expect(data.sessions.sCodex.accountEmail).toBe('codex@example.com')
    expect(data.sessions.sClaude.accountEmail).toBe('claude@example.com')
  })
})
