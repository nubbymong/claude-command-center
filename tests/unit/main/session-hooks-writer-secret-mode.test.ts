import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// settings-<sid>.json carries the per-session X-CCC-Hook-Token in its hooks
// block, and injectHooks rewrites it on every local spawn. It used to be written
// with no file mode (0644 on POSIX) via a plain writeFileSync + symlink-following
// fallback, which also undid the 0600 that writeLocalSessionSettings had just set
// on the same file. These tests pin the write to wx + 0600 through mkdirSecure.

const h = vi.hoisted(() => ({
  home: '',
  writes: [] as Array<{ path: string; opts: unknown }>,
  mkdirSecureCalls: [] as string[],
  hardenedDirs: [] as string[],
}))

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  const homedir = () => h.home
  return { ...real, default: { ...real, homedir }, homedir }
})

vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.home,
  registerSetupHandlers: () => {},
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    writeFileSync: (p: any, d: any, o: any) => {
      h.writes.push({ path: String(p), opts: o })
      return real.writeFileSync(p, d, o)
    },
  }
  return { ...patched, default: patched }
})

vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/account-profiles')>()
  return {
    ...real,
    mkdirSecure: (dir: string) => { h.mkdirSecureCalls.push(dir); return real.mkdirSecure(dir) },
    hardenCredentialDir: (dir: string) => { h.hardenedDirs.push(dir); return real.hardenCredentialDir(dir) },
  }
})

import { injectHooks } from '../../../src/main/hooks/session-hooks-writer'

const IS_POSIX = process.platform !== 'win32'
let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shw-'))
  h.home = tmp
  h.writes = []
  h.mkdirSecureCalls = []
  h.hardenedDirs = []
})
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('session-hooks-writer: settings-<sid>.json (hook token) is not world-readable', () => {
  it('injectHooks stages the settings file with flag wx + mode 0600 through mkdirSecure', () => {
    const claudeDir = join(tmp, '.claude')
    const settingsPath = join(claudeDir, 'settings-s1.json')
    injectHooks({ sessionId: 's1', settingsPath, port: 12345, secret: 'hook-secret-xyz', cwd: tmp, homeDir: tmp })
    const staged = h.writes.find((w) => w.path.includes('settings-s1.json'))
    expect(staged, 'the settings file was never written').toBeTruthy()
    expect(staged!.opts).toMatchObject({ flag: 'wx', mode: 0o600 })
    expect(h.mkdirSecureCalls).toContain(claudeDir)
  })

  it.runIf(IS_POSIX)('the settings file lands 0600 on disk after injectHooks', () => {
    const settingsPath = join(tmp, '.claude', 'settings-s1.json')
    injectHooks({ sessionId: 's1', settingsPath, port: 12345, secret: 'hook-secret-xyz', cwd: tmp, homeDir: tmp })
    expect(existsSync(settingsPath)).toBe(true)
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
  })
})
