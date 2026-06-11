import { describe, it, expect } from 'vitest'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'

describe('tk-db schema', () => {
  it('opens in-memory, sets schemaVersion, exposes meta get/set', () => {
    const db = openTkDb(':memory:')
    expect(db.getMeta('schemaVersion')).toBe('1')
    db.setMeta('firstIndexComplete', '1')
    expect(db.getMeta('firstIndexComplete')).toBe('1')
  })

  it('tracks file cursors (upsert + read + list)', () => {
    const db = openTkDb(':memory:')
    expect(db.getFileCursor('/a.jsonl')).toBeNull()
    db.setFileCursor({ path: '/a.jsonl', size: 100, mtime: 5, lastOffset: 80, lastIngestedAt: 1 })
    expect(db.getFileCursor('/a.jsonl')).toMatchObject({ size: 100, mtime: 5, lastOffset: 80 })
    db.setFileCursor({ path: '/a.jsonl', size: 200, mtime: 6, lastOffset: 150, lastIngestedAt: 2 })
    expect(db.getFileCursor('/a.jsonl')?.lastOffset).toBe(150)
  })

  it('counts events (0 on empty)', () => {
    const db = openTkDb(':memory:')
    expect(db.eventCount()).toBe(0)
  })
})
