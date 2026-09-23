// WP1.17, WP1.44, WP1.49 -- WP2 slices 3a and 3b (plan A6, A8; design 5.6,
// 8.4): the Codex version is proven from `codex --version` and classified
// against the tested range; the CLI runner and discovery work through
// injected ports. PURE: no process is started and no file is read here --
// the real-process fake-CLI integration is tests/wp1/fake-cli.test.ts (VM/CI).
import { describe, it, expect, vi } from 'vitest'
import {
  parseCodexVersion, classifyCodexVersion,
  CODEX_MIN_SUPPORTED_VERSION, CODEX_PINNED_CLI_VERSION, CODEX_MAX_TESTED_VERSION,
} from '../../src/main/providers/codex'
import { EventEmitter } from 'node:events'
import { codexCommandLine, runCodexCli, discoverCodex, verifyCodexExecutable, codexCompatibilityAllowsUse, makeCodexKillTree, extractMarkedPath } from '../../src/main/providers/codex'
import type { CodexDiscoveryDeps, CodexRunResult, CodexRunDeps } from '../../src/main/providers/codex'

describe('codex --version', () => {
  it('reads the semver from the CLI banner, and nothing else', () => {
    expect(parseCodexVersion('codex-cli 0.155.1\n')).toBe('0.155.1')
    expect(parseCodexVersion('codex-cli 0.156.0-alpha.3\r\n')).toBe('0.156.0-alpha.3')
    expect(parseCodexVersion('WARNING: something\ncodex-cli 0.155.1\n')).toBe('0.155.1')
    for (const bad of ['', '0.155.1', 'codex 0.155.1', 'codex-cli v0.155.1', 'codex-cli 0.155', 'codex-cli 0.155.1 extra', `codex-cli ${'9'.repeat(5000)}.1.1`, 'codex-cli 0.155.1-..']) {
      expect(parseCodexVersion(bad), bad.slice(0, 30)).toBeNull()
    }
  })

  it('two banners that disagree prove nothing; the same banner twice is fine', () => {
    expect(parseCodexVersion('codex-cli 0.100.0\ncodex-cli 0.155.1\n')).toBeNull()
    expect(parseCodexVersion('codex-cli 0.155.1\ncodex-cli 0.155.1\n')).toBe('0.155.1')
  })

  it('a version the parser cannot prove is unknown -- never quietly supported (the runner blocks it)', () => {
    for (const out of ['codex-cli 0.100.0 (abc123)', 'codex-cli 0.155.1+build', '0.1.2504301751']) {
      expect(classifyCodexVersion(parseCodexVersion(out)), out).toBe('unknown')
    }
  })
})

describe('the tested range', () => {
  it('is ordered: minimum <= pinned <= maximum tested', () => {
    expect(classifyCodexVersion(CODEX_MIN_SUPPORTED_VERSION)).toBe('supported')
    expect(classifyCodexVersion(CODEX_PINNED_CLI_VERSION)).toBe('supported')
    expect(classifyCodexVersion(CODEX_MAX_TESTED_VERSION)).toBe('supported')
  })

  it('older is too-old (blocked), newer is too-new (warned), unparseable is unknown', () => {
    expect(classifyCodexVersion('0.153.3')).toBe('too-old')
    expect(classifyCodexVersion('0.153.4-alpha.1')).toBe('too-old')
    expect(classifyCodexVersion('0.156.2')).toBe('too-new')
    expect(classifyCodexVersion('1.0.0')).toBe('too-new')
    expect(classifyCodexVersion(null)).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// WP1.17, WP1.49 -- slice 3b: the runner and discovery, through injected
// ports (no process is started, no file is read).
// ---------------------------------------------------------------------------

describe('the Codex command line', () => {
  it('runs a real executable directly, with a constant argv and its own folder as cwd', () => {
    expect(codexCommandLine('/usr/local/bin/codex', 'status', 'linux', {})).toEqual({ file: '/usr/local/bin/codex', args: ['login', 'status'], verbatim: false, cwd: '/usr/local/bin' })
    expect(codexCommandLine('C:\\Tools\\codex.exe', 'version', 'win32', {})).toEqual({ file: 'C:\\Tools\\codex.exe', args: ['--version'], verbatim: false, cwd: 'C:\\Tools' })
  })

  it('runs a Windows shim through the absolute cmd.exe, quoted, verbatim, in the shim folder', () => {
    const r = codexCommandLine('C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', 'login-api-key', 'win32', { SystemRoot: 'C:\\Windows' })
    expect(r).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd" login --with-api-key"'],
      verbatim: true, cwd: 'C:\\Users\\u\\AppData\\Roaming\\npm',
    })
    expect(codexCommandLine('C:\\npm\\codex.cmd', 'status', 'win32', { ComSpec: 'D:\\Win\\System32\\cmd.exe', SystemRoot: 'C:\\Windows' })).toMatchObject({ file: 'D:\\Win\\System32\\cmd.exe' })
    // A ComSpec that is not an absolute cmd.exe is ignored.
    expect(codexCommandLine('C:\\npm\\codex.cmd', 'status', 'win32', { ComSpec: 'evil.exe', SystemRoot: 'C:\\Windows' })).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe' })
  })

  it('refuses a shim path cmd.exe would re-read, a relative path, or no cmd.exe to use', () => {
    for (const p of ['C:\\a%PATH%\\codex.cmd', 'C:\\a"b\\codex.cmd', 'C:\\a&b\\codex.cmd', 'C:\\a^b\\codex.cmd', 'C:\\a\nb\\codex.cmd']) {
      expect(codexCommandLine(p, 'status', 'win32', { SystemRoot: 'C:\\Windows' }), p).toHaveProperty('refused')
    }
    expect(codexCommandLine('codex.cmd', 'status', 'win32', { SystemRoot: 'C:\\Windows' })).toHaveProperty('refused')
    expect(codexCommandLine('bin/codex', 'status', 'linux', {})).toHaveProperty('refused')
    expect(codexCommandLine('C:\\npm\\codex.cmd', 'status', 'win32', {})).toHaveProperty('refused')
    expect(codexCommandLine('/bin/codex', 'rm -rf' as never, 'linux', {})).toHaveProperty('refused')
  })
})

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } | null
  constructor(piped: boolean) { super(); this.stdin = piped ? { end: vi.fn(), on: vi.fn() } : null }
}

function fakeDeps() {
  const spawned: Array<{ file: string; args: readonly string[]; opts: Record<string, unknown>; child: FakeChild }> = []
  const killed: FakeChild[] = []
  const deps: CodexRunDeps = {
    platform: 'win32',
    spawn: ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
      const stdio = opts.stdio as string[]
      const child = new FakeChild(stdio[0] === 'pipe')
      spawned.push({ file, args, opts, child })
      return child
    }) as never,
    killTree: (c) => { killed.push(c as unknown as FakeChild) },
  }
  return { deps, spawned, killed }
}

describe('the Codex runner', () => {
  const cmd = { file: 'C:\\x\\codex.exe', args: ['login', 'status'], verbatim: false, cwd: 'C:\\x' }

  it('spawns without a shell, with exactly the env it was given, stdin ignored unless a value is sent', async () => {
    const { deps, spawned } = fakeDeps()
    const p = runCodexCli(cmd, { env: { PATH: 'p', CODEX_HOME: 'h' }, timeoutMs: 1000 }, deps)
    const s = spawned[0]
    expect(s.opts).toMatchObject({ cwd: 'C:\\x', env: { PATH: 'p', CODEX_HOME: 'h' }, shell: false, windowsHide: true, windowsVerbatimArguments: false })
    expect((s.opts.stdio as string[])[0]).toBe('ignore')
    s.child.stdout.emit('data', Buffer.from('Logged in using ChatGPT\n'))
    s.child.emit('close', 0)
    expect(await p).toEqual({ exitCode: 0, timedOut: false, stdout: 'Logged in using ChatGPT\n', stderr: '', truncated: false })
  })

  it('writes a stdin value once to a pipe and closes it (the API-key path; never argv)', async () => {
    const { deps, spawned } = fakeDeps()
    const p = runCodexCli({ ...cmd, args: ['login', '--with-api-key'] }, { env: {}, timeoutMs: 1000, stdin: 'sk-test' }, deps)
    const s = spawned[0]
    expect((s.opts.stdio as string[])[0]).toBe('pipe')
    expect(s.child.stdin!.end).toHaveBeenCalledWith('sk-test')
    expect(s.args.join(' ')).not.toContain('sk-test')
    s.child.emit('close', 0)
    await p
  })

  it('caps each stream and says so', async () => {
    const { deps, spawned } = fakeDeps()
    const p = runCodexCli(cmd, { env: {}, timeoutMs: 1000, maxOutput: 5 }, deps)
    spawned[0].child.stdout.emit('data', 'abcdefgh')
    spawned[0].child.emit('close', 0)
    expect(await p).toMatchObject({ stdout: 'abcde', truncated: true })
  })

  it('at the deadline it kills the whole tree and settles, whatever the child does next', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned, killed } = fakeDeps()
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 50 }, deps)
      await vi.advanceTimersByTimeAsync(60)
      expect(killed).toEqual([spawned[0].child])
      spawned[0].child.emit('close', 0)
      expect(await p).toMatchObject({ exitCode: null, timedOut: true })
    } finally { vi.useRealTimers() }
  })

  it('a spawn that throws or errors settles with the error; a cancel kills the tree', async () => {
    const throwing: CodexRunDeps = { platform: 'linux', spawn: (() => { throw new Error('EACCES') }) as never, killTree: () => {} }
    expect(await runCodexCli(cmd, { env: {}, timeoutMs: 1000 }, throwing)).toMatchObject({ exitCode: null, spawnError: 'EACCES' })
    const { deps, spawned, killed } = fakeDeps()
    const p = runCodexCli(cmd, { env: {}, timeoutMs: 1000 }, deps)
    spawned[0].child.emit('error', new Error('ENOENT'))
    expect(await p).toMatchObject({ spawnError: 'ENOENT' })
    const ac = new AbortController()
    const q = runCodexCli(cmd, { env: {}, timeoutMs: 1000, signal: ac.signal }, deps)
    ac.abort()
    expect(await q).toMatchObject({ spawnError: 'cancelled' })
    expect(killed).toContain(spawned[1].child)
  })

  it('a POSIX run leads its own process group, so the tree can be killed', () => {
    const { deps, spawned } = fakeDeps()
    void runCodexCli(cmd, { env: {}, timeoutMs: 1000 }, { ...deps, platform: 'linux' })
    expect(spawned[0].opts.detached).toBe(true)
    void runCodexCli(cmd, { env: {}, timeoutMs: 1000 }, deps)
    expect(spawned[1].opts.detached).toBe(false)
  })
})

describe('the runner: settling, the tree kill and the environment (adversarial round 1)', () => {
  const cmd = { file: 'C:\\x\\codex.exe', args: ['login', 'status'], verbatim: false, cwd: 'C:\\x' }

  it('a root that has exited is never killed by pid; the run settles with its exit code', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned, killed } = fakeDeps()
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 50 }, deps)
      spawned[0].child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(60)
      expect(killed).toEqual([])
      expect(await p).toMatchObject({ exitCode: 0, timedOut: false })
    } finally { vi.useRealTimers() }
  })

  it('nothing is reported after the run has settled', async () => {
    const seen: string[] = []
    const { deps, spawned } = fakeDeps()
    const ac = new AbortController()
    const p = runCodexCli(cmd, { env: {}, timeoutMs: 1000, signal: ac.signal, onOutput: (t) => seen.push(t) }, deps)
    ac.abort()
    await p
    spawned[0].child.stdout.emit('data', 'Successfully logged in\n')
    expect(seen).toEqual([])
  })

  it('an already-cancelled run and an unusable deadline start nothing', async () => {
    const { deps, spawned } = fakeDeps()
    const ac = new AbortController()
    ac.abort()
    expect(await runCodexCli(cmd, { env: {}, timeoutMs: 1000, signal: ac.signal }, deps)).toMatchObject({ spawnError: 'cancelled' })
    for (const t of [0, -1, Infinity, Number.NaN, 2 ** 31]) expect(await runCodexCli(cmd, { env: {}, timeoutMs: t }, deps), String(t)).toMatchObject({ spawnError: 'invalid timeout' })
    expect(spawned).toHaveLength(0)
  })

  it('the child gets a prototype-free copy of exactly the given variables', async () => {
    const { deps, spawned } = fakeDeps()
    void runCodexCli(cmd, { env: { PATH: 'p', X: undefined as unknown as string }, timeoutMs: 1000 }, deps)
    const env = spawned[0].opts.env as Record<string, string>
    expect(Object.getPrototypeOf(env)).toBeNull()
    expect({ ...env }).toEqual({ PATH: 'p' })
  })

  it('taskkill runs only from an absolute Windows root, there, bounded; otherwise the root alone is killed', () => {
    const calls: Array<{ file: string; opts: Record<string, unknown> }> = []
    const spawn = ((file: string, _a: readonly string[], opts: Record<string, unknown>) => { calls.push({ file, opts }); return new EventEmitter() }) as never
    const child = () => Object.assign(new EventEmitter(), { pid: 7, exitCode: null, signalCode: null, kill: vi.fn() })
    makeCodexKillTree('win32', spawn, 'C:\\Windows')(child() as never)
    expect(calls[0]).toMatchObject({ file: 'C:\\Windows\\System32\\taskkill.exe', opts: { cwd: 'C:\\Windows', timeout: 5000 } })
    for (const root of [undefined, '', 'Windows', '\\Windows']) {
      const c = child()
      makeCodexKillTree('win32', spawn, root)(c as never)
      expect(c.kill, String(root)).toHaveBeenCalled()
    }
    expect(calls).toHaveLength(1)
    const exited = Object.assign(child(), { exitCode: 0 })
    makeCodexKillTree('win32', spawn, 'C:\\Windows')(exited as never)
    expect(calls).toHaveLength(1)
  })

  it('refuses Windows executable spellings that are not anchored, and names ending in a dot or a space', () => {
    for (const p of ['\\npm\\codex.cmd', '\\\\?\\C:\\npm\\codex.cmd', '\\\\.\\C:\\npm\\codex.cmd', '//?/C:/npm/codex.cmd', 'C:\\a&calc\\codex.cmd ', 'C:\\a%x%\\codex.cmd.']) {
      expect(codexCommandLine(p, 'status', 'win32', { SystemRoot: 'C:\\Windows' }), p).toHaveProperty('refused')
    }
    expect(codexCommandLine('\\\\srv\\share\\npm\\codex.exe', 'status', 'win32', {})).toMatchObject({ file: '\\\\srv\\share\\npm\\codex.exe' })
  })
})

function discoveryDeps(over: Partial<CodexDiscoveryDeps> = {}, result: Partial<CodexRunResult> = {}) {
  const runs: Array<{ cmd: unknown; env: Record<string, string> }> = []
  const homes: Array<{ home: string; disposed: boolean }> = []
  const deps: CodexDiscoveryDeps = {
    resolve: () => 'C:\\npm\\codex.cmd',
    realpath: (p) => p,
    stat: () => ({ size: 100, mtimeMs: 5.25, ctimeMs: 6.5, dev: '1', ino: '2', isFile: true }),
    run: async (cmd, env) => { runs.push({ cmd, env }); return { exitCode: 0, stdout: 'codex-cli 0.155.1\n', stderr: '', timedOut: false, truncated: false, ...result } },
    env: { PATH: 'C:\\npm', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-x' },
    platform: 'win32',
    versionHome: () => { const h = { home: `C:\\tmp\\ccc-codex-version-${homes.length}`, disposed: false }; homes.push(h); return { home: h.home, dispose: () => { h.disposed = true } } },
    now: () => 77,
    ...over,
  }
  return { deps, runs, homes }
}

describe('discovery', () => {
  it('finds, canonicalises, proves the version in a throwaway home under the allowlisted environment, and records the identity', async () => {
    const { deps, runs, homes } = discoveryDeps({ realpath: () => 'C:\\npm\\codex.cmd' })
    expect(await discoverCodex(deps)).toEqual({
      state: 'found', executable: 'C:\\npm\\codex.cmd', version: '0.155.1', compatibility: 'supported', checkedAt: 77,
      identity: { path: 'C:\\npm\\codex.cmd', size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2' },
    })
    expect(runs[0].env).toMatchObject({ PATH: 'C:\\npm', NoDefaultCurrentDirectoryInExePath: '1', CODEX_HOME: homes[0].home })
    expect(runs[0].env.OPENAI_API_KEY).toBeUndefined()
    // The throwaway home is removed, whatever happened.
    expect(homes.map((h) => h.disposed)).toEqual([true])
    await discoverCodex(discoveryDeps({ run: async () => { throw new Error('boom') } }).deps)
  })

  it('the throwaway home is removed even when the run throws', async () => {
    const d = discoveryDeps({ run: async () => { throw new Error('boom') } })
    expect(await discoverCodex(d.deps)).toMatchObject({ state: 'error' })
    expect(d.homes.map((h) => h.disposed)).toEqual([true])
  })

  it('a change-time-only move during the run (Gatekeeper on first run) is not tampering; the identity kept is the one read after', async () => {
    let n = 0
    const d = discoveryDeps({ stat: () => ({ size: 100, mtimeMs: 5, ctimeMs: n++ === 0 ? 6 : 9, dev: '1', ino: '2', isFile: true }) })
    expect(await discoverCodex(d.deps)).toMatchObject({ state: 'found', identity: { ctimeMs: 9 } })
  })

  it('a file that changed while it was being checked is not proven', async () => {
    let n = 0
    const d = discoveryDeps({ stat: () => ({ size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: n++ === 0 ? '2' : '3', isFile: true }) })
    expect(await discoverCodex(d.deps)).toMatchObject({ state: 'invalid', detail: expect.stringMatching(/changed while/) })
  })

  it('classifies what it finds and never calls an unproven CLI usable', async () => {
    expect(await discoverCodex(discoveryDeps({}, { stdout: 'codex-cli 0.150.0' }).deps)).toMatchObject({ state: 'found', compatibility: 'too-old' })
    expect(await discoverCodex(discoveryDeps({}, { stdout: 'codex-cli 0.200.0' }).deps)).toMatchObject({ state: 'found', compatibility: 'too-new' })
    expect(await discoverCodex(discoveryDeps({}, { stdout: 'nonsense' }).deps)).toMatchObject({ state: 'invalid', compatibility: 'unknown' })
    expect(await discoverCodex(discoveryDeps({}, { exitCode: 1, stdout: 'codex-cli 0.155.1' }).deps)).toMatchObject({ state: 'invalid', compatibility: 'unknown' })
    expect(await discoverCodex(discoveryDeps({}, { stdout: '', stderr: 'codex-cli 0.155.1' }).deps)).toMatchObject({ state: 'invalid' })
    expect(['supported', 'too-new'].map((c) => codexCompatibilityAllowsUse(c as never))).toEqual([true, true])
    expect(['too-old', 'unknown', 'unsupported'].map((c) => codexCompatibilityAllowsUse(c as never))).toEqual([false, false, false])
  })

  it('reports missing, unreadable, not-a-file, refused, unstartable and silent CLIs without guessing', async () => {
    expect(await discoverCodex(discoveryDeps({ resolve: () => null }).deps)).toMatchObject({ state: 'missing' })
    expect(await discoverCodex(discoveryDeps({ realpath: () => { throw new Error('ENOENT') } }).deps)).toMatchObject({ state: 'invalid' })
    expect(await discoverCodex(discoveryDeps({ stat: () => ({ size: 0, mtimeMs: 0, ctimeMs: 0, dev: '0', ino: '0', isFile: false }) }).deps)).toMatchObject({ state: 'invalid' })
    expect(await discoverCodex(discoveryDeps({ resolve: () => 'C:\\a&b\\codex.cmd' }).deps)).toMatchObject({ state: 'invalid' })
    expect(await discoverCodex(discoveryDeps({}, { spawnError: 'EACCES', exitCode: null }).deps)).toMatchObject({ state: 'error' })
    expect(await discoverCodex(discoveryDeps({}, { timedOut: true, exitCode: null }).deps)).toMatchObject({ state: 'error' })
  })
})

describe('executable re-verification before use (WP1.49)', () => {
  const recorded = { path: 'C:\\npm\\codex.cmd', size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2' }
  const st = { size: 100, mtimeMs: 5.9, ctimeMs: 6.1, dev: '1', ino: '2', isFile: true }
  const base = { resolve: () => 'C:\\npm\\codex.cmd', realpath: (p: string) => p, stat: () => st, platform: 'win32' as const }

  it('the same file at the same path passes (case-insensitively on Windows) and returns the path to run', () => {
    expect(verifyCodexExecutable(recorded, base)).toEqual({ ok: true, executable: 'C:\\npm\\codex.cmd' })
    expect(verifyCodexExecutable(recorded, { ...base, resolve: () => 'c:\\NPM\\codex.cmd' })).toEqual({ ok: true, executable: 'c:\\NPM\\codex.cmd' })
  })

  it('a shadowing executable, a replaced file (even with size and mtime kept) or a vanished one blocks', () => {
    expect(verifyCodexExecutable(recorded, { ...base, resolve: () => 'C:\\evil\\codex.cmd' })).toMatchObject({ ok: false, reason: 'moved' })
    expect(verifyCodexExecutable(recorded, { ...base, stat: () => ({ ...st, size: 101 }) })).toMatchObject({ ok: false, reason: 'replaced' })
    expect(verifyCodexExecutable(recorded, { ...base, stat: () => ({ ...st, ino: '9' }) })).toMatchObject({ ok: false, reason: 'replaced' })
    expect(verifyCodexExecutable(recorded, { ...base, stat: () => ({ ...st, ctimeMs: 60 }) })).toMatchObject({ ok: false, reason: 'replaced' })
    expect(verifyCodexExecutable(recorded, { ...base, resolve: () => null })).toMatchObject({ ok: false, reason: 'missing' })
    expect(verifyCodexExecutable({ ...recorded, path: '/usr/bin/codex' }, { ...base, platform: 'linux', resolve: () => '/usr/bin/Codex' })).toMatchObject({ ok: false, reason: 'moved' })
  })
})

describe('the login-shell PATH (macOS/Linux)', () => {
  const O = '__CCC_CODEX_PATH_BEGIN__'
  const C = '__CCC_CODEX_PATH_END__'
  it('reads only what lies between the markers, whatever a profile prints around them', () => {
    expect(extractMarkedPath(`banner\n${O}/opt/homebrew/bin:/usr/bin${C}bye\n`)).toBe('/opt/homebrew/bin:/usr/bin')
    expect(extractMarkedPath(`${O}/usr/bin${C}\n`)).toBe('/usr/bin')
  })
  it('keeps absolute entries only, and refuses no marker, an unclosed one or a broken value', () => {
    expect(extractMarkedPath(`${O}:.:/usr/bin::rel/bin${C}`)).toBe('/usr/bin')
    expect(extractMarkedPath('/usr/bin')).toBeNull()
    expect(extractMarkedPath(`${O}/usr/bin`)).toBeNull()
    expect(extractMarkedPath(`${O}/usr/bin\n/x${C}`)).toBeNull()
    expect(extractMarkedPath(`${O}.:rel${C}`)).toBeNull()
  })
})
