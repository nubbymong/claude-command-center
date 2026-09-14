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

const h = vi.hoisted(() => ({
  resourcesDir: '',
  failFor: null as string | null,
  failRenameFor: null as string | null,
  failWriteFor: null as string | null,
  /** Models a mapped/removable drive that is not attached: every path on it
   *  answers ENOENT, including the volume root. */
  unreachableRoot: false,
  errno: 'EBUSY',
}))

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
      if (h.unreachableRoot) {
        const err = new Error(`ENOENT: no such file or directory, open '${String(p)}'`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return real.readFileSync(p, o)
    },
    // The volume root itself disappears with the drive.
    existsSync: (p: any) => (h.unreachableRoot ? false : real.existsSync(p)),
    writeFileSync: (p: any, d: any, o: any) => {
      if (h.failWriteFor && String(p).includes(h.failWriteFor.replace(/\.json$/, ''))) {
        const err = new Error(`EACCES: permission denied, open '${String(p)}'`) as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return real.writeFileSync(p, d, o)
    },
    // Lets a test model "the file did not parse AND could not be quarantined".
    renameSync: (from: any, to: any) => {
      if (h.failRenameFor && String(from).endsWith(h.failRenameFor)) {
        const err = new Error(`EACCES: permission denied, rename '${String(from)}'`) as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return real.renameSync(from, to)
    },
  }
  return { ...patched, default: patched }
})

const { logError } = await import('../../../src/main/debug-logger')
const { readConfigChecked, writeConfig } = await import('../../../src/main/config-manager')
const { createReadFailureLatch, loadConfigLatched, saveConfigLatched, mergeById } = await import('../../../src/main/persist-latch')
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
  h.failRenameFor = null
  h.failWriteFor = null
  h.unreachableRoot = false
  h.errno = 'EBUSY'
  vi.mocked(logError).mockClear()
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

  /**
   * Review MAJOR-2. The first cut asked `existsSync` first, and `existsSync`
   * answers false for ANY stat error — a denied parent, an unmounted resources
   * directory, a share that blinked — so the one case with the widest blast
   * radius (the whole CONFIG directory unreachable) read as "fresh install".
   * Only ENOENT may mean absent.
   */
  it.each(['ENOTDIR', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'ELOOP'])(
    '%s means the file could not be READ, never that it is absent',
    (code) => {
      writeGoodAgents()
      h.failFor = 'cloud-agents.json'
      h.errno = code
      expect(readConfigChecked('cloudAgents').outcome).toBe('failed')
    },
  )

  it('ENOENT is the only error that means absent', () => {
    writeGoodAgents()
    h.failFor = 'cloud-agents.json'
    h.errno = 'ENOENT'
    expect(readConfigChecked('cloudAgents').outcome).toBe('absent')
  })

  /**
   * Review MAJOR-3. "Nothing is left to protect" is the entire justification
   * for letting writes continue after an unparseable read — and it is only true
   * once the file has ACTUALLY been moved aside. When the rename fails the file
   * is still sitting there, possibly hand-recoverable, and the next save would
   * overwrite it.
   */
  it('an unparseable file that could NOT be moved aside latches instead of allowing the overwrite', () => {
    writeFileSync(agentsFile(), '{ truncated by a power cut, 90% recoverable')
    const before = agentBytes()
    h.failRenameFor = 'cloud-agents.json'

    const r = readConfigChecked('cloudAgents')
    expect(r.outcome).toBe('failed')

    const latch = createReadFailureLatch('test')
    latch.note(r.outcome)
    expect(saveConfigLatched('cloudAgents', () => [], latch)).toBe(false)

    h.failRenameFor = null
    expect(agentBytes()).toBe(before)
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
    writeConfig('magicButtons', [{ id: 'mb-1' }])
    const agentsLatch = createReadFailureLatch('agents')
    const buttonsLatch = createReadFailureLatch('buttons')

    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', agentsLatch)
    loadConfigLatched('magicButtons', buttonsLatch)

    expect(agentsLatch.failed()).toBe(true)
    expect(buttonsLatch.failed()).toBe(false)
    expect(saveConfigLatched('magicButtons', [{ id: 'mb-2' }], buttonsLatch)).toBe(true)
  })
})

/**
 * Review findings on #406. The first cut latched correctly and then never
 * un-latched: five of the six persisters load exactly once, at boot, so a
 * single 50 ms lock disabled persistence for the whole process — and every
 * refused write was reported to the caller as a success. Both halves are worse
 * than the bug they replaced, so both are pinned here.
 */
describe('a latched save retries the read rather than refusing forever', () => {
  it('recovers, folds the file back in, and writes — no second load needed', () => {
    writeGoodAgents()
    const latch = createReadFailureLatch('test')

    h.failFor = 'cloud-agents.json'
    expect(loadConfigLatched('cloudAgents', latch)).toBeNull()
    expect(latch.failed()).toBe(true)

    // The lock lifts. Nothing re-loads — this is the production shape, where
    // init ran once at boot and only saves happen from here on.
    h.failFor = null
    let recovered: unknown = 'never called'
    const inMemory = [{ id: 'ca-new', name: 'made while the file was locked' }]
    expect(
      saveConfigLatched('cloudAgents', () => inMemory, latch, { onRecovered: (r) => { recovered = r } }),
    ).toBe(true)

    // The owner was handed the file it never managed to read…
    expect(recovered).toEqual(GOOD)
    expect(latch.failed()).toBe(false)
  })

  it('still refuses while the file is STILL unreadable, and leaves the bytes alone', () => {
    writeGoodAgents()
    const before = agentBytes()
    const latch = createReadFailureLatch('test')

    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', latch)
    expect(saveConfigLatched('cloudAgents', () => [], latch)).toBe(false)

    h.failFor = null
    expect(agentBytes()).toBe(before)
  })

  it('evaluates the value AFTER recovery, so the merged state is what lands', () => {
    writeGoodAgents()
    const latch = createReadFailureLatch('test')
    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', latch)

    // Exactly how the persisters use it: the thunk reads module state that
    // `onRecovered` has just merged into.
    h.failFor = null
    let state: unknown[] = [{ id: 'ca-new' }]
    saveConfigLatched('cloudAgents', () => state, latch, {
      onRecovered: (r) => { state = mergeById(r, state as { id?: unknown }[]) },
    })

    const onDisk = readConfigChecked<Array<{ id: string }>>('cloudAgents').value!
    expect(onDisk.map((a) => a.id).sort()).toEqual(['ca-1', 'ca-new'])
  })

  it('the refusal is logged once per latch, not once per save', () => {
    writeGoodAgents()
    const latch = createReadFailureLatch('test')
    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', latch)

    // `saveSnapshots` runs on every usage poll; a line per poll for the life of
    // the process is noise that buries the one that matters.
    for (let i = 0; i < 5; i++) expect(saveConfigLatched('cloudAgents', () => [], latch)).toBe(false)
    const refusals = vi.mocked(logError).mock.calls.filter((c) => String(c[0]).includes('refusing to save'))
    expect(refusals).toHaveLength(1)
  })
})

/**
 * #371 ADR-009 pass — two clobber paths the RETRY itself introduced.
 */
describe('a recovery whose write then fails does not become a silent total loss', () => {
  it('re-latches, so the next save re-reads instead of overwriting with the failed-load state', () => {
    writeGoodAgents()
    const latch = createReadFailureLatch('test')
    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', latch)
    expect(latch.failed()).toBe(true)

    // The file becomes readable, the recovery runs — and the WRITE fails.
    h.failFor = null
    h.failWriteFor = 'cloud-agents.json'
    let recovered: unknown = null
    expect(
      saveConfigLatched('cloudAgents', () => [{ id: 'ca-new' }], latch, { onRecovered: (r) => { recovered = r } }),
    ).toBe(false)
    expect(recovered).toEqual(GOOD)

    // The caller now rolls back to its PRE-recovery snapshot (the small set
    // built from the failed load). If the latch had stayed clear, that would be
    // written over the good file next time and reported as a success.
    expect(latch.failed()).toBe(true)

    h.failWriteFor = null
    expect(saveConfigLatched('cloudAgents', () => [{ id: 'ca-new' }], latch, {
      onRecovered: (r) => { recovered = r },
    })).toBe(true)
    // It re-read and merged again rather than clobbering.
    expect(recovered).toEqual(GOOD)
  })

  it('retry:false refuses outright — for a store with nothing to merge', () => {
    writeGoodAgents()
    const before = agentBytes()
    const latch = createReadFailureLatch('test')
    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', latch)

    // The file is readable again, but a single-object store must NOT be
    // recovered-then-overwritten with its in-memory fallback.
    h.failFor = null
    expect(saveConfigLatched('cloudAgents', () => [], latch, { retry: false })).toBe(false)
    expect(agentBytes()).toBe(before)
  })
})

describe('an unreachable resources volume is not a fresh install', () => {
  it('ENOENT with the root gone is a read FAILURE, not an absence', () => {
    // What a mapped network drive that has not reconnected, or a removable
    // drive not yet attached at logon, answers for every path on it.
    h.unreachableRoot = true
    expect(readConfigChecked('cloudAgents').outcome).toBe('failed')
  })

  it('ENOENT with the root present is a genuine absence — a fresh install must still write', () => {
    rmSync(agentsFile(), { force: true })
    expect(readConfigChecked('cloudAgents').outcome).toBe('absent')
    const latch = createReadFailureLatch('test')
    expect(loadConfigLatched('cloudAgents', latch)).toBeNull()
    expect(latch.failed()).toBe(false)
    expect(saveConfigLatched('cloudAgents', () => GOOD, latch)).toBe(true)
  })
})

describe('the generation changes only on recovery', () => {
  it('an ordinary re-read does not invalidate a form built from the last one', () => {
    writeGoodAgents()
    const latch = createReadFailureLatch('test')
    loadConfigLatched('cloudAgents', latch)
    const g = latch.generation()
    loadConfigLatched('cloudAgents', latch)
    expect(latch.generation()).toBe(g)
  })

  it('a load that succeeds AFTER a failure does invalidate it', () => {
    writeGoodAgents()
    const latch = createReadFailureLatch('test')
    loadConfigLatched('cloudAgents', latch)
    const g = latch.generation()

    h.failFor = 'cloud-agents.json'
    loadConfigLatched('cloudAgents', latch)
    expect(latch.generation()).toBe(g) // a FAILED read is not a new generation

    h.failFor = null
    loadConfigLatched('cloudAgents', latch)
    expect(latch.generation()).not.toBe(g)
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
