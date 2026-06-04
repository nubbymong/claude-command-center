/**
 * Native test for src/main/logging/log-db.ts — must run under Electron-as-Node
 * (npm run test:unit:native) because better-sqlite3 is built for Electron's ABI.
 *
 * Uses ':memory:' DB in beforeEach for isolation; close() in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openLogDb } from '../../../src/main/logging/log-db'
import type { LogDb } from '../../../src/main/logging/log-db'

describe('log-db', () => {
  let db: LogDb

  beforeEach(() => {
    db = openLogDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('records a session + events and finds them by FTS', () => {
    db.upsertSession({
      sessionId: 's1',
      configId: 'c1',
      configLabel: 'APP_DEV',
      projectCwd: 'F:/x',
      provider: 'claude',
      startedAt: 1,
    })
    db.appendBatch([
      {
        sessionId: 's1',
        ts: 2,
        type: 'data',
        raw: Buffer.from('hello \x1b[31mworld\x1b[0m'),
        text: 'hello world',
      },
    ])
    expect(db.listSessions().length).toBe(1)
    expect(db.search('world').map((r) => r.sessionId)).toContain('s1')
    expect(db.readEvents('s1', { offset: 0, limit: 10 }).length).toBe(1)
  })

  it('upsert by sessionId is idempotent (no dup rows)', () => {
    db.upsertSession({
      sessionId: 's-idem',
      configLabel: 'X',
      provider: 'claude',
      startedAt: 10,
    })
    db.upsertSession({
      sessionId: 's-idem',
      configLabel: 'X',
      provider: 'claude',
      startedAt: 10,
    })
    expect(db.listSessions().length).toBe(1)
  })

  it('upsert does NOT clobber endedAt / status / byteSize / eventCount on re-upsert', () => {
    db.upsertSession({ sessionId: 's-nc', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([{ sessionId: 's-nc', ts: 2, type: 'data', raw: Buffer.from('x'), text: 'x' }])
    db.finishSession('s-nc', 999, 'completed')

    // Re-upsert with fresh fields — should NOT overwrite endedAt/status/counts
    db.upsertSession({ sessionId: 's-nc', configLabel: 'L2', provider: 'claude', startedAt: 1 })

    const [sess] = db.listSessions()
    expect(sess.endedAt).toBe(999)
    expect(sess.status).toBe('completed')
    expect(sess.eventCount).toBe(1)
    expect(sess.byteSize).toBeGreaterThan(0)
  })

  it('appendBatch assigns monotonically increasing seq per session', () => {
    db.upsertSession({ sessionId: 's-seq', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([
      { sessionId: 's-seq', ts: 1, type: 'start', raw: Buffer.from('a'), text: 'a' },
      { sessionId: 's-seq', ts: 2, type: 'data', raw: Buffer.from('b'), text: 'b' },
    ])
    db.appendBatch([
      { sessionId: 's-seq', ts: 3, type: 'data', raw: Buffer.from('c'), text: 'c' },
    ])

    const events = db.readEvents('s-seq', { offset: 0, limit: 20 })
    expect(events.length).toBe(3)
    expect(events[0].seq).toBe(0)
    expect(events[1].seq).toBe(1)
    expect(events[2].seq).toBe(2)
  })

  it('appendBatch updates byteSize and eventCount on sessions', () => {
    db.upsertSession({ sessionId: 's-counts', configLabel: 'L', provider: 'claude', startedAt: 1 })
    const buf1 = Buffer.from('hello')
    const buf2 = Buffer.from('world!!')
    db.appendBatch([
      { sessionId: 's-counts', ts: 1, type: 'data', raw: buf1, text: 'hello' },
      { sessionId: 's-counts', ts: 2, type: 'data', raw: buf2, text: 'world!!' },
    ])

    const [sess] = db.listSessions()
    expect(sess.eventCount).toBe(2)
    expect(sess.byteSize).toBe(buf1.length + buf2.length)
  })

  it('appendBatch accepts Uint8Array for raw and stores it as BLOB', () => {
    db.upsertSession({ sessionId: 's-u8', configLabel: 'L', provider: 'claude', startedAt: 1 })
    const u8 = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello"
    db.appendBatch([{ sessionId: 's-u8', ts: 1, type: 'data', raw: u8, text: 'hello' }])
    const events = db.readEvents('s-u8', { offset: 0, limit: 10 })
    expect(events.length).toBe(1)
    expect(Buffer.isBuffer(events[0].raw)).toBe(true)
    expect(events[0].raw.toString()).toBe('hello')
  })

  it('readEvents is cursored (offset/limit)', () => {
    db.upsertSession({ sessionId: 's-cursor', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch(
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: 's-cursor',
        ts: i,
        type: 'data' as const,
        raw: Buffer.from(`e${i}`),
        text: `e${i}`,
      })),
    )

    const page1 = db.readEvents('s-cursor', { offset: 0, limit: 2 })
    const page2 = db.readEvents('s-cursor', { offset: 2, limit: 2 })
    const page3 = db.readEvents('s-cursor', { offset: 4, limit: 2 })

    expect(page1.length).toBe(2)
    expect(page2.length).toBe(2)
    expect(page3.length).toBe(1)
    expect(page1[0].seq).toBe(0)
    expect(page2[0].seq).toBe(2)
  })

  it('listSessions is ordered newest-first and supports offset/limit', () => {
    db.upsertSession({ sessionId: 'older', configLabel: 'L', provider: 'claude', startedAt: 100 })
    db.upsertSession({ sessionId: 'newer', configLabel: 'L', provider: 'claude', startedAt: 200 })

    const all = db.listSessions()
    expect(all[0].sessionId).toBe('newer')
    expect(all[1].sessionId).toBe('older')

    const page = db.listSessions({ offset: 1, limit: 1 })
    expect(page.length).toBe(1)
    expect(page[0].sessionId).toBe('older')
  })

  it('finishSession updates endedAt and status', () => {
    db.upsertSession({ sessionId: 's-fin', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.finishSession('s-fin', 42, 'completed')

    const [sess] = db.listSessions()
    expect(sess.endedAt).toBe(42)
    expect(sess.status).toBe('completed')
  })

  it('pruneSessions deletes the session and all events', () => {
    db.upsertSession({ sessionId: 's-prune', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([
      { sessionId: 's-prune', ts: 1, type: 'data', raw: Buffer.from('bye'), text: 'bye' },
    ])

    db.pruneSessions(['s-prune'])

    expect(db.listSessions().length).toBe(0)
    expect(db.readEvents('s-prune', { offset: 0, limit: 10 }).length).toBe(0)
  })

  it('pruneSessions leaves NO orphan FTS rows (search returns nothing after prune)', () => {
    db.upsertSession({ sessionId: 's-fts-prune', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([
      {
        sessionId: 's-fts-prune',
        ts: 1,
        type: 'data',
        raw: Buffer.from('uniqueftsterm'),
        text: 'uniqueftsterm',
      },
    ])

    // Must find it before prune
    expect(db.search('uniqueftsterm').length).toBeGreaterThan(0)

    db.pruneSessions(['s-fts-prune'])

    // Must find NOTHING after prune — FTS triggers fired
    expect(db.search('uniqueftsterm').length).toBe(0)
  })

  it('pruneSessions only deletes the specified sessions (others untouched)', () => {
    db.upsertSession({ sessionId: 'keep', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.upsertSession({ sessionId: 'gone', configLabel: 'L', provider: 'claude', startedAt: 2 })
    db.appendBatch([{ sessionId: 'gone', ts: 1, type: 'data', raw: Buffer.from('x'), text: 'x' }])
    db.appendBatch([{ sessionId: 'keep', ts: 1, type: 'data', raw: Buffer.from('y'), text: 'y' }])

    db.pruneSessions(['gone'])

    const sessions = db.listSessions()
    expect(sessions.length).toBe(1)
    expect(sessions[0].sessionId).toBe('keep')
    expect(db.readEvents('keep', { offset: 0, limit: 10 }).length).toBe(1)
  })

  it('search returns SearchHit with correct fields', () => {
    db.upsertSession({ sessionId: 's-search', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([
      { sessionId: 's-search', ts: 100, type: 'data', raw: Buffer.from('target'), text: 'target' },
    ])

    const hits = db.search('target')
    expect(hits.length).toBeGreaterThan(0)
    const hit = hits[0]
    expect(hit.sessionId).toBe('s-search')
    expect(typeof hit.eventId).toBe('number')
    expect(typeof hit.seq).toBe('number')
    expect(hit.ts).toBe(100)
  })

  it('search limit is respected', () => {
    db.upsertSession({ sessionId: 's-lim', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch(
      Array.from({ length: 10 }, (_, i) => ({
        sessionId: 's-lim',
        ts: i,
        type: 'data' as const,
        raw: Buffer.from(`match${i}`),
        text: `match${i} shared`,
      })),
    )

    const hits = db.search('shared', { limit: 3 })
    expect(hits.length).toBe(3)
  })

  it('search returns empty array for non-matching term', () => {
    db.upsertSession({ sessionId: 's-empty', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([{ sessionId: 's-empty', ts: 1, type: 'data', raw: Buffer.from('foo'), text: 'foo' }])

    expect(db.search('zzznomatchzzz').length).toBe(0)
  })

  it('reopening an existing DB path is idempotent (CREATE IF NOT EXISTS guards)', () => {
    // This test needs a real temp file, not :memory: — so we create one,
    // close it, reopen, and verify data survived.
    const { mkdtempSync, rmSync } = require('fs')
    const { join } = require('path')
    const { tmpdir } = require('os')

    const dir = mkdtempSync(join(tmpdir(), 'logdb-reopen-'))
    const dbPath = join(dir, 'test.db')
    try {
      const db1 = openLogDb(dbPath)
      db1.upsertSession({ sessionId: 'reopen-s', configLabel: 'L', provider: 'claude', startedAt: 1 })
      db1.close()

      const db2 = openLogDb(dbPath)
      expect(db2.listSessions().length).toBe(1)
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
