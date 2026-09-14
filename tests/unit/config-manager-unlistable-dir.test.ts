import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// CONFIG/ exists, its files read fine BY NAME, but the directory cannot be
// LISTED (a deny-read ACL on the dir, a share that refuses enumeration).
// `configHasData` used to read that as "empty" -> needsMigration:true -> the
// renderer re-migrated the v1 localStorage snapshot over files that were
// perfectly readable. It is a read failure: writes latch, no migration.
// Found by the re-attack round of the beta.16 ADR-009 pass.

const h = vi.hoisted(() => ({ resourcesDir: '', failReaddir: false }))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    readdirSync: (p: any, o: any) => {
      if (h.failReaddir && String(p).replace(/\\/g, '/').endsWith('/CONFIG')) {
        const err = new Error(`EPERM: operation not permitted, scandir '${String(p)}'`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return real.readdirSync(p, o)
    },
  }
  return { ...patched, default: patched }
})

import { loadAllConfig, configHasData } from '../../src/main/config-manager'

let tmp = ''
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cfg-unlist-'))
  h.resourcesDir = tmp
  mkdirSync(join(tmp, 'CONFIG'), { recursive: true })
  writeFileSync(join(tmp, 'CONFIG', 'settings.json'), JSON.stringify({ theme: 'mocha' }))
  writeFileSync(join(tmp, 'CONFIG', 'commands.json'), JSON.stringify([{ id: 'c1' }]))
})
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('an unlistable CONFIG directory', () => {
  it('is reported as a read failure with the data that WAS readable, never as a fresh install', () => {
    h.failReaddir = false
    expect(configHasData()).toBe(true)
    const fine = loadAllConfig()
    expect(fine.needsMigration).toBe(false)
    expect(fine.readFailed).toBe(false)

    h.failReaddir = true
    expect(configHasData()).toBe('unknown')
    const r = loadAllConfig()
    expect(r.readFailed).toBe(true)
    expect(r.needsMigration).toBe(false)
    // The files were readable by name -- the renderer still gets them (and latches).
    expect(r.data.settings).toEqual({ theme: 'mocha' })
    expect(r.data.commands).toEqual([{ id: 'c1' }])
    h.failReaddir = false
  })
})
