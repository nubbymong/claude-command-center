/**
 * Native test (npm run test:unit:native) for the partial-import primitives that
 * let the migrate-dir worker op stream a HUGE legacy session into the DB in
 * bounded parts, crash-safely:
 *
 *   beginPartialImport   — session row created/replaced, marked status='importing'
 *   appendBatch          — (existing) seq-continued event appends under it
 *   completePartialImport— authoritative startedAt/endedAt + terminal status
 *
 * The 'importing' status is the crash marker: a worker death mid-import leaves
 * it set, a re-run's beginPartialImport wipes the partial rows and starts fresh,
 * and reclaim stays blocked because the run never reported clean completion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openLogDb } from '../../../src/main/logging/log-db'
import type { LogDb } from '../../../src/main/logging/log-db'

const meta = (id: string, startedAt = 100) => ({
  sessionId: id,
  configLabel: 'LBL',
  provider: 'claude',
  startedAt,
})

const ev = (id: string, ts: number, text: string) => ({
  sessionId: id,
  ts,
  type: 'data' as const,
  raw: Buffer.from(text, 'utf8'),
  text,
})

describe('log-db partial import primitives', () => {
  let db: LogDb
  beforeEach(() => { db = openLogDb(':memory:') })
  afterEach(() => { db.close() })

  it('getSessionImportState: null for unknown, {eventCount,status} for existing', () => {
    expect(db.getSessionImportState('nope')).toBeNull()
    db.upsertSession({ sessionId: 'live', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([ev('live', 1, 'x')])
    expect(db.getSessionImportState('live')).toEqual({ eventCount: 1, status: 'running' })
  })

  it('beginPartialImport creates an orphan (configId NULL) session marked importing', () => {
    db.beginPartialImport(meta('p1', 50))
    const s = db.listSessions().find((x) => x.sessionId === 'p1')!
    expect(s.status).toBe('importing')
    expect(s.configId).toBeNull()
    expect(s.startedAt).toBe(50)
    expect(db.getSessionImportState('p1')).toEqual({ eventCount: 0, status: 'importing' })
  })

  it('appendBatch streams parts under an importing session with continued seq', () => {
    db.beginPartialImport(meta('p2'))
    db.appendBatch([ev('p2', 1, 'a'), ev('p2', 2, 'b')])
    db.appendBatch([ev('p2', 3, 'c')]) // second part continues seq
    const rows = db.readEvents('p2', { offset: 0, limit: 10 })
    expect(rows.map((r) => [r.seq, r.text])).toEqual([[0, 'a'], [1, 'b'], [2, 'c']])
    expect(db.getSessionImportState('p2')).toEqual({ eventCount: 3, status: 'importing' })
  })

  it('completePartialImport sets authoritative startedAt/endedAt and a terminal status', () => {
    db.beginPartialImport(meta('p3', 999)) // begin-time approximation
    db.appendBatch([ev('p3', 7, 'x'), ev('p3', 3, 'y')])
    db.completePartialImport('p3', { startedAt: 3, endedAt: 7 })
    const s = db.listSessions().find((x) => x.sessionId === 'p3')!
    expect(s.status).toBe('ended')
    expect(s.startedAt).toBe(3)
    expect(s.endedAt).toBe(7)
  })

  it('beginPartialImport REPLACES a dead importing session (partial events wiped)', () => {
    db.beginPartialImport(meta('dead'))
    db.appendBatch([ev('dead', 1, 'partial')])
    // ... worker crashed here; re-run begins again:
    db.beginPartialImport(meta('dead'))
    expect(db.getSessionImportState('dead')).toEqual({ eventCount: 0, status: 'importing' })
    expect(db.readEvents('dead', { offset: 0, limit: 10 })).toEqual([])
    // FTS rows for the wiped partial must be gone too (search finds nothing).
    expect(db.search('partial')).toEqual([])
  })

  it('beginPartialImport never clobbers an existing non-importing row\'s identity fields', () => {
    db.upsertSession({ sessionId: 'race', configId: 'c9', configLabel: 'LIVE', provider: 'claude', startedAt: 5 })
    db.beginPartialImport(meta('race', 50))
    const s = db.listSessions().find((x) => x.sessionId === 'race')!
    // Row fields preserved (upsert is DO NOTHING); only the importing marker applies
    // (eventCount=0 -> safe to own).
    expect(s.configId).toBe('c9')
    expect(s.configLabel).toBe('LIVE')
    expect(s.startedAt).toBe(5)
    expect(s.status).toBe('importing')
  })

  it('beginPartialImport does NOT mark a session that already has live events', () => {
    db.upsertSession({ sessionId: 'busy', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([ev('busy', 1, 'live')])
    db.beginPartialImport(meta('busy'))
    // eventCount>0 guard: the live session keeps its status.
    expect(db.getSessionImportState('busy')).toEqual({ eventCount: 1, status: 'running' })
  })

  it('markRunningCrashed leaves importing sessions untouched (crash marker survives boots)', () => {
    db.beginPartialImport(meta('p4'))
    db.upsertSession({ sessionId: 'run', configLabel: 'L', provider: 'claude', startedAt: 1 })
    const flipped = db.markRunningCrashed()
    expect(flipped).toBe(1) // only 'run'
    expect(db.getSessionImportState('p4')!.status).toBe('importing')
  })

  it('completePartialImport is a no-op on a non-importing session', () => {
    db.upsertSession({ sessionId: 'done', configLabel: 'L', provider: 'claude', startedAt: 9 })
    db.finishSession('done', 99, 'ended')
    db.completePartialImport('done', { startedAt: 1, endedAt: 2 })
    const s = db.listSessions().find((x) => x.sessionId === 'done')!
    expect(s.startedAt).toBe(9) // untouched
    expect(s.endedAt).toBe(99)
  })
})
