import { describe, it, expect } from 'vitest'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'
import type { TkEvent } from '../../../src/main/tokenomics/tk-types'

function ev(p: Partial<TkEvent> & { configId?: string | null }): any {
  return {
    dedupKey: 'c:m:r', sessionId: 's1', provider: 'claude', model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8',
    ts: Date.parse('2026-06-01T10:00:00Z'), cwd: 'F:\\proj', inTok: 10, outTok: 20, cacheReadTok: 5, cacheCreateTok: 3, configId: 'a', ...p,
  }
}

describe('tk-db ingest + rollups', () => {
  it('inserts events, dedups by dedupKey (INSERT OR IGNORE)', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }])
    const inserted = db.insertEvents([ev({}), ev({})]) // same dedupKey twice
    expect(inserted).toBe(1)
    expect(db.eventCount()).toBe(1)
  })

  it('maintains tk_sessions aggregate (sums, min/max ts, msgCount, configId)', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }])
    db.insertEvents([
      ev({ dedupKey: 'c:1:1', ts: Date.parse('2026-06-01T10:00:00Z'), inTok: 10, outTok: 20 }),
      ev({ dedupKey: 'c:2:2', ts: Date.parse('2026-06-01T12:00:00Z'), inTok: 7, outTok: 1, model: 'claude-sonnet-4-6', priceModel: 'claude-sonnet-4-6' }),
    ])
    const row = db.raw.prepare('SELECT * FROM tk_sessions WHERE sessionId = ?').get('s1') as any
    expect(row.inTok).toBe(17)
    expect(row.outTok).toBe(21)
    expect(row.msgCount).toBe(2)
    expect(row.firstTs).toBe(Date.parse('2026-06-01T10:00:00Z'))
    expect(row.lastTs).toBe(Date.parse('2026-06-01T12:00:00Z'))
    expect(row.lastModel).toBe('claude-sonnet-4-6')
    expect(row.configId).toBe('a')
  })

  it('maintains tk_daily, tk_session_models, tk_heatmap', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([ev({ dedupKey: 'c:1:1' })])
    const daily = db.raw.prepare('SELECT * FROM tk_daily').all() as any[]
    expect(daily).toHaveLength(1)
    expect(daily[0].day).toBe('2026-06-01')
    expect(daily[0].inTok).toBe(10)
    const sm = db.raw.prepare('SELECT * FROM tk_session_models WHERE sessionId=?').all('s1') as any[]
    expect(sm[0].outTok).toBe(20)
    const heat = db.raw.prepare('SELECT * FROM tk_heatmap').all() as any[]
    expect(heat).toHaveLength(1)
    expect(heat[0].bucket).toBeGreaterThanOrEqual(0)
    expect(heat[0].bucket).toBeLessThan(168)
  })

  it('events with junk/unmatched cwd get the "" no-config sentinel (NOT NULL)', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([ev({ dedupKey: 'c:1:1', cwd: '', configId: undefined } as any)])
    const row = db.raw.prepare('SELECT configId FROM tk_sessions WHERE sessionId=?').get('s1') as any
    expect(row.configId).toBe('')
  })

  it('NULL-config events AGGREGATE in tk_daily (sentinel avoids SQLite NULL-distinct)', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([
      ev({ dedupKey: 'c:1:1', cwd: '', configId: null } as any),
      ev({ dedupKey: 'c:2:2', cwd: '', configId: null } as any),
    ])
    const rows = db.raw.prepare("SELECT * FROM tk_daily WHERE configId=''").all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].msgCount).toBe(2)
  })

  it('getSessionCwd returns the stored projectDir', () => {
    const db = openTkDb(':memory:')
    db.insertEvents([ev({ dedupKey: 'c:1:1' })])
    expect(db.getSessionCwd('s1')).toBe('F:\\proj')
  })
})
