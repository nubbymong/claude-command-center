/**
 * VM final pass at 8e41444f, defect 4: after a v1 to v2 upgrade the "sorting
 * by account" notice cleared before the managed Codex accounts' history was
 * re-read. In the app the account folders reach the worker just after its
 * first sweep has listed its files (the supervisor holds them until the
 * worker says it is ready, and the worker starts that sweep as it says so),
 * and that sweep, which listed only this computer's own folder, finished the
 * re-read: the account folders' rows were marked done unread and the notice
 * cleared; the folders were swept later with no notice.
 *
 * Host-safe: the real worker, real rollout files in a temp folder, and an
 * in-memory stand-in for the index database (better-sqlite3 is built for
 * Electron, so the database itself is covered by the native suite, in
 * tests/unit/native/tokenomics-reindex-accounts.native.test.ts). No process
 * starts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type Cursor = { path: string; size: number; mtime: number; lastOffset: number; scannedTo?: number; accountReread?: number; accountKey?: string; codexTurns?: number; codexSessionId?: string; codexModel?: string; codexCwd?: string }
const db = vi.hoisted(() => ({
  cursors: new Map<string, Cursor>(),
  meta: new Map<string, string>(),
  /** Files read to their end while their re-read was pending. */
  read: new Set<string>(),
  events: 0,
}))
vi.mock('../../../src/main/tokenomics/tk-db', () => {
  const setFileCursor = (c: Cursor): void => {
    const before = db.cursors.get(c.path)?.accountReread ?? 0
    const done = (c.scannedTo ?? c.lastOffset) >= c.size
    if (before === 1 && done) db.read.add(c.path)
    db.cursors.set(c.path, { ...c, accountReread: before === 1 && done ? 2 : before })
  }
  return {
    TK_REBUILD_PAGE: 5000,
    openTkDb: () => ({
      getFileCursor: (p: string) => db.cursors.get(p) ?? null,
      setFileCursor,
      insertEvents: (b: unknown[]) => { db.events += b.length; return b.length },
      insertEventsWithCursor: (b: unknown[], c: Cursor) => { db.events += b.length; setFileCursor(c); return b.length },
      getSessionCwd: () => '',
      accountRereadPending: () => db.meta.get('accountReread') === 'pending',
      finishAccountReread: () => {
        for (const [p, c] of db.cursors) if (c.accountReread === 1) db.cursors.set(p, { ...c, accountReread: 2 })
        db.meta.set('accountReread', 'done')
      },
      // The re-read leaves the rollups to rebuild, as the database does.
      rollupsDirty: () => db.meta.get('rollupsDirty') === '1',
      beginRollupRebuild: () => {},
      stepRollupRebuild: () => { db.meta.delete('rollupsDirty'); return { done: 1, total: 1, finished: true } },
      getMeta: (k: string) => db.meta.get(k),
      setMeta: (k: string, v: string) => { db.meta.set(k, v) },
      eventCount: () => db.events,
      upsertConfigs: () => {},
      setSessionAccount: () => {},
      queryAccounts: () => [],
      close: () => {},
    }),
  }
})

import { createTokenomicsWorker } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { FromTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

function writeRollout(dir: string, name: string, id: string, turns: number): string {
  fs.mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T00:00:00Z', payload: { id, cwd: 'F:\\proj', model: 'gpt-5.5' } })]
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: `2026-08-01T00:00:${String(10 + i).padStart(2, '0')}Z`, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 10 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0 } } } }))
  }
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

describe('the one-off re-read waits for the account folders (defect 4)', () => {
  let tmp: string
  let stop: (() => void) | null = null
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkorder-'))
    db.cursors.clear(); db.meta.clear(); db.read.clear(); db.events = 0
  })
  afterEach(() => {
    try { stop?.() } catch { /* stopped */ }
    stop = null
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // Not named yet when the worker opened (the app's case), or named then as
  // none and named again while a sweep runs (an account added meanwhile).
  for (const [how, knownAtOpen] of [['not named at open', false], ['named as none at open', true]] as const) {
    it(`folders named while the first sweep runs are read before the notice clears, and counted in it (${how})`, async () => {
      const home = path.join(tmp, 'home-codex')
      const realm = path.join(tmp, 'realms', 'a', 'sessions')
      const files = [
        writeRollout(path.join(home, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-h.jsonl', 'cx-h', 2),
        writeRollout(path.join(realm, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-a.jsonl', 'cx-a', 3),
        writeRollout(path.join(realm, '2026', '08', '02'), 'rollout-2026-08-02T00-00-00-a.jsonl', 'cx-a2', 1),
      ]
      // A database upgraded from v1: every rollout rewound for the re-read.
      for (const f of files) {
        const st = fs.statSync(f)
        db.cursors.set(f, { path: f, size: st.size, mtime: st.mtimeMs, lastOffset: 0, scannedTo: 0, accountReread: 1, accountKey: '', codexTurns: 0 })
      }
      // Enough new history in this computer's own folder that the sweep
      // yields while it reads, as a real one does: a sweep asked for then
      // is not lost.
      for (let i = 0; i < 48; i++) writeRollout(path.join(home, '2026', '07', '01'), `rollout-2026-07-01T00-00-00-x${i}.jsonl`, `cx-x${i}`, 1)
      db.meta.set('accountReread', 'pending')
      db.meta.set('rollupsDirty', '1')
      db.meta.set('firstIndexComplete', '1')

      const fake = new FakeTkWorkerTransport()
      let named = false
      // The folders are named once the first sweep has listed this computer's own.
      const late = new Proxy(fs, {
        get(target, k) {
          if (k === 'readdirSync') return (p: string, o: unknown) => {
            const listed = (fs.readdirSync as (p: string, o: unknown) => unknown)(p, o)
            if (!named && path.resolve(String(p)) === path.resolve(home)) {
              named = true
              fake.post({ type: 'set-codex-realm-dirs', dirs: [{ dir: realm, accountKey: 'codex:acct-a' }] })
            }
            return listed
          }
          return (target as unknown as Record<PropertyKey, unknown>)[k]
        },
      })
      let seen = false
      let counting = false
      const unreadWhenCleared: string[][] = []
      const totals: number[] = []
      // The moment the notice first clears, waited for as an event (no
      // polling), with a generous bound for a loaded CI runner.
      let cleared: () => void = () => {}
      const clearedOnce = new Promise<void>((resolve) => { cleared = resolve })
      fake.onMessage((m: FromTkWorker) => {
        if (m.type !== 'index-progress') return
        const r = (m as { accountReread?: { stage: string; total: number; counting?: boolean } | null }).accountReread
        if (r) {
          seen = true
          if (r.stage === 'reread' && r.counting === true) counting = true
          if (r.stage === 'reread' && r.total > 0) totals.push(r.total)
        } else if (seen) {
          unreadWhenCleared.push(files.filter((f) => !db.read.has(f)))
          cleared()
        }
      })
      const w = createTokenomicsWorker(fake.asWorkerSide(), { fs: late as unknown as typeof fs, watchDebounceMs: 0 })
      stop = () => w.stop()
      fake.post({ type: 'open', dbPath: path.join(tmp, 'tk.db'), pricing: {}, configs: [], claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: home, codexRealmSessionsDirs: [], codexRealmDirsKnown: knownAtOpen })
      let bound: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        clearedOnce,
        new Promise<void>((_, fail) => { bound = setTimeout(() => fail(new Error('the notice never cleared')), 20_000) }),
      ]).finally(() => clearTimeout(bound))
      expect(named).toBe(true)
      expect(seen).toBe(true)
      // When the notice cleared, every rollout had been read, the re-read was
      // done and the rollups rebuilt.
      expect(unreadWhenCleared[0]).toEqual([])
      expect(db.read.size).toBe(files.length)
      expect(db.meta.get('accountReread')).toBe('done')
      expect(db.meta.has('rollupsDirty')).toBe(false)
      // Until its files are counted, stage 1 says it is counting them.
      if (!knownAtOpen) expect(counting).toBe(true)
      // Stage 1 counts every rollout it will read, this computer's and the
      // account's: from the start when the folders were not named yet, and
      // once they are when they were named as none.
      expect(totals.length).toBeGreaterThan(0)
      if (!knownAtOpen) expect(new Set(totals)).toEqual(new Set([files.length]))
      expect(totals.at(-1)).toBe(files.length)
    }, 30_000)
  }

  // [host] With no first index on record, the sweep whose file list predates
  // the naming of the account folders has not read them: it never reports
  // the first index complete. The follow-up sweep that reads them does, once.
  for (const [how, knownAtOpen] of [['not named at open', false], ['named as none at open', true]] as const) {
    it(`with no first index on record, only the sweep that reads the named folders completes it (${how})`, async () => {
      const home = path.join(tmp, 'home-codex')
      const realm = path.join(tmp, 'realms', 'a', 'sessions')
      const files = [
        writeRollout(path.join(home, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-h.jsonl', 'cx-h', 2),
        writeRollout(path.join(realm, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-a.jsonl', 'cx-a', 3),
      ]
      for (const f of files) {
        const st = fs.statSync(f)
        db.cursors.set(f, { path: f, size: st.size, mtime: st.mtimeMs, lastOffset: 0, scannedTo: 0, accountReread: 1, accountKey: '', codexTurns: 0 })
      }
      for (let i = 0; i < 48; i++) writeRollout(path.join(home, '2026', '07', '01'), `rollout-2026-07-01T00-00-00-x${i}.jsonl`, `cx-x${i}`, 1)
      db.meta.set('accountReread', 'pending')
      expect(db.meta.has('firstIndexComplete')).toBe(false)

      const fake = new FakeTkWorkerTransport()
      let named = false
      const late = new Proxy(fs, {
        get(target, k) {
          if (k === 'readdirSync') return (p: string, o: unknown) => {
            const listed = (fs.readdirSync as (p: string, o: unknown) => unknown)(p, o)
            if (!named && path.resolve(String(p)) === path.resolve(home)) {
              named = true
              fake.post({ type: 'set-codex-realm-dirs', dirs: [{ dir: realm, accountKey: 'codex:acct-a' }] })
            }
            return listed
          }
          return (target as unknown as Record<PropertyKey, unknown>)[k]
        },
      })
      const readyFirst: boolean[] = []
      const completes: Array<{ firstIndex: boolean; drained: boolean; unread: number }> = []
      let completed: () => void = () => {}
      const firstIndexOnce = new Promise<void>((resolve) => { completed = resolve })
      fake.onMessage((m: FromTkWorker) => {
        if (m.type === 'ready') readyFirst.push(m.firstIndexComplete)
        if (m.type !== 'index-complete') return
        completes.push({ firstIndex: m.firstIndex, drained: m.drained, unread: files.filter((f) => !db.read.has(f)).length })
        if (m.firstIndex) completed()
      })
      const w = createTokenomicsWorker(fake.asWorkerSide(), { fs: late as unknown as typeof fs, watchDebounceMs: 0 })
      stop = () => w.stop()
      fake.post({ type: 'open', dbPath: path.join(tmp, 'tk.db'), pricing: {}, configs: [], claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: home, codexRealmSessionsDirs: [], codexRealmDirsKnown: knownAtOpen })
      let bound: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        firstIndexOnce,
        new Promise<void>((_, fail) => { bound = setTimeout(() => fail(new Error('the first index never completed')), 20_000) }),
      ]).finally(() => clearTimeout(bound))
      expect(named).toBe(true)
      expect(readyFirst).toEqual([false])
      const at = completes.findIndex((c) => c.firstIndex)
      // The sweep listed before the naming came first: not drained, not the
      // first index, with the account's rollout still unread.
      expect(at).toBeGreaterThan(0)
      expect(completes[0]).toMatchObject({ firstIndex: false, drained: false })
      expect(completes[0].unread).toBeGreaterThan(0)
      expect(completes.slice(0, at).every((c) => !c.firstIndex)).toBe(true)
      // The first index completes with a drained sweep that read every rollout.
      expect(completes[at]).toEqual({ firstIndex: true, drained: true, unread: 0 })
      expect(db.meta.get('firstIndexComplete')).toBe('1')
    }, 30_000)
  }
})
