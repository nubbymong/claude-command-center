import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'

describe('tk-db schema', () => {
  it('opens in-memory, sets schemaVersion, exposes meta get/set', () => {
    const db = openTkDb(':memory:')
    expect(db.getMeta('schemaVersion')).toBe('2')
    db.setMeta('firstIndexComplete', '1')
    expect(db.getMeta('firstIndexComplete')).toBe('1')
  })

  it('tracks file cursors (upsert + read + list)', () => {
    const db = openTkDb(':memory:')
    expect(db.getFileCursor('/a.jsonl')).toBeNull()
    db.setFileCursor({ path: '/a.jsonl', size: 100, mtime: 5, lastOffset: 80, lastIngestedAt: 1 })
    expect(db.getFileCursor('/a.jsonl')).toMatchObject({ size: 100, mtime: 5, lastOffset: 80 })
    db.setFileCursor({ path: '/a.jsonl', size: 200, mtime: 6, lastOffset: 150, lastIngestedAt: 2 })
    expect(db.getFileCursor('/a.jsonl')?.lastOffset).toBe(150)
  })

  it('counts events (0 on empty)', () => {
    const db = openTkDb(':memory:')
    expect(db.eventCount()).toBe(0)
  })
})

// Usage track MP9: schema v2, whose usage each row is.
const V1_DDL = `
CREATE TABLE tk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO tk_meta(key, value) VALUES ('schemaVersion', '1'), ('codexReindex307', 'done'), ('firstIndexComplete', '1');
CREATE TABLE tk_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, lastOffset INTEGER NOT NULL DEFAULT 0,
  lastIngestedAt INTEGER NOT NULL DEFAULT 0, scannedTo INTEGER NOT NULL DEFAULT 0, codexSessionId TEXT NOT NULL DEFAULT '',
  codexModel TEXT NOT NULL DEFAULT '', codexCwd TEXT NOT NULL DEFAULT '', codexTurns INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tk_events (dedupKey TEXT PRIMARY KEY, sessionId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  priceModel TEXT NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL, configId TEXT, projectDir TEXT NOT NULL DEFAULT '',
  inTok INTEGER NOT NULL, outTok INTEGER NOT NULL, cacheReadTok INTEGER NOT NULL, cacheCreateTok INTEGER NOT NULL);
CREATE TABLE tk_sessions (sessionId TEXT PRIMARY KEY, provider TEXT NOT NULL, configId TEXT, projectDir TEXT NOT NULL DEFAULT '',
  firstTs INTEGER NOT NULL, lastTs INTEGER NOT NULL, lastModel TEXT NOT NULL, inTok INTEGER NOT NULL DEFAULT 0, outTok INTEGER NOT NULL DEFAULT 0,
  cacheReadTok INTEGER NOT NULL DEFAULT 0, cacheCreateTok INTEGER NOT NULL DEFAULT 0, msgCount INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tk_session_models (sessionId TEXT NOT NULL, model TEXT NOT NULL, priceModel TEXT NOT NULL, inTok INTEGER NOT NULL DEFAULT 0,
  outTok INTEGER NOT NULL DEFAULT 0, cacheReadTok INTEGER NOT NULL DEFAULT 0, cacheCreateTok INTEGER NOT NULL DEFAULT 0,
  msgCount INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sessionId, model));
CREATE TABLE tk_daily (day TEXT NOT NULL, model TEXT NOT NULL, priceModel TEXT NOT NULL, provider TEXT NOT NULL, configId TEXT,
  inTok INTEGER NOT NULL DEFAULT 0, outTok INTEGER NOT NULL DEFAULT 0, cacheReadTok INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0, msgCount INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, model, provider, configId));
CREATE TABLE tk_heatmap (bucket INTEGER NOT NULL, model TEXT NOT NULL, priceModel TEXT NOT NULL, configId TEXT,
  inTok INTEGER NOT NULL DEFAULT 0, outTok INTEGER NOT NULL DEFAULT 0, cacheReadTok INTEGER NOT NULL DEFAULT 0,
  cacheCreateTok INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bucket, model, configId));
CREATE TABLE tk_configs (configId TEXT PRIMARY KEY, label TEXT NOT NULL, workingDirectory TEXT NOT NULL DEFAULT '');
`
const PRICING2 = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, 'gpt-5.5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }
const T1 = Date.parse('2026-06-01T10:00:00Z')
const cev = (i: number, sessionId = 's-claude'): any => ({ dedupKey: `c:m${i}:r${i}`, sessionId, provider: 'claude', model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8', ts: T1 + i * 60_000, cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: 'a' })
const xev = (i: number, sessionId = 'cx-1', accountKey?: string): any => ({ dedupKey: `x:${sessionId}:${i}`, sessionId, provider: 'codex', model: 'gpt-5.5', priceModel: 'gpt-5.5', ts: T1 + 3_600_000 + i * 60_000, cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: 'a', ...(accountKey !== undefined ? { accountKey } : {}) })
const cols = (db: ReturnType<typeof openTkDb>, t: string) => (db.raw.pragma(`table_info(${t})`) as Array<{ name: string; pk: number }>)
const pkOf = (db: ReturnType<typeof openTkDb>, t: string) => cols(db, t).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
const sums = (db: ReturnType<typeof openTkDb>, t: string) => db.raw.prepare(`SELECT COUNT(*) AS n, SUM(inTok) AS inTok, SUM(outTok) AS outTok FROM ${t}`).get()

describe('tk-db schema v2 (usage track MP9)', () => {
  let tmp: string
  let opened: Array<ReturnType<typeof openTkDb>> = []
  const open = (p: string) => { const db = openTkDb(p); opened.push(db); return db }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkv2-')); opened = [] })
  afterEach(() => { for (const db of opened) { try { db.close() } catch { /* closed */ } } fs.rmSync(tmp, { recursive: true, force: true }) })

  it('a fresh database is v2: accounts on events, sessions and files; the rollups keyed by account, the hourly one by provider too', () => {
    const db = open(':memory:')
    expect(db.getMeta('schemaVersion')).toBe('2')
    for (const t of ['tk_events', 'tk_sessions', 'tk_files']) expect(cols(db, t).map((c) => c.name), t).toContain('accountKey')
    expect(pkOf(db, 'tk_daily')).toEqual(['day', 'model', 'provider', 'configId', 'accountKey'])
    expect(pkOf(db, 'tk_heatmap')).toEqual(['bucket', 'model', 'provider', 'configId', 'accountKey'])
    expect(db.accountRereadPending()).toBe(false)
    expect(db.rollupsDirty()).toBe(false)
  })

  function seedV1(p: string) {
    const raw = new Database(p)
    raw.exec(V1_DDL)
    const ins = raw.prepare('INSERT INTO tk_events VALUES (@dedupKey,@sessionId,@provider,@model,@priceModel,@ts,@day,@configId,@projectDir,@inTok,@outTok,@cacheReadTok,@cacheCreateTok)')
    for (const e of [cev(1), cev(2), xev(0), xev(1)]) ins.run({ ...e, day: '2026-06-01', projectDir: 'F:\\proj' })
    raw.exec(`INSERT INTO tk_sessions VALUES ('s-claude','claude','a','F:\\proj',${T1},${T1},'claude-opus-4-8',2000000,0,0,0,2), ('cx-1','codex','a','F:\\proj',${T1},${T1},'gpt-5.5',2000000,0,0,0,2);
      INSERT INTO tk_daily VALUES ('2026-06-01','claude-opus-4-8','claude-opus-4-8','claude','a',2000000,0,0,0,2), ('2026-06-01','gpt-5.5','gpt-5.5','codex','a',2000000,0,0,0,2);
      INSERT INTO tk_heatmap VALUES (10,'claude-opus-4-8','claude-opus-4-8','a',2000000,0,0,0), (11,'gpt-5.5','gpt-5.5','a',2000000,0,0,0);
      INSERT INTO tk_files VALUES ('C:/claude/p/s.jsonl',100,1,100,1,100,'','','',0), ('C:/codex/sessions/rollout-2026-06-01T10-00-00-a.jsonl',200,1,200,1,200,'cx-1','gpt-5.5','F:\\proj',2);`)
    raw.close()
  }

  it('a v1 database migrates at open: nothing is lost, the rollups are copied, Codex rollouts are queued for the account re-read, Claude history is not', () => {
    const p = path.join(tmp, 'v1.db')
    seedV1(p)
    const db = open(p)
    expect(db.getMeta('schemaVersion')).toBe('2')
    expect(db.eventCount()).toBe(4)
    expect(sums(db, 'tk_daily')).toEqual({ n: 2, inTok: 4_000_000, outTok: 0 })
    expect(sums(db, 'tk_heatmap')).toEqual({ n: 2, inTok: 4_000_000, outTok: 0 })
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM tk_heatmap WHERE provider = '' AND accountKey = ''").get()).toEqual({ n: 2 })
    expect(pkOf(db, 'tk_daily')).toContain('accountKey')
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM tk_events WHERE accountKey = ''").get()).toEqual({ n: 4 })
    // The totals read the same as before the upgrade.
    expect(db.querySummary(PRICING2, {}, T1 + 86_400_000).kpis.lifeToDateCostUsd).toBeCloseTo(12, 5)
    // The Codex rollout is rewound and waits for its re-read; the Claude one does not.
    expect(db.getFileCursor('C:/codex/sessions/rollout-2026-06-01T10-00-00-a.jsonl')).toMatchObject({ lastOffset: 0, scannedTo: 0, codexTurns: 0, codexSessionId: '', accountReread: 1 })
    expect(db.getFileCursor('C:/claude/p/s.jsonl')).toMatchObject({ lastOffset: 100, scannedTo: 100, accountReread: 0 })
    expect(db.accountRereadPending()).toBe(true)
    expect(db.rollupsDirty()).toBe(true)
    expect(db.getMeta('firstIndexComplete')).toBe('1')
    db.close()
    // Once only: a second open changes nothing.
    const again = open(p)
    expect(again.getFileCursor('C:/claude/p/s.jsonl')?.lastOffset).toBe(100)
    again.setFileCursor({ path: 'C:/codex/sessions/rollout-2026-06-01T10-00-00-a.jsonl', size: 200, mtime: 1, lastOffset: 50, lastIngestedAt: 2, scannedTo: 50 })
    again.close()
    const third = open(p)
    expect(third.getFileCursor('C:/codex/sessions/rollout-2026-06-01T10-00-00-a.jsonl')?.lastOffset).toBe(50)
  })

  it('stamps at ingest; a row stored before its account was known is stamped by its re-read, and never re-stamped once known', () => {
    const db = open(':memory:')
    db.insertEvents([cev(1), xev(0, 'cx-1', 'codex:acct-a')])
    expect(db.querySessions(PRICING2, {}).rows.map((r) => [r.sessionId, r.accountKey]).sort()).toEqual([['cx-1', 'codex:acct-a'], ['s-claude', '']])
    expect(db.querySessions(PRICING2, { provider: 'claude' }).rows.map((r) => r.sessionId)).toEqual(['s-claude'])
    expect(db.querySessions(PRICING2, { provider: 'codex', accountKey: 'codex:acct-a' }).rows.map((r) => r.sessionId)).toEqual(['cx-1'])
    // Stored unstamped (as a v1 row), then re-read from its account's folder.
    db.insertEvents([xev(0, 'cx-2')])
    expect(db.rollupsDirty()).toBe(false)
    expect(db.insertEvents([xev(0, 'cx-2', 'codex:acct-b')])).toBe(0)
    expect(db.raw.prepare('SELECT accountKey FROM tk_events WHERE dedupKey = ?').get('x:cx-2:0')).toEqual({ accountKey: 'codex:acct-b' })
    expect(db.raw.prepare('SELECT accountKey FROM tk_sessions WHERE sessionId = ?').get('cx-2')).toEqual({ accountKey: 'codex:acct-b' })
    expect(db.rollupsDirty()).toBe(true)
    // Known: another folder's claim does not move it.
    db.insertEvents([xev(0, 'cx-2', 'codex:acct-z')])
    expect(db.raw.prepare('SELECT accountKey FROM tk_events WHERE dedupKey = ?').get('x:cx-2:0')).toEqual({ accountKey: 'codex:acct-b' })
    // A key that is not well formed is not recorded.
    db.insertEvents([xev(5, 'cx-3', 'codex:bad key')])
    expect(db.raw.prepare('SELECT accountKey FROM tk_events WHERE dedupKey = ?').get('x:cx-3:5')).toEqual({ accountKey: '' })
    // A session keeps the first account it was recorded to.
    db.insertEvents([xev(0, 'cx-4', 'codex:acct-c'), xev(1, 'cx-4', 'codex:acct-d')])
    expect(db.raw.prepare('SELECT accountKey FROM tk_sessions WHERE sessionId = ?').get('cx-4')).toEqual({ accountKey: 'codex:acct-c' })
  })

  it('the rollup rebuild runs in steps with progress into shadow tables, swaps them in at the end, and keeps totals whole', () => {
    const p = path.join(tmp, 'v1.db')
    seedV1(p)
    const db = open(p)
    const before = db.querySummary(PRICING2, {}, T1 + 86_400_000).kpis.lifeToDateCostUsd
    // The re-read stamps the Codex rows.
    db.insertEvents([xev(0, 'cx-1', 'codex:acct-a'), xev(1, 'cx-1', 'codex:acct-a')])
    db.beginRollupRebuild()
    const first = db.stepRollupRebuild(3)
    expect(first).toEqual({ done: 3, total: 4, finished: false })
    // Mid-rebuild, queries still read the live rollups, whole.
    expect(db.querySummary(PRICING2, {}, T1 + 86_400_000).kpis.lifeToDateCostUsd).toBeCloseTo(before, 5)
    const last = db.stepRollupRebuild(3)
    expect(last).toEqual({ done: 4, total: 4, finished: true })
    expect(db.rollupsDirty()).toBe(false)
    expect(db.querySummary(PRICING2, {}, T1 + 86_400_000).kpis.lifeToDateCostUsd).toBeCloseTo(before, 5)
    expect(db.querySummary(PRICING2, { accountKey: 'codex:acct-a' }, T1 + 86_400_000).kpis.lifeToDateCostUsd).toBeCloseTo(2, 5)
    expect(db.querySummary(PRICING2, { provider: 'claude' }, T1 + 86_400_000).kpis.lifeToDateCostUsd).toBeCloseTo(10, 5)
    expect(db.querySummary(PRICING2, { provider: 'codex' }, T1 + 86_400_000).heatmap.reduce((a, h) => a + h.tokens, 0)).toBe(2_000_000)
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM tk_heatmap WHERE provider = ''").get()).toEqual({ n: 0 })
    expect(db.queryAccounts()).toEqual([{ provider: 'claude', accountKey: '' }, { provider: 'codex', accountKey: 'codex:acct-a' }])
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_next'").all()).toEqual([])
  })

  it('a stamp during the rebuild leaves the rollups dirty for another one', () => {
    const db = open(':memory:')
    db.insertEvents([xev(0, 'cx-1'), xev(1, 'cx-1')])
    db.beginRollupRebuild()
    expect(db.stepRollupRebuild(1).finished).toBe(false)
    db.insertEvents([xev(0, 'cx-1', 'codex:acct-a')])
    expect(db.stepRollupRebuild(10).finished).toBe(true)
    expect(db.rollupsDirty()).toBe(true)
    db.beginRollupRebuild()
    expect(db.stepRollupRebuild(10).finished).toBe(true)
    expect(db.rollupsDirty()).toBe(false)
  })

  it('events stored during the rebuild are replayed too, and the total grows with them', () => {
    const db = open(':memory:')
    db.insertEvents([cev(1), cev(2)])
    db.beginRollupRebuild()
    expect(db.stepRollupRebuild(1)).toEqual({ done: 1, total: 2, finished: false })
    db.insertEvents([cev(3), cev(4), cev(5)])
    expect(db.stepRollupRebuild(2)).toEqual({ done: 3, total: 3, finished: false })
    expect(db.stepRollupRebuild(10)).toEqual({ done: 5, total: 5, finished: true })
    expect(sums(db, 'tk_daily')).toMatchObject({ inTok: 5_000_000 })
  })

  it('a v1 database with no Codex history still gets its hourly rollup rebuilt (its provider was never recorded)', () => {
    const p = path.join(tmp, 'v1-claude.db')
    const raw = new Database(p)
    raw.exec(V1_DDL)
    raw.exec("INSERT INTO tk_heatmap VALUES (10,'claude-opus-4-8','claude-opus-4-8','a',1000000,0,0,0)")
    raw.close()
    const db = open(p)
    expect(db.accountRereadPending()).toBe(false)
    expect(db.rollupsDirty()).toBe(true)
  })

  it('an empty v1 database needs no rebuild', () => {
    const p = path.join(tmp, 'v1-empty.db')
    const raw = new Database(p)
    raw.exec(V1_DDL)
    raw.close()
    const db = open(p)
    expect(db.getMeta('schemaVersion')).toBe('2')
    expect(db.rollupsDirty()).toBe(false)
  })

  it('a file waiting for the re-read is done once scanned to its end; the re-read finishes the rest (pruned files)', () => {
    const p = path.join(tmp, 'v1.db')
    seedV1(p)
    const raw = new Database(p)
    raw.exec("INSERT INTO tk_files VALUES ('C:/codex/sessions/rollout-2026-06-01T11-00-00-gone.jsonl',300,1,300,1,300,'cx-9','gpt-5.5','',3)")
    raw.close()
    const db = open(p)
    const F1 = 'C:/codex/sessions/rollout-2026-06-01T10-00-00-a.jsonl'
    db.setFileCursor({ path: F1, size: 200, mtime: 1, lastOffset: 120, lastIngestedAt: 2, scannedTo: 120, accountKey: 'codex:acct-a' })
    expect(db.getFileCursor(F1)).toMatchObject({ accountReread: 1, accountKey: 'codex:acct-a' })
    db.setFileCursor({ path: F1, size: 200, mtime: 1, lastOffset: 200, lastIngestedAt: 3, scannedTo: 200, accountKey: 'codex:acct-a' })
    expect(db.getFileCursor(F1)?.accountReread).toBe(2)
    expect(db.accountRereadPending()).toBe(true)
    db.finishAccountReread()
    expect(db.accountRereadPending()).toBe(false)
    expect(db.getMeta('accountReread')).toBe('done')
    expect(db.getFileCursor('C:/codex/sessions/rollout-2026-06-01T11-00-00-gone.jsonl')?.accountReread).toBe(2)
  })
})
