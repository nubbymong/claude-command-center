// Re-attack r3, MAJOR 1 (ADR-023): a headless run on the macOS realm spawns
// EXACTLY the binary its #172 verdict was taken for, with no shell; every
// other run keeps `claude` through the shell, as before.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const spawnCalls: Array<{ executable: string; args: string[]; opts: any }> = []
vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    const handlers: Record<string, (...a: any[]) => void> = {}
    return { pid: 1, stdin: { write: vi.fn(), end: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: (ev: string, cb: any) => { handlers[ev] = cb }, kill: vi.fn(), handlers }
  },
  execSync: vi.fn(),
  execFile: vi.fn(),
}))
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: (env: any) => env }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { spawnClaudeHeadless } = await import('../../src/main/claude-headless')
const V = await import('../../src/main/mac-realm-verdict')
const { gateManagedLaunch } = await import('../../src/main/managed-launch-diagnostics')
const { composeProviders } = await import('../../src/main/providers/compose')
composeProviders()

const HOME = path.join(os.tmpdir(), 'res', 'account-profiles', 'profile-r1')
const DIR = path.resolve(HOME, '.claude').normalize('NFC')
let tmp = ''

beforeEach(async () => {
  spawnCalls.length = 0
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-realm-'))
  V._resetMacRealmVerdictsForTest()
  await gateManagedLaunch(process.cwd()) // warm: the spawn stays synchronous
})
afterEach(() => {
  V.setMacRealmVerdictHooks(null)
  V._resetMacRealmVerdictsForTest()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('spawnClaudeHeadless and the macOS realm binary', () => {
  it('a realm run spawns the verified absolute binary, shell:false', async () => {
    const cli = path.join(tmp, 'verified claude')
    fs.writeFileSync(cli, 'x')
    const stamp = V.cliStampSync(cli)!
    V.setMacRealmVerdictHooks({ realmDir: (h) => (h === HOME ? DIR : null), ensure: async () => {}, pinnedPath: () => null })
    V.setCurrentInstalledCli({ path: cli, stamp })
    V.recordMacRealmVerdict(DIR, { path: cli, stamp })
    void spawnClaudeHeadless(['-p', 'hi'], 5_000, undefined, HOME)
    await Promise.resolve()
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].executable).toBe(cli)
    expect(spawnCalls[0].opts.shell).toBe(false)
  })

  it('a non-realm run (no realm folder: win32/linux, the primary, setting off) keeps `claude` through the shell', async () => {
    V.setMacRealmVerdictHooks({ realmDir: () => null, ensure: async () => {}, pinnedPath: () => null })
    void spawnClaudeHeadless(['-p', 'hi'], 5_000, undefined, HOME)
    void spawnClaudeHeadless(['-p', 'hi'], 5_000, undefined, null)
    await Promise.resolve()
    expect(spawnCalls.map((c) => [c.executable, c.opts.shell])).toEqual([['claude', true], ['claude', true]])
  })
})
