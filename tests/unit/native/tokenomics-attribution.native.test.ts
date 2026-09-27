/**
 * Usage track MP10 (owner decision Q1.4): Claude usage attributed to the
 * account its session launched under, from now on. The index records a
 * session id's account once (the first wins) and re-attributes what it already
 * holds of that session in one transaction; rows ingested after it are stored
 * with it. Both orders are covered, in the database and end to end in the
 * worker, and the moved rollups are shown to equal a rebuild from the events.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'
import { createTokenomicsWorker } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { FromTkWorker, ToTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, 'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, 'gpt-5.5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }
const U1 = '0b6f3c2e-9d41-4f8a-a1c2-3e4d5f607182'
const U2 = '7d2a9e10-4b3c-4d5e-8f60-718293a4b5c6'
const OLD = '11111111-2222-4333-8444-555555555555'
const K = 'claude:acct-' + 'a'.repeat(32)
const K2 = 'claude:acct-' + 'b'.repeat(32)
const T1 = Date.parse('2026-06-01T10:00:00Z')
const DAY = 86_400_000
const MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6']

/** A Claude event: two days, two models, a config and none, varied tokens. */
const cev = (i: number, sessionId: string, over: Record<string, unknown> = {}): any => ({
  dedupKey: `c:${sessionId}:m${i}:r${i}`, sessionId, provider: 'claude',
  model: MODELS[i % 2], priceModel: MODELS[i % 2], ts: T1 + (i % 3) * DAY + i * 60_000, cwd: 'F:\\proj',
  inTok: 1000 * (i + 1), outTok: 10 * (i + 1), cacheReadTok: 100 * i, cacheCreateTok: 7 * i, configId: i % 2 ? 'a' : null, ...over,
})
const xev = (i: number): any => ({ dedupKey: `x:cx-1:${i}`, sessionId: 'cx-1', provider: 'codex', model: 'gpt-5.5', priceModel: 'gpt-5.5', ts: T1 + i * 60_000, cwd: 'F:\\proj', inTok: 5000, outTok: 50, cacheReadTok: 0, cacheCreateTok: 0, configId: 'a', accountKey: 'codex:acct-c' })

type Db = ReturnType<typeof openTkDb>
const rollups = (db: Db) => ({
  daily: db.raw.prepare('SELECT day, model, priceModel, provider, configId, accountKey, inTok, outTok, cacheReadTok, cacheCreateTok, msgCount FROM tk_daily2 ORDER BY day, model, provider, configId, accountKey').all(),
  heat: db.raw.prepare('SELECT bucket, model, priceModel, provider, configId, accountKey, inTok, outTok, cacheReadTok, cacheCreateTok FROM tk_heatmap2 ORDER BY bucket, model, provider, configId, accountKey').all(),
})
const totals = (db: Db) => ({
  daily: db.raw.prepare('SELECT SUM(inTok) AS i, SUM(outTok) AS o, SUM(cacheReadTok) AS r, SUM(cacheCreateTok) AS c, SUM(msgCount) AS n FROM tk_daily2').get(),
  heat: db.raw.prepare('SELECT SUM(inTok) AS i, SUM(outTok) AS o, SUM(cacheReadTok) AS r, SUM(cacheCreateTok) AS c FROM tk_heatmap2').get(),
})
const rebuild = (db: Db) => { db.beginRollupRebuild(); for (let i = 0; i < 1000 && !db.stepRollupRebuild(3).finished; i++) { /* step */ } }
const accountsOf = (db: Db, sessionId: string) => (db.raw.prepare('SELECT DISTINCT accountKey FROM tk_events WHERE sessionId = ?').all(sessionId) as Array<{ accountKey: string }>).map((r) => r.accountKey)
const cost = (db: Db, filter: Record<string, unknown> = {}) => db.querySummary(PRICING, filter as any, T1 + 10 * DAY).kpis.lifeToDateCostUsd

describe('recording a Claude session\'s account in the index (MP10)', () => {
  let tmp: string
  let opened: Db[] = []
  const open = (p: string) => { const db = openTkDb(p); opened.push(db); return db }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkattr-')); opened = [] })
  afterEach(() => { for (const db of opened) { try { db.close() } catch { /* closed */ } } fs.rmSync(tmp, { recursive: true, force: true }) })

  it('is recorded once: the first attribution of a session id wins', () => {
    const db = open(':memory:')
    expect(db.setSessionAccount(U1, K, 5)).toEqual({ recorded: true, stamped: 0 })
    expect(db.setSessionAccount(U1, K2, 6)).toEqual({ recorded: false, stamped: 0 })
    expect(db.raw.prepare('SELECT sessionId, accountKey, setAt FROM tk_session_accounts').all()).toEqual([{ sessionId: U1, accountKey: K, setAt: 5 }])
  })

  it('refuses what is not a Claude account key or names no session', () => {
    const db = open(':memory:')
    for (const [s, k] of [['', K], [U1, ''], [U1, 'codex:acct-c'], [U1, 'codex:external'], [U1, 'claude:'], [U1, 'claude:bad key']]) {
      expect(db.setSessionAccount(s, k, 1)).toEqual({ recorded: false, stamped: 0 })
    }
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM tk_session_accounts').get()).toEqual({ n: 0 })
  })

  it('after ingest: re-attributes the stored rows and moves the rollups exactly, the same as a rebuild; nothing else moves', () => {
    const db = open(':memory:')
    db.insertEvents([...[0, 1, 2, 3, 4, 5].map((i) => cev(i, U1)), ...[0, 1, 2].map((i) => cev(i, U2)), xev(0), xev(1)])
    const before = totals(db)
    const all = cost(db)
    const u1Cost = db.querySessionDetail(PRICING, U1)!.costUsd
    const u2Cost = db.querySessionDetail(PRICING, U2)!.costUsd
    expect(db.setSessionAccount(U1, K, 9)).toEqual({ recorded: true, stamped: 6 })
    expect(accountsOf(db, U1)).toEqual([K])
    expect(accountsOf(db, U2)).toEqual([''])
    expect(accountsOf(db, 'cx-1')).toEqual(['codex:acct-c'])
    expect(db.querySessions(PRICING, {}).rows.map((r) => [r.sessionId, r.accountKey]).sort()).toEqual([[U1, K], [U2, ''], ['cx-1', 'codex:acct-c']].sort())
    // Totals never move; the split does.
    expect(totals(db)).toEqual(before)
    expect(cost(db)).toBeCloseTo(all, 9)
    expect(cost(db, { accountKey: K })).toBeCloseTo(u1Cost, 9)
    expect(cost(db, { provider: 'claude', accountKey: '' })).toBeCloseTo(u2Cost, 9)
    expect(db.queryAccounts()).toEqual([{ provider: 'claude', accountKey: '' }, { provider: 'claude', accountKey: K }, { provider: 'codex', accountKey: 'codex:acct-c' }])
    expect(db.rollupsDirty()).toBe(false)
    // Exactly what a rebuild from the events makes.
    const moved = rollups(db)
    rebuild(db)
    expect(rollups(db)).toEqual(moved)
  })

  it('a session that was all of its day\'s not-recorded usage leaves no empty not-recorded rows', () => {
    const db = open(':memory:')
    db.insertEvents([0, 1, 2, 3].map((i) => cev(i, U1)))
    db.setSessionAccount(U1, K, 1)
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM tk_daily2 WHERE accountKey = ''").get()).toEqual({ n: 0 })
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM tk_heatmap2 WHERE accountKey = ''").get()).toEqual({ n: 0 })
    expect(db.queryAccounts()).toEqual([{ provider: 'claude', accountKey: K }])
  })

  it('only the session\'s Claude rows move: a Codex row that happens to carry the same id stays as it was', () => {
    const db = open(':memory:')
    const odd = { ...xev(7), dedupKey: `x:${U1}:7`, sessionId: U1, accountKey: undefined }
    db.insertEvents([...[0, 1, 2].map((i) => cev(i, U1)), odd])
    expect(db.setSessionAccount(U1, K, 1)).toEqual({ recorded: true, stamped: 3 })
    expect(db.raw.prepare('SELECT provider, accountKey FROM tk_events WHERE sessionId = ? GROUP BY provider, accountKey ORDER BY provider').all(U1)).toEqual([{ provider: 'claude', accountKey: K }, { provider: 'codex', accountKey: '' }])
    const moved = rollups(db)
    rebuild(db)
    expect(rollups(db)).toEqual(moved)
    expect(db.queryAccounts()).toEqual([{ provider: 'claude', accountKey: K }, { provider: 'codex', accountKey: '' }])
    // One ingested after the attribution does not take it either.
    db.insertEvents([{ ...xev(8), dedupKey: `x:${U1}:8`, sessionId: U1, accountKey: undefined }])
    expect(db.raw.prepare('SELECT accountKey FROM tk_events WHERE dedupKey = ?').get(`x:${U1}:8`)).toEqual({ accountKey: '' })
  })

  it('a stored attribution that is not a Claude account key stamps nothing', () => {
    const db = open(':memory:')
    db.raw.prepare('INSERT INTO tk_session_accounts(sessionId, accountKey, setAt) VALUES (?, ?, 1), (?, ?, 1)').run(U1, 'codex:acct-c', U2, 'claude:bad key')
    db.insertEvents([cev(0, U1), cev(0, U2)])
    expect(accountsOf(db, U1)).toEqual([''])
    expect(accountsOf(db, U2)).toEqual([''])
  })

  it('before ingest: the session\'s rows are stored with its account, and the rollups under it, with no rebuild', () => {
    const db = open(':memory:')
    db.setSessionAccount(U1, K, 1)
    db.insertEvents([...[0, 1, 2].map((i) => cev(i, U1)), cev(0, U2)])
    expect(accountsOf(db, U1)).toEqual([K])
    expect(accountsOf(db, U2)).toEqual([''])
    expect(db.querySessions(PRICING, { accountKey: K }).rows.map((r) => r.sessionId)).toEqual([U1])
    expect(db.rollupsDirty()).toBe(false)
    const live = rollups(db)
    rebuild(db)
    expect(rollups(db)).toEqual(live)
    // The rest of the session later, in another sweep: the same.
    db.insertEvents([3, 4].map((i) => cev(i, U1)))
    expect(accountsOf(db, U1)).toEqual([K])
  })

  it('a session\'s account never re-stamps a row stored under another session (a resumed transcript repeats earlier turns)', () => {
    const db = open(':memory:')
    db.insertEvents([cev(0, OLD, { dedupKey: 'c:m-shared:r-shared' })])
    db.setSessionAccount(U1, K, 1)
    expect(db.insertEvents([cev(0, U1, { dedupKey: 'c:m-shared:r-shared' })])).toBe(0)
    expect(accountsOf(db, OLD)).toEqual([''])
    expect(db.rollupsDirty()).toBe(false)
  })

  it('while the rollups are dirty the rows are stamped and the rollups left for the rebuild', () => {
    const db = open(':memory:')
    db.insertEvents([0, 1, 2].map((i) => cev(i, U1)))
    db.setMeta('rollupsDirty', '1')
    const stale = rollups(db)
    expect(db.setSessionAccount(U1, K, 1)).toEqual({ recorded: true, stamped: 3 })
    expect(accountsOf(db, U1)).toEqual([K])
    expect(rollups(db)).toEqual(stale)
    expect(db.rollupsDirty()).toBe(true)
    rebuild(db)
    expect(db.rollupsDirty()).toBe(false)
    expect(db.queryAccounts()).toEqual([{ provider: 'claude', accountKey: K }])
  })

  it('during a rebuild: the rebuild that ends leaves the rollups dirty, and the next one settles the split', () => {
    const db = open(':memory:')
    db.insertEvents([0, 1, 2, 3, 4, 5].map((i) => cev(i, U1)))
    db.beginRollupRebuild()
    expect(db.stepRollupRebuild(2).finished).toBe(false)
    db.setSessionAccount(U1, K, 1)
    for (let i = 0; i < 100 && !db.stepRollupRebuild(2).finished; i++) { /* step */ }
    expect(db.rollupsDirty()).toBe(true)
    rebuild(db)
    expect(db.rollupsDirty()).toBe(false)
    expect(db.queryAccounts()).toEqual([{ provider: 'claude', accountKey: K }])
  })

  for (const [table, corrupt] of [
    ['daily', "UPDATE tk_daily2 SET msgCount = 0 WHERE accountKey = '' AND day = (SELECT MIN(day) FROM tk_daily2)"],
    ['hourly', "UPDATE tk_heatmap2 SET inTok = 0 WHERE accountKey = ''"],
  ] as const) {
    it(`a ${table} group the not-recorded row cannot cover is left alone and the rollups dirty; totals never move`, () => {
      const db = open(':memory:')
      db.insertEvents([0, 1, 2, 3].map((i) => cev(i, U1)))
      db.raw.prepare(corrupt).run()
      const before = totals(db)
      db.setSessionAccount(U1, K, 1)
      expect(db.rollupsDirty()).toBe(true)
      expect(totals(db)).toEqual(before)
      rebuild(db)
      expect(db.queryAccounts()).toEqual([{ provider: 'claude', accountKey: K }])
    })
  }

  it('is kept across a reopen: a later line of the session is stored with its account', () => {
    const p = path.join(tmp, 'tk.db')
    const db = open(p)
    db.insertEvents([cev(0, U1)])
    db.setSessionAccount(U1, K, 1)
    db.close()
    const again = open(p)
    again.insertEvents([cev(1, U1)])
    expect(accountsOf(again, U1)).toEqual([K])
    expect(again.setSessionAccount(U1, K2, 2).recorded).toBe(false)
  })
})

function writeClaude(dir: string, id: string, lines: number, from = 0): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  const out: string[] = []
  for (let i = from; i < from + lines; i++) {
    out.push(JSON.stringify({ type: 'assistant', timestamp: new Date(T1 + i * 60_000).toISOString(), sessionId: id, requestId: `r${i}`, message: { id: `m-${id}-${i}`, model: 'claude-opus-4-8', usage: { input_tokens: 1000 * (i + 1), output_tokens: 10 } } }))
  }
  fs.appendFileSync(file, out.join('\n') + '\n')
  return file
}

describe('the worker attributes a Claude session in either order (MP10)', () => {
  let tmp: string
  let workers: Array<{ stop: () => void }> = []
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkattrw-')); workers = [] })
  afterEach(() => {
    for (const w of workers) { try { w.stop() } catch { /* stopped */ } }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function start() {
    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    const w = createTokenomicsWorker(fake.asWorkerSide(), {})
    workers.push(w)
    const claude = path.join(tmp, 'claude')
    fake.post({ type: 'open', dbPath: path.join(tmp, 'tk.db'), pricing: PRICING, configs: [], claudeProjectsDir: claude, codexSessionsDir: path.join(tmp, 'codex') })
    let qid = 1000
    const ask = async (kind: string, args: Record<string, unknown> = {}): Promise<any> => {
      const id = ++qid
      fake.post({ type: 'query', id, kind, args })
      for (let i = 0; i < 400; i++) {
        const r = msgs.find((m) => m.type === 'query-result' && (m as { id: number }).id === id) as { rows: unknown[] } | undefined
        if (r) return r.rows[0]
        await new Promise((res) => setTimeout(res, 5))
      }
      throw new Error(`no answer to ${kind}`)
    }
    /** Sweep until the sessions query shows what the case waits for. */
    const until = async (what: string, ok: (rows: Array<{ sessionId: string; accountKey: string }>) => boolean): Promise<Array<{ sessionId: string; accountKey: string }>> => {
      for (let round = 0; round < 120; round++) {
        const page = await ask('sessions', {})
        if (ok(page.rows)) return page.rows
        fake.post({ type: 'reindex' })
        await new Promise((res) => setTimeout(res, 25))
      }
      throw new Error(`never: ${what}`)
    }
    const send = (m: ToTkWorker) => fake.post(m)
    return { claude, msgs, ask, until, send }
  }
  const row = (rows: Array<{ sessionId: string; accountKey: string }>, id: string) => rows.find((r) => r.sessionId === id)

  it('attributed after its rows are ingested: they move to its account, the other session stays not recorded', async () => {
    const t = start()
    writeClaude(path.join(t.claude, 'F--proj'), U1, 3)
    writeClaude(path.join(t.claude, 'F--proj'), U2, 2)
    await t.until('both sessions ingested', (rows) => !!row(rows, U1) && !!row(rows, U2))
    const all = (await t.ask('summary', {})).kpis.lifeToDateCostUsd
    t.send({ type: 'set-session-account', sessionId: U1, accountKey: K })
    const rows = await t.until('the session attributed', (r) => row(r, U1)?.accountKey === K)
    expect(row(rows, U2)?.accountKey).toBe('')
    expect((await t.ask('summary', {})).kpis.lifeToDateCostUsd).toBeCloseTo(all, 9)
    const mine = (await t.ask('summary', { accountKey: K })).kpis.lifeToDateCostUsd
    const rest = (await t.ask('summary', { accountKey: '' })).kpis.lifeToDateCostUsd
    expect(mine).toBeGreaterThan(0)
    expect(mine + rest).toBeCloseTo(all, 9)
    expect(await t.ask('accounts')).toEqual([{ provider: 'claude', accountKey: '' }, { provider: 'claude', accountKey: K }])
  })

  it('attributed before its transcript exists: its rows are stored with its account as they are ingested', async () => {
    const t = start()
    await t.until('the first sweep', () => t.msgs.some((m) => m.type === 'index-complete'))
    t.send({ type: 'set-session-account', sessionId: U1, accountKey: K })
    writeClaude(path.join(t.claude, 'F--proj'), U1, 2)
    await t.until('the session ingested with its account', (r) => row(r, U1)?.accountKey === K)
    // A later line of it, in a later sweep: the same account.
    writeClaude(path.join(t.claude, 'F--proj'), U1, 1, 2)
    await t.until('the later line', (r) => (row(r, U1) as { msgCount?: number } | undefined)?.msgCount === 3)
    expect(await t.ask('accounts')).toEqual([{ provider: 'claude', accountKey: K }])
  })

  it('ignores an attribution that is not well formed, and keeps the first one', async () => {
    const t = start()
    writeClaude(path.join(t.claude, 'F--proj'), U1, 1)
    await t.until('ingested', (r) => !!row(r, U1))
    for (const bad of [
      { type: 'set-session-account', sessionId: 'not-a-uuid', accountKey: K },
      { type: 'set-session-account', sessionId: U1, accountKey: 'codex:acct-c' },
      { type: 'set-session-account', sessionId: U1, accountKey: '' },
      { type: 'set-session-account', sessionId: U1 },
      { type: 'set-session-account', accountKey: K },
    ] as unknown as ToTkWorker[]) t.send(bad)
    const warned = t.msgs.filter((m) => m.type === 'log' && m.entry.level === 'warn' && /session attribution/.test(m.entry.message))
    expect(warned).toHaveLength(5)
    expect(row((await t.ask('sessions', {})).rows, U1)?.accountKey).toBe('')
    t.send({ type: 'set-session-account', sessionId: U1, accountKey: K })
    t.send({ type: 'set-session-account', sessionId: U1, accountKey: K2 })
    await t.until('the first attribution', (r) => row(r, U1)?.accountKey === K)
    expect(t.msgs.some((m) => m.type === 'error')).toBe(false)
  })
})
