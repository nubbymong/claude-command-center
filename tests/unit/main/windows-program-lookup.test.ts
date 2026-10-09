// Programs are found only in PATH's absolute folders, and started by their full
// path with no shell. Each Windows site -- the Claude launch's binary, the
// elevated terminal's gsudo, the CLI check, a headless run, the CLI auth probe,
// gh, and npm -- runs the REAL PATH walk (windows-programs.ts) over a PATH this
// test sets: relative entries hold a file of every name, which must never be
// chosen, and a fully qualified folder holds the real one. The file test is
// injected (no real file is read) and child_process is mocked (no process
// starts). The platform is forced to Windows so every runner checks the
// Windows branch. A site that takes an environment gets a synthetic one; the
// headless run and the CLI check read this process's own, so PATH and
// SystemRoot are set on it per case and put back after.
//
// Every site asks the same Claude Code names (claude.exe, claude.cmd,
// claude.bat), and only the launch, which cannot wait, may walk PATH on the
// event loop -- and not while the CLI check's answer is recent.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  present: new Set<string>(),
  asked: [] as string[],
  /** Walks run ON the event loop (findOnWindowsPath), by the names asked. */
  syncWalks: [] as string[][],
  spawn: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  execFile: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  execSync: [] as string[],
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}))

/** The injected file test: answers from `present`, records every path asked. */
function isFile(p: string): boolean {
  h.asked.push(p)
  return h.present.has(p.toLowerCase())
}

vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => {
      h.syncWalks.push([...names])
      return real.findOnWindowsPath(names, env, isFile, order)
    },
    findOnWindowsPathAsync: async (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => real.findOnWindowsPath(names, env, isFile, order),
  }
})

function fakeChild(): Record<string, unknown> {
  const handlers: Record<string, (code: number) => void> = {}
  queueMicrotask(() => handlers.close?.(0))
  return {
    pid: 4242,
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: (ev: string, fn: (code: number) => void) => { handlers[ev] = fn },
    kill: vi.fn(),
  }
}

/** child_process with every start recorded and none made (a function
 *  declaration, so the hoisted mocks below can call it). */
function childProcessMock(real: typeof import('child_process')): Record<string, unknown> {
  return {
    ...real,
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => { h.spawn.push({ file, args, opts }); return fakeChild() },
    execFile: (file: string, args: string[], opts: Record<string, unknown>, cb?: (e: unknown, out: unknown) => void) => {
      h.execFile.push({ file, args, opts })
      const done = typeof opts === 'function' ? (opts as unknown as typeof cb) : cb
      done?.(null, { stdout: '["2.1.0"]', stderr: '' })
      return { pid: 1 }
    },
    execSync: (cmd: string) => { h.execSync.push(cmd); return '' },
    spawnSync: () => ({ status: 0 }),
  }
}
vi.mock('child_process', async (importOriginal) => childProcessMock(await importOriginal<typeof import('child_process')>()))
vi.mock('node:child_process', async (importOriginal) => childProcessMock(await importOriginal<typeof import('child_process')>()))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) }, on: vi.fn() },
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))
vi.mock('../../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env, resolveClaudeForPty: () => ({ cmd: 'unused' }) }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('../../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => null, pendingProfileRefresh: () => null, holdProfileForRun: () => () => {} }))
vi.mock('../../../src/main/profile-id', () => ({ profileIdFromHome: () => null }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => 'C:\\res' }))
vi.mock('../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: () => null }))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerProbeRefusal: () => null, providerLaunchRefusal: () => null }))

const { resolveClaudeBinary, buildClaudeLocalSpawn, CLAUDE_NOT_ON_PATH } = await import('../../../src/main/providers/claude/spawn')
const { registerCliHandlers } = await import('../../../src/main/ipc/cli-handlers')
const { spawnClaudeHeadless } = await import('../../../src/main/claude-headless')
const { claudeAuthStatusCommand } = await import('../../../src/main/account-web/claude-cli-auth')
const { defaultGhRun } = await import('../../../src/main/github/auth/gh-cli-delegate')
const { npmCommand, fetchAvailableVersions } = await import('../../../src/main/legacy-version-manager')
const { probeClaudeCli, _resetClaudeCliProbeForTest, _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')
const { IPC } = await import('../../../src/shared/ipc-channels')

/** Relative entries first, then the real folders. */
const PATH = '.;rel\\bin;%APPDATA%\\npm;C:\\Npm;C:\\Tools'
/** A file of every name in every relative entry (never to be chosen). */
const IN_RELATIVE_ENTRIES = ['claude.exe', 'claude.cmd', 'claude.bat', 'gsudo.exe', 'gh.exe', 'npm.exe', 'npm.cmd'].flatMap((n) => [`.\\${n}`, `rel\\bin\\${n}`, n])
/** The synthetic environment the sites that take one are given. */
const ENV: Readonly<Record<string, string>> = Object.freeze({ PATH, SystemRoot: 'C:\\Windows' })

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved = { path: process.env.PATH, root: process.env.SystemRoot }

function have(...files: string[]): void {
  h.present = new Set([...IN_RELATIVE_ENTRIES, ...files].map((f) => f.toLowerCase()))
}
function restore(name: 'PATH' | 'SystemRoot', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  h.asked.length = 0
  h.syncWalks.length = 0
  h.spawn.length = 0
  h.execFile.length = 0
  h.execSync.length = 0
  have()
  _resetClaudeWindowsLookupForTest()
  _resetClaudeCliProbeForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  // The headless run and the CLI check read this process's own environment.
  process.env.PATH = PATH
  process.env.SystemRoot = 'C:\\Windows'
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  restore('PATH', saved.path)
  restore('SystemRoot', saved.root)
})

/** Every candidate the walk asked for was in a fully qualified folder. */
function onlyAbsoluteAsked(): void {
  expect(h.asked.length).toBeGreaterThan(0)
  for (const p of h.asked) expect(p, p).toMatch(/^[A-Za-z]:\\/)
}

describe('programs are found only in PATH\'s absolute folders', () => {
  it('the Claude launch: claude.exe in any folder before claude.cmd, by its full path; none -> nothing starts', () => {
    have('C:\\Npm\\claude.cmd', 'C:\\Tools\\claude.exe')
    expect(resolveClaudeBinary(undefined, ENV)).toEqual({ cmd: 'C:\\Tools\\claude.exe', args: [] })
    _resetClaudeWindowsLookupForTest()
    have('C:\\Npm\\claude.cmd')
    expect(resolveClaudeBinary(undefined, ENV)).toEqual({ cmd: 'C:\\Npm\\claude.cmd', args: [] })
    onlyAbsoluteAsked()
    _resetClaudeWindowsLookupForTest()
    have()
    expect(() => resolveClaudeBinary(undefined, ENV)).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.execSync).toEqual([])
    expect(h.execFile).toEqual([])
  })

  it('an elevated terminal: gsudo by its full path around PowerShell by its full path; none -> nothing starts', () => {
    have('C:\\Tools\\gsudo.exe')
    const r = buildClaudeLocalSpawn({ sessionId: 's', cols: 80, rows: 24, shellOnly: true, elevated: true } as never, ENV)
    expect(r.cmd).toBe('C:\\Tools\\gsudo.exe')
    expect(r.args).toEqual(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
    onlyAbsoluteAsked()
    have()
    expect(() => buildClaudeLocalSpawn({ sessionId: 's', cols: 80, rows: 24, shellOnly: true, elevated: true } as never, ENV)).toThrow(/gsudo/)
  })

  it('the CLI check walks PATH\'s folders and starts no process', async () => {
    registerCliHandlers()
    const check = h.handlers.get(IPC.CLI_CHECK)!
    have('C:\\Npm\\claude.cmd')
    expect(await check()).toBe(true)
    have()
    expect(await check()).toBe(false)
    onlyAbsoluteAsked()
    expect(h.execFile).toEqual([])
    expect(h.execSync).toEqual([])
  })

  it('a headless run starts claude.exe by its full path, with no shell and no current-folder lookup', async () => {
    have('C:\\Tools\\claude.exe')
    const res = await spawnClaudeHeadless(['-p', '--output-format', 'json'], 60_000, 'prompt')
    expect(res.code).toBe(0)
    expect(h.spawn).toHaveLength(1)
    expect(h.spawn[0].file).toBe('C:\\Tools\\claude.exe')
    expect(h.spawn[0].args).toEqual(['-p', '--output-format', 'json'])
    expect(h.spawn[0].opts).not.toHaveProperty('shell')
    expect((h.spawn[0].opts.env as Record<string, string>).NoDefaultCurrentDirectoryInExePath).toBe('1')
    onlyAbsoluteAsked()
  })

  it('a headless run starts an npm claude.cmd through the system cmd.exe, its arguments one each', async () => {
    have('C:\\Npm\\claude.cmd')
    await spawnClaudeHeadless(['-p', '--tools=', '--disallowedTools', 'Bash,Read'], 60_000, 'prompt')
    expect(h.spawn).toHaveLength(1)
    expect(h.spawn[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(h.spawn[0].args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\Npm\\claude.cmd" -p --tools= --disallowedTools Bash,Read"'])
    expect(h.spawn[0].opts).toMatchObject({ windowsVerbatimArguments: true })
    expect(h.spawn[0].opts).not.toHaveProperty('shell')
  })

  it('a headless run with Claude Code in none of PATH\'s folders starts nothing and says why', async () => {
    const res = await spawnClaudeHeadless(['-p'], 60_000, 'prompt')
    expect(res.code).toBe(1)
    expect(res.stderr).toBe(CLAUDE_NOT_ON_PATH)
    expect(h.spawn).toEqual([])
  })

  it('a headless run cancelled while Claude Code is being looked for starts nothing', async () => {
    have('C:\\Tools\\claude.exe')
    const ac = new AbortController()
    const run = spawnClaudeHeadless(['-p'], 60_000, 'prompt', null, ac.signal)
    ac.abort()
    const res = await run
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/Aborted/)
    expect(h.spawn).toEqual([])
  })

  it('the CLI auth probe starts Claude Code by its full path with no shell; none -> it rejects (the file is read instead)', async () => {
    have('C:\\Tools\\claude.exe')
    const run = await claudeAuthStatusCommand({ ...ENV }, 'win32')
    expect(run.file).toBe('C:\\Tools\\claude.exe')
    expect(run.args).toEqual(['auth', 'status'])
    expect(run.options).not.toHaveProperty('shell')
    expect((run.options.env as Record<string, string>).NoDefaultCurrentDirectoryInExePath).toBe('1')
    _resetClaudeWindowsLookupForTest()
    have()
    await expect(claudeAuthStatusCommand({ PATH }, 'win32')).rejects.toThrow(CLAUDE_NOT_ON_PATH)
    // POSIX is unchanged: `claude` through sh.
    expect(await claudeAuthStatusCommand({}, 'linux')).toMatchObject({ file: 'claude', args: ['auth', 'status'], options: { shell: true } })
  })

  it('gh starts by its full path with no shell; none -> it rejects and starts nothing', async () => {
    have('C:\\Tools\\gh.exe')
    await defaultGhRun(ENV)(['auth', 'status'])
    expect(h.spawn).toHaveLength(1)
    expect(h.spawn[0].file).toBe('C:\\Tools\\gh.exe')
    expect(h.spawn[0].opts).not.toHaveProperty('shell')
    onlyAbsoluteAsked()
    have()
    await expect(defaultGhRun(ENV)(['auth', 'status'])).rejects.toThrow(/gh was not found/)
    expect(h.spawn).toHaveLength(1)
  })

  it('npm starts by its full path (npm.cmd through the system cmd.exe) with no shell; none -> nothing starts, and the answer says so', async () => {
    have('C:\\Npm\\npm.cmd', 'C:\\Tools\\npm.exe')
    expect(await npmCommand(['view', 'x'], true, 'win32', ENV)).toMatchObject({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\Npm\\npm.cmd" view x"'],
      options: { windowsVerbatimArguments: true, env: expect.objectContaining({ NoDefaultCurrentDirectoryInExePath: '1' }) },
    })
    expect((await npmCommand(['view', 'x'], true, 'win32', ENV) as { options: object }).options).not.toHaveProperty('shell')
    have('C:\\Npm\\npm.exe', 'C:\\Npm\\npm.cmd')
    expect(await npmCommand(['view', 'x'], true, 'win32', ENV)).toMatchObject({ file: 'C:\\Npm\\npm.exe', args: ['view', 'x'] })
    have('C:\\Npm\\npm.cmd')
    await fetchAvailableVersions()
    expect(h.execFile).toHaveLength(1)
    expect(h.execFile[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(h.execFile[0].opts).not.toHaveProperty('shell')
    onlyAbsoluteAsked()
    have()
    expect(await npmCommand(['view', 'x'], true, 'win32', ENV)).toEqual({ refused: 'npm was not found in a folder PATH names (npm.exe, npm.cmd)' })
    // POSIX is unchanged.
    expect(await npmCommand(['install', 'x'], true, 'linux')).toEqual({ file: 'npm', args: ['install', 'x'], options: { shell: true } })
  })

  it('an npm that is found but cannot be started without a shell is not reported as missing', async () => {
    const env = { PATH: 'C:\\Node & Tools', SystemRoot: 'C:\\Windows' }
    have('C:\\Node & Tools\\npm.cmd')
    const r = await npmCommand(['view', 'x'], true, 'win32', env)
    expect(r).toHaveProperty('refused')
    expect((r as { refused: string }).refused).toMatch(/^npm was found but could not be started: /)
    expect((r as { refused: string }).refused).not.toMatch(/not found/)
  })
})

describe('every check and start asks the same Claude Code names and says the same thing when none is there', () => {
  it('claude.bat, alone in PATH\'s folders: the launch, the CLI check, the setup probe, a headless run and the auth probe all find it', async () => {
    have('C:\\Tools\\claude.bat')
    expect(resolveClaudeBinary(undefined, ENV)).toEqual({ cmd: 'C:\\Tools\\claude.bat', args: [] })
    _resetClaudeWindowsLookupForTest()
    registerCliHandlers()
    expect(await h.handlers.get(IPC.CLI_CHECK)!()).toBe(true)
    expect(await probeClaudeCli()).toMatchObject({ installed: true, path: 'C:\\Tools\\claude.bat' })
    _resetClaudeWindowsLookupForTest()
    await spawnClaudeHeadless(['-p'], 60_000, 'prompt')
    expect(h.spawn[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(h.spawn[0].args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\Tools\\claude.bat" -p"'])
    _resetClaudeWindowsLookupForTest()
    expect((await claudeAuthStatusCommand({ ...ENV }, 'win32')).args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\Tools\\claude.bat" auth status"'])
  })

  it('none there: the CLI check and the probe say not installed, and every start says the one message', async () => {
    registerCliHandlers()
    expect(await h.handlers.get(IPC.CLI_CHECK)!()).toBe(false)
    expect(await probeClaudeCli()).toMatchObject({ installed: false })
    expect(() => resolveClaudeBinary(undefined, ENV)).toThrow(CLAUDE_NOT_ON_PATH)
    expect((await spawnClaudeHeadless(['-p'], 60_000, 'prompt')).stderr).toBe(CLAUDE_NOT_ON_PATH)
    await expect(claudeAuthStatusCommand({ ...ENV }, 'win32')).rejects.toThrow(CLAUDE_NOT_ON_PATH)
    expect(CLAUDE_NOT_ON_PATH).toBe('Claude Code was not found in a folder PATH names (claude.exe, claude.cmd, claude.bat)')
  })
})

describe('only the launch walks PATH on the event loop, and not while the CLI check\'s answer is recent', () => {
  it('a headless run, the auth probe, npm, the CLI check and the setup probe never walk PATH on the event loop', async () => {
    have('C:\\Tools\\claude.exe', 'C:\\Tools\\npm.exe')
    await spawnClaudeHeadless(['-p'], 60_000, 'prompt')
    await claudeAuthStatusCommand({ ...ENV }, 'win32')
    await npmCommand(['view', 'x'], false, 'win32', ENV)
    registerCliHandlers()
    await h.handlers.get(IPC.CLI_CHECK)!()
    await probeClaudeCli()
    expect(h.spawn).toHaveLength(1)
    expect(h.syncWalks).toEqual([])
  })

  it('a launch right after the CLI check uses its answer without walking PATH; a launch under another PATH walks', async () => {
    have('C:\\Tools\\claude.exe')
    registerCliHandlers()
    expect(await h.handlers.get(IPC.CLI_CHECK)!()).toBe(true)
    h.asked.length = 0
    expect(resolveClaudeBinary(undefined, { ...ENV })).toEqual({ cmd: 'C:\\Tools\\claude.exe', args: [] })
    expect(h.syncWalks).toEqual([])
    expect(h.asked).toEqual([])
    have('C:\\Npm\\claude.exe')
    expect(resolveClaudeBinary(undefined, { ...ENV, PATH: 'C:\\Npm' })).toEqual({ cmd: 'C:\\Npm\\claude.exe', args: [] })
    expect(h.syncWalks).toHaveLength(1)
  })
})
