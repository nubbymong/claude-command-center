// WP1.38: the cached `claude --version` probe behind the managed-launch
// preflight's CLI floor.
//
// It is on the security path by consequence rather than by content: if this
// module answers `null` for a healthy install, every managed launch gets a
// blocking "version not verified" finding; if it ever cached a stale or wrong
// answer, an out-of-date CLI would read as verified. Both directions are
// covered below.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type ExecCb = (err: Error | null, stdout?: string) => void
let execFileImpl: (bin: string, args: string[], opts: unknown, cb: ExecCb) => unknown
let probeImpl: () => Promise<{ installed: boolean; path?: string; probe: string }>

vi.mock('node:child_process', () => ({
  execFile: (bin: string, args: string[], opts: unknown, cb: ExecCb) => execFileImpl(bin, args, opts, cb),
}))
vi.mock('../../../src/main/claude-cli-probe', () => ({
  probeClaudeCli: () => probeImpl(),
}))

const {
  parseClaudeCliVersion, peekClaudeCliVersion, probeClaudeCliVersion,
  ensureClaudeCliVersion, _resetClaudeCliVersionForTest, versionProbeCommand,
  findClaudeOnWindowsPath, _setProbeTimeoutForTest,
} = await import('../../../src/main/claude-cli-version')

const RESOLVED = '/usr/local/bin/claude'

// On Windows the probe walks the PATH instead of asking probeClaudeCli, so the
// generic cases below (a POSIX path from the mocked resolver) pin a POSIX
// platform; the Windows cases at the end set win32 themselves.
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true })

beforeEach(() => {
  setPlatform('linux')
  _resetClaudeCliVersionForTest()
  probeImpl = async () => ({ installed: true, path: RESOLVED, probe: 'test' })
  execFileImpl = (_b, _a, _o, cb) => cb(null, '2.1.278 (Claude Code)\n')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
})

describe('parseClaudeCliVersion', () => {
  it('reads the version out of the CLI banner', () => {
    expect(parseClaudeCliVersion('2.1.278 (Claude Code)')).toBe('2.1.278')
    expect(parseClaudeCliVersion('claude 2.1.0')).toBe('2.1.0')
    expect(parseClaudeCliVersion('2.1.0-beta.1')).toBe('2.1.0-beta.1')
  })

  it('answers null rather than guessing when there is no version in the output', () => {
    for (const raw of ['', 'command not found', 'claude']) expect(parseClaudeCliVersion(raw), raw).toBeNull()
  })
})

describe('probeClaudeCliVersion', () => {
  it('starts unknown: peek is null until a probe has answered', () => {
    expect(peekClaudeCliVersion()).toBeNull()
  })

  it('runs the RESOLVED binary, not the bare name', async () => {
    // The reason this module resolves through probeClaudeCli at all: a
    // GUI-launched Electron's PATH does not carry Homebrew/nvm/asdf, so
    // `execFile('claude', ...)` reports missing for a CLI the login shell finds.
    let seen = ''
    execFileImpl = (bin, _a, _o, cb) => { seen = bin; cb(null, '2.1.278 (Claude Code)') }
    await probeClaudeCliVersion()
    expect(seen).toBe(RESOLVED)
  })

  it('caches a successful answer', async () => {
    expect(await probeClaudeCliVersion()).toBe('2.1.278')
    expect(peekClaudeCliVersion()).toBe('2.1.278')
  })

  it('shares ONE subprocess between overlapping callers, and both get the same answer', async () => {
    let calls = 0
    let pending: ExecCb | null = null
    execFileImpl = (_b, _a, _o, cb) => { calls++; pending = cb }
    const a = probeClaudeCliVersion()
    const b = probeClaudeCliVersion()
    expect(a).toBe(b)               // the SAME promise: coalesced synchronously
    // The binary resolution is async, so the subprocess starts a microtask
    // later; drain before counting rather than asserting on a race.
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(calls).toBe(1)
    pending!(null, '2.1.278 (Claude Code)')
    expect(await a).toBe('2.1.278')
    expect(await b).toBe('2.1.278')
  })

  it('caches NOTHING on failure, so a transient error cannot make an old CLI look verified', async () => {
    execFileImpl = (_b, _a, _o, cb) => cb(new Error('boom'))
    expect(await probeClaudeCliVersion()).toBeNull()
    expect(peekClaudeCliVersion()).toBeNull()

    // ...and the next call genuinely re-probes rather than returning the failure.
    execFileImpl = (_b, _a, _o, cb) => cb(null, '2.1.279 (Claude Code)')
    expect(await probeClaudeCliVersion()).toBe('2.1.279')
    expect(peekClaudeCliVersion()).toBe('2.1.279')
  })

  it('answers null when no CLI can be resolved at all', async () => {
    probeImpl = async () => ({ installed: false, probe: 'where claude' })
    expect(await probeClaudeCliVersion()).toBeNull()
    expect(peekClaudeCliVersion()).toBeNull()
  })

  it('does not throw when the resolver itself rejects', async () => {
    probeImpl = async () => { throw new Error('probe exploded') }
    await expect(probeClaudeCliVersion()).resolves.toBeNull()
  })

  it('does not throw when execFile throws synchronously', async () => {
    execFileImpl = () => { throw new Error('spawn EACCES') }
    await expect(probeClaudeCliVersion()).resolves.toBeNull()
  })
})

describe('ensureClaudeCliVersion', () => {
  it('probes while the answer is unknown', async () => {
    let calls = 0
    execFileImpl = (_b, _a, _o, cb) => { calls++; cb(null, '2.1.278 (Claude Code)') }
    ensureClaudeCliVersion()
    await probeClaudeCliVersion()
    expect(calls).toBe(1)
    expect(peekClaudeCliVersion()).toBe('2.1.278')
  })

  it('does NOT re-probe once a version is known -- it is called on the launch path', async () => {
    await probeClaudeCliVersion()
    let calls = 0
    execFileImpl = (_b, _a, _o, cb) => { calls++; cb(null, '2.1.278 (Claude Code)') }
    ensureClaudeCliVersion()
    ensureClaudeCliVersion()
    await Promise.resolve()
    expect(calls).toBe(0)
  })

  it('never throws, whatever the probe does', () => {
    probeImpl = async () => { throw new Error('nope') }
    _resetClaudeCliVersionForTest()
    expect(() => ensureClaudeCliVersion()).not.toThrow()
  })

  it('backs off after a FAILED probe instead of re-probing on every spawn', async () => {
    // The opportunistic path runs per managed launch, and a resolution chain
    // spawns a LOGIN SHELL on POSIX (8s timeout, up to three candidates). With
    // no floor, a machine with no resolvable CLI would start one of those on
    // every session the user opens.
    let resolutions = 0
    probeImpl = async () => { resolutions++; return { installed: false, probe: 'none' } }

    expect(await probeClaudeCliVersion()).toBeNull()
    expect(resolutions).toBe(1)

    for (let i = 0; i < 5; i++) { ensureClaudeCliVersion(); await Promise.resolve() }
    expect(resolutions, 'ensure() re-probed inside the backoff window').toBe(1)
  })

  it('a DELIBERATE probe ignores the backoff', async () => {
    // The floor is on the opportunistic path only. An explicit call -- boot, or
    // a future "check again" affordance -- must still run.
    let resolutions = 0
    probeImpl = async () => { resolutions++; return { installed: false, probe: 'none' } }
    await probeClaudeCliVersion()
    await probeClaudeCliVersion()
    expect(resolutions).toBe(2)
  })
})

// Found on the packaged app on a Windows VM: the npm install puts `claude.cmd`
// on the PATH, Node refuses to execFile a batch file without a shell (EINVAL
// since CVE-2024-27980), so every probe threw, the version stayed unknown, and
// every managed launch carried a blocking "not yet verified" finding.
describe('findClaudeOnWindowsPath', () => {
  // Found in the same pass: `where` answers in the OEM code page, so a profile
  // folder like `José` came back with a replacement character and the version
  // stayed unknown.
  const files = (...ps: string[]) => async (p: string): Promise<'file' | 'none' | 'unreachable'> => (ps.includes(p) ? 'file' : 'none')

  it('finds claude.exe anywhere on the PATH before claude.cmd -- the order the managed launch asks where for', async () => {
    const PATH = 'C:\\npm;C:\\Users\\A\\.local\\bin'
    expect(await findClaudeOnWindowsPath(PATH, files('C:\\npm\\claude.cmd', 'C:\\Users\\A\\.local\\bin\\claude.exe'))).toBe('C:\\Users\\A\\.local\\bin\\claude.exe')
    expect(await findClaudeOnWindowsPath(PATH, files('C:\\npm\\claude.cmd'))).toBe('C:\\npm\\claude.cmd')
    expect(await findClaudeOnWindowsPath(PATH, files('C:\\npm\\claude.bat'))).toBe('C:\\npm\\claude.bat')
    expect(await findClaudeOnWindowsPath(PATH, files())).toBeNull()
    expect(await findClaudeOnWindowsPath(undefined, files())).toBeNull()
  })

  it('keeps a non-ASCII folder intact', async () => {
    for (const dir of ['C:\\Users\\José Müller\\AppData\\Roaming\\npm', 'C:\\Users\\张伟\\.local\\bin', 'C:\\Users\\Ivanо\\npm']) {
      expect(await findClaudeOnWindowsPath(`C:\\x;${dir}`, files(`${dir}\\claude.cmd`))).toBe(`${dir}\\claude.cmd`)
    }
  })

  it('never searches the current directory, and skips entries cmd.exe cannot run from', async () => {
    // relative, drive-relative, root-relative, unexpanded (relative AND absolute),
    // and the \\?\ and \\.\ device namespaces in either slash
    const entries = ['.', 'bin', 'C:bin', '\\bin', '%USERPROFILE%\\bin', 'C:\\Users\\%USERNAME%\\bin', '',
      '\\\\?\\C:\\npm', '\\\\.\\C:\\npm', '\\\\?/C:\\npm', '\\\\./C:\\npm', '\\\\.', '\\\\?', '\\\\. ']
    for (const entry of entries) {
      const anyExe = async (p: string): Promise<'file' | 'none'> => (p.toLowerCase().endsWith('claude.exe') ? 'file' : 'none')
      expect(await findClaudeOnWindowsPath(entry, anyExe), JSON.stringify(entry)).toBeNull()
    }
    expect(await findClaudeOnWindowsPath('"C:\\Program Files\\claude"', files('C:\\Program Files\\claude\\claude.exe'))).toBe('C:\\Program Files\\claude\\claude.exe')
    expect(await findClaudeOnWindowsPath('\\\\srv\\share\\bin', files('\\\\srv\\share\\bin\\claude.exe'))).toBe('\\\\srv\\share\\bin\\claude.exe')
  })

  it('drops a trailing dot or space from a folder name the way Windows does, but keeps .. meaning the parent', async () => {
    expect(await findClaudeOnWindowsPath('C:\\npm. ', files('C:\\npm\\claude.cmd'))).toBe('C:\\npm\\claude.cmd')
    expect(await findClaudeOnWindowsPath('C:\\a\\npm\\..', files('C:\\a\\claude.cmd'))).toBe('C:\\a\\claude.cmd')
  })

  it('awaits one entry at a time, and does not ask a folder that could not be reached again', async () => {
    // A dead network share can hold a stat for tens of seconds: the walk must
    // await it (never block the event loop), and must not pay it three times.
    let inFlight = 0
    let maxInFlight = 0
    const asked: string[] = []
    const stat = async (p: string): Promise<'file' | 'none' | 'unreachable'> => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); asked.push(p)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      if (p.startsWith('\\\\dead-host')) return 'unreachable'
      return p === 'C:\\c\\claude.cmd' ? 'file' : 'none'
    }
    expect(await findClaudeOnWindowsPath('C:\\a;\\\\dead-host\\share;C:\\c', stat)).toBe('C:\\c\\claude.cmd')
    expect(maxInFlight).toBe(1)
    expect(asked.filter((p) => p.startsWith('\\\\dead-host'))).toEqual(['\\\\dead-host\\share\\claude.exe'])
  })
})

describe('versionProbeCommand', () => {
  const ENV = { ComSpec: 'C:\\Windows\\system32\\cmd.exe', SystemRoot: 'C:\\Windows' }

  it('runs a resolved executable directly, with no shell, on every platform', () => {
    const direct = (file: string) => ({ file, args: ['--version'], verbatim: false, viaCmd: false })
    expect(versionProbeCommand('/usr/local/bin/claude', 'darwin', {})).toEqual(direct('/usr/local/bin/claude'))
    expect(versionProbeCommand('C:\\Users\\A\\.local\\bin\\claude.exe', 'win32', ENV)).toEqual(direct('C:\\Users\\A\\.local\\bin\\claude.exe'))
    // A POSIX file that happens to end in .cmd is not a batch file.
    expect(versionProbeCommand('/opt/x/claude.cmd', 'linux', {})).toEqual(direct('/opt/x/claude.cmd'))
  })

  it('runs a Windows .cmd/.bat shim through cmd.exe the way Node runs shell:true: quoted, verbatim, in its own folder', () => {
    const shim = 'C:\\Users\\A B (x86)\\AppData\\Roaming\\npm\\claude.cmd'
    expect(versionProbeCommand(shim, 'win32', ENV)).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `""${shim}" --version"`],
      verbatim: true,
      viaCmd: true,
      cwd: 'C:\\Users\\A B (x86)\\AppData\\Roaming\\npm',
      env: { NoDefaultCurrentDirectoryInExePath: '1' },
    })
    expect(versionProbeCommand('C:\\npm\\CLAUDE.BAT', 'win32', ENV)).toMatchObject({ verbatim: true, viaCmd: true })
  })

  it('uses ComSpec only when it is an absolute cmd.exe; otherwise the System32 one; bare cmd.exe only with neither', () => {
    const sys32 = 'C:\\Windows\\System32\\cmd.exe'
    for (const ComSpec of ['C:\\tools\\pwsh.exe', 'cmd', 'cmd.exe', '"C:\\Windows\\system32\\cmd.exe"', '\\\\?\\C:\\Windows\\System32\\cmd.exe', undefined]) {
      expect(versionProbeCommand('C:\\npm\\claude.cmd', 'win32', { ComSpec, SystemRoot: 'C:\\Windows' }), String(ComSpec)).toMatchObject({ file: sys32 })
    }
    expect(versionProbeCommand('C:\\npm\\claude.cmd', 'win32', { ComSpec: 'D:\\Win\\System32\\CMD.EXE' })).toMatchObject({ file: 'D:\\Win\\System32\\CMD.EXE' })
    expect(versionProbeCommand('C:\\npm\\claude.cmd', 'win32', {})).toMatchObject({ file: 'cmd.exe' })
    expect(versionProbeCommand('C:\\npm\\claude.cmd', 'win32', { SystemRoot: '%SystemRoot%' })).toMatchObject({ file: 'cmd.exe' })
  })

  it('refuses a shim path cmd.exe or the shim would re-read, rather than run it', () => {
    for (const p of ['C:\\Users\\%USERNAME%\\npm\\claude.cmd', 'C:\\a"b\\claude.cmd', 'C:\\a & b\\claude.cmd', 'C:\\a^b\\claude.cmd', 'C:\\a\nb\\claude.cmd', 'C:\\a\rb\\claude.cmd']) {
      expect(versionProbeCommand(p, 'win32', ENV), JSON.stringify(p)).toHaveProperty('refused')
    }
  })
})

/** A child that never calls back, recording what is done to it. */
const hungChild = (order: string[], exited: boolean) => ({
  pid: 4242,
  exitCode: exited ? 0 : null,
  signalCode: null,
  kill: () => { order.push('kill') },
  stdout: { destroy: () => { order.push('destroy-stdout') } },
  stderr: { destroy: () => { order.push('destroy-stderr') } },
})

// The timeout on the DIRECT route runs on every platform (macOS and Linux CI too).
describe('a probe that never answers, run directly', () => {
  it('settles, kills the child itself and destroys its streams; no taskkill', async () => {
    const order: string[] = []
    execFileImpl = (bin) => { order.push('exec ' + bin); return hungChild(order, false) }
    _setProbeTimeoutForTest(50)
    expect(await probeClaudeCliVersion()).toBeNull()
    expect(peekClaudeCliVersion()).toBeNull()
    expect(order).toEqual(['exec ' + RESOLVED, 'kill', 'destroy-stdout', 'destroy-stderr'])
  })
})

// These need a real Windows PATH entry (a drive-letter folder that exists), so
// they run on Windows only; the pure cases above run everywhere.
describe.runIf(process.platform === 'win32')('probeClaudeCliVersion on Windows', () => {
  let root = ''
  let savedPath: string | undefined
  let fsMod: typeof import('node:fs')
  let pathMod: typeof import('node:path')

  // The shim template npm writes for a JS bin: it re-reads its own folder
  // unquoted (`SET dp0=%~dp0`) and then starts a bare `node`.
  const NODE_SHIM = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n') + '\r\n'

  beforeEach(async () => {
    fsMod = await import('node:fs')
    pathMod = await import('node:path')
    const os = await import('node:os')
    root = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'wp1-probe-'))
    savedPath = process.env.PATH
    setPlatform('win32')
    // The resolver must NOT be consulted on Windows: `where` mangles non-ASCII.
    probeImpl = async () => { throw new Error('probeClaudeCli must not run on win32') }
  })

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    // A just-killed cmd.exe can hold its working folder for a moment.
    fsMod.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  const shimIn = (folder: string): string => {
    const dir = pathMod.join(root, folder)
    fsMod.mkdirSync(dir, { recursive: true })
    const shim = pathMod.join(dir, 'claude.cmd')
    fsMod.writeFileSync(shim, '@echo off\r\n')
    process.env.PATH = dir
    return shim
  }

  it('answers the version of an npm shim under a non-ASCII folder instead of throwing EINVAL', async () => {
    const shim = shimIn('José 张伟 (x86)')
    let seen: { bin: string; args: string[]; opts: { windowsVerbatimArguments?: boolean; cwd?: string; env?: Record<string, string> } } | null = null
    execFileImpl = (bin, args, opts, cb) => {
      seen = { bin, args, opts: opts as NonNullable<typeof seen>['opts'] }
      // What real Node does when handed a batch file with no shell.
      if (/\.(cmd|bat)$/i.test(bin)) throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
      cb(null, '2.1.280 (Claude Code)\n')
    }
    expect(await probeClaudeCliVersion()).toBe('2.1.280')
    expect(peekClaudeCliVersion()).toBe('2.1.280')
    expect(seen!.bin).toMatch(/[\\/]cmd\.exe$/i)
    expect(seen!.args.at(-1)).toBe(`""${shim}" --version"`)
    expect(seen!.opts.windowsVerbatimArguments).toBe(true)
    expect(seen!.opts.cwd).toBe(pathMod.dirname(shim))
    expect(seen!.opts.env?.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('leaves the version unknown, without running anything, for a refused shim path', async () => {
    shimIn('a & b')
    let calls = 0
    execFileImpl = (_b, _a, _o, cb) => { calls++; cb(null, '2.1.280 (Claude Code)') }
    expect(await probeClaudeCliVersion()).toBeNull()
    expect(calls).toBe(0)
    expect(peekClaudeCliVersion()).toBeNull()
  })

  it('settles a probe that never answers, takes the tree BEFORE cmd.exe with the System32 taskkill, and kills nothing once it has exited', async () => {
    shimIn('npm')
    const order: string[] = []
    let exited = false
    execFileImpl = (bin, args, _o, cb) => {
      if (/taskkill\.exe$/i.test(bin)) { order.push(`taskkill ${bin} ${args.join(' ')}`); cb(null, ''); return { pid: 1 } }
      return hungChild(order, exited)  // cmd.exe: never calls back
    }
    const taskkill = `taskkill ${pathMod.win32.join(process.env.SystemRoot!, 'System32', 'taskkill.exe')} /PID 4242 /T /F`

    _setProbeTimeoutForTest(50)
    expect(await probeClaudeCliVersion()).toBeNull()   // settles although the callback never fires
    expect(peekClaudeCliVersion()).toBeNull()
    expect(order.indexOf(taskkill)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(taskkill)).toBeLessThan(order.indexOf('kill'))
    expect(order).toContain('destroy-stdout')
    expect(order).toContain('destroy-stderr')

    // Exited but still holding its streams: its pid may already be someone else's.
    _resetClaudeCliVersionForTest()
    _setProbeTimeoutForTest(50)
    order.length = 0
    exited = true
    expect(await probeClaudeCliVersion()).toBeNull()
    expect(order.some((o) => o.startsWith('taskkill'))).toBe(false)
    expect(order).not.toContain('kill')
    expect(order).toContain('destroy-stdout')
  })

  it('with no usable SystemRoot there is no taskkill to trust: it kills cmd.exe itself and still destroys the streams', async () => {
    shimIn('npm')
    const order: string[] = []
    execFileImpl = (bin) => { if (/taskkill/i.test(bin)) order.push('taskkill'); return hungChild(order, false) }
    const saved = process.env.SystemRoot
    try {
      for (const root of [undefined, '%SystemRoot%', '\\\\.']) {
        if (root === undefined) delete process.env.SystemRoot
        else process.env.SystemRoot = root
        _resetClaudeCliVersionForTest()
        _setProbeTimeoutForTest(50)
        order.length = 0
        expect(await probeClaudeCliVersion(), String(root)).toBeNull()
        expect(order, String(root)).toEqual(['kill', 'destroy-stdout', 'destroy-stderr'])
      }
    } finally {
      if (saved === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = saved
    }
  })

  it('a REAL hung probe settles in time and leaves no process behind', async () => {
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    // cmd.exe's own exit: a real child whose exit event the test can await.
    let cmdExited: Promise<void> = Promise.resolve()
    execFileImpl = (b, a, o, cb) => {
      const c = real.execFile(b, a, o as Parameters<typeof real.execFile>[2], cb as Parameters<typeof real.execFile>[3])
      if (/[\\/]cmd\.exe$/i.test(b)) cmdExited = new Promise((r) => { if (c.exitCode !== null) r(); else c.once('exit', () => r()) })
      return c
    }
    const nodeDir = pathMod.dirname(process.execPath)
    // Precondition: the walk must reach this test's shim, not a claude.exe beside node.
    expect(fsMod.existsSync(pathMod.join(nodeDir, 'claude.exe'))).toBe(false)
    const dir = pathMod.join(root, 'hung npm')
    const cliDir = pathMod.join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
    fsMod.mkdirSync(cliDir, { recursive: true })
    const pidFile = pathMod.join(root, 'grandchild.pid')
    fsMod.writeFileSync(pathMod.join(cliDir, 'cli.js'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000)\n`)
    fsMod.writeFileSync(pathMod.join(dir, 'claude.cmd'), NODE_SHIM)
    process.env.PATH = `${dir};${nodeDir}`

    // Long enough for a cold cmd.exe + node start on a heavily loaded machine:
    // the case is about what happens AFTER the timeout, so the CLI must be
    // running by then (measured: 6 s was not enough with the CPU saturated).
    const TIMEOUT = 15_000
    _setProbeTimeoutForTest(TIMEOUT)
    const t0 = Date.now()
    const answer = probeClaudeCliVersion()
    let pid = 0
    let alive = true
    try {
      for (const end = Date.now() + TIMEOUT; !(pid > 0) && Date.now() < end;) {
        try { pid = Number(fsMod.readFileSync(pidFile, 'utf8')) } catch { /* not written yet */ }
        if (!(pid > 0)) await new Promise((r) => setTimeout(r, 100))
      }
      expect(pid, 'the hung CLI never started, so this case proved nothing').toBeGreaterThan(0)
      expect(await answer).toBeNull()
      expect(Date.now() - t0).toBeLessThan(TIMEOUT + 10_000)
      for (const end = Date.now() + 8000; Date.now() < end;) {
        try { process.kill(pid, 0) } catch { alive = false; break }
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(alive, `the CLI (pid ${pid}) outlived its timed-out probe`).toBe(false)
      // ...and so did cmd.exe (it is killed from taskkill's callback). Its exit
      // also releases the working folder the cleanup below removes.
      let raceTimer: ReturnType<typeof setTimeout> | undefined
      const cmdGone = await Promise.race([cmdExited.then(() => true), new Promise<boolean>((r) => { raceTimer = setTimeout(() => r(false), 10_000) })])
      clearTimeout(raceTimer)
      expect(cmdGone, 'cmd.exe outlived its timed-out probe').toBe(true)
    } finally {
      // Only a pid last seen ALIVE is ours to kill: a dead one may be reused.
      if (pid > 0 && alive) { try { process.kill(pid) } catch { /* already gone */ } }
      await answer.catch(() => null)
    }
  }, 60_000)

  // The mocks above prove the wiring; this proves the command line against the
  // REAL cmd.exe and npm's real shim template.
  const runReal = async (folder: string) => {
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const dir = pathMod.join(root, folder)
    const cliDir = pathMod.join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
    fsMod.mkdirSync(cliDir, { recursive: true })
    fsMod.writeFileSync(pathMod.join(cliDir, 'cli.js'), 'console.log("2.1.280 (Claude Code) args=" + JSON.stringify(process.argv.slice(2)))\n')
    // A `node` planted beside the shim: it must NOT be the one that runs.
    fsMod.writeFileSync(pathMod.join(dir, 'node.bat'), '@echo PLANTED_NODE_RAN\r\n')
    const shim = pathMod.join(dir, 'claude.cmd')
    fsMod.writeFileSync(shim, NODE_SHIM)
    const cmd = versionProbeCommand(shim, 'win32', { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot })
    if ('refused' in cmd) throw new Error('unexpected refusal: ' + cmd.refused)
    const env = { ...process.env, PATH: pathMod.dirname(process.execPath) + ';' + (savedPath ?? ''), ...cmd.env }
    return new Promise<string>((resolve, reject) => {
      real.execFile(cmd.file, cmd.args, { encoding: 'utf-8', timeout: 20_000, windowsHide: true, windowsVerbatimArguments: cmd.verbatim, cwd: cmd.cwd, env },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
    })
  }

  it('runs npm\'s real node shim through the real cmd.exe from a folder with spaces, parentheses, ! and \' and non-ASCII', async () => {
    const out = await runReal("npm (x86) O'Brien! José 张伟")
    expect(parseClaudeCliVersion(out)).toBe('2.1.280')
    expect(out).toContain('args=["--version"]')
    expect(out).not.toContain('PLANTED_NODE_RAN')
  })
})
