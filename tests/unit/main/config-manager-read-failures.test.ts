/**
 * A config READ that fails must say so. Two failures used to RESOLVE as if
 * nothing were wrong (ADR-009 pass, beta.16; pre-existing in every shipped
 * build): a CONFIG dir that cannot be reached at boot came back as "empty,
 * needs migration", and a file that exists but cannot be read or parsed came
 * back as null -- indistinguishable from "never written" -- so the boot
 * migrations and the stores wrote defaults over files that were fine.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-read-'))
const CONFIG = path.join(TMP, 'CONFIG')
vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => TMP,
  registerSetupHandlers: vi.fn(),
}))
let throwOnMkdir: Error | null = null
vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/account-profiles')>()
  return {
    ...actual,
    mkdirSecure: (...a: unknown[]) => {
      if (throwOnMkdir) { const e = throwOnMkdir; throwOnMkdir = null; throw e }
      return (actual.mkdirSecure as (...x: unknown[]) => unknown)(...a)
    },
  }
})

const { loadAllConfig } = await import('../../../src/main/config-manager')

const write = (name: string, text: string) => { fs.mkdirSync(CONFIG, { recursive: true }); fs.writeFileSync(path.join(CONFIG, name), text) }
const wipe = () => { fs.rmSync(CONFIG, { recursive: true, force: true }) }

beforeEach(() => { wipe(); throwOnMkdir = null })
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

describe('loadAllConfig reports read failures explicitly', () => {
  it('a clean read: data, no failures, not a fresh install', () => {
    write('settings.json', JSON.stringify({ theme: 'light', localMachineName: 'MY-BOX' }))
    write('commands.json', '[]')
    const r = loadAllConfig()
    expect(r.readFailed).toBe(false)
    expect(r.failedKeys).toEqual([])
    expect(r.needsMigration).toBe(false)
    expect(r.data.settings).toEqual({ theme: 'light', localMachineName: 'MY-BOX' })
  })

  it('a file that does not exist is ABSENT, not failed', () => {
    write('commands.json', '[]')
    const r = loadAllConfig()
    expect(r.data.settings).toBeNull()
    expect(r.failedKeys).toEqual([])
  })

  it('a file that does not PARSE is a failed key, its data null, and it is not a fresh install', () => {
    write('settings.json', '{"theme":"light","localMachineName":"MY-BO')   // truncated
    write('commands.json', '[]')
    const r = loadAllConfig()
    expect(r.readFailed).toBe(false)
    expect(r.failedKeys).toEqual(['settings'])
    expect(r.data.settings).toBeNull()
    expect(r.needsMigration).toBe(false)
    // The other files still arrive.
    expect(r.data.commands).toEqual([])
  })

  it('a file that cannot be OPENED (a directory at its path) is a failed key', () => {
    fs.mkdirSync(path.join(CONFIG, 'app-meta.json'), { recursive: true })
    write('settings.json', '{}')
    const r = loadAllConfig()
    expect(r.failedKeys).toEqual(['appMeta'])
    expect(r.data.appMeta).toBeNull()
  })

  it('an unreachable CONFIG dir is readFailed, NOT needsMigration: nothing read, every key failed, nothing thrown', () => {
    write('settings.json', JSON.stringify({ theme: 'light' }))
    throwOnMkdir = Object.assign(new Error('ENOENT: no such file or directory, mkdir'), { code: 'ENOENT' })
    const r = loadAllConfig()
    expect(r.readFailed).toBe(true)
    expect(r.needsMigration).toBe(false)
    expect(r.data).toEqual({})
    expect(r.failedKeys).toContain('settings')
    expect(r.failedKeys).toContain('commands')
    // And the very next load, with the dir back, reads the untouched file.
    const again = loadAllConfig()
    expect(again.readFailed).toBe(false)
    expect(again.data.settings).toEqual({ theme: 'light' })
  })
})
