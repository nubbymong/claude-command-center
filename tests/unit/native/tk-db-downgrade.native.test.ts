/**
 * Usage track MP9 round 1 (Q-1, Q-5): a database this build wrote still opens
 * and works in the build released before MP9 (a downgrade), because the v2
 * rollups live in their own tables and the v1 ones are kept and written as
 * that build knows them. The released module is the frozen fixture
 * tests/fixtures/tokenomics/tk-db-v1.ts, its code verbatim. Going back up,
 * what the released build stored is caught by the watermark and rebuilt in.
 * A database an earlier build of this work upgraded in place converts, and
 * shadow tables a quit left mid-rebuild are replaced by the next rebuild.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'
import { openTkDb as openReleasedTkDb } from '../../fixtures/tokenomics/tk-db-v1'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, 'gpt-5.5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }
const T1 = Date.parse('2026-06-01T10:00:00Z')
const NOW = T1 + 5 * 86_400_000
const U1 = '0b6f3c2e-9d41-4f8a-a1c2-3e4d5f607182'
const K = 'claude:acct-' + 'a'.repeat(32)
const cev = (i: number, sessionId = U1): any => ({ dedupKey: `c:m${i}:r${i}`, sessionId, provider: 'claude', model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8', ts: T1 + i * 3_600_000, cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: 'a' })
const xev = (i: number, accountKey?: string): any => ({ dedupKey: `x:cx-1:${i}`, sessionId: 'cx-1', provider: 'codex', model: 'gpt-5.5', priceModel: 'gpt-5.5', ts: T1 + i * 60_000, cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: 'a', ...(accountKey ? { accountKey } : {}) })
const tables = (raw: Database.Database) => (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name)
const pk = (raw: Database.Database, t: string) => (raw.pragma(`table_info(${t})`) as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
const rebuild = (db: ReturnType<typeof openTkDb>) => { db.beginRollupRebuild(); for (let i = 0; i < 1000 && !db.stepRollupRebuild(2).finished; i++) { /* step */ } }

describe('a downgrade and back (usage track MP9 round 1, Q-1)', () => {
  let tmp: string
  let closers: Array<() => void> = []
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkdown-')); closers = [] })
  afterEach(() => { for (const c of closers) { try { c() } catch { /* closed */ } } fs.rmSync(tmp, { recursive: true, force: true }) })
  const open = (p: string) => { const db = openTkDb(p); closers.push(() => db.close()); return db }
  const openReleased = (p: string) => { const db = openReleasedTkDb(p); closers.push(() => db.close()); return db }

  it('the released build opens a database this build wrote, sees every total, and keeps storing', () => {
    const p = path.join(tmp, 'tk.db')
    const mine = open(p)
    mine.setSessionAccount(U1, K, 1)
    mine.insertEvents([cev(0), cev(1), xev(0, 'codex:acct-c'), xev(1, 'codex:acct-c')])
    const total = mine.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd
    expect(total).toBeCloseTo(12, 6)
    mine.close()

    const released = openReleased(p)
    expect(released.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd).toBeCloseTo(total, 6)
    // Its hourly rollup is whole too.
    expect(released.querySummary(PRICING, {}, NOW).heatmap.reduce((s, h) => s + h.tokens, 0)).toBe(4_000_000)
    expect(released.querySessions(PRICING, {}).rows.map((r) => r.sessionId).sort()).toEqual([U1, 'cx-1'].sort())
    // It stores as it always did, in its own tables.
    expect(released.insertEvents([cev(2), xev(2)])).toBe(2)
    expect(released.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd).toBeCloseTo(total + 6, 6)
    released.close()
  })

  it('back on this build, what the released build stored is caught: attributed Claude rows take their account and the rollups are rebuilt', () => {
    const p = path.join(tmp, 'tk.db')
    const mine = open(p)
    mine.setSessionAccount(U1, K, 1)
    mine.insertEvents([cev(0), xev(0, 'codex:acct-c')])
    expect(mine.rollupsDirty()).toBe(false)
    mine.close()
    const released = openReleased(p)
    released.insertEvents([cev(1), cev(2, 'ffffffff-2222-4333-8444-555555555555'), xev(1)])
    const releasedTotal = released.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd
    released.close()

    const again = open(p)
    expect(again.rollupsDirty()).toBe(true)
    const byKey = (sid: string) => (again.raw.prepare('SELECT DISTINCT accountKey FROM tk_events WHERE sessionId = ?').all(sid) as Array<{ accountKey: string }>).map((r) => r.accountKey)
    expect(byKey(U1)).toEqual([K])
    expect(byKey('ffffffff-2222-4333-8444-555555555555')).toEqual([''])
    rebuild(again)
    expect(again.rollupsDirty()).toBe(false)
    expect(again.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd).toBeCloseTo(releasedTotal, 6)
    expect(again.querySummary(PRICING, { accountKey: K }, NOW).kpis.lifeToDateCostUsd).toBeCloseTo(10, 6)
    // The Codex turn the released build stored stays not recorded.
    expect(again.querySummary(PRICING, { provider: 'codex', accountKey: '' }, NOW).kpis.lifeToDateCostUsd).toBeCloseTo(1, 6)
    // Nothing more is caught on the next open.
    again.close()
    expect(open(p).rollupsDirty()).toBe(false)
  })

  it('a database an earlier build of this work upgraded in place converts: its tables move, the v1 ones are derived back, and the released build opens it', () => {
    const p = path.join(tmp, 'inplace.db')
    const raw = new Database(p)
    raw.exec(`
      CREATE TABLE tk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO tk_meta VALUES ('schemaVersion', '2'), ('codexReindex307', 'done');
      CREATE TABLE tk_events (dedupKey TEXT PRIMARY KEY, sessionId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, priceModel TEXT NOT NULL,
        ts INTEGER NOT NULL, day TEXT NOT NULL, configId TEXT, projectDir TEXT NOT NULL DEFAULT '', inTok INTEGER NOT NULL, outTok INTEGER NOT NULL,
        cacheReadTok INTEGER NOT NULL, cacheCreateTok INTEGER NOT NULL, accountKey TEXT NOT NULL DEFAULT '');
      CREATE TABLE tk_sessions (sessionId TEXT PRIMARY KEY, provider TEXT NOT NULL, configId TEXT, projectDir TEXT NOT NULL DEFAULT '', firstTs INTEGER NOT NULL,
        lastTs INTEGER NOT NULL, lastModel TEXT NOT NULL, inTok INTEGER NOT NULL DEFAULT 0, outTok INTEGER NOT NULL DEFAULT 0, cacheReadTok INTEGER NOT NULL DEFAULT 0,
        cacheCreateTok INTEGER NOT NULL DEFAULT 0, msgCount INTEGER NOT NULL DEFAULT 0, accountKey TEXT NOT NULL DEFAULT '');
      CREATE TABLE tk_daily (day TEXT NOT NULL, model TEXT NOT NULL, priceModel TEXT NOT NULL, provider TEXT NOT NULL, configId TEXT, accountKey TEXT NOT NULL DEFAULT '',
        inTok INTEGER NOT NULL DEFAULT 0, outTok INTEGER NOT NULL DEFAULT 0, cacheReadTok INTEGER NOT NULL DEFAULT 0, cacheCreateTok INTEGER NOT NULL DEFAULT 0,
        msgCount INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, model, provider, configId, accountKey));
      CREATE TABLE tk_heatmap (bucket INTEGER NOT NULL, model TEXT NOT NULL, priceModel TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', configId TEXT,
        accountKey TEXT NOT NULL DEFAULT '', inTok INTEGER NOT NULL DEFAULT 0, outTok INTEGER NOT NULL DEFAULT 0, cacheReadTok INTEGER NOT NULL DEFAULT 0,
        cacheCreateTok INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bucket, model, provider, configId, accountKey));
      CREATE TABLE tk_daily_next (x INTEGER);
      CREATE TABLE tk_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, lastOffset INTEGER NOT NULL DEFAULT 0,
        lastIngestedAt INTEGER NOT NULL DEFAULT 0, scannedTo INTEGER NOT NULL DEFAULT 0, codexSessionId TEXT NOT NULL DEFAULT '',
        codexModel TEXT NOT NULL DEFAULT '', codexCwd TEXT NOT NULL DEFAULT '', codexTurns INTEGER NOT NULL DEFAULT 0,
        accountKey TEXT NOT NULL DEFAULT '', accountReread INTEGER NOT NULL DEFAULT 0);
      INSERT INTO tk_files VALUES ('C:/r/a/sessions/rollout-2026-06-01T10-00-00-a.jsonl',200,1,200,1,200,'cx-1','gpt-5.5','',1,'codex:acct-a',0);
      INSERT INTO tk_events VALUES ('x:cx-1:0','cx-1','codex','gpt-5.5','gpt-5.5',${T1},'2026-06-01','a','',1000000,0,0,0,'codex:acct-a'),
        ('x:cx-2:0','cx-2','codex','gpt-5.5','gpt-5.5',${T1},'2026-06-01','a','',1000000,0,0,0,'codex:acct-b');
      INSERT INTO tk_daily VALUES ('2026-06-01','gpt-5.5','gpt-5.5','codex','a','codex:acct-a',1000000,0,0,0,1), ('2026-06-01','gpt-5.5','gpt-5.5','codex','a','codex:acct-b',1000000,0,0,0,1);
      INSERT INTO tk_heatmap VALUES (10,'gpt-5.5','gpt-5.5','codex','a','codex:acct-a',1000000,0,0,0), (10,'gpt-5.5','gpt-5.5','codex','a','codex:acct-b',1000000,0,0,0);`)
    raw.close()
    const db = open(p)
    expect(pk(db.raw, 'tk_daily2')).toEqual(['day', 'model', 'provider', 'configId', 'accountKey'])
    expect(pk(db.raw, 'tk_daily')).toEqual(['day', 'model', 'provider', 'configId'])
    expect(pk(db.raw, 'tk_heatmap')).toEqual(['bucket', 'model', 'configId'])
    expect(db.raw.prepare('SELECT day, model, provider, configId, inTok, msgCount FROM tk_daily').all()).toEqual([{ day: '2026-06-01', model: 'gpt-5.5', provider: 'codex', configId: 'a', inTok: 2_000_000, msgCount: 2 }])
    expect(db.raw.prepare('SELECT bucket, model, configId, inTok FROM tk_heatmap').all()).toEqual([{ bucket: 10, model: 'gpt-5.5', configId: 'a', inTok: 2_000_000 }])
    expect(tables(db.raw)).not.toContain('tk_daily_next')
    expect(db.queryAccounts()).toEqual([{ provider: 'codex', accountKey: 'codex:acct-a' }, { provider: 'codex', accountKey: 'codex:acct-b' }])
    expect(db.rollupsDirty()).toBe(false)
    // Its Codex history is already attributed: nothing is re-read.
    expect(db.accountRereadPending()).toBe(false)
    expect(db.getFileCursor('C:/r/a/sessions/rollout-2026-06-01T10-00-00-a.jsonl')).toMatchObject({ lastOffset: 200, codexTurns: 1 })
    db.close()
    const released = openReleased(p)
    expect(released.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd).toBeCloseTo(2, 6)
    expect(released.insertEvents([xev(3)])).toBe(1)
  })

  it('this build\'s own rows never look like the released build\'s', () => {
    const p = path.join(tmp, 'tk.db')
    const mine = open(p)
    mine.insertEvents([cev(0), xev(0)])
    mine.close()
    const again = open(p)
    again.insertEvents([cev(1)])
    again.close()
    expect(open(p).rollupsDirty()).toBe(false)
  })

  it('a database with no watermark yet takes the one it has, with no rebuild', () => {
    const p = path.join(tmp, 'tk.db')
    const mine = open(p)
    mine.insertEvents([cev(0)])
    mine.raw.prepare("DELETE FROM tk_meta WHERE key = 'rollupRowid'").run()
    mine.close()
    const again = open(p)
    expect(again.rollupsDirty()).toBe(false)
    expect(again.getMeta('rollupRowid')).toBe('1')
  })
})

describe('shadow tables a quit left mid-rebuild (usage track MP9 round 1, Q-5)', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkshadow-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('reopen: the rollups are still dirty and whole; the next rebuild replaces the shadows and swaps in', () => {
    const p = path.join(tmp, 'tk.db')
    const db = openTkDb(p)
    db.insertEvents([cev(0), cev(1), cev(2), xev(0), xev(1)])
    const total = db.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd
    db.setMeta('rollupsDirty', '1')
    db.beginRollupRebuild()
    expect(db.stepRollupRebuild(2).finished).toBe(false)
    db.close()
    const again = openTkDb(p)
    try {
      expect(tables(again.raw)).toEqual(expect.arrayContaining(['tk_daily2_next', 'tk_heatmap2_next']))
      expect(again.rollupsDirty()).toBe(true)
      expect(again.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd).toBeCloseTo(total, 6)
      rebuild(again)
      expect(again.rollupsDirty()).toBe(false)
      expect(tables(again.raw).filter((t) => t.endsWith('_next'))).toEqual([])
      expect(again.querySummary(PRICING, {}, NOW).kpis.lifeToDateCostUsd).toBeCloseTo(total, 6)
      expect((again.raw.prepare('SELECT SUM(msgCount) AS n FROM tk_daily2').get() as { n: number }).n).toBe(5)
    } finally {
      again.close()
    }
  })
})
