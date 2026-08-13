import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// conductor-secret.json is the ONLY thing authenticating requests to the loopback
// Conductor MCP server, and that server exposes vision_eval — arbitrary JS in the
// embedded browser. It was written with no file mode, so it landed 0644: any
// other local user could read it and drive the server. The config directory was
// created with a bare mkdirSync, so on Windows a planted junction redirected
// every config write into attacker space.
//
// The mode/flag assertions go through a mock so they run on the Windows CI leg
// too. Only the "what did the inode actually end up as" checks are POSIX-gated —
// a guard that runs on one leg of the matrix is a guard that is usually off.

const h = vi.hoisted(() => ({
  resourcesDir: '',
  writes: [] as Array<{ path: string; opts: unknown }>,
  mkdirSecureCalls: [] as string[],
  hardenedDirs: [] as string[]
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {}
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    writeFileSync: (p: any, d: any, o: any) => {
      h.writes.push({ path: String(p), opts: o })
      return real.writeFileSync(p, d, o)
    }
  }
  return { ...patched, default: patched }
})

// Spy on the two hardening helpers without changing what they do.
vi.mock('../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/account-profiles')>()
  return {
    ...real,
    mkdirSecure: (dir: string) => { h.mkdirSecureCalls.push(dir); return real.mkdirSecure(dir) },
    hardenCredentialDir: (dir: string) => { h.hardenedDirs.push(dir); return real.hardenCredentialDir(dir) }
  }
})

import { writeConfig, ensureConfigDir, getConfigDir } from '../../src/main/config-manager'

let tmp = ''
const IS_POSIX = process.platform !== 'win32'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cfg-secret-'))
  h.resourcesDir = tmp
  h.writes = []
  h.mkdirSecureCalls = []
  h.hardenedDirs = []
  vi.resetModules()
})
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('the MCP auth secret is not world-readable', () => {
  it('writes conductor-secret.json with mode 0600 (asserted on every platform)', () => {
    expect(writeConfig('conductorSecret', { secret: 'a'.repeat(64) })).toBe(true)

    const staged = h.writes.find((w) => w.path.includes('conductor-secret.json'))
    expect(staged, 'the secret was never written').toBeTruthy()
    // Exclusive create is what makes the mode apply at all: open(2) honours a
    // mode only on creation, so writing into an existing inode keeps its old
    // permissions.
    expect(staged!.opts).toMatchObject({ flag: 'wx', mode: 0o600 })
  })

  it('does NOT put a restrictive mode on ordinary config', () => {
    expect(writeConfig('commands', [{ id: 'c1' }])).toBe(true)

    const staged = h.writes.find((w) => w.path.includes('commands.json'))
    expect(staged).toBeTruthy()
    expect((staged!.opts as { mode?: number }).mode).toBeUndefined()
  })

  it.runIf(IS_POSIX)('the secret lands 0600 on disk', () => {
    writeConfig('conductorSecret', { secret: 'b'.repeat(64) })
    const f = join(getConfigDir(), 'conductor-secret.json')
    expect(existsSync(f)).toBe(true)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it.runIf(IS_POSIX)('replaces a pre-existing 0644 secret rather than inheriting its mode', () => {
    // The upgrade case: a file already on disk from a vulnerable build.
    writeConfig('conductorSecret', { secret: 'c'.repeat(64) })
    const f = join(getConfigDir(), 'conductor-secret.json')
    const { chmodSync } = require('fs')
    chmodSync(f, 0o644)

    writeConfig('conductorSecret', { secret: 'd'.repeat(64) })

    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(f, 'utf-8')).secret).toBe('d'.repeat(64))
  })
})

describe('the CONFIG directory is created defensively', () => {
  it('builds it through mkdirSecure, never a bare mkdir', () => {
    ensureConfigDir()
    expect(h.mkdirSecureCalls).toContain(getConfigDir())
  })

  it('re-asserts the directory mode on every call, not only on create', () => {
    ensureConfigDir()
    ensureConfigDir()
    // Existing installs were created at the umask default and would otherwise
    // stay world-readable forever after an upgrade.
    expect(h.hardenedDirs.filter((d) => d === getConfigDir()).length).toBeGreaterThanOrEqual(2)
  })

  it.runIf(IS_POSIX)('leaves the directory 0700', () => {
    ensureConfigDir()
    expect(statSync(getConfigDir()).mode & 0o777).toBe(0o700)
  })
})
