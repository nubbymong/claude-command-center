/**
 * The shared null-vs-failed pattern for main-side persisters (#371).
 *
 * The ADR-009 pass before beta.16 fixed this shape for saved sessions (#353)
 * and left a note: five other main-side persisters conflate "no file" with
 * "could not read the file", and it wanted ONE shared fix rather than five
 * copies. `persist-latch.ts` is that fix; these tests are its spec.
 *
 * The whole point is a distinction, so every test here has to be able to tell
 * the three outcomes apart on the ONE thing that matters — whether the bytes on
 * disk survive. A test that only checked a return value would pass against a
 * latch that never latched.
 *
 * Real fs, real config-manager: the failure being modelled is an fs failure, so
 * mocking the layer under test would prove nothing. Only `readFileSync` is
 * patched, and only for the file each test names.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync as realReadFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({ resourcesDir: '', failFor: null as string | null, errno: 'EBUSY' }))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(), logTrace: vi.fn(),
}))

// Only the named file fails, and only on READ. Everything else — the atomic
// write's staging file, the directory hardening — really runs.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    readFileSync: (p: any, o: any) => {
      if (h.failFor && String(p).endsWith(h.failFor)) {
        const err = new Error(`${h.errno}: resource busy or locked, open '${String(p)}'`) as NodeJS.ErrnoException
        err.code = h.errno
        throw err
      }
      return real.readFileSync(p, o)
    },
  }
  return { ...patched, default: patched }
})

const { readConfigChecked, writeConfig } = await import('../../../src/main/config-manager')
const { createReadFailureLatch, loadConfigLatched, saveConfigLatched } = await import('../../../src/main/persist-latch')
const windowState = await import('../../../src/main/window-state')

let configDir = ''

beforeAll(() => {
  // One dir for the whole file: getConfigDir() caches its answer.
  h.resourcesDir = mkdtempSync(join(tmpdir(), 'persist-latch-'))
  configDir = join(h.resourcesDir, 'CONFIG')
  mkdirSync(configDir, { recursive: true })
})

afterAll(() => {
  try { rmSync(h.resourcesDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

beforeEach(() => {
  h.failFor = null
  h.errno = 'EBUSY'
  windowState._resetWindowStateLatchForTest()
})

// Lazy: `configDir` is only known once beforeAll has made the temp dir.
const agentsFile = () => join(configDir, 'cloud-agents.json')
const GOOD = [{ id: 'ca-1', name: 'the user\'s real agent' }]
const writeGoodAgents = () => writeFileSync(agentsFile(), JSON.stringify(GOOD, null, 2))
const agentBytes = () => realReadFileSync(agentsFile(), 'utf-8')

describe('readConfigChecked tells the three ways to get nothing apart', () => {
  it('a file that is not there is ABSENT, not a failure', () => {
    try { rmSync(agentsFile(), { force: true }) } catch { /* fine */ }
    const r = readConfigChecked('cloudAgents')
    expect(r.outcome).toBe('absent')
    expect(r.value).toBeNull()
  })

  it('a file that reads and parses is OK', () => {
    writeGoodAgents()
    const r = readConfigChecked('cloudAgents')
    expect(r.outcome).toBe('ok')
    expect(r.value).toEqual(GOOD)
  })

  it('a file that cannot be READ is FAILED, and is left exactly as it was', () => {
    writeGoodAgents()
    const before = agentBytes()
    h.failFor = 'cloud-agents.json'
    const r = readConfigChecked('cloudAgents')
    expect(r.outcome).toBe('failed')
    expect(r.value).toBeNull()
    h.failFor = null
    expect(agentBytes()).toBe(before)
  })

  it.each(['EACCES', 'EPERM', 'EIO'])('%s is a read failure too, not an absence', (code) => {
    writeGoodAgents()
    h.failFor = 'cloud-agents.json'
    h.errno = code
    expect(readConfigChecked('cloudAgents').outcome).toBe('failed')
  })

  it('a file that reads but does not PARSE is UNPARSEABLE, and is moved aside rather than destroyed', () => {
    writeFileSync(agentsFile(), '{ this is not json')
    const r = readConfigChecked('cloudAgents')
    expect(r.outcome).toBe('unparseable')
    expect(r.value).toBeNull()
    expect(existsSync(agentsFile())).toBe(false)
    const aside = readdirSync(configDir).filter((f) => f.startsWith('cloud-agents.json.corrupt-'))
    expect(aside).toHaveLength(1)
    // The original bytes are kept for forensics, not silently dropped.
    expect(realReadFileSync(join(configDir, aside[0]), 'utf-8')).toBe('{ this is not json')
    for (const f of aside) rmSync(join(configDir, f), { force: true })
  })

  it('an unregistered key is FAILED, not absent — writeConfig refuses it, so an empty store could never be saved', () => {
    const r = readConfigChecked('nope' as never)
    expect(r.outcome).toBe('failed')
  })
})

describe('the latch refuses writes only after a READ failure', () => {
  it('a read failure latches, and the refused save leaves the file untouched', () => {
    writeGoodAgents()
    const before = agentBytes()
    const latch = createReadFailureLatch('test')

    h.failFor = 'cloud-agents.json'
    expect(loadConfigLatched('cloudAgents', latch)).toBeNull()
    expect(latch.failed()).toBe(true)

    // What every one of the five persisters does next: build an empty store and
    // save it. This is the write that used to destroy the file.
    expect(saveConfigLatched('cloudAgents', [], latch)).toBe(false)

    h.failFor = null
    expect(agentBytes()).toBe(before)
    expect(readConfigChecked('cloudAgents').value).toEqual(GOOD)
  })

  it('a later successful load clears the latch and writing resumes', () => {
    writeGoodAgents()
    const latch = createReadFailureLatch('test')

    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', latch)
    expect(latch.failed()).toBe(true)

    h.failFor = null
    expect(loadConfigLatched('cloudAgents', latch)).toEqual(GOOD)
    expect(latch.failed()).toBe(false)
    expect(saveConfigLatched('cloudAgents', [{ id: 'ca-2' }], latch)).toBe(true)
    expect(readConfigChecked('cloudAgents').value).toEqual([{ id: 'ca-2' }])
  })

  it('an ABSENT file does not latch — an empty store really is the truth, and must be savable', () => {
    rmSync(agentsFile(), { force: true })
    const latch = createReadFailureLatch('test')
    expect(loadConfigLatched('cloudAgents', latch)).toBeNull()
    expect(latch.failed()).toBe(false)
    expect(saveConfigLatched('cloudAgents', GOOD, latch)).toBe(true)
  })

  it('an UNPARSEABLE file does not latch — its content is already unrecoverable and has been kept aside', () => {
    writeFileSync(agentsFile(), 'not json at all')
    const latch = createReadFailureLatch('test')
    expect(loadConfigLatched('cloudAgents', latch)).toBeNull()
    expect(latch.failed()).toBe(false)
    expect(saveConfigLatched('cloudAgents', GOOD, latch)).toBe(true)
    for (const f of readdirSync(configDir).filter((n) => n.includes('.corrupt-'))) rmSync(join(configDir, f), { force: true })
  })

  it('refuses `clear` for the same reason it refuses `save`', () => {
    writeGoodAgents()
    const latch = createReadFailureLatch('test')
    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', latch)
    expect(latch.refuses('clear')).toBe(true)
    h.failFor = null
    expect(readConfigChecked('cloudAgents').value).toEqual(GOOD)
  })

  it('one persister\'s read failure says nothing about another\'s', () => {
    writeGoodAgents()
    writeConfig('agentTeams', [{ id: 't-1' }])
    const agentsLatch = createReadFailureLatch('agents')
    const teamsLatch = createReadFailureLatch('teams')

    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', agentsLatch)
    loadConfigLatched('agentTeams', teamsLatch)

    expect(agentsLatch.failed()).toBe(true)
    expect(teamsLatch.failed()).toBe(false)
    expect(saveConfigLatched('agentTeams', [{ id: 't-2' }], teamsLatch)).toBe(true)
  })
})

describe('window geometry (the persister that hid its failure best)', () => {
  const wsFile = () => join(configDir, 'window-state.json')
  const REAL = { x: 100, y: 120, width: 1280, height: 800, isMaximized: false }

  it('reads the saved geometry back', () => {
    writeFileSync(wsFile(), JSON.stringify(REAL))
    expect(windowState.loadWindowState()).toEqual(REAL)
    expect(windowState.windowStateReadFailed()).toBe(false)
  })

  it('still opens a window on a read failure, but never writes the default back over the real geometry', () => {
    writeFileSync(wsFile(), JSON.stringify(REAL))
    h.failFor = 'window-state.json'

    // The window must still open at SOME size.
    expect(windowState.loadWindowState()).toEqual(windowState.DEFAULT_WINDOW_STATE)
    expect(windowState.windowStateReadFailed()).toBe(true)

    // The close handler fires with the geometry of a window that opened at the
    // default. Before #371 this is the write that lost the user's layout.
    expect(windowState.saveWindowState({ x: 0, y: 0, width: 3200, height: 1800, isMaximized: false })).toBe(false)

    h.failFor = null
    expect(JSON.parse(realReadFileSync(wsFile(), 'utf-8'))).toEqual(REAL)
  })

  it('a missing file is an absence: the default opens AND is saved', () => {
    rmSync(wsFile(), { force: true })
    expect(windowState.loadWindowState()).toEqual(windowState.DEFAULT_WINDOW_STATE)
    expect(windowState.windowStateReadFailed()).toBe(false)
    expect(windowState.saveWindowState(REAL)).toBe(true)
    expect(JSON.parse(realReadFileSync(wsFile(), 'utf-8'))).toEqual(REAL)
  })

  it('geometry without usable width/height falls back to the default', () => {
    writeFileSync(wsFile(), JSON.stringify({ isMaximized: true }))
    expect(windowState.loadWindowState()).toEqual(windowState.DEFAULT_WINDOW_STATE)
  })

  it('writes to the same path the hand-rolled version used, so upgrading installs keep their geometry', () => {
    rmSync(wsFile(), { force: true })
    windowState.saveWindowState(REAL)
    expect(existsSync(join(configDir, 'window-state.json'))).toBe(true)
  })
})
