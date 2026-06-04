/**
 * Native test for src/main/logging/log-worker.ts.
 * Must run under Electron-as-Node (npm run test:unit:native) because it imports
 * log-db which loads better-sqlite3 (Electron ABI).
 *
 * Imports only handleWorkerMessage + openLogDb — does NOT trigger the parentPort
 * bootstrap (guarded by `if (parentPort)` at module end).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openLogDb } from '../../../src/main/logging/log-db'
import { handleWorkerMessage } from '../../../src/main/logging/log-worker'
import type { LogDb } from '../../../src/main/logging/log-db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost() {
  const out: any[] = []
  return { out, post: (m: any) => out.push(m) }
}

function sessionStartMsg(sessionId: string, extra?: Record<string, unknown>) {
  return {
    type: 'session-start' as const,
    meta: {
      sessionId,
      configLabel: 'Test Config',
      provider: 'claude',
      startedAt: 1,
      ...extra,
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('log-worker handleWorkerMessage', () => {
  let db: LogDb

  beforeEach(() => {
    db = openLogDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  // ---- canonical test from the task spec ----
  it('applies session-start + batch and serves a listSessions query', () => {
    const { out, post } = makePost()

    handleWorkerMessage(db, sessionStartMsg('s1', { configLabel: 'A' }), post)

    handleWorkerMessage(
      db,
      {
        type: 'batch',
        sessions: [
          {
            sessionId: 's1',
            chunks: [
              {
                ts: 2,
                type: 'data',
                raw: new Uint8Array([...Buffer.from('hi \x1b[31mred\x1b[0m')]),
              },
            ],
          },
        ],
      },
      post,
    )

    handleWorkerMessage(db, { type: 'query', id: 1, kind: 'listSessions', args: {} }, post)

    const res = out.find((m) => m.type === 'query-result' && m.id === 1)
    expect(res).toBeDefined()
    expect(res.rows.length).toBe(1)

    // The stored event's text is ANSI-stripped
    const ev = db.readEvents('s1', { offset: 0, limit: 10 })[0]
    expect(ev.text).toBe('hi red')
  })

  // ---- session-end ----
  it('session-end calls finishSession — listSessions shows correct endedAt and status', () => {
    const { out, post } = makePost()

    handleWorkerMessage(db, sessionStartMsg('s-end'), post)
    handleWorkerMessage(db, { type: 'session-end', sessionId: 's-end', ts: 999, status: 'completed' }, post)
    handleWorkerMessage(db, { type: 'query', id: 2, kind: 'listSessions', args: {} }, post)

    const res = out.find((m) => m.type === 'query-result' && m.id === 2)
    expect(res).toBeDefined()
    const row = res.rows[0] as any
    expect(row.endedAt).toBe(999)
    expect(row.status).toBe('completed')
  })

  // ---- query kind: search ----
  it('query kind=search returns a query-result with matching sessions', () => {
    const { out, post } = makePost()

    handleWorkerMessage(db, sessionStartMsg('s-search'), post)
    // Insert a batch with a unique searchable term
    handleWorkerMessage(
      db,
      {
        type: 'batch',
        sessions: [
          {
            sessionId: 's-search',
            chunks: [{ ts: 10, type: 'data', raw: new Uint8Array(Buffer.from('uniqueXYZterm')) }],
          },
        ],
      },
      post,
    )
    handleWorkerMessage(
      db,
      { type: 'query', id: 3, kind: 'search', args: { query: 'uniqueXYZterm', limit: 10 } },
      post,
    )

    const res = out.find((m) => m.type === 'query-result' && m.id === 3)
    expect(res).toBeDefined()
    expect((res.rows as any[]).length).toBeGreaterThan(0)
    expect((res.rows[0] as any).sessionId).toBe('s-search')
  })

  // ---- reconcile ----
  it('reconcile flips running sessions to crashed', () => {
    const { out, post } = makePost()

    // Two running sessions
    handleWorkerMessage(db, sessionStartMsg('s-reconcile-a'), post)
    handleWorkerMessage(db, sessionStartMsg('s-reconcile-b'), post)
    // Finish one so it is no longer 'running'
    handleWorkerMessage(db, { type: 'session-end', sessionId: 's-reconcile-a', ts: 100, status: 'exited' }, post)

    // Trigger reconcile
    handleWorkerMessage(db, { type: 'reconcile' }, post)

    // Read back via query
    handleWorkerMessage(db, { type: 'query', id: 4, kind: 'listSessions', args: {} }, post)
    const res = out.find((m) => m.type === 'query-result' && m.id === 4)
    const rows = res.rows as any[]

    const rowA = rows.find((r) => r.sessionId === 's-reconcile-a')
    const rowB = rows.find((r) => r.sessionId === 's-reconcile-b')

    expect(rowA.status).toBe('exited')   // finished — untouched
    expect(rowB.status).toBe('crashed')  // was running — now crashed
  })

  // ---- batch with dropped: N ----
  it('batch with dropped > 0 appends a gap marker event for the session', () => {
    const { out: _out, post } = makePost()

    handleWorkerMessage(db, sessionStartMsg('s-drop'), post)
    handleWorkerMessage(
      db,
      {
        type: 'batch',
        sessions: [
          {
            sessionId: 's-drop',
            chunks: [{ ts: 5, type: 'data', raw: new Uint8Array(Buffer.from('before')) }],
            dropped: 42,
          },
        ],
      },
      post,
    )

    const events = db.readEvents('s-drop', { offset: 0, limit: 20 })
    // Expect: 1 real chunk + 1 gap marker
    expect(events.length).toBe(2)
    const markerEv = events.find((e) => e.text.includes('42') && e.text.includes('dropped'))
    expect(markerEv).toBeDefined()
  })

  // ---- appendBatch is called once per batch (single transaction) ----
  it('batch is stored atomically — all chunks of a session share one txn', () => {
    const { out, post } = makePost()

    handleWorkerMessage(db, sessionStartMsg('s-atomic'), post)
    handleWorkerMessage(
      db,
      {
        type: 'batch',
        sessions: [
          {
            sessionId: 's-atomic',
            chunks: [
              { ts: 1, type: 'data', raw: new Uint8Array(Buffer.from('a')) },
              { ts: 2, type: 'data', raw: new Uint8Array(Buffer.from('b')) },
              { ts: 3, type: 'data', raw: new Uint8Array(Buffer.from('c')) },
            ],
          },
        ],
      },
      post,
    )

    // All three events must be visible (they were in one txn that committed)
    const events = db.readEvents('s-atomic', { offset: 0, limit: 10 })
    expect(events.length).toBe(3)
    expect(events[0].text).toBe('a')
    expect(events[2].text).toBe('c')
    // Sequence is monotonically increasing
    expect(events[0].seq).toBe(0)
    expect(events[1].seq).toBe(1)
    expect(events[2].seq).toBe(2)
  })

  // ---- unknown query kind produces an error response ----
  it('unknown query kind posts an error message', () => {
    const { out, post } = makePost()
    handleWorkerMessage(db, { type: 'query', id: 99, kind: 'unknownOp', args: {} }, post)
    const err = out.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    expect(err.message).toMatch(/unknown/i)
  })

  // ---- unknown query kind error carries the query id (prevents hung promises) ----
  it('unknown query kind posts an error with the same id as the query', () => {
    const { out, post } = makePost()
    handleWorkerMessage(db, { type: 'query', id: 7, kind: 'bogus', args: {} }, post)
    const err = out.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    expect(err.id).toBe(7)
  })

  it('query kind=clearAll deletes non-running and returns a single count row', () => {
    db.upsertSession({ sessionId: 'd', configLabel: 'A', provider: 'claude', startedAt: 1 })
    db.appendBatch([{ sessionId: 'd', ts: 2, type: 'data', raw: Buffer.from('x'), text: 'x' }])
    db.finishSession('d', 3, 'exited')
    const out: any[] = []
    handleWorkerMessage(db, { type: 'query', id: 7, kind: 'clearAll', args: {} }, (m) => out.push(m))
    const res = out.find((m) => m.type === 'query-result' && m.id === 7)
    expect(res).toBeTruthy()
    expect(res.rows).toEqual([{ deletedSessions: 1, deletedEvents: 1 }])
    expect(db.listSessions().length).toBe(0)
  })

  it('query kind=prune excludes running sessions', () => {
    db.upsertSession({ sessionId: 'd', configLabel: 'A', provider: 'claude', startedAt: 1 })
    db.finishSession('d', 3, 'exited')
    db.upsertSession({ sessionId: 'r', configLabel: 'A', provider: 'claude', startedAt: 1 }) // running
    const out: any[] = []
    handleWorkerMessage(db, { type: 'query', id: 8, kind: 'prune', args: { ids: ['d', 'r'] } }, (m) => out.push(m))
    const res = out.find((m) => m.type === 'query-result' && m.id === 8)
    expect(res.rows[0].deletedSessions).toBe(1)
    expect(db.listSessions().map((s) => s.sessionId)).toEqual(['r'])
  })

  // ---- query kind: readEvents ----
  it('query kind=readEvents returns events cursor for a session', () => {
    const { out, post } = makePost()

    handleWorkerMessage(db, sessionStartMsg('s-re'), post)
    handleWorkerMessage(
      db,
      {
        type: 'batch',
        sessions: [
          {
            sessionId: 's-re',
            chunks: [
              { ts: 1, type: 'data', raw: new Uint8Array(Buffer.from('x')) },
              { ts: 2, type: 'data', raw: new Uint8Array(Buffer.from('y')) },
            ],
          },
        ],
      },
      post,
    )

    handleWorkerMessage(
      db,
      { type: 'query', id: 5, kind: 'readEvents', args: { sessionId: 's-re', offset: 0, limit: 10 } },
      post,
    )

    const res = out.find((m) => m.type === 'query-result' && m.id === 5)
    expect(res).toBeDefined()
    expect((res.rows as any[]).length).toBe(2)
  })
})
