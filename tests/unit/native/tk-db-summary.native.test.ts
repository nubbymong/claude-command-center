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
    expect(s.dailySeries).toEqual([{ day: '2026-06-01', costUsd: 5 }])
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
