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

  function start(dbPath: string, dirs: Array<{ dir: string; accountKey: string }>) {
    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    const w = createTokenomicsWorker(fake.asWorkerSide(), {})
    workers.push(w)
    fake.post({ type: 'open', dbPath, pricing: PRICING, configs: [], claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: path.join(tmp, 'home-codex'), codexRealmSessionsDirs: dirs })
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
    // ...as a schema v1 database, and the rollout since pruned.
    const raw = new Database(dbPath)
    raw.prepare("UPDATE tk_meta SET value = '1' WHERE key = 'schemaVersion'").run()
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
})
