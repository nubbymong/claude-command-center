import { describe, it, expect } from 'vitest'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'
const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
function mk(db: any, sessionId: string, ts: string, configId: string | null) {
  db.insertEvents([{ dedupKey: `c:${sessionId}:1`, sessionId, provider: 'claude', model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8',
    ts: Date.parse(ts), cwd: configId ? 'F:\\proj' : '', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId }])
}

describe('tk-db querySessions', () => {
  it('keyset-paginates newest-first with stable cursor', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }])
    mk(db, 's1', '2026-06-01T10:00:00Z', 'a')
    mk(db, 's2', '2026-06-02T10:00:00Z', 'a')
    mk(db, 's3', '2026-06-03T10:00:00Z', 'a')
    const p1 = db.querySessions(PRICING, { limit: 2 })
    expect(p1.rows.map((r: any) => r.sessionId)).toEqual(['s3', 's2'])
    expect(p1.nextCursor).toEqual({ lastTs: Date.parse('2026-06-02T10:00:00Z'), sessionId: 's2' })
    const p2 = db.querySessions(PRICING, { limit: 2, cursor: p1.nextCursor })
    expect(p2.rows.map((r: any) => r.sessionId)).toEqual(['s1'])
    expect(p2.nextCursor).toBeNull()
  })

  it('filters by configId, model, time range, and search (sessionId substring)', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }])
    mk(db, 'alpha', '2026-06-01T10:00:00Z', 'a')
    mk(db, 'beta', '2026-06-02T10:00:00Z', null)
    expect(db.querySessions(PRICING, { configId: 'a' }).rows).toHaveLength(1)
    expect(db.querySessions(PRICING, { configId: null }).rows).toHaveLength(1)
    expect(db.querySessions(PRICING, { search: 'alph' }).rows[0].sessionId).toBe('alpha')
    expect(db.querySessions(PRICING, { from: Date.parse('2026-06-02T00:00:00Z') }).rows).toHaveLength(1)
  })

  it('rows carry computed cost + COALESCE config label', () => {
    const db = openTkDb(':memory:')
    mk(db, 's1', '2026-06-01T10:00:00Z', null)
    const r = db.querySessions(PRICING, {}).rows[0]
    expect(r.costUsd).toBeCloseTo(5, 5)
    expect(r.configLabel).toBe('External / no config')
  })

  it('querySessionDetail returns per-model breakdown', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }])
    mk(db, 's1', '2026-06-01T10:00:00Z', 'a')
    const d = db.querySessionDetail(PRICING, 's1')!
    expect(d.sessionId).toBe('s1')
    expect(d.byModel[0]).toMatchObject({ model: 'claude-opus-4-8', costUsd: 5 })
    expect(d.configLabel).toBe('App')
  })

  it('querySessionDetail returns null for unknown session', () => {
    const db = openTkDb(':memory:')
    expect(db.querySessionDetail(PRICING, 'nope')).toBeNull()
  })

  it('sums multi-model session cost correctly', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([
      { dedupKey: 'c:s1:1', sessionId: 's1', provider: 'claude', model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8', ts: Date.parse('2026-06-01T10:00:00Z'), cwd: '', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: null } as any,
      { dedupKey: 'c:s1:2', sessionId: 's1', provider: 'claude', model: 'claude-sonnet-4-6', priceModel: 'claude-sonnet-4-6', ts: Date.parse('2026-06-01T11:00:00Z'), cwd: '', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: null } as any,
    ])
    const PRICING2 = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, 'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }
    const r = db.querySessions(PRICING2, {}).rows[0]
    expect(r.costUsd).toBeCloseTo(8, 5)  // 1M*5/1e6 + 1M*3/1e6 = 8
    const d = db.querySessionDetail(PRICING2, 's1')!
    expect(d.costUsd).toBeCloseTo(8, 5)
    expect(d.byModel).toHaveLength(2)
  })
})
