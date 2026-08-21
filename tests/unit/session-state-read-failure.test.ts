import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A failed READ of session-state.json is not an absence. Before this, an
// AV scanner holding the file for a moment (EBUSY) made loadSessionState()
// answer null exactly as for "no file"; the renderer saw no saved sessions,
// and at close wrote the EMPTY list over the saved one -- the file's whole
// purpose defeated by the one thing it was supposed to survive. Found by the
// re-attack round of the beta.16 ADR-009 pass (main-side twin of the renderer
// config-write latch, #341/#353). Pre-existing since session-state.ts began.

const h = vi.hoisted(() => ({
  resourcesDir: '',
  failReads: false,
  errno: 'EBUSY',
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }))

// Only session-state.json reads fail, and only while the flag is on; every
// other fs call is real (the atomic writer, the config dir hardening, ...).
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    readFileSync: (p: any, o: any) => {
      if (h.failReads && String(p).endsWith('session-state.json')) {
        const err = new Error(`${h.errno}: resource busy or locked, open '${String(p)}'`) as NodeJS.ErrnoException
        err.code = h.errno
        throw err
      }
      return real.readFileSync(p, o)
    },
  }
  return { ...patched, default: patched }
})

import { loadSessionState, saveSessionState, clearSessionState, sessionStateReadFailed } from '../../src/main/session-state'

const saved = {
  sessions: [
    { id: 's1', configId: 'c1', name: 'one', provider: 'claude' },
    { id: 's2', configId: 'c2', name: 'two', provider: 'claude' },
  ],
  savedAt: 1_700_000_000_000,
} as unknown as import('../../src/main/session-state').SessionState

const empty = { sessions: [], savedAt: 1_700_000_000_001 } as unknown as import('../../src/main/session-state').SessionState

let tmp = ''
const file = () => join(tmp, 'CONFIG', 'session-state.json')

beforeAll(() => {
  // One resources dir for the file: config-manager caches the CONFIG path.
  tmp = mkdtempSync(join(tmpdir(), 'ss-latch-'))
  h.resourcesDir = tmp
  mkdirSync(join(tmp, 'CONFIG'), { recursive: true })
})

beforeEach(() => {
  h.failReads = false
  h.errno = 'EBUSY'
  // Reset the latch by performing a successful load over a known file.
  writeFileSync(file(), JSON.stringify(saved))
  expect(loadSessionState()?.sessions.length).toBe(2)
  expect(sessionStateReadFailed()).toBe(false)
})

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('a read failure latches save and clear off', () => {
  it('EBUSY on load: null, latched, the next save is refused and the two saved sessions survive', () => {
    const before = readFileSync(file(), 'utf-8')
    h.failReads = true
    expect(loadSessionState()).toBeNull()
    expect(sessionStateReadFailed()).toBe(true)
    h.failReads = false

    expect(saveSessionState(empty)).toBe(false)
    expect(readFileSync(file(), 'utf-8')).toBe(before)
    expect(JSON.parse(readFileSync(file(), 'utf-8')).sessions).toHaveLength(2)

    expect(clearSessionState()).toBe(false)
    expect(existsSync(file())).toBe(true)
  })

  it('the latch clears on the next successful load, and saving works again', () => {
    h.failReads = true
    expect(loadSessionState()).toBeNull()
    expect(sessionStateReadFailed()).toBe(true)
    h.failReads = false
    expect(loadSessionState()?.sessions.length).toBe(2)
    expect(sessionStateReadFailed()).toBe(false)
    expect(saveSessionState(empty)).toBe(true)
    expect(JSON.parse(readFileSync(file(), 'utf-8')).sessions).toHaveLength(0)
  })

  it('EACCES / EPERM are read failures too', () => {
    for (const code of ['EACCES', 'EPERM', 'EIO']) {
      h.errno = code
      h.failReads = true
      expect(loadSessionState(), code).toBeNull()
      expect(sessionStateReadFailed(), code).toBe(true)
      h.failReads = false
      expect(saveSessionState(empty), code).toBe(false)
      expect(loadSessionState()?.sessions.length, code).toBe(2)
    }
  })
})

describe('an absent file and an unparseable file are NOT read failures', () => {
  it('no file: null, not latched, save allowed', () => {
    rmSync(file(), { force: true })
    expect(loadSessionState()).toBeNull()
    expect(sessionStateReadFailed()).toBe(false)
    expect(saveSessionState(empty)).toBe(true)
  })

  it('garbage content: moved aside (never destroyed), null, not latched, save allowed', () => {
    writeFileSync(file(), '{ this is not json')
    expect(loadSessionState()).toBeNull()
    expect(sessionStateReadFailed()).toBe(false)
    const aside = readdirSync(join(tmp, 'CONFIG')).filter((f) => f.startsWith('session-state.json.corrupt-'))
    expect(aside.length).toBeGreaterThanOrEqual(1)
    expect(readFileSync(join(tmp, 'CONFIG', aside[aside.length - 1]), 'utf-8')).toBe('{ this is not json')
    expect(saveSessionState(empty)).toBe(true)
    expect(JSON.parse(readFileSync(file(), 'utf-8')).sessions).toHaveLength(0)
  })
})
