/**
 * Native test for the worker `migrate` op (npm run test:unit:native). Drives the
 * pure handleWorkerMessage against a real :memory: DB and a captured `post`,
 * proving idempotent import, event-grain skip of a live session, partner-fold
 * (already done by the parser; here we just confirm events land), orphan NULL
 * configId, and progress accounting.
 *
 * The 5th test covers AMENDMENT A2: a migrate op with a malformed `sessions`
 * (not iterable) must terminate with a `migrate-error` carrying the right id,
 * never a hang and never a generic `{type:'error'}`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openLogDb } from '../../../src/main/logging/log-db'
import type { LogDb } from '../../../src/main/logging/log-db'
import { handleWorkerMessage } from '../../../src/main/logging/log-worker'
import type { FromWorker } from '../../../src/main/logging/log-worker-transport'

const u8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'))

describe('worker migrate op', () => {
  let db: LogDb
  let posted: FromWorker[]
  const post = (m: FromWorker) => posted.push(m)

  beforeEach(() => {
    db = openLogDb(':memory:')
    posted = []
  })
  afterEach(() => { db.close() })

  it('imports a chunk and posts migrate-progress with the right tally', () => {
    handleWorkerMessage(db, {
      type: 'migrate',
      id: 1,
      sessions: [
        {
          sessionId: 'a', configLabel: 'APP DEV', provider: 'claude', startedAt: 1,
          events: [
            { ts: 1, type: 'start', raw: u8(''), text: '' },
            { ts: 2, type: 'data', raw: u8('alpha'), text: 'alpha' },
          ],
        },
        {
          sessionId: 'b', configLabel: 'OTHER', provider: 'claude', startedAt: 3,
          events: [{ ts: 3, type: 'data', raw: u8('beta'), text: 'beta' }],
        },
      ],
    }, post)

    const prog = posted.find((p) => p.type === 'migrate-progress') as Extract<FromWorker, { type: 'migrate-progress' }>
    expect(prog).toBeTruthy()
    expect(prog.importedSessions).toBe(2)
    expect(prog.skippedSessions).toBe(0)
    expect(prog.importedEvents).toBe(3)

    expect(db.listSessions().length).toBe(2)
    expect(db.listSessions().every((s) => s.configId === null)).toBe(true) // orphan NULL
    expect(db.search('alpha').map((h) => h.sessionId)).toContain('a')
  })

  it('re-running the same chunk skips every session (idempotent, no dup events)', () => {
    const sessions = [
      { sessionId: 'r', configLabel: 'L', provider: 'claude', startedAt: 1, events: [{ ts: 1, type: 'data' as const, raw: u8('x'), text: 'x' }] },
    ]
    handleWorkerMessage(db, { type: 'migrate', id: 1, sessions }, post)
    posted = []
    handleWorkerMessage(db, { type: 'migrate', id: 2, sessions }, post)

    const prog = posted.find((p) => p.type === 'migrate-progress') as Extract<FromWorker, { type: 'migrate-progress' }>
    expect(prog.importedSessions).toBe(0)
    expect(prog.skippedSessions).toBe(1)
    expect(db.getSessionEventCount('r')).toBe(1) // not doubled
  })

  it('skips a session already populated by live capture (event-grain)', () => {
    db.upsertSession({ sessionId: 'live', configId: 'c1', configLabel: 'L', provider: 'claude', startedAt: 1 })
    db.appendBatch([{ sessionId: 'live', ts: 1, type: 'data', raw: Buffer.from('live'), text: 'live' }])

    handleWorkerMessage(db, {
      type: 'migrate', id: 1,
      sessions: [{ sessionId: 'live', configLabel: 'L', provider: 'claude', startedAt: 9, events: [{ ts: 9, type: 'data', raw: u8('legacy'), text: 'legacy' }] }],
    }, post)

    const prog = posted.find((p) => p.type === 'migrate-progress') as Extract<FromWorker, { type: 'migrate-progress' }>
    expect(prog.skippedSessions).toBe(1)
    expect(db.getSessionEventCount('live')).toBe(1)
    expect(db.readEvents('live', { offset: 0, limit: 5 })[0].text).toBe('live') // untouched
  })

  it('a malformed session in a chunk does not abort the whole chunk', () => {
    handleWorkerMessage(db, {
      type: 'migrate', id: 1,
      sessions: [
        // good
        { sessionId: 'ok', configLabel: 'L', provider: 'claude', startedAt: 1, events: [{ ts: 1, type: 'data', raw: u8('ok'), text: 'ok' }] },
        // empty events -> importSession returns skipped; must not throw or roll back 'ok'
        { sessionId: 'bad', configLabel: 'L', provider: 'claude', startedAt: 1, events: [] },
      ],
    }, post)

    const prog = posted.find((p) => p.type === 'migrate-progress') as Extract<FromWorker, { type: 'migrate-progress' }>
    expect(prog.importedSessions).toBe(1)
    expect(prog.skippedSessions).toBe(1)
    expect(db.getSessionEventCount('ok')).toBe(1)
  })

  it('a session whose importSession THROWS is counted as FAILED (not skipped), surfaced as a log warn, without aborting the chunk', () => {
    // Force importSession to throw for one specific session. The per-session
    // try/catch must count it as a FAILURE (its data did NOT reach the DB) — NOT a
    // benign already-present skip — and emit a log warn while the good session
    // imports. This distinction is what keeps reclaim blocked on a partial import.
    const realImport = db.importSession.bind(db)
    ;(db as { importSession: LogDb['importSession'] }).importSession = ((meta, events) => {
      if (meta.sessionId === 'thrower') throw new Error('boom')
      return realImport(meta, events)
    }) as LogDb['importSession']

    handleWorkerMessage(db, {
      type: 'migrate', id: 4,
      sessions: [
        { sessionId: 'thrower', configLabel: 'L', provider: 'claude', startedAt: 1, events: [{ ts: 1, type: 'data', raw: u8('x'), text: 'x' }] },
        { sessionId: 'good', configLabel: 'L', provider: 'claude', startedAt: 1, events: [{ ts: 1, type: 'data', raw: u8('ok'), text: 'ok' }] },
      ],
    }, post)

    const prog = posted.find((p) => p.type === 'migrate-progress') as Extract<FromWorker, { type: 'migrate-progress' }>
    expect(prog).toBeTruthy()
    expect(prog.failedSessions).toBe(1)   // counted as FAILED, not skipped
    expect(prog.skippedSessions).toBe(0)
    expect(prog.importedSessions).toBe(1)
    expect(db.getSessionEventCount('good')).toBe(1)
    expect(db.getSessionEventCount('thrower')).toBe(0)
    // The failure is surfaced (never swallowed) as a worker log warn.
    expect(
      posted.some((p) => p.type === 'log' && /thrower/.test((p as Extract<FromWorker, { type: 'log' }>).entry.message)),
    ).toBe(true)
  })

  it('A2: a migrate op with a malformed sessions array posts migrate-error with the right id', () => {
    // `sessions: null` is not iterable -> the for..of throws OUTSIDE the
    // per-session try/catch. The outer A2 guard must post migrate-error carrying
    // the SAME id (id:7), not hang and not a generic {type:'error'}.
    handleWorkerMessage(db, { type: 'migrate', id: 7, sessions: null as any }, post)

    const err = posted.find((p) => p.type === 'migrate-error') as Extract<FromWorker, { type: 'migrate-error' }>
    expect(err).toBeTruthy()
    expect(err.id).toBe(7)
    expect(typeof err.message).toBe('string')
    // It must NOT degrade to a generic error with an undefined id.
    expect(posted.find((p) => p.type === 'migrate-progress')).toBeUndefined()
    expect(posted.find((p) => p.type === 'error')).toBeUndefined()
  })
})
