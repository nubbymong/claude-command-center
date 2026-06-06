/**
 * Native test for src/main/logging/transcripts-db.ts — must run under
 * Electron-as-Node (npm run test:unit:native) because better-sqlite3 is built
 * for Electron's ABI.
 *
 * A fresh tmp dir per test (mkdtempSync) — NEVER touches real paths.
 */
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openTranscriptsDb } from '../../../src/main/logging/transcripts-db'
import type { TranscriptsDb } from '../../../src/main/logging/transcripts-db'

type Msg = {
  idx: number
  ts: number
  role: string
  kind: string
  content: string
  toolName?: string
  toolMeta?: string
  raw?: string
}

describe('transcripts-db', () => {
  let dir: string
  let dbPath: string
  let db: TranscriptsDb

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transcripts-db-'))
    dbPath = join(dir, 'transcripts.db')
    db = openTranscriptsDb(dbPath)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
    rmSync(dir, { recursive: true, force: true })
  })

  // Direct-inspection helper for columns the public API intentionally does not
  // expose (raw, meta, run status). Opens a second connection on the same file.
  const inspect = <T>(fn: (raw: InstanceType<typeof Database>) => T): T => {
    const raw = new Database(dbPath)
    try {
      return fn(raw)
    } finally {
      raw.close()
    }
  }

  const runMeta = (over: Partial<Parameters<TranscriptsDb['insertRun']>[0]> = {}) => ({
    sessionId: 's1',
    configLabel: 'APP_DEV',
    provider: 'claude',
    startedAt: 100,
    ...over,
  })

  const msg = (idx: number, over: Partial<Msg> = {}): Msg => ({
    idx,
    ts: 1000 + idx,
    role: 'user',
    kind: 'message',
    content: `msg ${idx}`,
    ...over,
  })

  // -------------------------------------------------------------------------
  // 1. schema + reopen
  // -------------------------------------------------------------------------

  it('open creates schema v1; reopening the same file is idempotent and keeps data', () => {
    const runId = db.insertRun(runMeta())
    expect(typeof runId).toBe('number')
    db.close()

    const { metaValue, tables } = (() => {
      const raw = new Database(dbPath)
      try {
        const m = raw.prepare(`SELECT value FROM meta WHERE key = 'schemaVersion'`).get() as
          | { value: string }
          | undefined
        const t = (
          raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
        ).map((r) => r.name)
        return { metaValue: m?.value, tables: t }
      } finally {
        raw.close()
      }
    })()
    expect(metaValue).toBe('1')
    expect(tables).toEqual(expect.arrayContaining(['runs', 'transcripts', 'messages', 'meta']))

    // Reopen — CREATE IF NOT EXISTS / INSERT OR IGNORE guards make this a no-op
    db = openTranscriptsDb(dbPath)
    const stats = db.ingestStats('s1')
    expect(stats).not.toBeNull()
    expect(stats!.messageCount).toBe(0)
    expect(stats!.transcripts).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 2. insertRun is per-spawn
  // -------------------------------------------------------------------------

  it('insertRun twice with the same sessionId creates two distinct runs', () => {
    const r1 = db.insertRun(runMeta({ startedAt: 100 }))
    const r2 = db.insertRun(runMeta({ startedAt: 200 }))
    expect(r1).not.toBe(r2)

    const count = inspect(
      (raw) => (raw.prepare(`SELECT COUNT(*) AS c FROM runs WHERE sessionId = 's1'`).get() as { c: number }).c,
    )
    expect(count).toBe(2)
  })

  // -------------------------------------------------------------------------
  // 3. closeRun / setRunAccount target the latest OPEN run
  // -------------------------------------------------------------------------

  it('closeRun closes only the latest open run; setRunAccount targets the latest open run', () => {
    const r1 = db.insertRun(runMeta({ startedAt: 100 }))
    const r2 = db.insertRun(runMeta({ startedAt: 200 }))

    db.closeRun('s1', 999, 'exited')
    let rows = inspect((raw) =>
      raw.prepare(`SELECT runId, status, endedAt, accountEmail FROM runs ORDER BY runId`).all(),
    ) as { runId: number; status: string; endedAt: number | null; accountEmail: string | null }[]
    expect(rows.find((r) => r.runId === r2)).toMatchObject({ status: 'exited', endedAt: 999 })
    expect(rows.find((r) => r.runId === r1)).toMatchObject({ status: 'running', endedAt: null })

    // r1 is now the latest open run — setRunAccount must hit it, not r2
    db.setRunAccount('s1', 'second@example.com')
    rows = inspect((raw) =>
      raw.prepare(`SELECT runId, status, endedAt, accountEmail FROM runs ORDER BY runId`).all(),
    ) as { runId: number; status: string; endedAt: number | null; accountEmail: string | null }[]
    expect(rows.find((r) => r.runId === r1)!.accountEmail).toBe('second@example.com')
    expect(rows.find((r) => r.runId === r2)!.accountEmail).toBeNull()

    // Close r1, then a third closeRun is a no-op (no open run left)
    db.closeRun('s1', 1000, 'crashed')
    expect(() => db.closeRun('s1', 1001, 'exited')).not.toThrow()
    rows = inspect((raw) =>
      raw.prepare(`SELECT runId, status, endedAt, accountEmail FROM runs ORDER BY runId`).all(),
    ) as { runId: number; status: string; endedAt: number | null; accountEmail: string | null }[]
    expect(rows.find((r) => r.runId === r1)).toMatchObject({ status: 'crashed', endedAt: 1000 })
    expect(rows.find((r) => r.runId === r2)).toMatchObject({ status: 'exited', endedAt: 999 })
  })

  // -------------------------------------------------------------------------
  // 4. bindTranscript upsert + ord assignment
  // -------------------------------------------------------------------------

  it('bindTranscript upserts by (runId, path): re-bind keeps id+ord, new path gets ord+1', () => {
    const r1 = db.insertRun(runMeta())

    const a = db.bindTranscript(r1, 'C:/transcripts/a.jsonl', { confidence: 'exact', parserVersion: 1 })
    expect(a.isNew).toBe(true)
    expect(a.ord).toBe(0)

    const a2 = db.bindTranscript(r1, 'C:/transcripts/a.jsonl', {
      confidence: 'heuristic',
      sourceVersion: '2.1.0',
      parserVersion: 2,
    })
    expect(a2.isNew).toBe(false)
    expect(a2.transcriptId).toBe(a.transcriptId)
    expect(a2.ord).toBe(0)

    const b = db.bindTranscript(r1, 'C:/transcripts/b.jsonl', { confidence: 'exact', parserVersion: 1 })
    expect(b.isNew).toBe(true)
    expect(b.ord).toBe(1)
    expect(b.transcriptId).not.toBe(a.transcriptId)

    // ord is per-run: a different run starts back at 0
    const r2 = db.insertRun(runMeta({ startedAt: 200 }))
    const c = db.bindTranscript(r2, 'C:/transcripts/a.jsonl', { confidence: 'exact', parserVersion: 1 })
    expect(c.isNew).toBe(true)
    expect(c.ord).toBe(0)
  })

  it('setTranscriptStatus / advanceCursor / listResumableTranscripts round-trip', () => {
    const r1 = db.insertRun(runMeta())
    const a = db.bindTranscript(r1, 'C:/t/a.jsonl', { confidence: 'exact', parserVersion: 3 })
    const b = db.bindTranscript(r1, 'C:/t/b.jsonl', { confidence: 'heuristic', parserVersion: 3 })

    expect(db.listResumableTranscripts()).toEqual([])

    db.setTranscriptStatus(a.transcriptId, 'tailing')
    db.advanceCursor(a.transcriptId, 4096)
    db.setTranscriptStatus(b.transcriptId, 'failed')

    expect(db.listResumableTranscripts()).toEqual([
      { transcriptId: a.transcriptId, runId: r1, path: 'C:/t/a.jsonl', ingestCursor: 4096, parserVersion: 3 },
    ])

    db.setTranscriptStatus(a.transcriptId, 'complete')
    expect(db.listResumableTranscripts()).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 5. appendMessages + nextIdx + UNIQUE(runId, idx)
  // -------------------------------------------------------------------------

  it('appendMessages + nextIdx; duplicate idx throws and rolls back the whole batch', () => {
    const r1 = db.insertRun(runMeta())
    expect(db.nextIdx(r1)).toBe(0)

    db.appendMessages(r1, [msg(0), msg(1)])
    expect(db.nextIdx(r1)).toBe(2)

    // duplicate idx in a fresh batch → throws
    expect(() => db.appendMessages(r1, [msg(1)])).toThrow()

    // single transaction: a batch where the SECOND row collides rolls back the first too
    expect(() => db.appendMessages(r1, [msg(2), msg(0)])).toThrow()
    expect(db.nextIdx(r1)).toBe(2)

    // empty batch is a no-op
    expect(() => db.appendMessages(r1, [])).not.toThrow()

    // nextIdx is per-run
    const r2 = db.insertRun(runMeta({ startedAt: 200 }))
    expect(db.nextIdx(r2)).toBe(0)
  })

  it('appendMessages throws FOREIGN KEY constraint when the run has been deleted by deleteSlot', () => {
    const r1 = db.insertRun(runMeta({ configId: 'cfgFK', startedAt: 100 }))
    db.appendMessages(r1, [msg(0)])
    db.deleteSlot({ configId: 'cfgFK' })
    // The run no longer exists — FOREIGN KEY constraint must fire
    expect(() => db.appendMessages(r1, [msg(1)])).toThrow()
  })

  // -------------------------------------------------------------------------
  // 6. readMessagesPage — stitching
  // -------------------------------------------------------------------------

  it('stitches two runs in one config with a synthesized relaunch row between them', () => {
    const r1 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 100 }))
    db.appendMessages(r1, [msg(0)])
    const r2 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 200 }))
    db.appendMessages(r2, [msg(0)])

    const page = db.readMessagesPage({ configId: 'cfg1' }, { anchor: 'tail', dir: 'older', limit: 10 })
    expect(page.map((p) => p.kind)).toEqual(['message', 'relaunch', 'message'])
    expect(page[0]).toMatchObject({ runId: r1, idx: 0 })
    // synthesized relaunch row: idx -1, ts = next run's startedAt, system/empty
    expect(page[1]).toMatchObject({ runId: r2, idx: -1, ts: 200, role: 'system', kind: 'relaunch', content: '' })
    expect(page[2]).toMatchObject({ runId: r2, idx: 0 })
  })

  it('tail anchor returns the LAST limit messages ascending; relaunch rows do not count against limit', () => {
    const r1 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 100 }))
    db.appendMessages(r1, [msg(0), msg(1), msg(2)])
    const r2 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 200 }))
    db.appendMessages(r2, [msg(0), msg(1), msg(2)])

    // last 2 — both inside r2, no boundary spanned, no relaunch row
    const last2 = db.readMessagesPage({ configId: 'cfg1' }, { anchor: 'tail', dir: 'older', limit: 2 })
    expect(last2.map((p) => [p.runId, p.idx])).toEqual([
      [r2, 1],
      [r2, 2],
    ])

    // last 4 — spans the boundary: 4 stored + 1 relaunch = 5 rows
    const last4 = db.readMessagesPage({ configId: 'cfg1' }, { anchor: 'tail', dir: 'older', limit: 4 })
    expect(last4.length).toBe(5)
    expect(last4.filter((p) => p.kind !== 'relaunch').length).toBe(4)
    expect(last4.map((p) => [p.runId, p.idx])).toEqual([
      [r1, 2],
      [r2, -1],
      [r2, 0],
      [r2, 1],
      [r2, 2],
    ])

    // limit larger than total — everything, one relaunch row
    const all = db.readMessagesPage({ configId: 'cfg1' }, { anchor: 'tail', dir: 'older', limit: 100 })
    expect(all.filter((p) => p.kind !== 'relaunch').length).toBe(6)
    expect(all.filter((p) => p.kind === 'relaunch').length).toBe(1)
  })

  it('dir=older from an anchor pair crosses the run boundary; dir=newer returns strictly after', () => {
    const r1 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 100 }))
    db.appendMessages(r1, [msg(0), msg(1), msg(2)])
    const r2 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 200 }))
    db.appendMessages(r2, [msg(0), msg(1), msg(2)])

    // strictly BEFORE (r2, 1): nearest 3 = r1m1, r1m2, r2m0 — ascending, boundary stitched
    const older = db.readMessagesPage(
      { configId: 'cfg1' },
      { anchor: { runId: r2, idx: 1 }, dir: 'older', limit: 3 },
    )
    expect(older.map((p) => [p.runId, p.idx])).toEqual([
      [r1, 1],
      [r1, 2],
      [r2, -1],
      [r2, 0],
    ])

    // strictly AFTER (r1, 1): first 2 = r1m2, r2m0 — boundary stitched
    const newer = db.readMessagesPage(
      { configId: 'cfg1' },
      { anchor: { runId: r1, idx: 1 }, dir: 'newer', limit: 2 },
    )
    expect(newer.map((p) => [p.runId, p.idx])).toEqual([
      [r1, 2],
      [r2, -1],
      [r2, 0],
    ])

    // older from the very first message — nothing before it
    expect(
      db.readMessagesPage({ configId: 'cfg1' }, { anchor: { runId: r1, idx: 0 }, dir: 'older', limit: 5 }),
    ).toEqual([])

    // newer from the tail anchor — nothing after the tail
    expect(db.readMessagesPage({ configId: 'cfg1' }, { anchor: 'tail', dir: 'newer', limit: 5 })).toEqual([])
  })

  it('scopes by sessionId (configId-null runs) and isolates scopes; ties on startedAt break by runId', () => {
    // sessionId scope: two restarts of the same slot instance, no configId
    const r1 = db.insertRun(runMeta({ sessionId: 'sx', startedAt: 100 }))
    db.appendMessages(r1, [msg(0)])
    const r2 = db.insertRun(runMeta({ sessionId: 'sx', startedAt: 100 })) // same startedAt → runId tie-break
    db.appendMessages(r2, [msg(0)])

    // unrelated run that must NOT leak into the scope
    const other = db.insertRun(runMeta({ sessionId: 'sy', configId: 'cfgOther', startedAt: 50 }))
    db.appendMessages(other, [msg(0)])

    const page = db.readMessagesPage({ sessionId: 'sx' }, { anchor: 'tail', dir: 'older', limit: 10 })
    expect(page.map((p) => [p.runId, p.idx])).toEqual([
      [r1, 0],
      [r2, -1],
      [r2, 0],
    ])

    // configId scope isolation
    const otherPage = db.readMessagesPage({ configId: 'cfgOther' }, { anchor: 'tail', dir: 'older', limit: 10 })
    expect(otherPage.map((p) => [p.runId, p.idx])).toEqual([[other, 0]])

    // unknown scope → empty
    expect(db.readMessagesPage({ configId: 'nope' }, { anchor: 'tail', dir: 'older', limit: 10 })).toEqual([])
  })

  it('page-seam divider: older page ending exactly at a run boundary appends a trailing divider', () => {
    // r1 has m0-m2; r2 has m0-m2. tail page with limit=3 returns all of r2.
    // The NEXT older-anchored page (from r2,m0) returns all of r1 — and since
    // that page ends exactly at the r1/r2 boundary it must include a trailing divider.
    const r1 = db.insertRun(runMeta({ configId: 'cfgSeam', startedAt: 100 }))
    db.appendMessages(r1, [msg(0), msg(1), msg(2)])
    const r2 = db.insertRun(runMeta({ configId: 'cfgSeam', startedAt: 200 }))
    db.appendMessages(r2, [msg(0), msg(1), msg(2)])

    // tail page = exactly r2
    const tailPage = db.readMessagesPage(
      { configId: 'cfgSeam' },
      { anchor: 'tail', dir: 'older', limit: 3 },
    )
    expect(tailPage.map((p) => [p.runId, p.idx])).toEqual([
      [r2, 0],
      [r2, 1],
      [r2, 2],
    ])

    // older page anchored at r2,m0 — returns r1m0..r1m2, ends at r1 while anchor is in r2 → trailing divider
    const olderPage = db.readMessagesPage(
      { configId: 'cfgSeam' },
      { anchor: { runId: r2, idx: 0 }, dir: 'older', limit: 3 },
    )
    expect(olderPage.map((p) => [p.runId, p.idx])).toEqual([
      [r1, 0],
      [r1, 1],
      [r1, 2],
      [r2, -1], // trailing seam divider
    ])
    expect(olderPage[3]).toMatchObject({ role: 'system', kind: 'relaunch', content: '' })
  })

  it('page-seam divider: newer page starting exactly at a new run prepends a leading divider', () => {
    // r1 m0-m2; r2 m0-m2. Anchoring at r1,m2 with dir=newer + limit=3 returns
    // all of r2 — a different run from the anchor → leading divider prepended.
    const r1 = db.insertRun(runMeta({ configId: 'cfgSeam2', startedAt: 100 }))
    db.appendMessages(r1, [msg(0), msg(1), msg(2)])
    const r2 = db.insertRun(runMeta({ configId: 'cfgSeam2', startedAt: 200 }))
    db.appendMessages(r2, [msg(0), msg(1), msg(2)])

    const newerPage = db.readMessagesPage(
      { configId: 'cfgSeam2' },
      { anchor: { runId: r1, idx: 2 }, dir: 'newer', limit: 3 },
    )
    expect(newerPage.map((p) => [p.runId, p.idx])).toEqual([
      [r2, -1], // leading seam divider
      [r2, 0],
      [r2, 1],
      [r2, 2],
    ])
    expect(newerPage[0]).toMatchObject({ role: 'system', kind: 'relaunch', content: '' })
  })

  it('page-seam divider: anchoring ON a divider row (idx=-1) does not produce a duplicate', () => {
    const r1 = db.insertRun(runMeta({ configId: 'cfgSeam3', startedAt: 100 }))
    db.appendMessages(r1, [msg(0), msg(1)])
    const r2 = db.insertRun(runMeta({ configId: 'cfgSeam3', startedAt: 200 }))
    db.appendMessages(r2, [msg(0), msg(1)])

    // Anchor on the divider row (idx=-1) that lives at r2; dir=older
    // → page is all of r1; anchor.idx === -1, so NO trailing divider appended
    const olderFromDivider = db.readMessagesPage(
      { configId: 'cfgSeam3' },
      { anchor: { runId: r2, idx: -1 }, dir: 'older', limit: 10 },
    )
    expect(olderFromDivider.filter((p) => p.kind === 'relaunch').length).toBe(0)
    expect(olderFromDivider.map((p) => [p.runId, p.idx])).toEqual([
      [r1, 0],
      [r1, 1],
    ])
  })

  it('empty middle run produces no divider of its own (A with msgs / B with none / C with msgs)', () => {
    const rA = db.insertRun(runMeta({ configId: 'cfgABC', startedAt: 100 }))
    db.appendMessages(rA, [msg(0), msg(1)])
    // rB: zero messages
    db.insertRun(runMeta({ configId: 'cfgABC', startedAt: 200 }))
    const rC = db.insertRun(runMeta({ configId: 'cfgABC', startedAt: 300 }))
    db.appendMessages(rC, [msg(0), msg(1)])

    const page = db.readMessagesPage({ configId: 'cfgABC' }, { anchor: 'tail', dir: 'older', limit: 100 })
    // rB contributes nothing → one divider between A and C
    expect(page.filter((p) => p.kind === 'relaunch').length).toBe(1)
    const kinds = page.map((p) => p.kind)
    expect(kinds).toEqual(['message', 'message', 'relaunch', 'message', 'message'])
    expect(page[2]).toMatchObject({ runId: rC, idx: -1, ts: 300, kind: 'relaunch' })
  })

  // -------------------------------------------------------------------------
  // 7. turnSummary
  // -------------------------------------------------------------------------

  it('turnSummary returns ordered summaries without content', () => {
    const r1 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 100 }))
    db.appendMessages(r1, [
      msg(0),
      msg(1, { role: 'assistant', kind: 'tool_use', toolName: 'Bash', content: 'running ls' }),
    ])
    const r2 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 200 }))
    db.appendMessages(r2, [msg(0)])

    const summ = db.turnSummary({ configId: 'cfg1' })
    expect(summ.map((s) => [s.runId, s.idx])).toEqual([
      [r1, 0],
      [r1, 1],
      [r2, 0],
    ])
    expect(summ[1]).toMatchObject({ role: 'assistant', kind: 'tool_use', toolName: 'Bash', ts: 1001 })
    expect(summ[0].toolName).toBeNull()
    // no content payload in a summary row
    expect(Object.keys(summ[1])).not.toContain('content')

    // sessionId scope works too
    expect(db.turnSummary({ sessionId: 's1' }).length).toBe(3)
  })

  // -------------------------------------------------------------------------
  // 8. searchMessages (FTS)
  // -------------------------------------------------------------------------

  it('searchMessages finds content via FTS and returns (runId, idx) + snippet + scope ids', () => {
    const r1 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 100 }))
    db.appendMessages(r1, [msg(0, { content: 'deploy AND release uniqueneedle done' })])

    const hits = db.searchMessages('uniqueneedle')
    expect(hits.length).toBe(1)
    expect(hits[0]).toMatchObject({ runId: r1, idx: 0, configId: 'cfg1', sessionId: 's1' })
    expect(hits[0].snippet).toContain('uniqueneedle')

    // bare FTS operator word matches literally (token double-quoting)
    expect(db.searchMessages('AND').length).toBe(1)

    // limit respected
    const r2 = db.insertRun(runMeta({ configId: 'cfg1', startedAt: 200 }))
    db.appendMessages(
      r2,
      Array.from({ length: 5 }, (_, i) => msg(i, { content: `sharedterm ${i}` })),
    )
    expect(db.searchMessages('sharedterm', 3).length).toBe(3)
  })

  it('searchMessages never throws on operator/syntax-heavy queries', () => {
    const r1 = db.insertRun(runMeta())
    db.appendMessages(r1, [msg(0, { content: 'plain text' })])

    expect(() => db.searchMessages('AND OR NOT (')).not.toThrow()
    expect(() => db.searchMessages('foo(bar')).not.toThrow()
    expect(() => db.searchMessages('"unbalanced')).not.toThrow()
    expect(() => db.searchMessages('  ')).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // 9. listSlots + deleteSlot
  // -------------------------------------------------------------------------

  it('listSlots groups per configId with orphan:<sessionId> rows for configId-null runs', () => {
    // cfgA: two runs of sessionId s1; identity fields come from the LATEST run
    const a1 = db.insertRun(runMeta({ configId: 'cfgA', configLabel: 'Slot A', startedAt: 100 }))
    db.appendMessages(a1, [msg(0)])
    db.closeRun('s1', 150, 'exited')
    const a2 = db.insertRun(
      runMeta({ configId: 'cfgA', configLabel: 'Slot A v2', accountEmail: 'a@example.com', startedAt: 200 }),
    )
    db.appendMessages(a2, [msg(0), msg(1)])
    db.closeRun('s1', 250, 'exited')

    // orphan: configId-null run of sessionId s2
    const o1 = db.insertRun(runMeta({ sessionId: 's2', startedAt: 300 }))
    db.appendMessages(o1, [msg(0)])

    const slots = db.listSlots()
    expect(slots.length).toBe(2)

    const slotA = slots.find((s) => s.slotKey === 'cfgA')!
    expect(slotA).toMatchObject({
      configId: 'cfgA',
      configLabel: 'Slot A v2',
      accountEmail: 'a@example.com',
      lastActive: 250,
      runCount: 2,
      messageCount: 3,
    })

    const orphan = slots.find((s) => s.slotKey === 'orphan:s2')!
    expect(orphan).toMatchObject({
      configId: null,
      lastActive: 300,
      runCount: 1,
      messageCount: 1,
    })
  })

  it('deleteSlot by configId cascades messages + transcripts (and their FTS rows)', () => {
    const a1 = db.insertRun(runMeta({ configId: 'cfgA', startedAt: 100 }))
    db.appendMessages(a1, [msg(0, { content: 'cascadetoken alpha' })])
    db.bindTranscript(a1, 'C:/t/a1.jsonl', { confidence: 'exact', parserVersion: 1 })
    db.closeRun('s1', 150, 'exited')
    const a2 = db.insertRun(runMeta({ configId: 'cfgA', startedAt: 200 }))
    db.appendMessages(a2, [msg(0), msg(1)])
    db.closeRun('s1', 250, 'exited')

    const o1 = db.insertRun(runMeta({ sessionId: 's2', startedAt: 300 }))
    db.appendMessages(o1, [msg(0)])

    expect(db.searchMessages('cascadetoken').length).toBe(1)

    const res = db.deleteSlot({ configId: 'cfgA' })
    expect(res).toEqual({ deletedRuns: 2, deletedMessages: 3 })

    // FTS rows gone (delete triggers fired through the FK cascade).
    // Verify via direct FTS table query so a JOIN bug can't mask orphan rows.
    const ftsDirect = inspect(
      (raw) =>
        (
          raw
            .prepare(`SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH ?`)
            .get('"cascadetoken"') as { c: number }
        ).c,
    )
    expect(ftsDirect).toBe(0)
    expect(db.searchMessages('cascadetoken')).toEqual([])
    // transcripts cascaded
    const tCount = inspect(
      (raw) => (raw.prepare(`SELECT COUNT(*) AS c FROM transcripts`).get() as { c: number }).c,
    )
    expect(tCount).toBe(0)
    // the orphan slot is untouched
    expect(db.listSlots().map((s) => s.slotKey)).toEqual(['orphan:s2'])
  })

  it('deleteSlot by sessionId removes that slot instance only', () => {
    const r1 = db.insertRun(runMeta({ sessionId: 'sx', startedAt: 100 }))
    db.appendMessages(r1, [msg(0)])
    const keep = db.insertRun(runMeta({ sessionId: 'sy', startedAt: 200 }))
    db.appendMessages(keep, [msg(0)])

    const res = db.deleteSlot({ sessionId: 'sx' })
    expect(res).toEqual({ deletedRuns: 1, deletedMessages: 1 })
    expect(db.listSlots().map((s) => s.slotKey)).toEqual(['orphan:sy'])
  })

  // -------------------------------------------------------------------------
  // 10. clearAll preserves running runs
  // -------------------------------------------------------------------------

  it('clearAll preserves running runs and their messages/transcripts', () => {
    const live = db.insertRun(runMeta({ sessionId: 'live', configId: 'cfgL', startedAt: 100 })) // stays running
    db.appendMessages(live, [msg(0), msg(1)])
    db.bindTranscript(live, 'C:/t/live.jsonl', { confidence: 'exact', parserVersion: 1 })

    const done = db.insertRun(runMeta({ sessionId: 'done', configId: 'cfgD', startedAt: 50 }))
    db.appendMessages(done, [msg(0)])
    db.closeRun('done', 60, 'exited')

    const res = db.clearAll()
    expect(res).toEqual({ deletedRuns: 1, deletedMessages: 1 })

    // live run intact: messages + transcript survive
    const page = db.readMessagesPage({ sessionId: 'live' }, { anchor: 'tail', dir: 'older', limit: 10 })
    expect(page.map((p) => [p.runId, p.idx])).toEqual([
      [live, 0],
      [live, 1],
    ])
    const stats = db.ingestStats('live')
    expect(stats!.messageCount).toBe(2)
    expect(stats!.transcripts).toEqual([{ path: 'C:/t/live.jsonl', status: 'pending', ord: 0 }])

    // ended run gone
    expect(db.readMessagesPage({ sessionId: 'done' }, { anchor: 'tail', dir: 'older', limit: 10 })).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 11. raw column
  // -------------------------------------------------------------------------

  it('appendMessages stores raw only when provided (kind=unknown rows); others NULL', () => {
    const r1 = db.insertRun(runMeta())
    db.appendMessages(r1, [
      msg(0, { content: 'normal row' }),
      msg(1, { role: 'system', kind: 'unknown', content: '', raw: '{"unparsed":true}' }),
    ])

    const rows = inspect((raw) =>
      raw.prepare(`SELECT idx, kind, raw FROM messages WHERE runId = ? ORDER BY idx`).all(r1),
    ) as { idx: number; kind: string; raw: string | null }[]
    expect(rows[0].raw).toBeNull()
    expect(rows[1]).toMatchObject({ kind: 'unknown', raw: '{"unparsed":true}' })
  })

  // -------------------------------------------------------------------------
  // ingestStats
  // -------------------------------------------------------------------------

  it('ingestStats targets the latest open run, falls back to the latest run, null when none', () => {
    expect(db.ingestStats('nope')).toBeNull()

    const r1 = db.insertRun(runMeta({ startedAt: 100 }))
    db.bindTranscript(r1, 'C:/t/r1.jsonl', { confidence: 'exact', parserVersion: 1 })
    db.appendMessages(r1, [msg(0)])
    db.closeRun('s1', 150, 'exited')

    // no open run → falls back to the latest run (r1)
    let stats = db.ingestStats('s1')
    expect(stats!.messageCount).toBe(1)
    expect(stats!.transcripts).toEqual([{ path: 'C:/t/r1.jsonl', status: 'pending', ord: 0 }])

    // a new OPEN run takes precedence even with fewer messages
    const r2 = db.insertRun(runMeta({ startedAt: 200 }))
    db.bindTranscript(r2, 'C:/t/r2.jsonl', { confidence: 'heuristic', parserVersion: 1 })
    stats = db.ingestStats('s1')
    expect(stats!.messageCount).toBe(0)
    expect(stats!.transcripts).toEqual([{ path: 'C:/t/r2.jsonl', status: 'pending', ord: 0 }])
  })

  // -------------------------------------------------------------------------
  // checkpoint
  // -------------------------------------------------------------------------

  it('checkpoint() runs without throwing and the db remains usable', () => {
    const r1 = db.insertRun(runMeta())
    db.appendMessages(r1, [msg(0)])
    db.deleteSlot({ sessionId: 's1' })
    expect(() => db.checkpoint()).not.toThrow()
    // db is still functional after checkpoint
    expect(() => db.insertRun(runMeta())).not.toThrow()
  })
})
