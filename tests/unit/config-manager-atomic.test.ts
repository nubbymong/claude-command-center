import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

// Real-fs atomicity tests for writeConfig. The long-standing mocked suite
// (config-manager.test.ts) stubs fs entirely and cannot see truncate-vs-rename
// semantics — this file uses the REAL filesystem with targeted fault injection.

const fsControl = vi.hoisted(() => ({
  failNextWrite: false,
  failNextRename: false,
  copyCalls: 0,
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    copyFileSync: ((...args: Parameters<typeof real.copyFileSync>) => {
      fsControl.copyCalls++
      return real.copyFileSync(...args)
    }) as typeof real.copyFileSync,
    writeFileSync: ((...args: Parameters<typeof real.writeFileSync>) => {
      if (fsControl.failNextWrite) {
        fsControl.failNextWrite = false
        throw new Error('ENOSPC (injected)')
      }
      return real.writeFileSync(...args)
    }) as typeof real.writeFileSync,
    renameSync: ((...args: Parameters<typeof real.renameSync>) => {
      if (fsControl.failNextRename) {
        fsControl.failNextRename = false
        throw new Error('EPERM (injected)')
      }
      return real.renameSync(...args)
    }) as typeof real.renameSync,
  }
})

vi.mock('../../src/main/ipc/setup-handlers', () => {
  // Real temp dir created at module-mock time; the factory cannot close over
  // outer variables (hoisting), so it builds its own.
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-cfg-atomic-'))
  return { getResourcesDirectory: () => dir }
})

vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}))

const { writeConfig, readConfig, getConfigDir } = await import('../../src/main/config-manager')
const realFs = (await vi.importActual('fs')) as typeof import('fs')

function configFilePath(): string {
  return join(getConfigDir(), 'settings.json')
}

function tmpLeftovers(): string[] {
  return realFs.readdirSync(getConfigDir()).filter((e) => e.includes('.tmp'))
}

describe('writeConfig atomicity (real fs)', () => {
  beforeEach(() => {
    fsControl.failNextWrite = false
    fsControl.failNextRename = false
    fsControl.copyCalls = 0
    realFs.rmSync(getConfigDir(), { recursive: true, force: true })
  })

  it('overwrites via atomic rename — never the truncate-and-copy path', () => {
    expect(writeConfig('settings', { v: 1 })).toBe(true)
    expect(writeConfig('settings', { v: 2 })).toBe(true)
    expect(readConfig('settings')).toEqual({ v: 2 })
    // copyFileSync truncates the destination in place before writing — a crash
    // mid-copy corrupts the config. Overwrite must go through renameSync
    // (atomic replace on POSIX and on Windows via MoveFileExW+REPLACE_EXISTING).
    expect(fsControl.copyCalls).toBe(0)
    expect(tmpLeftovers()).toEqual([])
  })

  it('rename failure on overwrite leaves the original intact, cleans tmp, returns false', () => {
    expect(writeConfig('settings', { v: 1 })).toBe(true)
    fsControl.failNextRename = true
    expect(writeConfig('settings', { v: 2 })).toBe(false)
    expect(readConfig('settings')).toEqual({ v: 1 })
    expect(tmpLeftovers()).toEqual([])
  })

  it('tmp-write failure leaves the original intact and returns false', () => {
    expect(writeConfig('settings', { v: 1 })).toBe(true)
    fsControl.failNextWrite = true
    expect(writeConfig('settings', { v: 2 })).toBe(false)
    expect(readConfig('settings')).toEqual({ v: 1 })
    expect(tmpLeftovers()).toEqual([])
  })

  it('repeated overwrites leave exactly the final content and no debris', () => {
    for (let i = 1; i <= 5; i++) expect(writeConfig('settings', { v: i })).toBe(true)
    expect(readConfig('settings')).toEqual({ v: 5 })
    const entries = realFs.readdirSync(getConfigDir())
    expect(entries).toEqual(['settings.json'])
  })
})
