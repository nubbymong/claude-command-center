// Helper tools start from the system folder: the registry reads and writes,
// the captured-run kill, the headless-run kill and the session shell name
// reg.exe, taskkill.exe and Windows PowerShell by their full path below
// <SystemRoot>\System32, with an argument list and no shell; with no plain
// system folder to name a tool from, that tool is not started. The platform is
// forced to Windows so every runner checks the Windows branch; no process is
// started (child_process is mocked).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  execFileSync: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  execFile: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  spawnSync: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  spawn: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  execSync: [] as string[],
  regOut: '',
}))

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  return {
    ...real,
    execFileSync: (file: string, args: string[], opts: Record<string, unknown>) => { h.execFileSync.push({ file, args, opts }); return h.regOut },
    execFile: (file: string, args: string[], opts: Record<string, unknown>, cb?: () => void) => { h.execFile.push({ file, args, opts }); cb?.(); return { pid: 1 } },
    spawnSync: (file: string, args: string[], opts: Record<string, unknown>) => { h.spawnSync.push({ file, args, opts }); return { status: 0 } },
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      h.spawn.push({ file, args, opts })
      // A run that never ends, so the headless spawner reaches its time limit.
      return { pid: 4242, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() }
    },
    execSync: (cmd: string) => { h.execSync.push(cmd); return '' },
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))
vi.mock('../../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('../../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => null, pendingProfileRefresh: () => null }))
vi.mock('../../../src/main/profile-id', () => ({ profileIdFromHome: () => null }))
// The headless run finds Claude Code in PATH's folders (stubbed: no real PATH is read).
vi.mock('../../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/windows-programs')>()),
  findOnWindowsPath: () => 'C:\\Tools\\claude.exe',
  findOnWindowsPathAsync: async () => 'C:\\Tools\\claude.exe',
}))

const { readRegistry, writeRegistry, migrateRegistryKeys } = await import('../../../src/main/registry')
const { defaultKillTree } = await import('../../../src/main/gui-exe-runner')
const { spawnClaudeHeadless } = await import('../../../src/main/claude-headless')
const { localSessionShell } = await import('../../../src/main/login-shell')

const SYS = 'C:\\Windows\\System32'
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedRoot = process.env.SystemRoot

function setRoot(root: string | undefined): void {
  if (root === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = root
}

beforeEach(() => {
  h.execFileSync.length = 0
  h.execFile.length = 0
  h.spawnSync.length = 0
  h.spawn.length = 0
  h.execSync.length = 0
  h.regOut = ''
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  setRoot('C:\\Windows')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  setRoot(savedRoot)
})

describe('helper tools start from the system folder', () => {
  it('the registry reads and writes run reg.exe by its full path, with an argument list', () => {
    h.regOut = '    DataDir    REG_SZ    D:\\data\n'
    expect(readRegistry('DataDir')).toBe('D:\\data')
    expect(writeRegistry('DataDir', 'E:\\x y')).toBe(true)
    migrateRegistryKeys()
    expect(h.execFileSync.length).toBeGreaterThan(0)
    for (const c of h.execFileSync) {
      expect(c.file).toBe(`${SYS}\\reg.exe`)
      expect(Array.isArray(c.args)).toBe(true)
      expect(c.opts).not.toHaveProperty('shell')
    }
    expect(h.execFileSync[0].args).toEqual(['query', 'HKCU\\Software\\AI Code Conductor', '/v', 'DataDir'])
    expect(h.execFileSync.find((c) => c.args[0] === 'add')?.args).toEqual(['add', 'HKCU\\Software\\AI Code Conductor', '/v', 'DataDir', '/t', 'REG_SZ', '/d', 'E:\\x y', '/f'])
    expect(h.execSync).toEqual([])
  })

  it('with no plain system folder, reg.exe is not started and a read is "not there"', () => {
    for (const root of [undefined, 'Windows', '\\\\srv\\share\\Windows', '%SystemRoot%']) {
      setRoot(root)
      expect(readRegistry('DataDir'), String(root)).toBeNull()
      expect(writeRegistry('DataDir', 'x'), String(root)).toBe(false)
    }
    expect(h.execFileSync).toEqual([])
    expect(h.execSync).toEqual([])
  })

  it('the captured-run kill starts taskkill by its full path, and nothing without a plain system folder', () => {
    defaultKillTree(77)
    expect(h.execFile).toHaveLength(1)
    expect(h.execFile[0].file).toBe(`${SYS}\\taskkill.exe`)
    expect(h.execFile[0].args).toEqual(['/pid', '77', '/T', '/F'])
    expect(h.execFile[0].opts).not.toHaveProperty('shell')
    setRoot('C:relative')
    defaultKillTree(78)
    expect(h.execFile).toHaveLength(1)
  })

  it('a headless run at its time limit ends its tree with taskkill by its full path', async () => {
    const res = await spawnClaudeHeadless(['-p'], 30, 'prompt')
    expect(res.code).toBe(1)
    expect(h.spawnSync).toHaveLength(1)
    expect(h.spawnSync[0].file).toBe(`${SYS}\\taskkill.exe`)
    expect(h.spawnSync[0].args).toEqual(['/pid', '4242', '/T', '/F'])
    expect(h.spawnSync[0].opts).not.toHaveProperty('shell')
    expect(h.execSync).toEqual([])
  })

  it('a local session\'s shell is Windows PowerShell by its full path', () => {
    expect(localSessionShell({ SystemRoot: 'C:\\Windows' }, 'win32')).toBe(`${SYS}\\WindowsPowerShell\\v1.0\\powershell.exe`)
    expect(() => localSessionShell({ SystemRoot: 'Windows' }, 'win32')).toThrow(/SystemRoot/)
    expect(() => localSessionShell({}, 'win32')).toThrow(/SystemRoot/)
  })
})
