// [host] WP2 PR 4, P4.6 second half (row 58): the start sweep of Codex
// chatgpt.com web sessions trusts the record store only when it reads cleanly.
// The REAL channel storage, record store and sweep, over an in-memory file
// system (the channel-storage test's pattern: no real disk is touched):
//  - an absent store means no records: each unrecorded account whose own
//    partition folder exists is wiped;
//  - a corrupt store, one of another schema version (a downgrade) or one that
//    cannot be read skips the WHOLE sweep, logs one line (names only), and
//    leaves the file exactly where and as it was (no .corrupt rename);
//  - an account whose partition folder does not exist is never touched, so no
//    partition is made at start for a never-used or archived account.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const F = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  readFails: new Set<string>(),
  statFails: new Set<string>(),
  listFails: false,
  renamed: [] as Array<[string, string]>,
  minted: [] as string[],
  wiped: [] as string[],
  logs: [] as string[],
}))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const fs = {
    ...real,
    // As Node's: a path whose stat fails (EACCES) reads as missing.
    existsSync: (p: string) => !F.statFails.has(p) && (F.files.has(p) || F.dirs.has(p)),
    readFileSync: (p: string) => {
      if (F.readFails.has(p)) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${p}'`), { code: 'EISDIR' })
      if (!F.files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return F.files.get(p)!
    },
    statSync: (p: string, opts?: { throwIfNoEntry?: boolean }) => {
      if (F.statFails.has(p)) throw Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: 'EACCES' })
      if (F.files.has(p)) return { isDirectory: () => false, isFile: () => true }
      if (F.dirs.has(p)) return { isDirectory: () => true, isFile: () => false }
      if (opts?.throwIfNoEntry === false) return undefined
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    writeFileSync: (p: string, d: string) => { F.files.set(p, d) },
    mkdirSync: () => {},
    renameSync: (a: string, b: string) => { F.renamed.push([a, b]); F.files.set(b, F.files.get(a)!); F.files.delete(a) },
    copyFileSync: (a: string, b: string) => { F.files.set(b, F.files.get(a)!) },
    unlinkSync: (p: string) => { F.files.delete(p) },
    readdirSync: (dir: string) => {
      if (F.listFails) throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
      const prefix = dir.endsWith('/') ? dir : dir + '/'
      return [...F.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length))
    },
    appendFileSync: () => {},
  }
  return { ...fs, default: fs }
})
vi.mock('path', async (orig) => {
  const real = await orig<typeof import('path')>()
  const join = (...p: string[]): string => p.join('/')
  return { ...real, default: { ...real, join }, join }
})
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { F.logs.push(a.map(String).join(' ')) },
  logError: (...a: unknown[]) => { F.logs.push(a.map(String).join(' ')) },
  logWarn: () => {},
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {
    fromPartition: (p: string) => {
      F.minted.push(p)
      return { clearStorageData: async () => { F.wiped.push(p) }, clearCache: async () => {} }
    },
  },
}))

const STORE = await import('../../src/main/account-web/codex-web-store')
const CWS = await import('../../src/main/account-web/codex-web-session')

const A = 'acct-0123456789abcdef'
const B = 'acct-fedcba9876543210'
const C = 'acct-00112233445566aa'
const FILE = '/res/conductor-channels/codex-web-sessions.json'
const record = (id: string) => ({ accountId: id, accountEmail: 'owner@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' })
/** Each account's own partition folder exists, unless the test says otherwise. */
const everyFolder = () => true

beforeEach(() => {
  F.files.clear(); F.dirs.clear(); F.readFails.clear(); F.statFails.clear(); F.listFails = false
  F.renamed.length = 0; F.minted.length = 0; F.wiped.length = 0; F.logs.length = 0
  CWS._resetCodexWebForTest()
})

async function sweep(ids: string[], partitionExists: (id: string) => boolean = everyFolder) {
  return CWS.sweepUnrecordedCodexWebSessions(ids, STORE.readCodexWebRecordsForSweep(), partitionExists)
}

describe('[host] the start sweep reads the record store once, without side effects', () => {
  it('a clean store: only the accounts it has no record for are wiped', async () => {
    F.files.set(FILE, JSON.stringify({ schemaVersion: 1, sessions: [record(B)] }))
    expect(await sweep([A, B])).toEqual([A])
    expect(F.wiped).toEqual([`persist:codex-web-${A}`])
  })

  it('an absent store means no records: each unrecorded account is wiped', async () => {
    expect(await sweep([A, B])).toEqual([A, B])
  })

  it('a record with a bad field still counts as a record: its account is never wiped', async () => {
    F.files.set(FILE, JSON.stringify({ schemaVersion: 1, sessions: [{ ...record(B), accountEmail: 'not an email' }] }))
    expect(await sweep([A, B])).toEqual([A])
  })

  for (const [label, setUp] of [
    ['a corrupt store', () => { F.files.set(FILE, '{ not json') }],
    ['a store of another schema version (a downgrade)', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 2, sessions: [] })) }],
    ['a store whose sessions are not a list', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 1, sessions: {} })) }],
    ['a store that cannot be read', () => { F.files.set(FILE, '{}'); F.readFails.add(FILE) }],
    ['a store whose presence cannot be checked (the stat throws; existsSync would call it missing)', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 1, sessions: [record(B)] })); F.statFails.add(FILE) }],
    ['a store that is a folder', () => { F.dirs.add(FILE) }],
    ['a quarantined copy of the store (an earlier corrupt read moved it aside)', () => { F.files.set(`${FILE}.corrupt-1700000000000-ab12cd34`, '{ not json') }],
    ['a quarantined copy beside a store that reads cleanly', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 1, sessions: [] })); F.files.set(`${FILE}.corrupt-1700000000000-ab12cd34`, '{}') }],
    ['a folder that cannot be listed (a quarantined copy cannot be ruled out)', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 1, sessions: [] })); F.listFails = true }],
  ] as const) {
    it(`${label}: the whole sweep is skipped, one line is logged, and the file stays where and as it was`, async () => {
      setUp()
      const before = F.files.get(FILE)
      const filesBefore = [...F.files.keys()].sort()
      expect(await sweep([A, B, C])).toEqual([])
      expect([...F.files.keys()].sort()).toEqual(filesBefore)
      expect(F.minted).toEqual([])
      expect(F.wiped).toEqual([])
      expect(F.renamed).toEqual([])
      expect(F.files.get(FILE)).toBe(before)
      const lines = F.logs.filter((l) => /start sweep/.test(l))
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toMatch(/acct-|owner@|res\//)
    })
  }
})

describe('[host] the start sweep never makes a partition', () => {
  it('an account whose partition folder does not exist is skipped, never opened', async () => {
    expect(await sweep([A, B, C], (id) => id === B)).toEqual([B])
    expect(F.minted).toEqual([`persist:codex-web-${B}`])
  })

  it('a folder check that throws skips that account', async () => {
    expect(await sweep([A], () => { throw new Error('stat failed') })).toEqual([])
    expect(F.minted).toEqual([])
  })
})

describe('[host] a store written by a newer build is never overwritten', () => {
  const NEWER = JSON.stringify({ schemaVersion: 2, sessions: [record(B)], somethingNew: true })

  it('a save is refused (so a finished sign-in is cleared, failing closed), and the file stays as it was', () => {
    F.files.set(FILE, NEWER)
    expect(STORE.saveCodexWebSession(record(A) as never)).toBe(false)
    expect(F.files.get(FILE)).toBe(NEWER)
    expect(F.renamed).toEqual([])
  })

  it('a removal is refused (a sign-out or an archive reports it), and the file stays as it was', () => {
    F.files.set(FILE, NEWER)
    expect(STORE.removeCodexWebSession(B)).toBe(false)
    expect(STORE.removeCodexWebSession(A)).toBe(false)
    expect(F.files.get(FILE)).toBe(NEWER)
  })

  it("this build's own store is written as before", () => {
    F.files.set(FILE, JSON.stringify({ schemaVersion: 1, sessions: [] }))
    expect(STORE.saveCodexWebSession(record(A) as never)).toBe(true)
    expect(JSON.parse(F.files.get(FILE)!).sessions.map((r: { accountId: string }) => r.accountId)).toEqual([A])
    expect(STORE.removeCodexWebSession(A)).toBe(true)
  })
})
