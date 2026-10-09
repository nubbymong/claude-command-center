// The first-run Claude Code setup terminal (src/main/ipc/setup-handlers.ts,
// setup:spawnCliSetup). On Windows it starts Claude Code itself, often through
// an npm command shim that starts `node` by a bare name: its environment keeps
// that lookup to the folders PATH names (NoDefaultCurrentDirectoryInExePath, in
// one spelling), with the rest of the environment as it was. On macOS and
// Linux it is the user's own login shell, given the parent environment as is,
// and `claude` is typed into it by name once the shell has started.
// The REAL setup handler with node-pty, the launch rule and the resolver
// faked: nothing is started.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The real module (tests/unit/setup.ts stands it in for every other file).
vi.unmock('../../../src/main/ipc/setup-handlers')

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => '' },
}))
type PtyCall = { cmd: string; args: string[]; opts: { env: Record<string, string>; cwd: string }; pty: { write: ReturnType<typeof vi.fn> } }
const ptyCalls = vi.hoisted(() => [] as PtyCall[])
vi.mock('node-pty', () => ({
  spawn: (cmd: string, args: string[], opts: PtyCall['opts']) => {
    const pty = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() }
    ptyCalls.push({ cmd, args, opts, pty })
    return pty
  },
}))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'C:\\npm\\claude.cmd', args: [] }) }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/claude-cli-probe', () => ({ probeClaudeCli: vi.fn() }))
vi.mock('../../../src/main/login-shell', () => ({ defaultLoginShell: () => '/bin/zsh' }))
vi.mock('../../../src/main/pty-input-guard', () => ({ guardPtyIo: vi.fn() }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => '', getResourcesDirectory: () => '', setDataDirectory: vi.fn(), setResourcesDirectory: vi.fn(), isDataDirFromRegistry: () => false,
}))

import { registerSetupHandlers, setupTerminalEnv } from '../../../src/main/ipc/setup-handlers'
import { logInfo } from '../../../src/main/debug-logger'

const LOOKUP = 'NODEFAULTCURRENTDIRECTORYINEXEPATH'
const spellings = (env: Record<string, string>) => Object.entries(env).filter(([k]) => k.toUpperCase() === LOOKUP)

describe('the setup terminal\'s environment', () => {
  it('on Windows: program lookup kept to PATH\'s folders, in one spelling, the rest as given, the input unchanged', () => {
    const given = { Path: 'C:\\npm;C:\\Windows', A: '1', nodefaultcurrentdirectoryinexepath: '0' }
    const env = setupTerminalEnv(given, 'win32')
    expect(spellings(env)).toEqual([['NoDefaultCurrentDirectoryInExePath', '1']])
    expect(env.Path).toBe('C:\\npm;C:\\Windows')
    expect(env.A).toBe('1')
    expect(given).toEqual({ Path: 'C:\\npm;C:\\Windows', A: '1', nodefaultcurrentdirectoryinexepath: '0' })
  })

  it('on Windows: PATH keeps only its fully qualified folders, in every spelling', () => {
    const given = { Path: '.;tools;C:\\npm;"D:\\Quoted"', PATH: 'relative', A: '1' }
    const env = setupTerminalEnv(given, 'win32')
    expect(env.Path).toBe('C:\\npm;D:\\Quoted')
    expect('PATH' in env).toBe(false)
    expect(given.Path).toBe('.;tools;C:\\npm;"D:\\Quoted"')
  })

  it('on macOS and Linux: the environment as given', () => {
    const given = { PATH: '/usr/bin', A: '1' }
    expect(setupTerminalEnv(given, 'darwin')).toBe(given)
    expect(setupTerminalEnv(given, 'linux')).toBe(given)
  })
})

describe('the setup terminal starts Claude Code', () => {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    handlers.clear()
    ptyCalls.length = 0
    registerSetupHandlers()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', saved)
    vi.useRealTimers()
  })
  const invoke = (ch: string, ...args: unknown[]) => handlers.get(ch)!({ sender: {} }, ...args)

  it('on Windows it starts the resolved command directly, with program lookup kept to PATH\'s folders', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(await invoke('setup:spawnCliSetup', 100, 20)).toBe('__cli_setup__')
    expect(ptyCalls).toHaveLength(1)
    expect(ptyCalls[0].cmd).toBe('C:\\npm\\claude.cmd')
    expect(ptyCalls[0].args).toEqual([])
    expect(ptyCalls[0].opts.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(ptyCalls[0].opts.env).not.toBe(process.env)
    await invoke('setup:killCliSetup')
  })

  it('on macOS and Linux it opens the login shell with the parent environment and types claude by name', async () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await invoke('setup:spawnCliSetup', 100, 20)
    expect(ptyCalls).toHaveLength(1)
    expect(ptyCalls[0].cmd).toBe('/bin/zsh')
    expect(ptyCalls[0].args).toEqual(['-l'])
    expect(ptyCalls[0].opts.env).toBe(process.env)
    vi.advanceTimersByTime(499)
    expect(ptyCalls[0].pty.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(ptyCalls[0].pty.write).toHaveBeenCalledWith('claude\r')
    await invoke('setup:killCliSetup')
  })

  it('its log line names what the terminal runs: the resolved command on Windows, the login shell and claude by name elsewhere', async () => {
    const started = () => vi.mocked(logInfo).mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith('[setup] Spawning CLI setup PTY'))
    vi.mocked(logInfo).mockClear()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await invoke('setup:spawnCliSetup', 100, 20)
    await invoke('setup:killCliSetup')
    expect(started()).toHaveLength(1)
    expect(started()[0]).toMatch(/^\[setup\] Spawning CLI setup PTY: C:\\npm\\claude\.cmd in /)

    vi.mocked(logInfo).mockClear()
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await invoke('setup:spawnCliSetup', 100, 20)
    await invoke('setup:killCliSetup')
    expect(started()).toHaveLength(1)
    expect(started()[0]).toMatch(/^\[setup\] Spawning CLI setup PTY: \/bin\/zsh -l in .+, then claude by name$/)
    expect(started()[0]).not.toContain('claude.cmd')
  })
})
