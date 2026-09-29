/**
 * P3.8 round 1 (M1, Q2): Tokenomics prices a Codex turn by its model's own id,
 * as the session strip does. A row stored before this build was keyed to the
 * longest price key its model started with (gpt-5.3-codex-spark took
 * gpt-5.3-codex's price, and any gpt-5.* took gpt-5's once the live list held
 * it); every open keys it to its own model (round 2, RK: not once behind a
 * marker, so a row an older build stores later is keyed at the next open), so
 * an unpriced model reads "no price" again, and a priced one keeps its price.
 * Claude rows are left as they are. The pricing CTE binds only the keys the
 * usage names, read again only after a write (round 2, UP).
 *
 * Native: better-sqlite3 is built for Electron, so this runs under
 * `npm run test:unit:native` (CI and the test VM), not in the host's vitest run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openTkDb as openTkDbRaw } from '../../../src/main/tokenomics/tk-db'
import type { TkEvent } from '../../../src/main/tokenomics/tk-types'

const T0 = Date.UTC(2026, 8, 1, 10, 0, 0)
const PRICING = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
}
const ev = (i: number, provider: 'claude' | 'codex', model: string, priceModel: string, sessionId: string): TkEvent & { configId: string } => ({
  dedupKey: `${provider}:${sessionId}:${i}`, sessionId, provider: provider as never, model, priceModel,
  ts: T0 + i * 60_000, cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: 'cfgA',
})

describe('Codex turns priced by their own id (P3.8 round 1)', () => {
  let tmp: string
  let dbPath: string
  let opened: ReturnType<typeof openTkDbRaw>[] = []
  const openTkDb = (p: string) => { const db = openTkDbRaw(p); opened.push(db); return db }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkexact-')); dbPath = path.join(tmp, 'tk.db'); opened = [] })
  afterEach(() => {
    for (const db of opened) { try { db.close() } catch { /* already closed */ } }
    // Only the folder this test made: its own prefix, directly in the temp folder.
    if (path.basename(tmp).startsWith('tkexact-') && path.dirname(tmp) === os.tmpdir()) fs.rmSync(tmp, { recursive: true, force: true })
  })

  function seedBeforeThisBuild() {
    const db = openTkDb(dbPath)
    db.insertEvents([
      ev(1, 'codex', 'gpt-5.3-codex-spark', 'gpt-5.3-codex', 'x-spark'),
      ev(2, 'codex', 'gpt-5.6-terra', 'gpt-5', 'x-terra'),
      ev(3, 'codex', 'gpt-5.3-codex', 'gpt-5.3-codex', 'x-priced'),
      ev(4, 'claude', 'claude-opus-4-8-20260101', 'claude-opus-4-8', 's-claude'),
    ])
    const before = db.querySummary(PRICING, {}, T0 + 86_400_000)
    db.close()
    return before
  }

  it('keys stored Codex rows to their own model once, so unpriced models cost nothing and priced ones keep their price', () => {
    const before = seedBeforeThisBuild()
    // Before: spark at gpt-5.3-codex's $1.75, terra at gpt-5's $1.25, the priced one $1.75, Claude $5.
    expect(before.kpis.lifeToDateCostUsd).toBeCloseTo(9.75, 6)
    const db = openTkDb(dbPath)
    const rows = db.raw.prepare('SELECT provider, model, priceModel FROM tk_events ORDER BY dedupKey').all()
    expect(rows).toEqual([
      { provider: 'claude', model: 'claude-opus-4-8-20260101', priceModel: 'claude-opus-4-8' },
      { provider: 'codex', model: 'gpt-5.3-codex', priceModel: 'gpt-5.3-codex' },
      { provider: 'codex', model: 'gpt-5.3-codex-spark', priceModel: 'gpt-5.3-codex-spark' },
      { provider: 'codex', model: 'gpt-5.6-terra', priceModel: 'gpt-5.6-terra' },
    ])
    for (const t of ['tk_daily2', 'tk_heatmap2']) {
      const bad = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE provider = 'codex' AND priceModel <> model`).get() as { n: number }
      expect(bad.n, t).toBe(0)
    }
    const sm = db.raw.prepare("SELECT COUNT(*) AS n FROM tk_session_models WHERE sessionId LIKE 'x-%' AND priceModel <> model").get() as { n: number }
    expect(sm.n).toBe(0)
    const after = db.querySummary(PRICING, {}, T0 + 86_400_000)
    expect(after.kpis.lifeToDateCostUsd).toBeCloseTo(1.75 + 5, 6)
    expect(after.unpriced.map((u: { model: string }) => u.model).sort()).toEqual(['gpt-5.3-codex-spark', 'gpt-5.6-terra'])
    db.close()
  })

  // Round 2 (RK): a build before this one, run after it (a downgrade, then
  // back), stores Codex rows its way; they are keyed exactly at the next open.
  it('rows an older build stores after this build first opened are keyed exactly at the next open', () => {
    openTkDb(dbPath).close()
    let db = openTkDb(dbPath) // stands in for an older build storing a turn its way (the prefix key)
    db.insertEvents([ev(1, 'codex', 'gpt-5.3-codex-spark', 'gpt-5.3-codex', 'x-later')])
    db.close()
    db = openTkDb(dbPath)
    expect(db.raw.prepare("SELECT model, priceModel FROM tk_events WHERE provider = 'codex'").all())
      .toEqual([{ model: 'gpt-5.3-codex-spark', priceModel: 'gpt-5.3-codex-spark' }])
    expect(db.querySummary(PRICING, {}, T0 + 86_400_000).kpis.lifeToDateCostUsd).toBeCloseTo(0, 6)
    db.close()
  })

  // Round 2 (UP): the price keys the stored usage names are read once and
  // again only after a write (a new turn, a rollup rebuild), not on every
  // query; a key a new turn names is bound at once.
  it('reads the used price keys again only after a write, and a new key is priced at once', () => {
    const db = openTkDb(dbPath)
    db.insertEvents([ev(1, 'claude', 'claude-opus-4-8-20260101', 'claude-opus-4-8', 's-1')])
    const prepare = db.raw.prepare.bind(db.raw)
    let unions = 0
    ;(db.raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/UNION SELECT priceModel/.test(sql)) unions++
      return prepare(sql)
    }
    const cost = () => db.querySummary(PRICING, {}, T0 + 86_400_000).kpis.lifeToDateCostUsd
    expect(cost()).toBeCloseTo(5, 6)
    db.querySessions(PRICING, {})
    expect(cost()).toBeCloseTo(5, 6)
    expect(unions).toBe(1)
    db.insertEvents([ev(2, 'codex', 'gpt-5.3-codex', 'gpt-5.3-codex', 'x-1')])
    expect(cost()).toBeCloseTo(5 + 1.75, 6)
    expect(unions).toBe(2)
    db.beginRollupRebuild()
    for (let i = 0; i < 10 && !db.stepRollupRebuild(1000).finished; i++) { /* page on */ }
    expect(cost()).toBeCloseTo(5 + 1.75, 6)
    expect(unions).toBe(3)
    db.close()
  })

  it('a new Codex turn is stored under its own model', () => {
    const db = openTkDb(dbPath)
    db.insertEvents([ev(1, 'codex', 'gpt-5.3-codex-spark', 'gpt-5.3-codex-spark', 'x-new')])
    const s = db.querySessions(PRICING, {})
    const row = s.rows.find((r: { sessionId: string }) => r.sessionId === 'x-new')!
    expect(row.costUsd).toBeNull()
    db.close()
  })
})
