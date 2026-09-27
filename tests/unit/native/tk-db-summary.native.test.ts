import { describe, it, expect } from 'vitest'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'
import type { TkEvent } from '../../../src/main/tokenomics/tk-types'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
function ev(p: Partial<TkEvent> & { configId?: string | null }): any {
  return { dedupKey: 'c:m:r', sessionId: 's1', provider: 'claude', model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8',
    ts: Date.parse('2026-06-01T10:00:00Z'), cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: 'a', ...p }
}

describe('tk-db querySummary', () => {
  it('computes cost from tokens via pricing CTE', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }])
    db.insertEvents([ev({ dedupKey: 'c:1:1' })])
    const s = db.querySummary(PRICING, {})
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(5, 5)
    expect(s.dailySeries).toEqual([{ day: '2026-06-01', costUsd: 5, byProvider: { claude: 5, codex: 0 } }])
    expect(s.costByConfig[0]).toMatchObject({ configId: 'a', label: 'App', costUsd: 5, sessions: 1 })
  })

  it('labels NULL config as External / no config', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([ev({ dedupKey: 'c:1:1', cwd: '', configId: null })])
    const s = db.querySummary(PRICING, {})
    expect(s.costByConfig[0].label).toBe('External / no config')
    expect(s.costByConfig[0].configId).toBeNull()
  })

  it('cache efficiency + savings', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([ev({ dedupKey: 'c:1:1', inTok: 1_000_000, cacheReadTok: 1_000_000 })])
    const s = db.querySummary(PRICING, {})
    expect(s.kpis.cacheEfficiencyPct).toBeCloseTo(50, 1)
    expect(s.kpis.cacheSavingsUsd).toBeCloseTo(4.5, 5)
  })

  it('filters by configId and time range', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }, { configId: 'b', label: 'Other', workingDirectory: 'F:\\o' }])
    db.insertEvents([
      ev({ dedupKey: 'c:1:1', sessionId: 's1', configId: 'a' }),
      ev({ dedupKey: 'c:2:2', sessionId: 's2', configId: 'b', cwd: 'F:\\o' }),
    ])
    const s = db.querySummary(PRICING, { configId: 'a' })
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(5, 5)
    expect(s.costByConfig).toHaveLength(1)
  })

  it('produces 7d and prev-7d windows + heatmap + modelSplit + cacheSplit', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([ev({ dedupKey: 'c:1:1' })])
    const s = db.querySummary(PRICING, {})
    expect(Array.isArray(s.heatmap)).toBe(true)
    expect(s.modelSplit[0]).toMatchObject({ model: 'claude-opus-4-8', costUsd: 5 })
    expect(s.cacheSplit.inputUsd).toBeCloseTo(5, 5)
    expect(typeof s.kpis.last7dCostUsd).toBe('number')
    expect(typeof s.kpis.prev7dCostUsd).toBe('number')
  })

  it('counts sessions PER config (not the grand total on one arbitrary config)', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([
      { configId: 'a', label: 'App', workingDirectory: 'F:\\proj' },
      { configId: 'b', label: 'Other', workingDirectory: 'F:\\o' },
    ])
    db.insertEvents([
      ev({ dedupKey: 'c:1:1', sessionId: 's1', configId: 'a' }),
      ev({ dedupKey: 'c:2:2', sessionId: 's2', configId: 'b', cwd: 'F:\\o' }),
      ev({ dedupKey: 'c:3:3', sessionId: 's3', configId: 'b', cwd: 'F:\\o' }),
    ])
    const s = db.querySummary(PRICING, {})
    const byId = Object.fromEntries(s.costByConfig.map((c) => [c.configId, c.sessions]))
    expect(byId['a']).toBe(1)
    expect(byId['b']).toBe(2)
  })
})

// Usage track MP11: a model with no price is "no price", never $0, and its
// cost is in no figure; the figures split by provider.
describe('tk-db querySummary: unpriced models and the provider split (MP11)', () => {
  const PRICED = { ...PRICING, 'gpt-5.5': { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 } }
  const codex = (p: Record<string, unknown>) => ev({ provider: 'codex', model: 'gpt-5.5', priceModel: 'gpt-5.5', ...p })
  const NOW = Date.parse('2026-06-03T12:00:00Z')
  function seed() {
    const db = openTkDb(':memory:')
    db.insertEvents([
      ev({ dedupKey: 'c:1:1', sessionId: 's-claude' }),
      ev({ dedupKey: 'c:2:2', sessionId: 's-claude', ts: Date.parse('2026-06-02T10:00:00Z') }),
      // A Claude model with no price, in a session of its own and beside a priced one.
      ev({ dedupKey: 'c:3:3', sessionId: 's-new', model: 'claude-new-9', priceModel: 'claude-new-9', inTok: 300, outTok: 20 }),
      ev({ dedupKey: 'c:4:4', sessionId: 's-claude', model: 'claude-new-9', priceModel: 'claude-new-9', inTok: 100, outTok: 0, cacheReadTok: 7 }),
      codex({ dedupKey: 'x:c:0', sessionId: 'cx-1', inTok: 2_000_000 }),
      codex({ dedupKey: 'x:c:1', sessionId: 'cx-1', model: 'gpt-9-unpriced', priceModel: 'gpt-9-unpriced', inTok: 50, ts: Date.parse('2026-06-02T11:00:00Z') }),
    ])
    return db
  }

  it('a model with no price has no cost: never $0, in no total, listed with its tokens', () => {
    const s = seed().querySummary(PRICED, {}, NOW)
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(5 + 5 + 2, 6)
    expect(s.modelSplit.find((m) => m.model === 'claude-new-9')).toEqual({ model: 'claude-new-9', costUsd: null, tokens: 427 })
    expect(s.modelSplit.find((m) => m.model === 'gpt-9-unpriced')?.costUsd).toBeNull()
    expect(s.modelSplit.find((m) => m.model === 'claude-opus-4-8')?.costUsd).toBeCloseTo(10, 6)
    expect(s.unpriced).toEqual([{ model: 'claude-new-9', provider: 'claude', tokens: 427 }, { model: 'gpt-9-unpriced', provider: 'codex', tokens: 50 }])
    expect(s.costByConfig[0].costUsd).toBeCloseTo(12, 6)
    expect(s.cacheSplit.inputUsd).toBeCloseTo(12, 6)
    // Every model priced: none listed.
    expect(seed().querySummary({ ...PRICED, 'claude-new-9': PRICING['claude-opus-4-8'], 'gpt-9-unpriced': PRICED['gpt-5.5'] }, {}, NOW).unpriced).toEqual([])
  })

  it('the unpriced list follows the filters', () => {
    const db = seed()
    expect(db.querySummary(PRICED, { provider: 'codex' }, NOW).unpriced).toEqual([{ model: 'gpt-9-unpriced', provider: 'codex', tokens: 50 }])
    expect(db.querySummary(PRICED, { provider: 'claude' }, NOW).unpriced).toEqual([{ model: 'claude-new-9', provider: 'claude', tokens: 427 }])
    expect(db.querySummary(PRICED, { model: 'claude-opus-4-8' }, NOW).unpriced).toEqual([])
  })

  it('a session with no priced model has no cost; one with some carries the priced part and the tokens without a price', () => {
    const db = seed()
    const rows = Object.fromEntries(db.querySessions(PRICED, {}).rows.map((r) => [r.sessionId, r]))
    expect(rows['s-new']).toMatchObject({ costUsd: null, unpricedTokens: 320 })
    expect(rows['s-claude'].costUsd).toBeCloseTo(10, 6)
    expect(rows['s-claude'].unpricedTokens).toBe(107)
    expect(rows['cx-1'].costUsd).toBeCloseTo(2, 6)
    expect(rows['cx-1'].unpricedTokens).toBe(50)
    const none = db.querySessionDetail(PRICED, 's-new')!
    expect(none).toMatchObject({ costUsd: null, unpricedTokens: 320 })
    expect(none.byModel).toEqual([expect.objectContaining({ model: 'claude-new-9', costUsd: null })])
    const some = db.querySessionDetail(PRICED, 's-claude')!
    expect(some.costUsd).toBeCloseTo(10, 6)
    expect(some.unpricedTokens).toBe(107)
    expect(some.byModel.find((m) => m.model === 'claude-new-9')?.costUsd).toBeNull()
  })

  it('the headline figures and the daily series split by provider, and the parts make the whole', () => {
    const s = seed().querySummary(PRICED, {}, NOW)
    expect(s.kpisByProvider.claude.lifeToDateCostUsd).toBeCloseTo(10, 6)
    expect(s.kpisByProvider.codex.lifeToDateCostUsd).toBeCloseTo(2, 6)
    for (const k of ['lifeToDateCostUsd', 'last7dCostUsd', 'prev7dCostUsd', 'cacheSavingsUsd'] as const) {
      expect(s.kpisByProvider.claude[k] + s.kpisByProvider.codex[k], k).toBeCloseTo(s.kpis[k], 6)
    }
    expect(s.kpisByProvider.claude.cacheEfficiencyPct).toBeCloseTo((7 / (7 + 2_000_400)) * 100, 6)
    expect(s.kpisByProvider.codex.cacheEfficiencyPct).toBe(0)
    expect(s.dailySeries).toEqual([
      { day: '2026-06-01', costUsd: expect.closeTo(7, 6), byProvider: { claude: expect.closeTo(5, 6), codex: expect.closeTo(2, 6) } },
      { day: '2026-06-02', costUsd: expect.closeTo(5, 6), byProvider: { claude: expect.closeTo(5, 6), codex: 0 } },
    ])
    // One provider's summary: the other's part is empty.
    const onlyCodex = seedOnly('codex')
    expect(onlyCodex.kpisByProvider.claude.lifeToDateCostUsd).toBe(0)
    expect(onlyCodex.kpisByProvider.codex.lifeToDateCostUsd).toBeCloseTo(onlyCodex.kpis.lifeToDateCostUsd, 6)
  })

  // MP11 round 1 (Q-2): a config whose usage has no price has no cost.
  it('a config whose usage has no price has no cost, listed after the priced ones', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([
      ev({ dedupKey: 'c:1:1', configId: 'a' }),
      ev({ dedupKey: 'c:2:2', configId: 'b', model: 'claude-new-9', priceModel: 'claude-new-9', inTok: 300 }),
      // A priced config that cost nothing is $0, and comes before no price.
      ev({ dedupKey: 'c:3:3', configId: 'z', inTok: 0 }),
    ])
    const s = db.querySummary(PRICED, {}, NOW)
    expect(s.costByConfig.map((c) => [c.configId, c.costUsd])).toEqual([['a', 5], ['z', 0], ['b', null]])
  })

  // MP11 round 1 (spec): the unpriced list covers the range shown, as the
  // charts do, so the notice names what the view holds.
  it('the unpriced list covers the range shown', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([
      ev({ dedupKey: 'c:1:1', model: 'claude-old-1', priceModel: 'claude-old-1', inTok: 70, ts: Date.parse('2026-05-01T10:00:00Z') }),
      ev({ dedupKey: 'c:2:2', model: 'claude-new-9', priceModel: 'claude-new-9', inTok: 30, ts: Date.parse('2026-06-02T10:00:00Z') }),
    ])
    const week = Date.parse('2026-05-27T00:00:00Z')
    expect(db.querySummary(PRICED, { from: week }, NOW).unpriced).toEqual([{ model: 'claude-new-9', provider: 'claude', tokens: 30 }])
    expect(db.querySummary(PRICED, {}, NOW).unpriced.map((u) => u.model)).toEqual(['claude-old-1', 'claude-new-9'])
  })

  function seedOnly(provider: 'codex') {
    return seed().querySummary(PRICED, { provider }, NOW)
  }
})
