// [host] A claude.ai web sign-in left unfinished never stays signed in after a
// restart, and a record store written by a newer build is never overwritten.
//
// The REAL channel storage, record store and start sweep, over an in-memory
// file system (no real disk is touched) and a fake Electron session per
// partition:
//  - at start, each listed account with no record whose own partition folder
//    already exists is wiped (stored data, HTTP cache, code caches), its
//    views closed first; a recorded account, or one with no partition folder,
//    is never touched, and no partition is made;
//  - unless the record store reads cleanly (or is absent) the WHOLE sweep
//    stands down with one line, and the file stays where and as it was;
//  - a store written by a newer build is never written over: a save and each
//    setting are refused, a removal counts as done, the status says why.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const F = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  readFails: new Set<string>(),
  statFails: new Set<string>(),
  writeFails: false,
  listFails: false,
  listMissing: false,
  renamed: [] as Array<[string, string]>,
  minted: [] as string[],
  wiped: [] as string[],
  caches: [] as string[],
  codeCaches: [] as string[],
  events: [] as string[],
  logs: [] as string[],
  /** Reads of each file's contents. */
  reads: new Map<string, number>(),
}))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const fs = {
    ...real,
    existsSync: (p: string) => !F.statFails.has(p) && (F.files.has(p) || F.dirs.has(p)),
    readFileSync: (p: string) => {
      F.reads.set(p, (F.reads.get(p) ?? 0) + 1)
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
    lstatSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    writeFileSync: (p: string, d: string) => {
      if (F.writeFails) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })
      F.files.set(p, d)
    },
    mkdirSync: () => {},
    renameSync: (a: string, b: string) => { F.renamed.push([a, b]); F.files.set(b, F.files.get(a)!); F.files.delete(a) },
    copyFileSync: (a: string, b: string) => { F.files.set(b, F.files.get(a)!) },
    unlinkSync: (p: string) => { F.files.delete(p) },
    readdirSync: (dir: string) => {
      if (F.listFails) throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
      if (F.listMissing) throw Object.assign(new Error('ENOENT: no such file or directory, scandir'), { code: 'ENOENT' })
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
      return {
        clearStorageData: async () => { F.events.push(`wipe ${p}`); F.wiped.push(p) },
        clearCache: async () => { F.caches.push(p) },
        clearCodeCaches: async () => { F.codeCaches.push(p) },
      }
    },
  },
}))

const STORE = await import('../../src/main/account-web/session-store')
const SIGN_IN = await import('../../src/main/account-web/sign-in')

const A = 'profile-aaa111'
const B = 'profile-bbb222'
const C = 'profile-ccc333'
const FILE = '/res/conductor-channels/account-web-sessions.json'
const part = (id: string): string => `persist:claude-web-${id}`
const record = (id: string) => ({ profileId: id, accountEmail: 'owner@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' as const })
/** Each account's own partition folder exists, unless the test says otherwise. */
const everyFolder = () => true

beforeEach(() => {
  F.files.clear(); F.dirs.clear(); F.readFails.clear(); F.statFails.clear()
  F.writeFails = false; F.listFails = false; F.listMissing = false
  F.renamed.length = 0; F.minted.length = 0; F.wiped.length = 0; F.caches.length = 0; F.codeCaches.length = 0
  F.events.length = 0; F.logs.length = 0; F.reads.clear()
  SIGN_IN._resetClaudeWebForTest()
  SIGN_IN.onClaudeWebSessionClosing((id: string) => { F.events.push(`close ${id}`) })
})

async function sweep(ids: string[], partitionExists: (id: string) => boolean = everyFolder) {
  return SIGN_IN.sweepUnrecordedClaudeWebSessions(ids, STORE.readClaudeWebRecordsForSweep(), partitionExists)
}

describe('[host] a web session with no record is cleared at start', () => {
  it('a clean store: only the accounts it has no record for are wiped, stored data, HTTP cache and code caches', async () => {
    F.files.set(FILE, JSON.stringify({ schemaVersion: 4, sessions: [record(B)], authMethods: {}, authBrowsers: {}, webSignInModes: {} }))
    expect(await sweep([A, B])).toEqual([A])
    expect(F.wiped).toEqual([part(A)])
    expect(F.caches).toEqual([part(A)])
    expect(F.codeCaches).toEqual([part(A)])
  })

  it('an absent store means no records: each unrecorded account is wiped', async () => {
    expect(await sweep([A, B])).toEqual([A, B])
  })

  it('no channels folder yet (a first start): no quarantined copy, so the sweep runs', async () => {
    F.listMissing = true
    expect(await sweep([A])).toEqual([A])
  })

  it("a store from an older build this one migrates is read for its records", async () => {
    F.files.set(FILE, JSON.stringify({ schemaVersion: 3, sessions: [record(B)], authMethods: {}, authBrowsers: {} }))
    expect(await sweep([A, B])).toEqual([A])
  })

  it('a record with a bad field still counts as a record: its account is never wiped', async () => {
    F.files.set(FILE, JSON.stringify({ schemaVersion: 4, sessions: [{ ...record(B), accountEmail: 42, acquiredAt: 'x' }] }))
    expect(await sweep([A, B])).toEqual([A])
  })

  it("the account's views close before its wipe", async () => {
    expect(await sweep([A])).toEqual([A])
    const first = F.events.indexOf(`close ${A}`)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(F.events.indexOf(`wipe ${part(A)}`))
  })

  it('an id that is not a profile id is never touched', async () => {
    expect(await sweep(['../evil', 'PROFILE-X', A])).toEqual([A])
    expect(F.minted).toEqual([part(A)])
    expect(F.events.filter((e) => !e.endsWith(A))).toEqual([])
    expect(F.logs.filter((l) => /evil|PROFILE-X/.test(l))).toEqual([])
  })

  for (const [label, why, setUp] of [
    ['a corrupt store', 'malformed', () => { F.files.set(FILE, '{ not json') }],
    ['a store of another schema version (a newer build)', 'other-schema', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 5, sessions: [] })) }],
    ['a store of an unknown older schema version', 'other-schema', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 0, sessions: [] })) }],
    ['a store whose sessions are not a list', 'malformed', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 4, sessions: {} })) }],
    ['a store with no sessions at all', 'malformed', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 4 })) }],
    ['a store that cannot be read', 'unreadable', () => { F.files.set(FILE, '{}'); F.readFails.add(FILE) }],
    ['a store whose presence cannot be checked', 'unreadable', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 4, sessions: [record(B)] })); F.statFails.add(FILE) }],
    ['a store that is a folder', 'unreadable', () => { F.dirs.add(FILE) }],
    ['a quarantined copy of the store (an earlier corrupt read moved it aside)', 'quarantined: account-web-sessions.json.corrupt-1700000000000-ab12cd34', () => { F.files.set(`${FILE}.corrupt-1700000000000-ab12cd34`, '{ not json') }],
    ['a quarantined copy beside a store that reads cleanly', 'quarantined: account-web-sessions.json.corrupt-1700000000000-ab12cd34', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 4, sessions: [] })); F.files.set(`${FILE}.corrupt-1700000000000-ab12cd34`, '{}') }],
    ['a folder that cannot be listed (a quarantined copy cannot be ruled out)', 'unreadable', () => { F.files.set(FILE, JSON.stringify({ schemaVersion: 4, sessions: [] })); F.listFails = true }],
  ] as const) {
    it(`${label}: the start sweep stands down while the record store is in doubt, logs one line, and the file stays where and as it was`, async () => {
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
      expect(lines[0]).toContain(`(${why})`)
      expect(lines[0]).not.toMatch(/profile-|owner@|res\//)
    })
  }
})

describe('[host] the start sweep never makes a partition', () => {
  it('an account whose partition folder does not exist is skipped, never opened', async () => {
    expect(await sweep([A, B, C], (id) => id === B)).toEqual([B])
    expect(F.minted).toEqual([part(B)])
  })

  it('a folder check that throws skips that account', async () => {
    expect(await sweep([A], () => { throw new Error('stat failed') })).toEqual([])
    expect(F.minted).toEqual([])
  })

  it("the folder checked is this instance's own session data folder's partition, and a check that throws answers no", async () => {
    const { join } = await import('node:path')
    const asked: string[] = []
    const exists = SIGN_IN.claudePartitionFolderExists(() => '/this-instance/session-data', (p) => { asked.push(p); return p.endsWith(`claude-web-${A}`) })
    expect(exists(A)).toBe(true)
    expect(exists(B)).toBe(false)
    expect(asked).toEqual([join('/this-instance/session-data', 'Partitions', `claude-web-${A}`), join('/this-instance/session-data', 'Partitions', `claude-web-${B}`)])
    expect(SIGN_IN.claudePartitionFolderExists(() => { throw new Error('no session data folder') })(A)).toBe(false)
    expect(SIGN_IN.claudePartitionFolderExists(() => '/x', () => { throw new Error('stat failed') })(A)).toBe(false)
    expect(SIGN_IN.claudePartitionFolderExists(() => '/x', () => true)('../evil')).toBe(false)
  })
})

describe('[host] a wipe that fails at start is logged and the sweep goes on', () => {
  it('the failing account is not reported wiped; the next one is', async () => {
    const electron = await import('electron')
    const original = electron.session.fromPartition
    ;(electron.session as { fromPartition: unknown }).fromPartition = (p: string) => {
      const ses = (original as (x: string) => Record<string, unknown>)(p)
      if (p === part(A)) ses.clearStorageData = async () => { throw new Error('storage clear failed') }
      return ses
    }
    try {
      expect(await sweep([A, B])).toEqual([B])
      expect(F.logs.some((l) => /could not clear/.test(l) && l.includes(A))).toBe(true)
    } finally {
      ;(electron.session as { fromPartition: unknown }).fromPartition = original
    }
  })
})

describe('[host] a record store from a newer build is never overwritten', () => {
  const NEWER = JSON.stringify({ schemaVersion: 5, sessions: [record(B)], somethingNew: true })

  it('a save is refused and the file stays as it was', () => {
    F.files.set(FILE, NEWER)
    expect(STORE.saveWebSession(record(A))).toBe(false)
    expect(F.files.get(FILE)).toBe(NEWER)
    expect(F.renamed).toEqual([])
  })

  it('each per-account setting is refused with the reason, and the file stays as it was', () => {
    F.files.set(FILE, NEWER)
    expect(() => STORE.setAuthMethod(A, 'sso')).toThrow(STORE.NEWER_WEB_STORE_REASON)
    expect(() => STORE.setAuthBrowser(A, 'chrome')).toThrow(STORE.NEWER_WEB_STORE_REASON)
    expect(() => STORE.setWebSignInMode(A, 'internal-pane')).toThrow(STORE.NEWER_WEB_STORE_REASON)
    expect(F.files.get(FILE)).toBe(NEWER)
  })

  it('a removal (after a wipe that succeeded) counts as done, for an account it records or not, and the file stays as it was', () => {
    F.files.set(FILE, NEWER)
    expect(STORE.removeWebSession(B)).toBe(true)
    expect(STORE.removeWebSession(A)).toBe(true)
    expect(F.files.get(FILE)).toBe(NEWER)
  })

  it('the status says why, never a plain none', () => {
    F.files.set(FILE, NEWER)
    expect(STORE.claudeWebStoreIsNewer()).toBe(true)
    expect(STORE.viewFor(A)).toEqual({ profileId: A, status: 'none', unavailable: STORE.NEWER_WEB_STORE_REASON })
    expect(STORE.NEWER_WEB_STORE_REASON).toMatch(/written by a newer version of the app/)
    F.files.set(FILE, JSON.stringify({ schemaVersion: 4, sessions: [] }))
    expect(STORE.claudeWebStoreIsNewer()).toBe(false)
    expect(STORE.viewFor(A)).toEqual({ profileId: A, status: 'none' })
  })

  it("this build's own store, and an older one it migrates, are written as before", () => {
    F.files.set(FILE, JSON.stringify({ schemaVersion: 3, sessions: [], authMethods: { [A]: 'sso' }, authBrowsers: {} }))
    expect(STORE.saveWebSession(record(A))).toBe(true)
    const disk = JSON.parse(F.files.get(FILE)!)
    expect(disk.schemaVersion).toBe(4)
    expect(disk.authMethods).toEqual({ [A]: 'sso' })
    expect(disk.sessions.map((r: { profileId: string }) => r.profileId)).toEqual([A])
    STORE.setWebSignInMode(A, 'internal-pane')
    expect(STORE.getWebSignInMode(A)).toBe('internal-pane')
    expect(STORE.removeWebSession(A)).toBe(true)
    expect(STORE.getWebSession(A)).toBeUndefined()
    expect(STORE.getAuthMethod(A)).toBe('sso')
  })

  it('the status, a save, a removal and each setting read the record store once', () => {
    const once = (label: string, act: () => unknown) => {
      F.reads.clear()
      try { act() } catch { /* a refused setting throws; the count is what is checked */ }
      expect(F.reads.get(FILE) ?? 0, label).toBe(1)
    }
    for (const store of [NEWER, JSON.stringify({ schemaVersion: 4, sessions: [record(B)], authMethods: {}, authBrowsers: {}, webSignInModes: {} })]) {
      F.files.set(FILE, store)
      once('status', () => STORE.viewFor(B))
      once('save', () => STORE.saveWebSession(record(A)))
      once('removal', () => STORE.removeWebSession(A))
      once('method', () => STORE.setAuthMethod(A, 'sso'))
      once('browser', () => STORE.setAuthBrowser(A, 'chrome'))
      once('mode', () => STORE.setWebSignInMode(A, 'internal-pane'))
    }
  })

  it('a save or a removal that cannot be written reads as not done', () => {
    F.files.set(FILE, JSON.stringify({ schemaVersion: 4, sessions: [record(B)], authMethods: {}, authBrowsers: {}, webSignInModes: {} }))
    F.writeFails = true
    expect(STORE.saveWebSession(record(A))).toBe(false)
    expect(STORE.removeWebSession(B)).toBe(false)
  })
})
