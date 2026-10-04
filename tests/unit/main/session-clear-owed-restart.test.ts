// [host] The owner's 2026-10-04 answer for "Close sessions", kept across a
// restart (PR 4 review C-S1): a clear the user asked for that cannot remove
// the saved file (held by a virus scanner or a sync tool) is remembered in a
// small marker beside the file, so the next start offers nothing and tries
// the removal again. The marker goes once every copy is gone, or once a later
// save has replaced the set. The marker keeps the time of the clear, and
// nothing that may hold a later save is ever removed (PR 4 re-review R-1,
// R-2): a marker that cannot be read stands at its own time, and when even
// that or the file cannot be read, nothing is removed and saves are held.
// Also here: a clear the read-failure latch refused is not a held file
// (review C-Q1), and the GitHub sidebar's reads answer nothing while a clear
// is owed and leave the latch alone (review C-Q2).
//
// Each "run" re-imports session-state and the durability core afresh, so no
// state of the module carries over: only the files in this test's own temp
// folder do. The fs faults stand in for another program holding a file.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import type { SessionState } from '../../../src/main/session-state'

const h = vi.hoisted(() => ({ resourcesDir: '', logs: [] as string[] }))

// `mainUnlink`: the session file cannot be removed (EBUSY). `readBusy`: it
// cannot be read. `mainWrite`: a save cannot write it. `markerUnlink` /
// `markerRead` / `markerWrite`: the same for the marker; `markerStat`: not
// even its times can be read. Otherwise the real fs.
const fault = vi.hoisted(() => ({ mainUnlink: false, readBusy: false, mainWrite: false, markerUnlink: false, markerRead: false, markerWrite: false, markerStat: false }))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const busy = () => Object.assign(new Error('EBUSY: the file is held'), { code: 'EBUSY' })
  const isMain = (p: unknown) => String(p).endsWith('session-state.json')
  const isMarker = (p: unknown) => String(p).endsWith('session-state.json.clear-owed')
  const unlinkSync = ((p: Parameters<typeof real.unlinkSync>[0]) => {
    if (fault.mainUnlink && isMain(p)) throw busy()
    if (fault.markerUnlink && isMarker(p)) throw busy()
    return real.unlinkSync(p)
  }) as typeof real.unlinkSync
  const readFileSync = ((p: Parameters<typeof real.readFileSync>[0], o?: Parameters<typeof real.readFileSync>[1]) => {
    if (fault.readBusy && isMain(p)) throw busy()
    if (fault.markerRead && isMarker(p)) throw busy()
    return real.readFileSync(p, o)
  }) as typeof real.readFileSync
  const writeFileSync = ((p: Parameters<typeof real.writeFileSync>[0], d: Parameters<typeof real.writeFileSync>[1], o?: Parameters<typeof real.writeFileSync>[2]) => {
    // The atomic writer stages `<name>.<uuid>.tmp` beside the target.
    if (fault.markerWrite && String(p).includes('session-state.json.clear-owed')) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    if (fault.mainWrite && /session-state\.json\.[0-9a-f-]{36}\.tmp$/.test(String(p))) throw busy()
    return real.writeFileSync(p, d, o)
  }) as typeof real.writeFileSync
  const lstatSync = ((p: Parameters<typeof real.lstatSync>[0], o?: Parameters<typeof real.lstatSync>[1]) => {
    if (fault.markerStat && isMarker(p)) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    return real.lstatSync(p, o as never)
  }) as typeof real.lstatSync
  const statSync = ((p: Parameters<typeof real.statSync>[0], o?: Parameters<typeof real.statSync>[1]) => {
    if (fault.markerStat && isMarker(p)) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    return real.statSync(p, o as never)
  }) as typeof real.statSync
  const patched = { ...real, unlinkSync, readFileSync, writeFileSync, lstatSync, statSync }
  return { ...patched, default: patched }
})

vi.mock('../../../src/main/config-manager', async () => {
  const path = await import('node:path')
  const fs = await import('node:fs')
  return {
    getConfigDir: () => path.join(h.resourcesDir, 'CONFIG'),
    ensureConfigDir: () => { fs.mkdirSync(path.join(h.resourcesDir, 'CONFIG'), { recursive: true }) },
    migrateConfigToProviderShape: (s: unknown) => s,
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (m: string) => { h.logs.push(String(m)) }, logError: (m: string) => { h.logs.push(String(m)) }, logWarn: () => {} }))
vi.mock('../../../src/main/pty-manager', () => ({
  getKeptCodexConversation: () => undefined,
  uncertainCodexConversationIds: () => [],
  rememberUncertainCodexConversationsFrom: () => {},
}))
vi.mock('../../../src/main/hooks', () => ({ isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))
vi.mock('../../../src/main/logging/transcript-discovery', () => ({ resolveResumeTargetFromTranscript: () => null }))

const PREFIX = 'ccc-test-clear-owed-'
let tmp = ''
const file = () => join(tmp, 'CONFIG', 'session-state.json')
const marker = () => `${file()}.clear-owed`

/** The set the user discards: one tab, and a remote the registry recorded. */
const theSet = (): SessionState =>
  ({
    sessions: [{ id: 's1', provider: 'claude', name: 'Orchard', cwd: 'C:/work/orchard' }],
    activeSessionId: 's1',
    savedAt: Date.now() - 60_000,
    detachedRemotes: [{ sessionId: 's1', host: 'h.example', username: 'u', remotePath: '/w' }],
  } as unknown as SessionState)
/** A set saved after the clear. */
const freshSet = (): SessionState =>
  ({ sessions: [{ id: 's2', provider: 'claude', name: 'Quarry', cwd: 'C:/work/quarry' }], activeSessionId: 's2', savedAt: Date.now() + 1_000 } as unknown as SessionState)
const names = (s: SessionState | null) => (s?.sessions ?? []).map((x) => (x as unknown as { name: string }).name)

/** A new run of the app: every module afresh, only the files carried over. */
async function run() {
  vi.resetModules()
  const ss = await import('../../../src/main/session-state')
  const { createAppSessionDurability } = await import('../../../src/main/app-session-durability')
  return { ss, d: createAppSessionDurability() }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), PREFIX))
  h.resourcesDir = tmp
})
beforeEach(() => {
  Object.assign(fault, { mainUnlink: false, readBusy: false, mainWrite: false, markerUnlink: false, markerRead: false, markerWrite: false, markerStat: false })
  h.logs.length = 0
  for (const f of [file(), `${file()}.bak`, marker()]) rmSync(f, { force: true })
})
afterAll(() => {
  // Only the folder this file made: its own prefix, directly in the temp folder.
  if (tmp && dirname(tmp) === tmpdir() && basename(tmp).startsWith(PREFIX)) rmSync(tmp, { recursive: true, force: true })
})

describe('a clear still owed is remembered across a restart (C-S1)', () => {
  it('[host] "Close sessions" with the file held until the app has quit: the next start offers nothing, and removes the set once the hold ends', async () => {
    const one = await run()
    expect(one.d.saveEnriched(theSet())).toBe(true)
    fault.mainUnlink = true
    expect(one.d.clear()).toBe(false)
    one.d.flushOnExit('before-quit')
    expect(readFileSync(file(), 'utf8')).toMatch(/Orchard/)

    // Still held at the next start: nothing offered, nothing else reads the set.
    const two = await run()
    expect(two.d.load()).toBeNull()
    expect(two.ss.hasSavedSessionState()).toBe(false)
    expect(two.ss.readDetachedRemotesRegistry()).toEqual([])
    expect(two.ss.sessionStateReadFailed()).toBe(false)
    expect(readFileSync(file(), 'utf8')).toMatch(/Orchard/)
    expect(existsSync(marker())).toBe(true)

    // The hold ends before the start after that: the load removes the set.
    fault.mainUnlink = false
    const three = await run()
    expect(three.d.load()).toBeNull()
    for (const f of [file(), `${file()}.bak`, marker()]) expect(existsSync(f), f).toBe(false)
    // And the app works as before: a save is loaded at the next start.
    expect(three.d.saveEnriched(freshSet())).toBe(true)
    expect(names((await run()).d.load())).toEqual(['Quarry'])
  })

  it('[host] the marker is written beside the file, atomically, and goes once the clear has removed every copy; a clear that succeeds writes none', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    expect(one.d.clear()).toBe(true)
    expect(existsSync(marker())).toBe(false)

    one.d.saveEnriched(theSet())
    fault.mainUnlink = true
    expect(one.d.clear()).toBe(false)
    const note = JSON.parse(readFileSync(marker(), 'utf8')) as { clearedAt?: unknown }
    expect(typeof note.clearedAt).toBe('number')
    // No staging file of the atomic write is left beside it.
    expect(readdirSync(join(tmp, 'CONFIG')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    fault.mainUnlink = false
    one.d.flushOnExit('before-quit')
    expect(existsSync(file())).toBe(false)
    expect(existsSync(marker())).toBe(false)
  })

  it('[host] a save after the clear replaces the set: the marker goes and the next start offers the saved set', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    fault.mainUnlink = true
    expect(one.d.clear()).toBe(false)
    expect(existsSync(marker())).toBe(true)
    // The user opens new tabs; the autosave writes over the held file.
    expect(one.d.saveEnriched(freshSet())).toBe(true)
    expect(existsSync(marker())).toBe(false)
    fault.mainUnlink = false
    one.d.flushOnExit('before-quit')
    expect(names((await run()).d.load())).toEqual(['Quarry'])
  })

  it('[host] a marker that could not be removed after that save never costs the saved state: the file saved after the clear is loaded', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    fault.mainUnlink = true
    one.d.clear()
    fault.markerUnlink = true
    expect(one.d.saveEnriched(freshSet())).toBe(true)
    one.d.flushOnExit('before-quit')
    expect(existsSync(marker())).toBe(true)
    fault.mainUnlink = false
    fault.markerUnlink = false
    const two = await run()
    expect(names(two.d.load())).toEqual(['Quarry'])
    expect(readFileSync(file(), 'utf8')).toMatch(/Quarry/)
    expect(existsSync(marker())).toBe(false)
  })

  // PR 4 re-review R-2: a marker that cannot be read, does not parse or holds
  // no time never removes a state saved after the clear. Its own modification
  // time (the atomic write made it at the clear) stands for the clear's.
  it('[host] a marker that cannot be read, does not parse or holds no time stands at its own time: a set saved before it is removed, one saved after it is kept', async () => {
    const now = Date.now()
    const markAt = new Date(now - 30_000)
    for (const [what, plant] of [
      ['does not parse', () => writeFileSync(marker(), '{ not json')],
      ['has no time in it', () => writeFileSync(marker(), JSON.stringify({ clearedAt: 'soon' }))],
      ['cannot be read', () => { writeFileSync(marker(), JSON.stringify({ clearedAt: 1 })); fault.markerRead = true }],
    ] as const) {
      // Saved before the marker's time: the cleared set, removed.
      const one = await run()
      one.d.saveEnriched({ ...theSet(), savedAt: now - 60_000 } as SessionState)
      plant()
      utimesSync(marker(), markAt, markAt)
      expect((await run()).d.load(), what).toBeNull()
      expect(existsSync(file()), what).toBe(false)
      expect(existsSync(marker()), what).toBe(false)
      fault.markerRead = false
      // Saved after it: kept, and the marker goes.
      const three = await run()
      three.d.saveEnriched({ ...freshSet(), savedAt: now - 10_000 } as SessionState)
      plant()
      utimesSync(marker(), markAt, markAt)
      expect(names((await run()).d.load()), what).toEqual(['Quarry'])
      expect(existsSync(marker()), what).toBe(false)
      fault.markerRead = false
    }
  })

  it("[host] when not even the marker's time can be read, nothing is removed or offered, the read-failure latch holds saves, and a later load tries again", async () => {
    const one = await run()
    one.d.saveEnriched(freshSet())
    writeFileSync(marker(), '{ not json')
    fault.markerRead = true
    fault.markerStat = true
    const two = await run()
    expect(two.d.load()).toBeNull()
    expect(two.ss.sessionStateReadFailed()).toBe(true)
    // Nothing is written over the file, and no clear removes it.
    expect(two.d.saveEnriched(theSet())).toBe(false)
    expect(two.d.clear()).toBe(false)
    expect(readFileSync(file(), 'utf8')).toMatch(/Quarry/)
    // The marker can be read again: a later load tells, and the latch lifts.
    fault.markerRead = false
    fault.markerStat = false
    writeFileSync(marker(), JSON.stringify({ clearedAt: 1 }))
    expect(names(two.d.load())).toEqual(['Quarry'])
    expect(two.ss.sessionStateReadFailed()).toBe(false)
    expect(existsSync(marker())).toBe(false)
  })

  it('[host] a saved file that cannot be read is never removed for an owed clear: nothing offered and saves held until a later load can read it', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    // A clear owed from a later time than that save.
    writeFileSync(marker(), JSON.stringify({ clearedAt: Date.now() + 60_000 }))
    fault.readBusy = true
    const two = await run()
    expect(two.d.load()).toBeNull()
    expect(two.ss.sessionStateReadFailed()).toBe(true)
    expect(two.d.saveEnriched(freshSet())).toBe(false)
    fault.readBusy = false
    expect(readFileSync(file(), 'utf8')).toMatch(/Orchard/)
    // Readable again but still held: the cleared set, owed as before, so the
    // hold on saves lifts (a save would replace the set).
    fault.mainUnlink = true
    expect(two.d.load()).toBeNull()
    expect(two.ss.sessionStateReadFailed()).toBe(false)
    expect(readFileSync(file(), 'utf8')).toMatch(/Orchard/)
    // Released: it is removed, and saves work.
    fault.mainUnlink = false
    expect(two.d.load()).toBeNull()
    expect(existsSync(file())).toBe(false)
    expect(two.ss.sessionStateReadFailed()).toBe(false)
    expect(two.d.saveEnriched(freshSet())).toBe(true)
  })

  it('[host] a damaged file whose .bak was saved after the clear is kept for the load to recover', async () => {
    const one = await run()
    one.d.saveEnriched(freshSet())
    writeFileSync(marker(), JSON.stringify({ clearedAt: Date.now() - 1_000 }))
    writeFileSync(file(), '{"sessions": [')
    expect(names((await run()).d.load())).toEqual(['Quarry'])
    expect(existsSync(marker())).toBe(false)
  })

  // PR 4 re-review R-1: a retry that fails keeps the time of the user's clear.
  it('[host] a failed retry keeps the time of the clear, so a state saved after the clear while the marker is held is never removed at the next start', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    fault.mainUnlink = true
    expect(one.d.clear()).toBe(false)
    const clearedAt = (JSON.parse(readFileSync(marker(), 'utf8')) as { clearedAt: number }).clearedAt
    // An autosave of a state built just after the clear cannot write the
    // file, and its retry of the clear fails a few seconds later.
    const later = { ...freshSet(), savedAt: clearedAt + 1 } as SessionState
    fault.mainWrite = true
    const clock = vi.spyOn(Date, 'now').mockReturnValue(clearedAt + 5_000)
    try {
      expect(one.d.saveEnriched(later)).toBe(false)
    } finally {
      clock.mockRestore()
    }
    expect((JSON.parse(readFileSync(marker(), 'utf8')) as { clearedAt: number }).clearedAt).toBe(clearedAt)
    // The exit flush saves that state; the marker cannot be removed.
    fault.mainWrite = false
    fault.markerUnlink = true
    one.d.flushOnExit('before-quit')
    expect(readFileSync(file(), 'utf8')).toMatch(/Quarry/)
    expect(existsSync(marker())).toBe(true)
    fault.mainUnlink = false
    fault.markerUnlink = false
    expect(names((await run()).d.load())).toEqual(['Quarry'])
  })

  it('[host] a marker that could not be written still holds the clear for the rest of the run, and a later retry writes it with the time of the clear', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    fault.mainUnlink = true
    fault.markerWrite = true
    expect(one.d.clear()).toBe(false)
    const afterClear = Date.now()
    expect(existsSync(marker())).toBe(false)
    expect(one.ss.loadSessionState()).toBeNull()
    expect(one.ss.hasSavedSessionState()).toBe(false)
    expect(h.logs.some((l) => /still owed/.test(l))).toBe(true)
    // The folder takes writes again; the next retry (still held) writes it.
    fault.markerWrite = false
    const clock = vi.spyOn(Date, 'now').mockReturnValue(afterClear + 10_000)
    try {
      one.d.flushOnExit('before-quit')
    } finally {
      clock.mockRestore()
    }
    const note = JSON.parse(readFileSync(marker(), 'utf8')) as { clearedAt: number }
    expect(note.clearedAt).toBeLessThanOrEqual(afterClear)
  })
})

describe('the GitHub sidebar reads nothing while a clear is owed (C-Q2)', () => {
  it('[host] its read answers nothing and never sets the read-failure latch, and its save replaces the set', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    fault.mainUnlink = true
    expect(one.d.clear()).toBe(false)
    // session:load answers nothing too; index.ts's loadSessions / saveSessions
    // read through peekSessionState.
    expect(one.ss.loadSessionState()).toBeNull()
    expect(one.ss.peekSessionState()).toBeNull()
    fault.readBusy = true
    expect(one.ss.peekSessionState()).toBeNull()
    expect(one.ss.sessionStateReadFailed()).toBe(false)
    fault.readBusy = false
    // A pure read: it never retries the removal, so the set is still there.
    fault.mainUnlink = false
    expect(one.ss.peekSessionState()).toBeNull()
    expect(readFileSync(file(), 'utf8')).toMatch(/Orchard/)
    // A profile removal patches what it read (nothing) and saves it back.
    const existing = one.ss.peekSessionState()
    expect(one.d.saveEnriched({ sessions: [], activeSessionId: existing?.activeSessionId ?? null, savedAt: Date.now() })).toBe(true)
    one.d.flushOnExit('before-quit')
    expect(names((await run()).d.load())).toEqual([])
    expect(readFileSync(file(), 'utf8')).not.toMatch(/Orchard/)
  })
})

// PR 4 follow-up (the defect the lane C fixer recorded): the GitHub sidebar's
// session reads used to go through loadSessionState, which sets and resets
// the read-failure latch. After a start whose load failed, a sidebar read that
// succeeded reset it, and a later close with no tabs then removed a saved file
// the window never showed. Its reads are pure reads now: they never set or
// reset the latch; a read that fails gives the sidebar nothing, and a save
// whose read fails writes nothing.
describe("the GitHub sidebar's session reads leave the save guard alone", () => {
  it('[host] a start whose load failed, then a sidebar read that succeeds: a close with no tabs never removes the file the window never showed', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    const two = await run()
    fault.readBusy = true
    expect(two.d.load()).toBeNull()
    expect(two.ss.sessionStateReadFailed()).toBe(true)
    fault.readBusy = false
    // The sidebar reads the saved sessions; the latch stays set.
    expect(names(two.ss.peekSessionState())).toEqual(['Orchard'])
    expect(two.ss.sessionStateReadFailed()).toBe(true)
    // The window closed with no tabs: the clear is still refused.
    expect(two.d.clear()).toBe(false)
    two.d.flushOnExit('before-quit')
    expect(readFileSync(file(), 'utf8')).toMatch(/Orchard/)
    expect(names((await run()).d.load())).toEqual(['Orchard'])
  })

  it('[host] a sidebar read that fails sets no latch and throws; nothing is moved aside, recovered or written', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    const listing = () => readdirSync(join(tmp, 'CONFIG')).sort()
    const before = listing()
    fault.readBusy = true
    expect(() => one.ss.peekSessionState()).toThrow()
    expect(one.ss.sessionStateReadFailed()).toBe(false)
    fault.readBusy = false
    // A damaged file with a good .bak: an error, never the .bak's set, and
    // the file is left where it is for the real load.
    writeFileSync(file(), '{"sessions": [')
    expect(() => one.ss.peekSessionState()).toThrow()
    expect(one.ss.sessionStateReadFailed()).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe('{"sessions": [')
    expect(listing()).toEqual(before)
    // No file: nothing saved.
    rmSync(file())
    expect(one.ss.peekSessionState()).toBeNull()
  })

  it('[host] the sidebar read drops malformed entries, as the load does, and writes nothing back', async () => {
    // (This file's config-manager stand-in leaves each entry's shape as it is.)
    const raw = JSON.stringify({ sessions: [null, 7, { id: 's3', name: 'Legacy', cwd: 'C:/work/legacy' }], activeSessionId: 's3', savedAt: 5 })
    const one = await run()
    writeFileSync(file(), raw)
    const read = one.ss.peekSessionState()
    expect(read?.sessions).toHaveLength(1)
    expect(read?.sessions[0]).toMatchObject({ id: 's3', name: 'Legacy' })
    expect(read?.activeSessionId).toBe('s3')
    expect(readFileSync(file(), 'utf8')).toBe(raw)
    expect(existsSync(`${file()}.bak`)).toBe(false)
  })

  it('[host] index.ts hands the sidebar the pure read: a failed read gives it nothing and its save writes nothing', () => {
    const index = readFileSync(join(__dirname, '../../../src/main/index.ts'), 'utf8')
    expect(index).not.toMatch(/\bloadSessionState\b/)
    const at = index.indexOf('registerGitHubHandlers({')
    expect(at).toBeGreaterThan(0)
    const block = index.slice(at, at + 2500)
    expect(block).toMatch(/loadSessions: async \(\) => \{\s*try \{\s*return peekSessionState\(\)\?\.sessions \?\? \[\]\s*\} catch \{\s*return \[\]\s*\}/)
    expect(block).toMatch(/try \{\s*existing = peekSessionState\(\)\s*\} catch \(err\) \{\s*logWarn\([^\n]*\)\s*return\s*\}/)
  })
})

describe('a clear the read-failure latch refused is not a held file (C-Q1)', () => {
  it('[host] nothing is retried and no marker is written; the next load still reads the file, which resets the latch', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    // The start: the file cannot be read, so the renderer is handed nothing.
    const two = await run()
    fault.readBusy = true
    expect(two.d.load()).toBeNull()
    expect(two.ss.sessionStateReadFailed()).toBe(true)
    // The window closed with no tabs: the clear is refused.
    expect(two.d.clear()).toBe(false)
    expect(existsSync(marker())).toBe(false)
    fault.readBusy = false
    // A reopened window's load reads the file: the latch is reset, saves work.
    expect(names(two.d.load())).toEqual(['Orchard'])
    expect(two.ss.sessionStateReadFailed()).toBe(false)
    expect(two.d.saveEnriched(freshSet())).toBe(true)
  })

  it('[host] a later read that resets the latch never lets a retry delete the set nobody saw', async () => {
    const one = await run()
    one.d.saveEnriched(theSet())
    const two = await run()
    fault.readBusy = true
    expect(two.d.load()).toBeNull()
    expect(two.d.clear()).toBe(false)
    fault.readBusy = false
    // The GitHub sidebar's own read succeeds and resets the latch.
    expect(names(two.ss.loadSessionState())).toEqual(['Orchard'])
    two.d.flushOnExit('before-quit')
    expect(readFileSync(file(), 'utf8')).toMatch(/Orchard/)
    expect(names((await run()).d.load())).toEqual(['Orchard'])
  })
})
