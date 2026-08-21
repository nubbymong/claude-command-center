/**
 * The #307 one-off re-index is CODEX-SCOPED and self-contained (ADR-009 pass on
 * the beta.16 substrate found the first cut wiping every event and rewinding
 * every cursor, so life-to-date Claude spend whose transcript was no longer on
 * disk was lost on first launch). A Claude row whose source file is gone must
 * survive; Codex rows go; the rollups are rebuilt from the survivors in the
 * same transaction; only Codex cursors are rewound.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openTkDb as openTkDbRaw } from '../../../src/main/tokenomics/tk-db'
import type { TkEvent } from '../../../src/main/tokenomics/tk-types'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, 'gpt-5.5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }
const T0 = Date.UTC(2026, 5, 1, 10, 0, 0)

const claudeEvent = (i: number, sessionId = 's-claude', configId = 'cfgA'): TkEvent & { configId: string } => ({
  dedupKey: `c:m${i}:r${i}`, sessionId, provider: 'claude' as never, model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8',
  ts: T0 + i * 60_000, cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId,
})
const codexEvent = (i: number, sessionId = 'x-codex'): TkEvent & { configId: string } => ({
  dedupKey: `x:${sessionId}:${i}`, sessionId, provider: 'codex' as never, model: 'gpt-5.5', priceModel: 'gpt-5.5',
  ts: T0 + 3_600_000 + i * 60_000, cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: 'cfgA',
})
const cursor = (p: string, extra: Partial<{ codexSessionId: string; codexTurns: number }> = {}) => ({
  path: p, size: 1234, mtime: T0, lastOffset: 1234, lastIngestedAt: T0, scannedTo: 1234,
  codexSessionId: extra.codexSessionId ?? '', codexModel: extra.codexSessionId ? 'gpt-5.5' : '', codexCwd: extra.codexSessionId ? 'F:\\proj' : '', codexTurns: extra.codexTurns ?? 0,
})

describe('#307 re-index is Codex-scoped', () => {
  let tmp: string
  let dbPath: string
  // Every db this test opens, so a failed assertion still closes the file and
  // the temp dir can be removed (Windows refuses to delete an open db).
  let opened: ReturnType<typeof openTkDb>[] = []
  const openTkDb = (p: string) => { const db = openTkDbRaw(p); opened.push(db); return db }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tk307-')); dbPath = path.join(tmp, 'tk.db'); opened = [] })
  afterEach(() => {
    for (const db of opened) { try { db.close() } catch { /* already closed */ } }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function seedPreUpgradeDb() {
    // A db as a beta.15 install leaves it: rows + cursors, no 307 marker.
    const db = openTkDb(dbPath)
    db.raw.prepare('DELETE FROM tk_meta WHERE key = ?').run('codexReindex307')
    db.insertEventsWithCursor([claudeEvent(1), claudeEvent(2)], cursor('C:/gone/claude-old.jsonl'))
    db.insertEventsWithCursor([claudeEvent(3, 's-claude-2', 'cfgB')], cursor('C:/live/claude-new.jsonl'))
    db.insertEventsWithCursor([codexEvent(1), codexEvent(2)], cursor('C:/codex/sessions/2026/rollout-2026-06-01T10-00-00-abc.jsonl', { codexSessionId: 'x-codex', codexTurns: 2 }))
    db.setMeta('firstIndexComplete', '1')
    const before = db.querySummary(PRICING, {}, T0 + 86_400_000)
    // Sanity: the marker is gone and the wipe would have found rows to wipe.
    expect(db.getMeta('codexReindex307')).toBeNull()
    expect(db.eventCount()).toBe(5)
    db.close()
    return before
  }

  it('keeps every Claude row (including one whose transcript is gone), drops Codex rows, marks done', () => {
    const before = seedPreUpgradeDb()
    const db = openTkDb(dbPath)
    expect(db.getMeta('codexReindex307')).toBe('done')
    expect(db.eventCount()).toBe(3)
    const providers = db.raw.prepare('SELECT provider, COUNT(*) n FROM tk_events GROUP BY provider').all() as { provider: string; n: number }[]
    expect(providers).toEqual([{ provider: 'claude', n: 3 }])
    // Life-to-date Claude spend is intact even though C:/gone/ no longer exists.
    const after = db.querySummary(PRICING, {}, T0 + 86_400_000)
    // before = 3 Claude @ $5 + 2 Codex @ $1 = $17; after = the Claude $15 only.
    expect(before.kpis.lifeToDateCostUsd).toBeCloseTo(17, 5)
    expect(after.kpis.lifeToDateCostUsd).toBeCloseTo(15, 5)
    db.close()
  })

  it('rebuilds every rollup from the surviving events with the live upsert rules', () => {
    seedPreUpgradeDb()
    const db = openTkDb(dbPath)
    const sessions = db.raw.prepare('SELECT sessionId, provider, configId, msgCount, inTok, firstTs, lastTs, lastModel FROM tk_sessions ORDER BY sessionId').all() as Record<string, unknown>[]
    expect(sessions).toEqual([
      { sessionId: 's-claude', provider: 'claude', configId: 'cfgA', msgCount: 2, inTok: 2_000_000, firstTs: T0 + 60_000, lastTs: T0 + 120_000, lastModel: 'claude-opus-4-8' },
      { sessionId: 's-claude-2', provider: 'claude', configId: 'cfgB', msgCount: 1, inTok: 1_000_000, firstTs: T0 + 180_000, lastTs: T0 + 180_000, lastModel: 'claude-opus-4-8' },
    ])
    const daily = db.raw.prepare('SELECT day, model, provider, configId, msgCount, inTok FROM tk_daily ORDER BY configId').all() as Record<string, unknown>[]
    expect(daily).toEqual([
      { day: '2026-06-01', model: 'claude-opus-4-8', provider: 'claude', configId: 'cfgA', msgCount: 2, inTok: 2_000_000 },
      { day: '2026-06-01', model: 'claude-opus-4-8', provider: 'claude', configId: 'cfgB', msgCount: 1, inTok: 1_000_000 },
    ])
    const sm = db.raw.prepare('SELECT sessionId, model, msgCount FROM tk_session_models ORDER BY sessionId').all()
    expect(sm).toEqual([{ sessionId: 's-claude', model: 'claude-opus-4-8', msgCount: 2 }, { sessionId: 's-claude-2', model: 'claude-opus-4-8', msgCount: 1 }])
    const heat = db.raw.prepare('SELECT SUM(inTok) t, COUNT(*) n FROM tk_heatmap').get() as { t: number; n: number }
    expect(heat.t).toBe(3_000_000)
    // No Codex trace anywhere.
    expect((db.raw.prepare("SELECT COUNT(*) n FROM tk_sessions WHERE provider='codex'").get() as { n: number }).n).toBe(0)
    expect((db.raw.prepare("SELECT COUNT(*) n FROM tk_daily WHERE provider='codex'").get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('rewinds ONLY Codex cursors; Claude cursors keep their offsets', () => {
    seedPreUpgradeDb()
    const db = openTkDb(dbPath)
    expect(db.getFileCursor('C:/gone/claude-old.jsonl')).toMatchObject({ lastOffset: 1234, scannedTo: 1234 })
    expect(db.getFileCursor('C:/live/claude-new.jsonl')).toMatchObject({ lastOffset: 1234, scannedTo: 1234 })
    expect(db.getFileCursor('C:/codex/sessions/2026/rollout-2026-06-01T10-00-00-abc.jsonl')).toMatchObject({ lastOffset: 0, scannedTo: 0, codexTurns: 0, codexSessionId: '', codexModel: '', codexCwd: '' })
    db.close()
  })

  it('runs exactly once: a second open changes nothing', () => {
    seedPreUpgradeDb()
    openTkDb(dbPath).close()
    const db = openTkDb(dbPath)
    // Re-ingesting the same Claude rows after the re-index is a dedup no-op, so
    // a live file being re-read cannot double count.
    const n = db.insertEventsWithCursor([claudeEvent(1), claudeEvent(2)], cursor('C:/gone/claude-old.jsonl'))
    expect(n).toBe(0)
    expect(db.eventCount()).toBe(3)
    db.close()
  })
})

// ── Re-attack round (beta.16 ADR-009 pass): the three minors it found here.
describe('#307 re-index -- re-attack findings', () => {
  let tmp: string
  let dbPath: string
  let opened: ReturnType<typeof openTkDbRaw>[] = []
  const openTkDb = (p: string) => { const db = openTkDbRaw(p); opened.push(db); return db }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tk307b-')); dbPath = path.join(tmp, 'tk.db'); opened = [] })
  afterEach(() => {
    for (const db of opened) { try { db.close() } catch { /* already closed */ } }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function seed() {
    const db = openTkDb(dbPath)
    db.raw.prepare('DELETE FROM tk_meta WHERE key = ?').run('codexReindex307')
    db.insertEventsWithCursor([claudeEvent(1), claudeEvent(2)], cursor('C:/gone/claude-old.jsonl'))
    db.insertEventsWithCursor([claudeEvent(3, 's-claude-2', 'cfgB')], cursor('C:/live/claude-new.jsonl'))
    db.insertEventsWithCursor([codexEvent(1), codexEvent(2)], cursor('C:/codex/sessions/2026/rollout-2026-06-01T10-00-00-abc.jsonl', { codexSessionId: 'x-codex', codexTurns: 2 }))
    db.setMeta('firstIndexComplete', '1')
    return db
  }

  it('clears firstIndexComplete: the index is not complete with every Codex row gone and its files queued', () => {
    seed().close()
    const db = openTkDb(dbPath)
    expect(db.getMeta('codexReindex307')).toBe('done')
    expect(db.getMeta('firstIndexComplete')).toBeNull()
    db.close()
  })

  it('rebuilds tk_daily from the STORED day, not from ts in the re-index-time zone', () => {
    const db0 = seed()
    // Simulate an ingest-time zone that put this event on the next day.
    db0.raw.prepare("UPDATE tk_events SET day = '2026-06-02' WHERE sessionId = 's-claude-2'").run()
    db0.close()
    const db = openTkDb(dbPath)
    const daily = db.raw.prepare('SELECT day, configId FROM tk_daily ORDER BY configId').all() as { day: string; configId: string }[]
    expect(daily).toEqual([{ day: '2026-06-01', configId: 'cfgA' }, { day: '2026-06-02', configId: 'cfgB' }])
    db.close()
  })

  it('a failure mid-replay rolls back, leaves the marker unset, and does NOT leak the handle', () => {
    seed().close()
    // Arm a trigger that aborts the first rollup insert of the replay.
    const arm = new Database(dbPath)
    arm.exec("CREATE TRIGGER boom BEFORE INSERT ON tk_daily BEGIN SELECT RAISE(ABORT, 'boom'); END;")
    arm.close()

    expect(() => openTkDbRaw(dbPath)).toThrow(/boom/)

    // Handle closed: the file can be renamed (Windows refuses while it is open).
    const moved = dbPath + '.moved'
    expect(() => fs.renameSync(dbPath, moved)).not.toThrow()
    fs.renameSync(moved, dbPath)

    // Rolled back: every row still there, marker still unset.
    const check = new Database(dbPath)
    expect((check.prepare('SELECT COUNT(*) n FROM tk_events').get() as { n: number }).n).toBe(5)
    expect(check.prepare("SELECT value FROM tk_meta WHERE key='codexReindex307'").get()).toBeUndefined()
    check.exec('DROP TRIGGER boom')
    check.close()

    // Disarmed, the next open completes the re-index.
    const db = openTkDb(dbPath)
    expect(db.getMeta('codexReindex307')).toBe('done')
    expect(db.eventCount()).toBe(3)
    db.close()
  })
})
