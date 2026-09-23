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
import { codexCommandLine, codexShellEnv, runCodexCli, discoverCodex, verifyCodexExecutable, codexCompatibilityAllowsUse, makeCodexKillTree, extractMarkedPath } from '../../src/main/providers/codex'
import { codexChainPids, parseWindowsProcessTable, parsePosixProcessTable, parseLinuxStat, makeCodexProcessLister, CODEX_KILL_SETTLE_MS, CODEX_PROCESS_TABLE_TIMEOUT_MS, CODEX_TASKKILL_TIMEOUT_MS, WINDOWS_PROCESS_QUERY } from '../../src/main/providers/codex'
import type { CodexDiscoveryDeps, CodexRunResult, CodexRunDeps, CodexProcessEntry } from '../../src/main/providers/codex'

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
    // The kill lands: the root exits.
    killTree: (c) => { killed.push(c as unknown as FakeChild); queueMicrotask(() => c.emit('exit', null, 'SIGKILL')) },
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
      // ...marked as stopped: a descendant holding the pipe may have been cut off mid-line.
      expect(await p).toMatchObject({ exitCode: 0, timedOut: false, stopped: 'deadline' })
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

  it('taskkill runs only from an absolute Windows root, there, bounded; otherwise the root alone is killed', async () => {
    const calls: Array<{ file: string; args: readonly string[]; opts: Record<string, unknown> }> = []
    const spawn = ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts })
      const k = new EventEmitter()
      queueMicrotask(() => k.emit('exit', 0))
      return k
    }) as never
    const child = () => Object.assign(new EventEmitter(), { pid: 7, exitCode: null, signalCode: null, kill: vi.fn() })
    await makeCodexKillTree('win32', spawn, 'C:\\Windows', null)(child() as never)
    expect(calls[0]).toMatchObject({ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/F', '/PID', '7'], opts: { cwd: 'C:\\Windows', timeout: 5000 } })
    for (const root of [undefined, '', 'Windows', '\\Windows']) {
      const c = child()
      await makeCodexKillTree('win32', spawn, root, null)(c as never)
      expect(c.kill, String(root)).toHaveBeenCalled()
    }
    expect(calls).toHaveLength(1)
    const exited = Object.assign(child(), { exitCode: 0 })
    await makeCodexKillTree('win32', spawn, 'C:\\Windows', null)(exited as never)
    expect(calls).toHaveLength(1)
  })

  it('a stopped run settles only once its root has exited -- a close the kill causes is not its result -- and never reports output meanwhile', async () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const killed: FakeChild[] = []
      const { deps, spawned } = fakeDeps()
      const slow: CodexRunDeps = { ...deps, killTree: (c) => { killed.push(c as unknown as FakeChild) } }
      let settled = false
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 50, onOutput: (t) => seen.push(t) }, slow).then((r) => { settled = true; return r })
      await vi.advanceTimersByTimeAsync(60)
      expect(killed).toHaveLength(1)
      spawned[0].child.stdout.emit('data', 'late output\n')
      spawned[0].child.emit('close', 1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(settled, 'settled before the root exited').toBe(false)
      spawned[0].child.emit('exit', null, 'SIGKILL')
      expect(await p).toMatchObject({ exitCode: null, timedOut: true })
      expect(seen).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('a root that never exits still settles, after the bound', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = fakeDeps()
      const stuck: CodexRunDeps = { ...deps, killTree: () => new Promise(() => {}) }
      let settled = false
      const ac = new AbortController()
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 60_000, signal: ac.signal }, stuck).then((r) => { settled = true; return r })
      ac.abort()
      await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS - 10)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
      expect(await p).toMatchObject({ spawnError: 'cancelled' })
    } finally { vi.useRealTimers() }
  })

  it('refuses Windows executable spellings that are not anchored, and names ending in a dot or a space', () => {
    for (const p of ['\\npm\\codex.cmd', '\\\\?\\C:\\npm\\codex.cmd', '\\\\.\\C:\\npm\\codex.cmd', '//?/C:/npm/codex.cmd', 'C:\\a&calc\\codex.cmd ', 'C:\\a%x%\\codex.cmd.']) {
      expect(codexCommandLine(p, 'status', 'win32', { SystemRoot: 'C:\\Windows' }), p).toHaveProperty('refused')
    }
    expect(codexCommandLine('\\\\srv\\share\\npm\\codex.exe', 'status', 'win32', {})).toMatchObject({ file: '\\\\srv\\share\\npm\\codex.exe' })
  })
})

describe('the kill reaches only the run\'s own chain (a browser a sign-in opened is the user\'s)', () => {
  // cmd.exe (root 10) -> node (11) -> codex (12) -> chrome (13) -> chrome renderer (14)
  //                                              -> codex helper (15)
  const table: CodexProcessEntry[] = [
    { pid: 10, ppid: 1, name: 'cmd.exe', created: 100 },
    { pid: 11, ppid: 10, name: 'node.exe', created: 101 },
    { pid: 12, ppid: 11, name: 'codex-x86_64-pc-windows-msvc.exe', created: 102 },
    { pid: 13, ppid: 12, name: 'chrome.exe', created: 103 },
    { pid: 14, ppid: 13, name: 'node.exe', created: 104 },
    { pid: 15, ppid: 12, name: 'codex-command-runner.exe', created: 105 },
    { pid: 16, ppid: 10, name: 'conhost.exe', created: 101 },
    // A stale parent id: this node started long before pid 10 was reused for our cmd.exe.
    { pid: 17, ppid: 10, name: 'node.exe', created: 5 },
    { pid: 18, ppid: 99, name: 'codex.exe', created: 106 },
  ]

  it('takes the root and, below it, only cmd/node/codex images, stopping at anything else; leaves first', () => {
    const pids = codexChainPids(10, table)
    expect(new Set(pids)).toEqual(new Set([10, 11, 12, 15]))
    expect(pids[pids.length - 1]).toBe(10)
    expect(pids.indexOf(12)).toBeLessThan(pids.indexOf(11))
  })

  it('POSIX names, macOS image paths, a cycle and malformed rows are handled', () => {
    const posix: CodexProcessEntry[] = [
      { pid: 20, ppid: 1, name: 'node' },
      { pid: 21, ppid: 20, name: '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex' },
      { pid: 22, ppid: 21, name: 'xdg-open' },
      { pid: 23, ppid: 22, name: 'firefox' },
      { pid: 20, ppid: 21, name: 'node' },
      { pid: NaN, ppid: 20, name: 'node' },
      { pid: 24, ppid: 24, name: 'codex' },
      null as never,
    ]
    expect(new Set(codexChainPids(20, posix))).toEqual(new Set([20, 21]))
    expect(codexChainPids(5, [])).toEqual([5])
  })

  it('parses the Windows CIM rows and the ps rows', () => {
    expect(parseWindowsProcessTable('10,1,133000000000000000,cmd.exe\r\n11,10,0,node.exe\r\nbad row\r\n12,11,133000000000010000,Program, With Comma.exe\n')).toEqual([
      { pid: 10, ppid: 1, name: 'cmd.exe', created: 13300000000000 },
      { pid: 11, ppid: 10, name: 'node.exe' },
      { pid: 12, ppid: 11, name: 'Program, With Comma.exe', created: 13300000000001 },
    ])
    expect(parsePosixProcessTable('   20     1 node\n   21    20 /Applications/My App.app/Contents/MacOS/codex  \nnonsense\n')).toEqual([
      { pid: 20, ppid: 1, name: 'node' },
      { pid: 21, ppid: 20, name: '/Applications/My App.app/Contents/MacOS/codex' },
    ])
  })

  const child = (pid = 10) => Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
  const taskkills = (exitCode = 0) => {
    const calls: Array<readonly string[]> = []
    const spawn = ((_f: string, args: readonly string[]) => { calls.push(args); const k = new EventEmitter(); queueMicrotask(() => k.emit('exit', exitCode)); return k }) as never
    return { calls, spawn }
  }

  it('Windows: one taskkill naming exactly the chain, no /T', async () => {
    const { calls, spawn } = taskkills()
    await makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => table)(child() as never)
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('/T')
    expect(calls[0][0]).toBe('/F')
    const named = calls[0].filter((_a, i) => calls[0][i - 1] === '/PID').map(Number)
    expect(new Set(named)).toEqual(new Set([10, 11, 12, 15]))
  })

  it('an unreadable process table kills the root alone, never the whole tree', async () => {
    const { calls, spawn } = taskkills()
    await makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { throw new Error('no powershell') })(child() as never)
    expect(calls).toEqual([['/F', '/PID', '10']])
  })

  it('a taskkill that fails makes sure of the root; a root that exited while the table was read is not killed by pid', async () => {
    const failing = taskkills(128)
    const c = child()
    await makeCodexKillTree('win32', failing.spawn, 'C:\\Windows', async () => table)(c as never)
    expect(c.kill).toHaveBeenCalled()
    const late = taskkills()
    const d = child()
    await makeCodexKillTree('win32', late.spawn, 'C:\\Windows', async () => { d.exitCode = 0; return table })(d as never)
    // Its chain exited before it (cmd.exe waits for node, node for codex): those pids may be strangers' now.
    expect(late.calls).toEqual([])
  })

  it('launchers a global install may use (bun, deno) are part of the chain; a child with no start time under a parent with one is not', () => {
    expect(new Set(codexChainPids(30, [
      { pid: 30, ppid: 1, name: 'cmd.exe', created: 10 },
      { pid: 31, ppid: 30, name: 'bun.exe', created: 11 },
      { pid: 32, ppid: 31, name: 'codex.exe', created: 12 },
      { pid: 33, ppid: 32, name: 'chrome.exe', created: 13 },
      { pid: 34, ppid: 30, name: 'node.exe' },
    ]))).toEqual(new Set([30, 31, 32]))
    expect(new Set(codexChainPids(40, [{ pid: 40, ppid: 1, name: 'deno' }, { pid: 41, ppid: 40, name: 'codex' }]))).toEqual(new Set([40, 41]))
  })

  it('the settle bound outlasts reading the table plus taskkill', () => {
    expect(CODEX_KILL_SETTLE_MS).toBeGreaterThan(CODEX_PROCESS_TABLE_TIMEOUT_MS + CODEX_TASKKILL_TIMEOUT_MS)
  })

  it('reads the table: PowerShell -Command (never an encoded command) from System32 on Windows, /proc on Linux, ps -ww with no inherited width elsewhere', async () => {
    const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
    const execFile = (file: string, args: string[], opts: Record<string, unknown>, cb: (e: Error | null, out: string) => void) => { calls.push({ file, args, opts }); cb(null, '10,1,0,cmd.exe\n') }
    expect(await makeCodexProcessLister('win32', 'C:\\Windows', { execFile })!()).toEqual([{ pid: 10, ppid: 1, name: 'cmd.exe' }])
    expect(calls[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(calls[0].args).toEqual(['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY])
    expect(WINDOWS_PROCESS_QUERY).not.toContain('"')
    expect(calls[0].opts).toMatchObject({ cwd: 'C:\\Windows', timeout: CODEX_PROCESS_TABLE_TIMEOUT_MS })
    expect(makeCodexProcessLister('win32', 'Windows', { execFile })).toBeNull()
    const mac = makeCodexProcessLister('darwin', undefined, { execFile: (f, a, o, cb) => { calls.push({ file: f, args: a, opts: o }); cb(null, ' 5 1 /usr/bin/x\n') }, exists: (f) => f === '/bin/ps' })!
    expect(await mac()).toEqual([{ pid: 5, ppid: 1, name: '/usr/bin/x' }])
    expect(calls[1].file).toBe('/bin/ps')
    expect(calls[1].args[0]).toBe('-ww')
    expect(Object.keys(calls[1].opts.env as object).sort()).toEqual(['LC_ALL', 'PATH'])
    expect(makeCodexProcessLister('darwin', undefined, { execFile, exists: () => false })).toBeNull()
    const linux = makeCodexProcessLister('linux', undefined, { readProc: () => [{ pid: 7, ppid: 1, name: 'node' }] })!
    expect(await linux()).toEqual([{ pid: 7, ppid: 1, name: 'node' }])
  })

  it('parses /proc stat lines, a name with spaces and parentheses included', () => {
    const tail = 'S 100 7 7 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 424242 1 2 3'
    expect(parseLinuxStat(`123 (codex) ${tail}`)).toEqual({ pid: 123, ppid: 100, name: 'codex', created: 424242 })
    expect(parseLinuxStat(`124 (a) (b c) ${tail}`)).toMatchObject({ pid: 124, ppid: 100, name: 'a) (b c' })
    expect(parseLinuxStat('garbage')).toBeNull()
    expect(parseLinuxStat('x (y) S z')).toBeNull()
  })

  it('POSIX: each chain pid is killed on its own -- not the process group, which may hold a browser', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await makeCodexKillTree('linux', (() => { throw new Error('no spawn') }) as never, undefined, async () => [
        { pid: 20, ppid: 1, name: 'node' }, { pid: 21, ppid: 20, name: 'codex' }, { pid: 22, ppid: 21, name: 'firefox' },
      ])(child(20) as never)
      const targets = killSpy.mock.calls.map((a) => a[0])
      expect(new Set(targets)).toEqual(new Set([20, 21]))
      expect(targets.every((t) => Number(t) > 0)).toBe(true)
    } finally { killSpy.mockRestore() }
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

  it('finds cmd.exe however the environment copy spells ComSpec and SystemRoot (Windows names are case-insensitive)', async () => {
    // A plain-object copy of process.env keeps the parent's spelling; a CI
    // runner hands over SYSTEMROOT, and discovery read `env.SystemRoot`.
    const upper = discoveryDeps({ env: { PATH: 'C:\\npm', SYSTEMROOT: 'C:\\Windows' } })
    expect(await discoverCodex(upper.deps)).toMatchObject({ state: 'found' })
    expect(upper.runs[0].cmd).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe' })
    const spec = discoveryDeps({ env: { PATH: 'C:\\npm', COMSPEC: 'D:\\Win\\System32\\cmd.exe', systemroot: 'C:\\Windows' } })
    await discoverCodex(spec.deps)
    expect(spec.runs[0].cmd).toMatchObject({ file: 'D:\\Win\\System32\\cmd.exe' })
  })

  it('reads ComSpec and SystemRoot case-insensitively on Windows only, ASCII names only, and refuses two spellings that disagree', () => {
    expect(codexShellEnv({ SYSTEMROOT: 'C:\\Windows', comspec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32')).toEqual({ SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    expect(codexShellEnv({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows' }, 'win32')).toEqual({ SystemRoot: 'C:\\Windows' })
    expect(codexShellEnv({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Elsewhere' }, 'win32')).toEqual({})
    expect(codexShellEnv({ SystemRoot: '' }, 'win32')).toEqual({})
    // A long s upper-cases onto an ASCII S: not a name Windows would match.
    expect(codexShellEnv({ [`${String.fromCharCode(0x17f)}ystemRoot`]: 'D:\\Elsewhere' }, 'win32')).toEqual({})
    expect(codexShellEnv({ SYSTEMROOT: 'C:\\Windows', SystemRoot: undefined }, 'linux')).toEqual({})
    expect(codexShellEnv({ SystemRoot: '/x' }, 'linux')).toEqual({ SystemRoot: '/x' })
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
