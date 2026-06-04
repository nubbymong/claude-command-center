/**
 * Native test (npm run test:unit:native — Electron-as-Node ABI) for the LogDb
 * migration primitives getSessionEventCount + importSession. Uses :memory: per
 * test for isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openLogDb } from '../../../src/main/logging/log-db'
import type { LogDb } from '../../../src/main/logging/log-db'

const buf = (s: string) => Buffer.from(s, 'utf8')

describe('log-db import primitives', () => {
  let db: LogDb
  beforeEach(() => {
    db = openLogDb(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  it('getSessionEventCount returns 0 for an unknown session', () => {
    expect(db.getSessionEventCount('nope')).toBe(0)
  })

  it('importSession inserts a session + events atomically with NULL configId and monotonic seq', () => {
    const res = db.importSession(
      { sessionId: 'm1', configLabel: 'APP DEV', accountEmail: 'a@b.com', profileId: 'p1', provider: 'claude', startedAt: 100 },
      [
        { ts: 100, type: 'start', raw: buf(''), text: '' },
        { ts: 101, type: 'data', raw: buf('hello world'), text: 'hello world' },
        { ts: 102, type: 'end', raw: buf(''), text: '' },
      ],
    )
    expect(res).toEqual({ imported: true, skipped: false, events: 3 })

    const [sess] = db.listSessions()
    expect(sess.sessionId).toBe('m1')
    expect(sess.configId).toBeNull() // migrated rows are always orphan-classified
    expect(sess.configLabel).toBe('APP DEV')
    expect(sess.eventCount).toBe(3)
    expect(sess.byteSize).toBe(buf('hello world').length)

    const events = db.readEvents('m1', { offset: 0, limit: 10 })
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(db.getSessionEventCount('m1')).toBe(3)
    // FTS stays consistent automatically.
    expect(db.search('hello').map((h) => h.sessionId)).toContain('m1')
  })

  it('importSession is idempotent: a second import of the same id with events SKIPS (no dup events)', () => {
    const meta = { sessionId: 'm2', configLabel: 'L', provider: 'claude', startedAt: 1 }
    db.importSession(meta, [{ ts: 1, type: 'data', raw: buf('x'), text: 'x' }])
    const second = db.importSession(meta, [
      { ts: 1, type: 'data', raw: buf('x'), text: 'x' },
      { ts: 2, type: 'data', raw: buf('y'), text: 'y' },
    ])
    expect(second).toEqual({ imported: false, skipped: true, events: 0 })
    expect(db.getSessionEventCount('m2')).toBe(1) // unchanged
    expect(db.readEvents('m2', { offset: 0, limit: 10 }).length).toBe(1)

    // A-note defensive assertion: the app-level idempotency guard (NOT a DB UNIQUE
    // constraint) must leave the seq sequence gap-free 0..n-1 with NO duplicate
    // (sessionId, seq) rows after a skipped re-import. Pin that guarantee directly.
    db.importSession(meta, [{ ts: 3, type: 'data', raw: buf('z'), text: 'z' }]) // also skipped
    expect(db.readEvents('m2', { offset: 0, limit: 100 }).map((e) => e.seq)).toEqual([0])
  })

  it('seq stays gap-free 0..n-1 with no duplicates across a skipped re-import of a multi-event session', () => {
    const meta = { sessionId: 'm-seq', configLabel: 'L', provider: 'claude', startedAt: 1 }
    db.importSession(meta, [
      { ts: 1, type: 'data', raw: buf('a'), text: 'a' },
      { ts: 2, type: 'data', raw: buf('b'), text: 'b' },
      { ts: 3, type: 'data', raw: buf('c'), text: 'c' },
      { ts: 4, type: 'data', raw: buf('d'), text: 'd' },
    ])
    // Re-import with more events — must be SKIPPED, never appended.
    const second = db.importSession(meta, [
      { ts: 5, type: 'data', raw: buf('e'), text: 'e' },
      { ts: 6, type: 'data', raw: buf('f'), text: 'f' },
    ])
    expect(second).toEqual({ imported: false, skipped: true, events: 0 })
    const seqs = db.readEvents('m-seq', { offset: 0, limit: 100 }).map((e) => e.seq)
    expect(seqs).toEqual([0, 1, 2, 3]) // gap-free, no dup (sessionId, seq) rows
    expect(db.getSessionEventCount('m-seq')).toBe(4)
  })

  it('importSession SKIPS a session already populated by live capture (event-grain safety)', () => {
    // Simulate a live/just-captured session: upsert + appendBatch (the normal path).
    db.upsertSession({ sessionId: 'live1', configId: 'c-live', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([{ sessionId: 'live1', ts: 1, type: 'data', raw: buf('live'), text: 'live' }])

    const res = db.importSession(
      { sessionId: 'live1', configLabel: 'L', provider: 'claude', startedAt: 1 },
      [{ ts: 9, type: 'data', raw: buf('legacy'), text: 'legacy' }],
    )
    expect(res.skipped).toBe(true)
    // The live row is untouched: still one event, configId still the live one.
    const [sess] = db.listSessions()
    expect(sess.eventCount).toBe(1)
    expect(sess.configId).toBe('c-live')
    expect(db.readEvents('live1', { offset: 0, limit: 10 })[0].text).toBe('live')
  })

  it('importSession with an empty events array is a no-op skip', () => {
    const res = db.importSession({ sessionId: 'm3', configLabel: 'L', provider: 'claude', startedAt: 1 }, [])
    expect(res).toEqual({ imported: false, skipped: true, events: 0 })
    expect(db.listSessions().length).toBe(0)
  })

  it('importSession does not roll a NULL configId over a row that was upserted (only-if-absent) then has zero events', () => {
    // Edge: a session row exists (configId set) but has NO events yet (eventCount 0).
    // importSession should be allowed to add the events (not skip), because the
    // skip rule is eventCount > 0. configId stays whatever the existing row had
    // (ON CONFLICT DO NOTHING -> import does not clobber an existing configId).
    db.upsertSession({ sessionId: 'empty1', configId: 'c-pre', configLabel: 'L', provider: 'claude', startedAt: 1 })
    const res = db.importSession(
      { sessionId: 'empty1', configLabel: 'L', provider: 'claude', startedAt: 1 },
      [{ ts: 1, type: 'data', raw: buf('z'), text: 'z' }],
    )
    expect(res.imported).toBe(true)
    expect(db.getSessionEventCount('empty1')).toBe(1)
    const [sess] = db.listSessions()
    expect(sess.configId).toBe('c-pre') // pre-existing configId preserved
  })
})
