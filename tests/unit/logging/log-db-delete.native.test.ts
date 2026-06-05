/**
 * Native test for the Phase-2a delete-ops on src/main/logging/log-db.ts.
 * Runs under Electron-as-Node (npm run test:unit:native) — better-sqlite3 ABI.
 * ':memory:' DB per test for isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openLogDb } from '../../../src/main/logging/log-db'
import type { LogDb } from '../../../src/main/logging/log-db'

describe('log-db delete-ops', () => {
  let db: LogDb

  beforeEach(() => {
    db = openLogDb(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  // Helper: a finished session with one event.
  const seedFinished = (id: string, label: string) => {
    db.upsertSession({ sessionId: id, configLabel: label, provider: 'claude', startedAt: 1 })
    db.appendBatch([{ sessionId: id, ts: 2, type: 'data', raw: Buffer.from('hello world'), text: 'hello world' }])
    db.finishSession(id, 3, 'exited')
  }
  // Helper: a still-running session with one event (no finishSession).
  const seedRunning = (id: string, label: string) => {
    db.upsertSession({ sessionId: id, configLabel: label, provider: 'claude', startedAt: 1 })
    db.appendBatch([{ sessionId: id, ts: 2, type: 'data', raw: Buffer.from('live output'), text: 'live output' }])
  }

  it('clearAll deletes non-running sessions and returns counts', () => {
    seedFinished('a', 'APP')
    seedFinished('b', 'APP')
    const res = db.clearAll()
    expect(res.deletedSessions).toBe(2)
    expect(res.deletedEvents).toBe(2)
    expect(db.listSessions().length).toBe(0)
  })

  it('clearAll keeps running sessions', () => {
    seedFinished('done', 'APP')
    seedRunning('live', 'APP')
    const res = db.clearAll()
    expect(res.deletedSessions).toBe(1)
    expect(db.listSessions().map((s) => s.sessionId)).toEqual(['live'])
  })

  it('clearAll leaves no orphan FTS rows (no ghost search hits)', () => {
    seedFinished('a', 'APP')
    expect(db.search('hello').length).toBeGreaterThan(0)
    db.clearAll()
    expect(db.search('hello')).toEqual([])
  })

  it('pruneSessions skips running sessions and returns counts', () => {
    seedFinished('done', 'APP')
    seedRunning('live', 'APP')
    const res = db.pruneSessions(['done', 'live'])
    expect(res.deletedSessions).toBe(1)
    expect(res.deletedEvents).toBe(1)
    expect(db.listSessions().map((s) => s.sessionId)).toEqual(['live'])
    // running session's FTS row survives; finished one is gone.
    expect(db.search('hello')).toEqual([])
    expect(db.search('live').length).toBeGreaterThan(0)
  })

  it('checkpoint() returns without throwing on a :memory: DB', () => {
    // :memory: has no WAL file; checkpoint must be a safe no-throw there too.
    expect(() => db.checkpoint()).not.toThrow()
  })
})
