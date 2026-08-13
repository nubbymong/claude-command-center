import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// mcp-<sid>.json carries the Conductor MCP bearer token (?token=<secret>) -- the
// only gate on the loopback MCP server and thus on vision_eval. It was written
// with no file mode, so on POSIX it landed 0644: any other local user could read
// the token. These tests pin the write to wx + 0600 and the dir to mkdirSecure.
// The mode/flag assertion goes through a writeFileSync spy so it runs on the
// Windows CI leg too; only the on-disk statSync checks are POSIX-gated.

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

vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 19333,
  getConductorMcpSecret: () => 'a'.repeat(64),
}))

vi.mock('../../../src/main/providers/claude/statusline-command', () => ({
  buildStatuslineSetting: () => ({ type: 'command', command: 'x' }),
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.home,
  registerSetupHandlers: () => {},
}))

// Spy the staging write's options without changing what it does.
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

// Real hardening helpers, spied so we can assert the dir is built securely.
vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/account-profiles')>()
  return {
    ...real,
    mkdirSecure: (dir: string) => { h.mkdirSecureCalls.push(dir); return real.mkdirSecure(dir) },
    hardenCredentialDir: (dir: string) => { h.hardenedDirs.push(dir); return real.hardenCredentialDir(dir) },
  }
})

import { writeLocalSessionMcpConfig, getLocalSessionMcpConfigPath } from '../../../src/main/hooks/per-session-settings'

const IS_POSIX = process.platform !== 'win32'
let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'psm-'))
  h.home = tmp
  h.writes = []
  h.mkdirSecureCalls = []
  h.hardenedDirs = []
})
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('per-session mcp-config: the MCP token is not world-readable', () => {
  it('stages mcp-<sid>.json with flag wx + mode 0600 (asserted on every platform)', () => {
    writeLocalSessionMcpConfig('sess-1', true)
    const staged = h.writes.find((w) => w.path.includes('mcp-sess-1.json'))
    expect(staged, 'the mcp-config was never written').toBeTruthy()
    // Exclusive create is what makes the mode apply at all (open(2) honours a
    // mode only on creation), and refuses a link pre-planted at the staging path.
    expect(staged!.opts).toMatchObject({ flag: 'wx', mode: 0o600 })
  })

  it('creates ~/.claude through mkdirSecure and hardens it (never a bare mkdir)', () => {
    writeLocalSessionMcpConfig('sess-1', true)
    const claudeDir = join(h.home, '.claude')
    expect(h.mkdirSecureCalls).toContain(claudeDir)
    expect(h.hardenedDirs).toContain(claudeDir)
  })

  it.runIf(IS_POSIX)('the token file lands 0600 on disk', () => {
    writeLocalSessionMcpConfig('sess-1', true)
    const f = getLocalSessionMcpConfigPath('sess-1')
    expect(existsSync(f)).toBe(true)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it.runIf(IS_POSIX)('leaves ~/.claude at 0700', () => {
    writeLocalSessionMcpConfig('sess-1', true)
    expect(statSync(join(h.home, '.claude')).mode & 0o777).toBe(0o700)
  })
})
