// [host] A test that keeps the real debug-logger keeps its log inside its own folder.
//
// Covers tests/helpers/test-data-dir.ts. The real logger appends to
// <data folder>/debug/app.log, and the real getDataDirectory() reads the installed
// app's folder from the registry, which is inside the real LOCALAPPDATA wherever the
// app is installed. The helper pins the folder to a fresh one under the test's temp
// root, so: the REAL getDataDirectory() returns it and never reads the registry, the
// REAL logger writes app.log there, and the variable goes back to what it was when the
// describe (or file) that pinned it is done.
//
// The registry is stubbed and only records, so a run without the pin reads nothing
// real and writes nothing real (the logger would then go to the isolated home's
// default folder, and the assertions below fail).
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isRealHomePath } from '../../helpers/home-guard-core.mjs'

vi.unmock('../../../src/main/debug-logger')

const h = vi.hoisted(() => ({ registryReads: [] as string[] }))
vi.mock('../../../src/main/registry', () => ({
  readRegistry: (name: string) => { h.registryReads.push(name); return null },
  writeRegistry: vi.fn(),
  migrateRegistryKeys: vi.fn(),
}))

const TEST_DATA = await vi.hoisted(async () => (await import('../../helpers/test-data-dir')).useTestDataDirectory())

const { DATA_DIR_ENV, pinTestDataDirectory, useTestDataDirectory } = await import('../../helpers/test-data-dir')
const { getDataDirectory } = await import('../../../src/main/data-paths')
const { logInfo, getLogDir, closeDebugLogger } = await import('../../../src/main/debug-logger')

// Resolved while the file is collected, before the describe below pins a folder of its
// own: data-paths keeps the first answer for the life of the module.
const RESOLVED = getDataDirectory()

describe('useTestDataDirectory', () => {
  it('pins a fresh folder under the test temp root, never a real home', () => {
    expect(fs.statSync(TEST_DATA).isDirectory()).toBe(true)
    const rel = path.relative(os.tmpdir(), TEST_DATA)
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(false)
    expect(path.basename(TEST_DATA).startsWith('ccc-test-data-')).toBe(true)
    expect(isRealHomePath(TEST_DATA)).toBe(false)
  })

  it('the real data folder is the pinned one, and the registry is never read', () => {
    expect(RESOLVED).toBe(TEST_DATA)
    expect(getDataDirectory()).toBe(TEST_DATA)
    expect(h.registryReads).toEqual([])
  })

  it('the real logger writes app.log inside the pinned folder', async () => {
    const marker = `test-data-dir marker ${process.pid}-${Date.now()}`
    logInfo(marker)
    expect(getLogDir()).toBe(path.join(TEST_DATA, 'debug'))
    closeDebugLogger()
    const log = path.join(TEST_DATA, 'debug', 'app.log')
    await vi.waitFor(() => {
      expect(fs.readFileSync(log, 'utf8')).toContain(marker)
    })
    expect(h.registryReads).toEqual([])
  })
})

describe('pinTestDataDirectory', () => {
  it('sets the variable to a fresh folder each time, and restore() puts back the value before it', () => {
    const before = process.env[DATA_DIR_ENV]
    const a = pinTestDataDirectory()
    expect(process.env[DATA_DIR_ENV]).toBe(a.dir)
    const b = pinTestDataDirectory()
    expect(b.dir).not.toBe(a.dir)
    expect(process.env[DATA_DIR_ENV]).toBe(b.dir)
    b.restore()
    expect(process.env[DATA_DIR_ENV]).toBe(a.dir)
    a.restore()
    expect(process.env[DATA_DIR_ENV]).toBe(before)
  })

  it('an unset variable is unset again after restore()', () => {
    const saved = process.env[DATA_DIR_ENV]
    delete process.env[DATA_DIR_ENV]
    try {
      const pin = pinTestDataDirectory()
      expect(process.env[DATA_DIR_ENV]).toBe(pin.dir)
      pin.restore()
      expect(DATA_DIR_ENV in process.env).toBe(false)
    } finally {
      if (saved === undefined) delete process.env[DATA_DIR_ENV]
      else process.env[DATA_DIR_ENV] = saved
    }
  })
})

// useTestDataDirectory registers the restore with afterAll on the suite that called it.
// This describe pins a folder of its own while the file is collected; the next one runs
// after its afterAll and sees the file's folder again.
let inner = ''
describe('a describe that pins a folder of its own', () => {
  inner = useTestDataDirectory()
  it('has the variable on its own folder while it runs', () => {
    expect(inner).not.toBe(TEST_DATA)
    expect(process.env[DATA_DIR_ENV]).toBe(inner)
  })
})

describe('after the describe that pinned its own folder', () => {
  it("its afterAll put the variable back on the file's folder", () => {
    expect(inner).not.toBe('')
    expect(process.env[DATA_DIR_ENV]).toBe(TEST_DATA)
  })
})
