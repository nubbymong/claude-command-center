/**
 * Usage track MP9: the one-off attribution of stored Codex history to its
 * accounts, end to end in the worker. A database indexed before accounts were
 * recorded is upgraded: every Codex rollout still on disk is re-read and its
 * stored rows stamped with the account of the folder it lives in (the #307
 * rewind, without the delete: the same dedup keys stamp rather than insert),
 * then the daily and hourly rollups are rebuilt from the stored events in
 * steps, with progress. Totals never change; a pruned rollout's history stays,
 * not recorded; Claude history is not re-read; the re-read never wedges.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTokenomicsWorker } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { FromTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

const PRICING = { 'gpt-5.5': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }, 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }

function writeRollout(dir: string, name: string, id: string, turns: number): string {
  fs.mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T00:00:00Z', payload: { id, cwd: 'F:\\proj', model: 'gpt-5.5' } })]
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: `2026-08-01T00:00:${String(10 + i).padStart(2, '0')}Z`, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 10 }, last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 } } } }))
  }
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function writeClaude(dir: string, id: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T01:00:00Z', sessionId: id, requestId: 'r1', message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + '\n')
  return file
}

describe('the one-off Codex account attribution (usage track MP9)', () => {
  let tmp: string
  let workers: Array<{ stop: () => void }> = []
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkacct-')); workers = [] })
  afterEach(() => {
    for (const w of workers) { try { w.stop() } catch { /* stopped */ } }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function start(dbPath: string, dirs: Array<{ dir: string; accountKey: string }>, extra: { codexRealmDirsKnown?: boolean } = {}, workerFs?: typeof fs) {
    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    const w = createTokenomicsWorker(fake.asWorkerSide(), workerFs ? { fs: workerFs } : {})
    workers.push(w)
    fake.post({ type: 'open', dbPath, pricing: PRICING, configs: [], claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: path.join(tmp, 'home-codex'), codexRealmSessionsDirs: dirs, ...extra })
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
    /** Sweep until a drained sweep has settled the attribution. */
    const settle = async (): Promise<void> => {
      for (let round = 0; round < 80; round++) {
        const status = await ask('index-status')
        const drained = msgs.some((m) => m.type === 'index-complete' && (m as { drained: boolean }).drained)
        if (drained && status.accountReread === null) {
          const db = (await ask('accounts')) as unknown[]
          if (db) return
        }
        fake.post({ type: 'reindex' })
        await new Promise((res) => setTimeout(res, 25))
      }
      throw new Error('attribution did not settle')
    }
    return { fake, msgs, ask, settle, w }
  }

  it('upgrading re-reads the Codex history into its accounts, rebuilds the rollups with progress, and never changes the totals', async () => {
    const dbPath = path.join(tmp, 'tk.db')
    const realmA = path.join(tmp, 'realms', 'a', 'sessions')
    const realmB = path.join(tmp, 'realms', 'b', 'sessions')
    writeRollout(path.join(realmA, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-a.jsonl', 'cx-a', 3)
    writeRollout(path.join(realmB, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-b.jsonl', 'cx-b', 2)
    const gone = writeRollout(path.join(realmB, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-gone.jsonl', 'cx-gone', 4)
    const claudeFile = writeClaude(path.join(tmp, 'claude', 'F--proj'), 's-claude')

    // The previous build: accounts not recorded (the folders indexed as nobody's).
    const a = start(dbPath, [{ dir: realmA, accountKey: '' }, { dir: realmB, accountKey: '' }])
    await a.settle()
    const before = await a.ask('summary')
    expect(before.kpis.lifeToDateCostUsd).toBeCloseTo(3 + 2 + 4 + 5, 5)
    a.w.stop()
    await new Promise((r) => setTimeout(r, 30))
    // ...as a schema v1 database (what this build adds taken away; the v1
    // rollups it keeps writing are the v1 build's own), and the rollout
    // since pruned.
    const raw = new Database(dbPath)
    raw.exec(`DROP INDEX IF EXISTS idx_sessions_account;
      ALTER TABLE tk_events DROP COLUMN accountKey; ALTER TABLE tk_sessions DROP COLUMN accountKey;
      ALTER TABLE tk_files DROP COLUMN accountKey; ALTER TABLE tk_files DROP COLUMN accountReread;
      DROP TABLE tk_daily2; DROP TABLE tk_heatmap2; DROP TABLE tk_session_accounts;
      UPDATE tk_meta SET value = '1' WHERE key = 'schemaVersion';
      DELETE FROM tk_meta WHERE key IN ('rollupRowid', 'rollupsDirty', 'accountReread');`)
    const claudeCursorBefore = raw.prepare('SELECT lastOffset, lastIngestedAt FROM tk_files WHERE path = ?').get(claudeFile)
    raw.close()
    fs.rmSync(gone)
    // ...and a new rollout since, which the re-read does not count.
    writeRollout(path.join(realmA, '2026', '08', '02'), 'rollout-2026-08-02T00-00-00-new.jsonl', 'cx-new', 1)

    // This build, with the accounts known.
    const b = start(dbPath, [{ dir: realmA, accountKey: 'codex:acct-a' }, { dir: realmB, accountKey: 'codex:acct-b' }])
    const firstStatus = await b.ask('index-status')
    expect(firstStatus.accountReread?.stage).toBe('reread')
    expect((await b.ask('summary')).kpis.lifeToDateCostUsd).toBeCloseTo(before.kpis.lifeToDateCostUsd, 5)
    await b.settle()
    const after = await b.ask('summary')
    // Nothing lost or counted twice: only the new rollout's turn is added.
    expect(after.kpis.lifeToDateCostUsd).toBeCloseTo(before.kpis.lifeToDateCostUsd + 1, 5)
    expect((await b.ask('index-status')).eventsTotal).toBe(3 + 2 + 4 + 1 + 1)
    // The rebuild reported its progress, and finished.
    const stages = b.msgs.filter((m) => m.type === 'index-progress').map((m) => (m as { accountReread?: { stage: string } | null }).accountReread?.stage ?? null)
    expect(stages).toContain('reread')
    expect(stages).toContain('rebuild')
    expect(stages.at(-1)).toBeNull()
    // The re-read counted the two rollouts still on disk, both done; the rebuild
    // replayed every stored event.
    const progress = b.msgs.filter((m) => m.type === 'index-progress').map((m) => (m as { accountReread?: { stage: string; done: number; total: number } | null }).accountReread).filter(Boolean) as Array<{ stage: string; done: number; total: number }>
    expect(progress.filter((p) => p.stage === 'reread').at(-1)).toEqual({ stage: 'reread', done: 2, total: 2 })
    expect(progress.filter((p) => p.stage === 'rebuild').at(-1)).toEqual({ stage: 'rebuild', done: 11, total: 11 })
    // Each account's history is its own; the pruned rollout's stays, not recorded.
    expect(await b.ask('accounts')).toEqual([
      { provider: 'claude', accountKey: '' },
      { provider: 'codex', accountKey: '' },
      { provider: 'codex', accountKey: 'codex:acct-a' },
      { provider: 'codex', accountKey: 'codex:acct-b' },
    ])
    expect((await b.ask('summary', { accountKey: 'codex:acct-a' })).kpis.lifeToDateCostUsd).toBeCloseTo(3 + 1, 5)
    expect((await b.ask('summary', { accountKey: 'codex:acct-b' })).kpis.lifeToDateCostUsd).toBeCloseTo(2, 5)
    expect((await b.ask('summary', { provider: 'codex', accountKey: '' })).kpis.lifeToDateCostUsd).toBeCloseTo(4, 5)
    // The hourly rollup now knows its provider.
    const heat = (await b.ask('summary', { provider: 'codex' })).heatmap.reduce((s: number, h: { tokens: number }) => s + h.tokens, 0)
    expect(heat).toBe((3 + 2 + 4 + 1) * 1_000_000)
    const sessions = (await b.ask('sessions')).rows as Array<{ sessionId: string; accountKey: string }>
    expect(Object.fromEntries(sessions.map((r) => [r.sessionId, r.accountKey]))).toEqual({ 'cx-a': 'codex:acct-a', 'cx-b': 'codex:acct-b', 'cx-gone': '', 'cx-new': 'codex:acct-a', 's-claude': '' })
    b.w.stop()
    await new Promise((r) => setTimeout(r, 30))
    // Claude history was not re-read.
    const check = new Database(dbPath)
    expect(check.prepare('SELECT lastOffset, lastIngestedAt FROM tk_files WHERE path = ?').get(claudeFile)).toEqual(claudeCursorBefore)
    expect(check.prepare("SELECT value FROM tk_meta WHERE key = 'accountReread'").get()).toEqual({ value: 'done' })
    expect(check.prepare("SELECT value FROM tk_meta WHERE key = 'rollupsDirty'").get()).toEqual({ value: '0' })
    // Each file's cursor names its account.
    expect(check.prepare("SELECT accountKey FROM tk_files WHERE path LIKE '%rollout-2026-08-01T00-00-00-a.jsonl'").get()).toEqual({ accountKey: 'codex:acct-a' })
    check.close()
  })

  it('a rollout reachable through two listed folders is read once, for the first folder', async () => {
    const home = path.join(tmp, 'home-codex')
    writeRollout(path.join(home, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-h.jsonl', 'cx-h', 2)
    // A realm folder listed inside the user's own home.
    const s = start(path.join(tmp, 'nested.db'), [{ dir: path.join(home, '2026'), accountKey: 'codex:acct-n' }])
    await s.settle()
    const totals = s.msgs.filter((m) => m.type === 'index-progress').map((m) => (m as { filesTotal: number }).filesTotal)
    expect(Math.max(...totals)).toBe(1)
    expect(await s.ask('accounts')).toEqual([{ provider: 'codex', accountKey: 'codex:external' }])
  })

  it('a fresh database starts no re-read and no rebuild', async () => {
    const realmA = path.join(tmp, 'realms', 'a', 'sessions')
    writeRollout(path.join(realmA, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-a.jsonl', 'cx-a', 2)
    const s = start(path.join(tmp, 'fresh.db'), [{ dir: realmA, accountKey: 'codex:acct-a' }])
    await s.settle()
    const stages = s.msgs.filter((m) => m.type === 'index-progress').map((m) => (m as { accountReread?: { stage: string } | null }).accountReread?.stage ?? null)
    expect(stages.every((x) => x === null)).toBe(true)
    expect(await s.ask('accounts')).toEqual([{ provider: 'codex', accountKey: 'codex:acct-a' }])
  })

  // MP9 round 1 (B-F1): one folder walked once and one file listed once,
  // however many paths reach it; a folder reached by its own path owns it.
  const link = (target: string, at: string) => {
    fs.mkdirSync(path.dirname(at), { recursive: true })
    fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
  }

  it('an account folder linked into another account\'s never takes that account\'s sessions', async () => {
    const realmA = path.join(tmp, 'realms', 'a', 'sessions')
    const realmB = path.join(tmp, 'realms', 'b', 'sessions')
    writeRollout(path.join(realmB, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-b.jsonl', 'cx-b', 2)
    link(realmB, realmA)
    // A is listed first, and is reached only through the link.
    // The folder is walked once, by its own path (the link is never listed).
    const listed: string[] = []
    const tracing = new Proxy(fs, {
      get(target, k) {
        if (k === 'readdirSync') return (p: string, o: unknown) => { listed.push(String(p)); return (fs.readdirSync as (p: string, o: unknown) => unknown)(p, o) }
        return (target as unknown as Record<PropertyKey, unknown>)[k]
      },
    })
    const t = start(path.join(tmp, 'tk.db'), [{ dir: realmA, accountKey: 'codex:acct-a' }, { dir: realmB, accountKey: 'codex:acct-b' }], {}, tracing as unknown as typeof fs)
    await t.settle()
    expect(await t.ask('accounts')).toEqual([{ provider: 'codex', accountKey: 'codex:acct-b' }])
    expect((await t.ask('index-status')).eventsTotal).toBe(2)
    expect(listed.filter((p) => p.startsWith(realmA))).toEqual([])
    expect(listed.filter((p) => p.startsWith(realmB)).length).toBeGreaterThan(0)
  })

  it('this computer\'s own folder linked into an account\'s never takes that account\'s sessions', async () => {
    const realmB = path.join(tmp, 'realms', 'b', 'sessions')
    writeRollout(path.join(realmB, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-b.jsonl', 'cx-b', 2)
    link(realmB, path.join(tmp, 'home-codex'))
    const t = start(path.join(tmp, 'tk.db'), [{ dir: realmB, accountKey: 'codex:acct-b' }])
    await t.settle()
    expect(await t.ask('accounts')).toEqual([{ provider: 'codex', accountKey: 'codex:acct-b' }])
    expect((await t.ask('index-status')).eventsTotal).toBe(2)
  })

  it('one rollout reached by two paths (a hard link) is read once', async () => {
    const realmA = path.join(tmp, 'realms', 'a', 'sessions')
    const realmB = path.join(tmp, 'realms', 'b', 'sessions')
    const file = writeRollout(path.join(realmB, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-b.jsonl', 'cx-b', 2)
    fs.mkdirSync(path.join(realmA, '2026', '08', '01'), { recursive: true })
    fs.linkSync(file, path.join(realmA, '2026', '08', '01', 'rollout-2026-08-01T00-00-00-b.jsonl'))
    const t = start(path.join(tmp, 'tk.db'), [{ dir: realmA, accountKey: 'codex:acct-a' }, { dir: realmB, accountKey: 'codex:acct-b' }])
    await t.settle()
    expect((await t.ask('index-status')).eventsTotal).toBe(2)
    expect((await t.ask('summary')).kpis.lifeToDateCostUsd).toBeCloseTo(2, 5)
    // One file, one cursor.
    const last = t.msgs.filter((m) => m.type === 'index-progress').at(-1) as { filesTotal: number }
    expect(last.filesTotal).toBe(1)
  })

  it('where the file system gives no file id, files are told apart by path', async () => {
    const realmA = path.join(tmp, 'realms', 'a', 'sessions')
    writeRollout(path.join(realmA, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-a.jsonl', 'cx-a', 2)
    writeRollout(path.join(realmA, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-b.jsonl', 'cx-b', 3)
    const noIds = new Proxy(fs, {
      get(target, k) {
        if (k === 'statSync') return (p: string, o?: { bigint?: boolean }) => {
          const st = (fs.statSync as (p: string, o?: unknown) => fs.Stats)(p, o)
          return o?.bigint ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: 0n }) : st
        }
        return (target as unknown as Record<PropertyKey, unknown>)[k]
      },
    })
    const t = start(path.join(tmp, 'tk.db'), [{ dir: realmA, accountKey: 'codex:acct-a' }], {}, noIds as unknown as typeof fs)
    await t.settle()
    expect((await t.ask('index-status')).eventsTotal).toBe(5)
  })

  // MP9 round 1 (Q-4): the one-off attribution is settled only once the app
  // has named its account folders.
  it('the re-read is not declared done, nor the rollups rebuilt, before the account folders are named', async () => {
    const dbPath = path.join(tmp, 'tk.db')
    const realmA = path.join(tmp, 'realms', 'a', 'sessions')
    writeRollout(path.join(realmA, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-a.jsonl', 'cx-a', 3)
    const a = start(dbPath, [{ dir: realmA, accountKey: '' }])
    await a.settle()
    a.w.stop()
    await new Promise((r) => setTimeout(r, 30))
    const raw = new Database(dbPath)
    raw.exec(`DROP INDEX IF EXISTS idx_sessions_account;
      ALTER TABLE tk_events DROP COLUMN accountKey; ALTER TABLE tk_sessions DROP COLUMN accountKey;
      ALTER TABLE tk_files DROP COLUMN accountKey; ALTER TABLE tk_files DROP COLUMN accountReread;
      DROP TABLE tk_daily2; DROP TABLE tk_heatmap2; DROP TABLE tk_session_accounts;
      UPDATE tk_meta SET value = '1' WHERE key = 'schemaVersion';
      DELETE FROM tk_meta WHERE key IN ('rollupRowid', 'rollupsDirty', 'accountReread');`)
    raw.close()
    // Not named yet: sweeps drain, the re-read waits.
    const b = start(dbPath, [], { codexRealmDirsKnown: false })
    for (let i = 0; i < 6; i++) { b.fake.post({ type: 'reindex' }); await new Promise((r) => setTimeout(r, 25)) }
    expect(b.msgs.some((m) => m.type === 'index-complete' && (m as { drained: boolean }).drained)).toBe(true)
    expect((await b.ask('index-status')).accountReread).toMatchObject({ stage: 'reread' })
    expect(b.msgs.some((m) => m.type === 'index-progress' && (m as { accountReread?: { stage: string } | null }).accountReread?.stage === 'rebuild')).toBe(false)
    // Named: the folder is re-read into its account, then settled.
    b.fake.post({ type: 'set-codex-realm-dirs', dirs: [{ dir: realmA, accountKey: 'codex:acct-a' }] })
    await b.settle()
    expect(await b.ask('accounts')).toEqual([{ provider: 'codex', accountKey: 'codex:acct-a' }])
  })
})
