// A Claude session's launch line is written for the sh family, so off Windows
// its launcher is a sh-family shell whatever the user's login shell is
// (login-shell.ts shFamilyLoginShell). For a user whose login shell is fish or
// PowerShell, the PATH that shell builds is where their Claude Code (and an
// npm install's node) lives. So the launcher carries that PATH, reads no
// profile of its own, and the launch names the Claude Code found in it by its
// full path; the CLI checks ask the same question, so they never say
// installed for a Claude Code no session can start. Another login shell
// outside the sh family is asked the same way; when it reports no PATH, the
// launch and the checks both stay on the launcher's own login profile. No
// shell runs here: child_process is mocked (the login shell's answer is the
// test's), and so are the file tests.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'darwin' as NodeJS.Platform,
  /** /bin/* shells that exist. */
  present: new Set<string>(['/bin/bash', '/bin/zsh', '/bin/sh']),
  /** Files a user may run. */
  runnable: new Set<string>(),
  /** Files nobody may run. */
  plain: new Set<string>(),
  /** Files with a run bit that only another user may run (owner-only, not ours). */
  othersOnly: new Set<string>(),
  /** What the login shell prints, or an Error it fails with. */
  loginShellOut: '' as string | Error,
  /** What `which claude` answers through a login shell, by shell. */
  which: new Map<string, string>(),
  sync: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  async: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}))

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, platform: () => h.platform, homedir: () => '/home/u' }
})
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const answer = (p: string) => {
    if (h.runnable.has(String(p))) return { isFile: () => true, mode: 0o100755 }
    if (h.plain.has(String(p))) return { isFile: () => true, mode: 0o100644 }
    if (h.othersOnly.has(String(p))) return { isFile: () => true, mode: 0o100744 }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  /** Whether this user may run `p`: only the runnable files. */
  const access = (p: string) => {
    answer(p)
    if (!h.runnable.has(p)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
  }
  const owned = (p: unknown) => String(p).startsWith('/')
  return {
    ...real,
    existsSync: (p: string) => (String(p).startsWith('/bin/') ? h.present.has(String(p)) : real.existsSync(p)),
    statSync: (p: string, ...rest: unknown[]) => (owned(p) ? answer(String(p)) : (real.statSync as (...a: unknown[]) => unknown)(p, ...rest)),
    accessSync: (p: string, ...rest: unknown[]) => (owned(p) ? access(String(p)) : (real.accessSync as (...a: unknown[]) => unknown)(p, ...rest)),
    promises: {
      ...real.promises,
      stat: async (p: string, ...rest: unknown[]) => (owned(p) ? answer(String(p)) : (real.promises.stat as (...a: unknown[]) => unknown)(p, ...rest)),
      access: async (p: string, ...rest: unknown[]) => (owned(p) ? access(String(p)) : (real.promises.access as (...a: unknown[]) => unknown)(p, ...rest)),
    },
  }
})
/** child_process: no process starts. A login shell asked for its PATH answers
 *  with `loginShellOut`; `<shell> -l -c 'which claude'` with `which`. */
function childProcessMock(real: typeof import('child_process')): Record<string, unknown> {
  const reply = (file: string, args: string[]): { err: Error | null; out: string } => {
    if (file === 'which') return { err: new Error('exit 1'), out: '' }
    if (args[2] === 'which claude' || args[1] === 'command -v claude') {
      const w = h.which.get(file)
      return w ? { err: null, out: `${w}\n` } : { err: new Error('exit 1'), out: '' }
    }
    return h.loginShellOut instanceof Error ? { err: h.loginShellOut, out: '' } : { err: null, out: h.loginShellOut }
  }
  return {
    ...real,
    execFile: (file: string, args: string[], opts: Record<string, unknown>, cb?: (e: unknown, out: unknown, err?: unknown) => void) => {
      h.async.push({ file, args, opts })
      const r = reply(file, args)
      queueMicrotask(() => cb?.(r.err, r.out, ''))
      return { pid: 1 }
    },
    execFileSync: (file: string, args: string[], opts: Record<string, unknown>) => {
      h.sync.push({ file, args, opts })
      const r = reply(file, args)
      if (r.err) throw r.err
      return r.out
    },
  }
}
vi.mock('child_process', async (importOriginal) => childProcessMock(await importOriginal<typeof import('child_process')>()))
vi.mock('node:child_process', async (importOriginal) => childProcessMock(await importOriginal<typeof import('child_process')>()))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) }, on: vi.fn() },
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))
vi.mock('../../../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env, resolveClaudeForPty: () => ({ cmd: 'unused' }) }))
vi.mock('../../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: vi.fn() }))
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: () => null }))
vi.mock('../../../../src/main/provider-launch-gate', () => ({ providerProbeRefusal: () => null, providerLaunchRefusal: () => null }))

const { buildClaudeLocalSpawn, resolveClaudeBinary } = await import('../../../../src/main/providers/claude/spawn')
const { registerCliHandlers } = await import('../../../../src/main/ipc/cli-handlers')
const { probeClaudeCli, claudeInLoginShellPathAsync, _resetClaudeCliProbeForTest, _resetClaudeLoginShellLookupForTest, CLAUDE_LOOKUP_REUSE_MS } = await import('../../../../src/main/claude-cli-probe')
const { LOGIN_SHELL_PATH_COMMAND } = await import('../../../../src/main/login-shell')
const { IPC } = await import('../../../../src/shared/ipc-channels')

const BASE_OPTS = { sessionId: 'ses-1', cwd: '/work/project', cols: 80, rows: 24 }
const APP_OWNED = {
  CLAUDE_MULTI_SESSION_ID: 'ses-1',
  CLAUDE_CODE_DISABLE_MOUSE: '1',
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
}
const FISH = '/opt/homebrew/bin/fish'
const APP_PATH = '/usr/bin:/bin'
/** The login shell's own PATH, as its profile builds it (a relative entry included). */
const OWN_PATH = '/Users/u/.local/bin:rel/bin:/opt/homebrew/bin:/usr/bin:/bin'
const OWN_PATH_ABSOLUTE = '/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin'
const answered = (pathValue: string) => `Welcome to fish\n__CCC_LOGIN_PATH_BEGIN__${pathValue}__CCC_LOGIN_PATH_END__`

const saved = { shell: process.env.SHELL, path: process.env.PATH }
function restore(name: 'SHELL' | 'PATH', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  h.platform = 'darwin'
  h.runnable = new Set(['/Users/u/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', 'rel/bin/claude'])
  h.plain = new Set()
  h.othersOnly = new Set()
  h.loginShellOut = answered(OWN_PATH)
  h.which = new Map()
  h.sync.length = 0
  h.async.length = 0
  _resetClaudeLoginShellLookupForTest()
  _resetClaudeCliProbeForTest()
})
afterEach(() => {
  vi.restoreAllMocks()
  restore('SHELL', saved.shell)
  restore('PATH', saved.path)
})

describe('a Claude session of a user whose login shell is not of the sh family', () => {
  it('the launcher carries the PATH that login shell builds, reads no profile of its own, and the launch names the Claude Code found in it', () => {
    const source = { SHELL: FISH, PATH: APP_PATH, HOME: '/home/u' }
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toEqual({
      cmd: '/bin/zsh',
      args: [],
      env: { ...source, ...APP_OWNED, PATH: OWN_PATH_ABSOLUTE },
    })
    expect(resolveClaudeBinary(undefined, source)).toEqual({ cmd: '/Users/u/.local/bin/claude', args: [] })
    // The question went to the user's own login shell, as a login shell, from
    // the home folder, and a launch waits at most 3 s for its answer.
    expect(h.sync).toHaveLength(1)
    expect(h.sync[0].file).toBe(FISH)
    expect(h.sync[0].args).toEqual(['-l', '-c', LOGIN_SHELL_PATH_COMMAND])
    expect(h.sync[0].opts).toMatchObject({ cwd: '/home/u', env: source, timeout: 3000 })
    expect(source).toEqual({ SHELL: FISH, PATH: APP_PATH, HOME: '/home/u' })
  })

  it('a PowerShell user on Linux gets the same, under bash', () => {
    h.platform = 'linux'
    const source = { SHELL: '/usr/bin/pwsh', PATH: APP_PATH }
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toMatchObject({ cmd: '/bin/bash', args: [], env: { PATH: OWN_PATH_ABSOLUTE } })
    expect(resolveClaudeBinary(undefined, source).cmd).toBe('/Users/u/.local/bin/claude')
    expect(h.sync.map((c) => [c.file, c.args])).toEqual([['/usr/bin/pwsh', ['-l', '-c', LOGIN_SHELL_PATH_COMMAND]]])
  })

  it('no answer from that login shell, or no Claude Code in its PATH: the sh-family login shell builds the PATH, and Claude Code is named as before', () => {
    const source = { SHELL: FISH, PATH: APP_PATH }
    h.loginShellOut = new Error('timed out')
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toEqual({ cmd: '/bin/zsh', args: ['-l'], env: { ...source, ...APP_OWNED } })
    expect(resolveClaudeBinary(undefined, source)).toEqual({ cmd: 'claude', args: [] })
    _resetClaudeLoginShellLookupForTest()
    h.loginShellOut = answered('/usr/bin:/bin')
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toEqual({ cmd: '/bin/zsh', args: ['-l'], env: { ...source, ...APP_OWNED } })
    expect(resolveClaudeBinary(undefined, source)).toEqual({ cmd: 'claude', args: [] })
  })

  it('a Claude Code only in a relative entry of that PATH is never named', () => {
    h.runnable = new Set(['rel/bin/claude'])
    const source = { SHELL: FISH, PATH: APP_PATH }
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toMatchObject({ args: ['-l'], env: { PATH: APP_PATH } })
    expect(resolveClaudeBinary(undefined, source).cmd).toBe('claude')
  })

  it('a file in that PATH that nobody may run is passed over for the next folder\'s', () => {
    h.runnable = new Set(['/opt/homebrew/bin/claude'])
    h.plain = new Set(['/Users/u/.local/bin/claude'])
    const source = { SHELL: FISH, PATH: APP_PATH }
    buildClaudeLocalSpawn({ ...BASE_OPTS }, source)
    expect(resolveClaudeBinary(undefined, source).cmd).toBe('/opt/homebrew/bin/claude')
  })

  it('a file in that PATH that only another user may run is passed over for the next folder\'s, at the launch and in the check', async () => {
    h.runnable = new Set(['/opt/homebrew/bin/claude'])
    h.othersOnly = new Set(['/Users/u/.local/bin/claude'])
    const source = { SHELL: FISH, PATH: APP_PATH }
    buildClaudeLocalSpawn({ ...BASE_OPTS }, source)
    expect(resolveClaudeBinary(undefined, source).cmd).toBe('/opt/homebrew/bin/claude')
    _resetClaudeLoginShellLookupForTest()
    expect(await claudeInLoginShellPathAsync(source, 'darwin')).toEqual({ path: OWN_PATH_ABSOLUTE, claude: '/opt/homebrew/bin/claude' })
  })

  it('the login shell is asked once per answer\'s life: a second launch reuses it, and one a minute later asks again', () => {
    const source = { SHELL: FISH, PATH: APP_PATH }
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    buildClaudeLocalSpawn({ ...BASE_OPTS }, source)
    h.loginShellOut = new Error('a second question would fail')
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toMatchObject({ args: [], env: { PATH: OWN_PATH_ABSOLUTE } })
    expect(h.sync).toHaveLength(1)
    now += CLAUDE_LOOKUP_REUSE_MS
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toMatchObject({ args: ['-l'] })
    expect(h.sync).toHaveLength(2)
  })

  it('a sh-family login shell, a terminal tab and an elevated tab ask nothing and keep what they had', () => {
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, { SHELL: '/bin/zsh', PATH: APP_PATH })).toMatchObject({ cmd: '/bin/zsh', args: ['-l'], env: { PATH: APP_PATH } })
    expect(resolveClaudeBinary(undefined, { SHELL: '/bin/zsh', PATH: APP_PATH }).cmd).toBe('claude')
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true }, { SHELL: FISH, PATH: APP_PATH })).toMatchObject({ cmd: FISH, args: ['-l'], env: { PATH: APP_PATH } })
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, elevated: true }, { SHELL: FISH, PATH: APP_PATH })).toMatchObject({ cmd: 'sudo', args: [FISH, '-l'] })
    expect(h.sync).toEqual([])
    expect(h.async).toEqual([])
  })
})

describe('the CLI checks ask what the launch will run', () => {
  // The CLI check reads process.platform (the setup probe os.platform()):
  // both run as macOS here, and are put back after.
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    process.env.SHELL = FISH
    process.env.PATH = APP_PATH
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })
  afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform) })

  it('the CLI check: Claude Code in that login shell\'s PATH is installed, with no other question asked', async () => {
    registerCliHandlers()
    const check = h.handlers.get(IPC.CLI_CHECK)!
    h.async.length = 0
    expect(await check()).toBe(true)
    expect(h.async.map((c) => [c.file, c.args])).toEqual([[FISH, ['-l', '-c', LOGIN_SHELL_PATH_COMMAND]]])
  })

  it('the CLI check: none in that PATH -> the sh-family launcher\'s own login shell is asked, never the user\'s', async () => {
    h.runnable = new Set()
    h.which.set('/bin/zsh', '/usr/local/bin/claude')
    h.which.set(FISH, '/somewhere/claude')
    registerCliHandlers()
    const check = h.handlers.get(IPC.CLI_CHECK)!
    h.async.length = 0
    expect(await check()).toBe(true)
    expect(h.async.map((c) => c.file)).toEqual([FISH, '/bin/zsh'])
    expect(h.async[1].args).toEqual(['-l', '-c', 'which claude'])
    h.which.delete('/bin/zsh')
    expect(await check()).toBe(false)
  })

  it('the setup probe reports the Claude Code the launch will name', async () => {
    const r = await probeClaudeCli()
    expect(r).toMatchObject({ installed: true, path: '/Users/u/.local/bin/claude' })
    h.runnable = new Set()
    h.which.set('/bin/zsh', '/usr/local/bin/claude')
    h.which.set(FISH, '/somewhere/claude')
    _resetClaudeCliProbeForTest()
    expect(await probeClaudeCli()).toMatchObject({ installed: true, path: '/usr/local/bin/claude' })
    expect(h.async.some((c) => c.file === FISH && c.args.includes('command -v claude'))).toBe(false)
  })

  it('a launch right after the CLI check uses its answer and asks nothing on the event loop', async () => {
    registerCliHandlers()
    expect(await h.handlers.get(IPC.CLI_CHECK)!()).toBe(true)
    // The same login shell and PATH the check was asked under (beforeEach).
    const source = { SHELL: FISH, PATH: APP_PATH }
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toMatchObject({ cmd: '/bin/zsh', args: [], env: { PATH: OWN_PATH_ABSOLUTE } })
    expect(resolveClaudeBinary(undefined, source).cmd).toBe('/Users/u/.local/bin/claude')
    expect(h.sync).toEqual([])
  })

  it('another login shell outside the sh family that reports no PATH: the CLI check and the launch both stay on the launcher\'s own login shell', async () => {
    h.loginShellOut = new Error('no answer')
    h.which.set('/bin/zsh', '/usr/local/bin/claude')
    registerCliHandlers()
    // Let the ask registration starts settle first, so its answer cannot land
    // after the ones below.
    await new Promise((r) => setTimeout(r, 0))
    const check = h.handlers.get(IPC.CLI_CHECK)!
    for (const shell of ['/opt/homebrew/bin/nu', '/bin/tcsh']) {
      process.env.SHELL = shell
      _resetClaudeLoginShellLookupForTest()
      h.async.length = 0
      h.sync.length = 0
      // The check: the user's shell is asked, gives nothing, and the launcher's
      // own login shell answers -- never the user's shell for `which`.
      expect(await check(), shell).toBe(true)
      expect(h.async.map((c) => [c.file, c.args]), shell).toEqual([[shell, ['-l', '-c', LOGIN_SHELL_PATH_COMMAND]], ['/bin/zsh', ['-l', '-c', 'which claude']]])
      // The launch: the same login shell builds the PATH, and Claude Code is named.
      const source = { SHELL: shell, PATH: APP_PATH }
      expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source), shell).toEqual({ cmd: '/bin/zsh', args: ['-l'], env: { ...source, ...APP_OWNED } })
      expect(resolveClaudeBinary(undefined, source), shell).toEqual({ cmd: 'claude', args: [] })
      expect(h.sync, shell).toEqual([])
    }
  })
})
