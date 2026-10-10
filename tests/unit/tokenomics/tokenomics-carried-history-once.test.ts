// HOST QUARANTINE: plants hard links. [CI] [VM] only -- never run on the owner's machine.
/**
 * P3.3 review round 3 (C5): a staged sign in again carries an account's Codex
 * history into its new folder (a hard link of each rollout, else a byte
 * copy), and from the switch on the app names only the new folder to
 * Tokenomics. The worker then meets the same rollout under a new path, with
 * no cursor, and reads it from the top. Its turns must be counted once: the
 * worker keys a Codex turn on the session id and its ordinal, from the
 * rollout's content, never its path, and the index stores a key once
 * (INSERT OR IGNORE).
 *
 * Host-safe: the real worker, real rollout files in a temp folder, and an
 * in-memory stand-in for the index database that keeps a key once, as the
 * database does (better-sqlite3 is built for Electron; the database itself
 * is covered by the native suite). No process starts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type Cursor = { path: string; size: number; mtime: number; lastOffset: number; scannedTo?: number }
const db = vi.hoisted(() => ({
  cursors: new Map<string, Cursor>(),
  meta: new Map<string, string>(),
  /** Every key stored: the index's unique dedup key. */
  keys: new Set<string>(),
  /** Per rollout path: the turns the worker offered, and how many were new. */
  offered: new Map<string, number>(),
  stored: new Map<string, number>(),
}))
vi.mock('../../../src/main/tokenomics/tk-db', () => {
  const insert = (b: Array<{ dedupKey: string }>, file?: string): number => {
    let fresh = 0
    for (const ev of b) {
      if (db.keys.has(ev.dedupKey)) continue
      db.keys.add(ev.dedupKey)
      fresh++
    }
    if (file) {
      db.offered.set(file, (db.offered.get(file) ?? 0) + b.length)
      db.stored.set(file, (db.stored.get(file) ?? 0) + fresh)
    }
    return fresh
  }
  return {
    TK_REBUILD_PAGE: 5000,
    openTkDb: () => ({
      getFileCursor: (p: string) => db.cursors.get(p) ?? null,
      setFileCursor: (c: Cursor) => { db.cursors.set(c.path, c) },
      insertEvents: (b: Array<{ dedupKey: string }>) => insert(b),
      insertEventsWithCursor: (b: Array<{ dedupKey: string }>, c: Cursor) => { db.cursors.set(c.path, c); return insert(b, c.path) },
      getSessionCwd: () => '',
      accountRereadPending: () => false,
      finishAccountReread: () => {},
      rollupsDirty: () => false,
      beginRollupRebuild: () => {},
      stepRollupRebuild: () => ({ done: 1, total: 1, finished: true }),
      getMeta: (k: string) => db.meta.get(k),
      setMeta: (k: string, v: string) => { db.meta.set(k, v) },
      eventCount: () => db.keys.size,
      upsertConfigs: () => {},
      setSessionAccount: () => {},
      queryAccounts: () => [],
      close: () => {},
    }),
  }
})

import { createTokenomicsWorker } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'

const FIXTURE = path.resolve(__dirname, '../../fixtures/codex/cli/0.155.1/rollout-exec-then-resume.jsonl')
const NAME = 'rollout-2026-09-27T12-08-23-00000000-0000-7000-8000-000000000001.jsonl'

/** Waits for the worker to have read `file` to its end (bounded). */
async function readToEnd(file: string): Promise<void> {
  const size = fs.statSync(file).size
  const deadline = Date.now() + 20_000
  for (;;) {
    const c = db.cursors.get(file)
    if (c && (c.scannedTo ?? c.lastOffset) >= size) return
    if (Date.now() > deadline) throw new Error(`the worker never read ${file}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('history carried over by a sign in again is counted once (P3.3 review round 3, C5)', () => {
  let tmp: string
  let stop: (() => void) | null = null
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkcarried-'))
    db.cursors.clear(); db.meta.clear(); db.keys.clear(); db.offered.clear(); db.stored.clear()
    db.meta.set('firstIndexComplete', '1')
  })
  afterEach(() => {
    try { stop?.() } catch { /* stopped */ }
    stop = null
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('the rollout read from the old folder, then from the new one (a second name of it, then a byte copy): one count', async () => {
    const day = path.join('2026', '09', '27')
    const folder = (realm: string) => path.join(tmp, 'codex-realms', realm, 'sessions')
    const original = path.join(folder('old'), day, NAME)
    fs.mkdirSync(path.dirname(original), { recursive: true })
    fs.copyFileSync(FIXTURE, original)
    // The new folder as a sign in again leaves it: the same file under a
    // second name where the file system allows one, else a byte copy.
    const linked = path.join(folder('new'), day, NAME)
    fs.mkdirSync(path.dirname(linked), { recursive: true })
    try { fs.linkSync(original, linked) } catch { fs.copyFileSync(original, linked) }
    const copied = path.join(folder('newer'), day, NAME)
    fs.mkdirSync(path.dirname(copied), { recursive: true })
    fs.copyFileSync(original, copied)

    const fake = new FakeTkWorkerTransport()
    const w = createTokenomicsWorker(fake.asWorkerSide(), { watchDebounceMs: 0 })
    stop = () => w.stop()
    const account = 'codex:acct-a'
    // Before the switch: the account's folder is the old one.
    fake.post({ type: 'open', dbPath: path.join(tmp, 'tk.db'), pricing: {}, configs: [], claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: path.join(tmp, 'home-codex'), codexRealmSessionsDirs: [{ dir: folder('old'), accountKey: account }], codexRealmDirsKnown: true })
    await readToEnd(original)
    const counted = db.keys.size
    expect(counted).toBeGreaterThan(0)
    expect(db.stored.get(original)).toBe(counted)

    // After it: only the new folder is named. The rollout there is read from
    // the top, and every turn it offers is already counted.
    for (const [next, root] of [[linked, folder('new')], [copied, folder('newer')]]) {
      fake.post({ type: 'set-codex-realm-dirs', dirs: [{ dir: root, accountKey: account }] })
      w.tickNow()
      await readToEnd(next)
      expect(db.offered.get(next), next).toBe(counted)
      expect(db.stored.get(next), next).toBe(0)
      expect(db.keys.size, next).toBe(counted)
    }
  }, 60_000)
})
