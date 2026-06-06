/**
 * Native test (npm run test:unit:native) for the worker-internal `migrate-dir`
 * op — the fix for the 16 GB main-thread freeze. The worker walks + parses the
 * legacy tree itself (streaming, bounded batches) and imports group by group via
 * the partial-import primitives, so nothing huge ever crosses a process boundary
 * and a crash mid-session leaves a re-runnable 'importing' marker, never silent
 * data loss.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openLogDb } from '../../../src/main/logging/log-db'
import type { LogDb } from '../../../src/main/logging/log-db'
import { handleWorkerMessage, runDirMigration, __resetDirMigrationForTest } from '../../../src/main/logging/log-worker'
import type { FromWorker, DirMigrationReport } from '../../../src/main/logging/log-worker-transport'

let root: string
let logsDir: string

function line(o: object): string {
  return JSON.stringify(o) + '\n'
}

function makeSession(label: string, id: string, files: Record<string, string>, meta?: object) {
  const dir = join(logsDir, label, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
}

function doneReport(posted: FromWorker[]): DirMigrationReport {
  const done = posted.find((p) => p.type === 'migrate-dir-done') as Extract<FromWorker, { type: 'migrate-dir-done' }>
  expect(done).toBeTruthy()
  return done.report
}

describe('worker migrate-dir op', () => {
  let db: LogDb
  let posted: FromWorker[]
  const post = (m: FromWorker) => posted.push(m)

  beforeEach(() => {
    db = openLogDb(':memory:')
    posted = []
    root = mkdtempSync(join(tmpdir(), 'migdir-'))
    logsDir = join(root, 'logs')
    mkdirSync(logsDir, { recursive: true })
    __resetDirMigrationForTest()
  })
  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('imports a small tree (partner fold + meta) and posts a reconciling done report', async () => {
    makeSession('APP', 's1', { 'session.jsonl': line({ ts: 10, type: 'start' }) + line({ ts: 11, type: 'data', data: 'hello' }) },
      { configLabel: 'App Dev', accountEmail: 'a@b.com' })
    makeSession('APP', 's1-partner', { 'session.jsonl': line({ ts: 12, type: 'data', data: 'partner' }) })
    makeSession('OTHER', 's2', { 'session.jsonl': line({ ts: 20, type: 'data', data: 'world' }) })

    await runDirMigration(db, { type: 'migrate-dir', id: 1, logsDir }, post)

    const report = doneReport(posted)
    expect(report.totalSessions).toBe(2)
    expect(report.importedSessions).toBe(2)
    expect(report.skippedSessions).toBe(0)
    expect(report.failedSessions).toBe(0)
    expect(report.importedEvents).toBe(4) // s1: start+hello+partner (3) + s2: world (1)
    expect(report.foldedPartnerDirs).toBe(1)
    expect(report.noEventDirs).toBe(0)
    // detectedFolders identity: 3 dirs = 2 sessions + 1 folded + 0 noEvent
    expect(report.totalSessions + report.foldedPartnerDirs + report.noEventDirs).toBe(3)

    const s1 = db.listSessions().find((s) => s.sessionId === 's1')!
    expect(s1.status).toBe('ended')
    expect(s1.startedAt).toBe(10)
    expect(s1.endedAt).toBe(12)
    expect(s1.configLabel).toBe('App Dev')
    expect(s1.accountEmail).toBe('a@b.com')
    expect(s1.configId).toBeNull()
    expect(db.readEvents('s1', { offset: 0, limit: 10 }).map((e) => e.text)).toEqual(['', 'hello', 'partner'])
    expect(db.search('world').map((h) => h.sessionId)).toContain('s2')
  })

  it('streams a session in MULTIPLE parts (tiny batchBytes) with intact seq order', async () => {
    let content = ''
    for (let i = 0; i < 50; i++) content += line({ ts: i, type: 'data', data: `chunk-${String(i).padStart(3, '0')}-` + 'x'.repeat(100) })
    makeSession('BIG', 'huge', { 'session.jsonl': content })

    await runDirMigration(db, { type: 'migrate-dir', id: 2, logsDir, batchBytes: 512 }, post)

    const report = doneReport(posted)
    expect(report.importedSessions).toBe(1)
    expect(report.importedEvents).toBe(50)
    const rows = db.readEvents('huge', { offset: 0, limit: 100 })
    expect(rows.length).toBe(50)
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i))
    expect(rows[49].text.startsWith('chunk-049-')).toBe(true)
    const s = db.listSessions().find((x) => x.sessionId === 'huge')!
    expect(s.eventCount).toBe(50)
    expect(s.status).toBe('ended')
  })

  it('re-run pre-skips complete sessions WITHOUT parsing and keeps the reconciliation identity', async () => {
    makeSession('A', 'r1', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'one' }) })
    makeSession('A', 'r1-partner', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'two' }) })
    await runDirMigration(db, { type: 'migrate-dir', id: 3, logsDir }, post)
    posted = []
    await runDirMigration(db, { type: 'migrate-dir', id: 4, logsDir }, post)

    const report = doneReport(posted)
    expect(report.totalSessions).toBe(1)
    expect(report.importedSessions).toBe(0)
    expect(report.skippedSessions).toBe(1)
    // Approximation: the skipped group's extra member dir is attributed as folded.
    expect(report.foldedPartnerDirs).toBe(1)
    expect(report.totalSessions + report.foldedPartnerDirs + report.noEventDirs).toBe(2)
    expect(db.getSessionEventCount('r1')).toBe(2) // not doubled
  })

  it('a DEAD partial import (importing marker) is wiped and fully re-imported on re-run', async () => {
    makeSession('A', 'd1', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'full' }) + line({ ts: 2, type: 'data', data: 'data' }) })
    // Simulate a previous run that died mid-stream:
    db.beginPartialImport({ sessionId: 'd1', configLabel: 'A', provider: 'claude', startedAt: 1 })
    db.appendBatch([{ sessionId: 'd1', ts: 1, type: 'data', raw: Buffer.from('partial'), text: 'partial' }])

    await runDirMigration(db, { type: 'migrate-dir', id: 5, logsDir }, post)

    const report = doneReport(posted)
    expect(report.importedSessions).toBe(1)
    expect(report.skippedSessions).toBe(0)
    const rows = db.readEvents('d1', { offset: 0, limit: 10 })
    expect(rows.map((r) => r.text)).toEqual(['full', 'data']) // partial wiped, fresh import
    expect(db.listSessions().find((s) => s.sessionId === 'd1')!.status).toBe('ended')
  })

  it('a session that fails mid-stream is FAILED (importing marker kept), others import, identity holds', async () => {
    makeSession('A', 'bad', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'x' }) })
    makeSession('A', 'bad-partner', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'y' }) })
    makeSession('B', 'good', { 'session.jsonl': line({ ts: 3, type: 'data', data: 'ok' }) })

    const realComplete = db.completePartialImport.bind(db)
    ;(db as { completePartialImport: LogDb['completePartialImport'] }).completePartialImport = ((id, opts) => {
      if (id === 'bad') throw new Error('boom')
      return realComplete(id, opts)
    }) as LogDb['completePartialImport']

    await runDirMigration(db, { type: 'migrate-dir', id: 6, logsDir }, post)

    const report = doneReport(posted)
    expect(report.failedSessions).toBe(1)
    expect(report.importedSessions).toBe(1)
    expect(report.totalSessions).toBe(2)
    // Failed group's extra member attributed as folded -> identity over 3 dirs holds.
    expect(report.totalSessions + report.foldedPartnerDirs + report.noEventDirs).toBe(3)
    // Its events did not count as imported and its marker survives for the re-run.
    expect(report.importedEvents).toBe(1)
    expect(db.getSessionImportState('bad')!.status).toBe('importing')
    // Failure surfaced as a warn log.
    expect(posted.some((p) => p.type === 'log' && /bad/.test((p as Extract<FromWorker, { type: 'log' }>).entry.message))).toBe(true)
  })

  it('counts malformed-only dirs as noEventDirs with unparseable entries, no session row', async () => {
    makeSession('A', 'junk', { 'session.jsonl': 'not json\n' })
    makeSession('A', 'fine', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'ok' }) })

    await runDirMigration(db, { type: 'migrate-dir', id: 7, logsDir }, post)

    const report = doneReport(posted)
    expect(report.totalSessions).toBe(1)
    expect(report.noEventDirs).toBe(1)
    expect(report.unparseable.some((u) => u.path.includes('junk'))).toBe(true)
    expect(db.listSessions().some((s) => s.sessionId === 'junk')).toBe(false)
  })

  it('posts monotonic progress that ends at done === total', async () => {
    for (let i = 0; i < 5; i++) makeSession('A', `p${i}`, { 'session.jsonl': line({ ts: i, type: 'data', data: 'x' }) })
    await runDirMigration(db, { type: 'migrate-dir', id: 8, logsDir }, post)
    const prog = posted.filter((p) => p.type === 'migrate-dir-progress') as Extract<FromWorker, { type: 'migrate-dir-progress' }>[]
    expect(prog.length).toBeGreaterThan(0)
    const last = prog[prog.length - 1]
    expect(last.done).toBe(5)
    expect(last.total).toBe(5)
    for (let i = 1; i < prog.length; i++) expect(prog[i].done).toBeGreaterThanOrEqual(prog[i - 1].done)
  })

  it('rejects a CONCURRENT migrate-dir via handleWorkerMessage with migrate-error (right id)', async () => {
    makeSession('A', 'c1', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'x' }) })
    // First op via the sync handler (kicks the async loop)...
    handleWorkerMessage(db, { type: 'migrate-dir', id: 10, logsDir }, post)
    // ...second op while the first is still running must be refused.
    handleWorkerMessage(db, { type: 'migrate-dir', id: 11, logsDir }, post)
    const err = posted.find((p) => p.type === 'migrate-error') as Extract<FromWorker, { type: 'migrate-error' }>
    expect(err).toBeTruthy()
    expect(err.id).toBe(11)
    // Let the first run finish so the test does not leak into the next.
    await new Promise((r) => setTimeout(r, 200))
    expect(posted.some((p) => p.type === 'migrate-dir-done' && (p as Extract<FromWorker, { type: 'migrate-dir-done' }>).id === 10)).toBe(true)
  })

  it('an empty/missing logs dir completes with an all-zero report', async () => {
    await runDirMigration(db, { type: 'migrate-dir', id: 12, logsDir: join(root, 'nope') }, post)
    const report = doneReport(posted)
    expect(report.totalSessions).toBe(0)
    expect(report.importedSessions).toBe(0)
    const prog = posted.filter((p) => p.type === 'migrate-dir-progress') as Extract<FromWorker, { type: 'migrate-dir-progress' }>[]
    expect(prog[prog.length - 1]?.total ?? 0).toBe(0)
  })
})
