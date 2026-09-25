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
import { codexCommandLine, codexShellEnv, runCodexCli, discoverCodex, verifyCodexExecutable, codexCompatibilityAllowsUse, makeCodexKillTree, extractMarkedPath, CODEX_TREE_PRIME_MS, CODEX_PRIME_TABLE_TIMEOUT_MS, codexWrapperLinePids } from '../../src/main/providers/codex'
import { codexChainPids, parseWindowsProcessTable, parsePosixProcessTable, parseLinuxStat, makeCodexProcessLister, CODEX_KILL_SETTLE_MS, CODEX_PROCESS_TABLE_TIMEOUT_MS, CODEX_TASKKILL_TIMEOUT_MS, WINDOWS_PROCESS_QUERY } from '../../src/main/providers/codex'
import type { CodexDiscoveryDeps, CodexRunResult, CodexRunDeps, CodexProcessEntry } from '../../src/main/providers/codex'
import { createCodexReviewOperations, createCodexExecEventReader, parseCodexExecEvents, REVIEW_MAX_TEXT } from '../../src/main/providers/codex'
import { harness, addCodexAccount } from './accounts-harness'

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

  // WP2 (must-fix before the PR leaves draft): on a loaded machine the
  // kill-time table read can time out; the root alone would then be killed
  // and the codex binary under cmd.exe would keep running.
  const named = (call: readonly string[]) => new Set(call.filter((_a, i) => call[i - 1] === '/PID').map(Number))

  it('an early read still running at kill time is awaited, not raced by a second read, and its whole chain is killed', async () => {
    const { calls, spawn } = taskkills()
    let reads = 0
    let release!: (t: CodexProcessEntry[]) => void
    const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { reads++; throw new Error('kill-time read must not run') }, () => { reads++; return new Promise((r) => { release = r }) })
    const c = child()
    kill.prime!(c as never)
    kill.prime!(c as never)
    const done = kill(c as never)
    await Promise.resolve()
    release(table)
    await done
    expect(reads).toBe(1)
    expect(named(calls[0])).toEqual(new Set([10, 11, 12, 15]))
  })

  it('an EARLIER read stands in for a failed kill-time read with its wrapper line only -- never a helper the codex binary may have reaped', async () => {
    const { calls, spawn } = taskkills()
    let reads = 0
    const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { reads++; throw new Error('timed out') }, async () => { reads++; return table })
    const c = child()
    kill.prime!(c as never)
    await new Promise((r) => setTimeout(r, 0))
    await kill(c as never)
    expect(reads).toBe(2)
    expect(named(calls[0])).toEqual(new Set([10, 11, 12]))
  })

  const KILL_READ_BUDGET = CODEX_KILL_SETTLE_MS - CODEX_TASKKILL_TIMEOUT_MS

  it('an early read that never answers is waited for only as long as the kill can read (taskkill still lands inside the settle bound); then the root alone', async () => {
    vi.useFakeTimers()
    try {
      const { calls, spawn } = taskkills()
      const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => table, () => new Promise<CodexProcessEntry[]>(() => {}))
      const c = child()
      kill.prime!(c as never)
      let finished = false
      const done = Promise.resolve(kill(c as never)).then(() => { finished = true })
      await vi.advanceTimersByTimeAsync(KILL_READ_BUDGET - 10)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
      await done
      expect(calls).toEqual([['/F', '/PID', '10']])
    } finally { vi.useRealTimers() }
  })

  it('an early read that FAILS while the kill waits for it hands the time left to the kill\'s own read', async () => {
    vi.useFakeTimers()
    try {
      const { calls, spawn } = taskkills()
      let fail!: (e: Error) => void
      let own = 0
      const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { own++; return table }, () => new Promise<CodexProcessEntry[]>((_r, rej) => { fail = rej }))
      const c = child()
      kill.prime!(c as never)
      const done = Promise.resolve(kill(c as never))
      await vi.advanceTimersByTimeAsync(1500)
      fail(new Error('powershell failed'))
      await vi.advanceTimersByTimeAsync(10)
      await done
      expect(own).toBe(1)
      expect(named(calls[0])).toEqual(new Set([10, 11, 12, 15]))
    } finally { vi.useRealTimers() }
  })

  it('an early table that is not a list (even an iterable of rows) counts as a failed read', async () => {
    const { calls, spawn } = taskkills()
    const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { throw new Error('timed out') }, async () => new Set(table) as never)
    const c = child()
    kill.prime!(c as never)
    await new Promise((r) => setTimeout(r, 0))
    await kill(c as never)
    expect(calls).toEqual([['/F', '/PID', '10']])
  })

  it('the table reader honours its own budget (the early read gets the longer one)', async () => {
    const seen: number[] = []
    const execFile = ((_f: string, _a: string[], o: Record<string, unknown>, cb: (e: Error | null, out: string) => void) => { seen.push(o.timeout as number); cb(null, '') }) as never
    await makeCodexProcessLister('win32', 'C:\\Windows', { execFile })!()
    await makeCodexProcessLister('win32', 'C:\\Windows', { execFile, timeoutMs: CODEX_PRIME_TABLE_TIMEOUT_MS })!()
    expect(seen).toEqual([CODEX_PROCESS_TABLE_TIMEOUT_MS, CODEX_PRIME_TABLE_TIMEOUT_MS])
    expect(CODEX_PRIME_TABLE_TIMEOUT_MS).toBeGreaterThan(KILL_READ_BUDGET)
  })

  it('an early read that failed, or a root that has exited, adds nothing', async () => {
    const failed = taskkills()
    const k1 = makeCodexKillTree('win32', failed.spawn, 'C:\\Windows', async () => { throw new Error('timed out') }, async () => { throw new Error('also') })
    const c = child()
    k1.prime!(c as never)
    await new Promise((r) => setTimeout(r, 0))
    await k1(c as never)
    expect(failed.calls).toEqual([['/F', '/PID', '10']])
    const exitedRun = taskkills()
    const d = child()
    const k2 = makeCodexKillTree('win32', exitedRun.spawn, 'C:\\Windows', async () => { throw new Error('timed out') }, async () => table)
    k2.prime!(d as never)
    await new Promise((r) => setTimeout(r, 0))
    d.exitCode = 0
    await k2(d as never)
    expect(exitedRun.calls).toEqual([])
  })

  it('the wrapper line: the root, then each only chain child, down to the codex binary and no further', () => {
    expect(codexWrapperLinePids(10, table)).toEqual([12, 11, 10])
    // A native codex root wraps nothing.
    expect(codexWrapperLinePids(12, table)).toEqual([12])
    // Two chain children: which one is the line is not known, so it stops.
    expect(codexWrapperLinePids(30, [
      { pid: 30, ppid: 1, name: 'cmd.exe', created: 1 },
      { pid: 31, ppid: 30, name: 'node.exe', created: 2 },
      { pid: 32, ppid: 30, name: 'node.exe', created: 3 },
    ])).toEqual([30])
  })

  it('the runner reads the chain once for a run still going after CODEX_TREE_PRIME_MS -- never for a short, stopped or exited run, and a prime that throws breaks nothing', async () => {
    vi.useFakeTimers()
    try {
      const cmd = { file: 'C:/x/codex.exe', args: ['login'], verbatim: false, cwd: 'C:/x' }
      const { deps, spawned } = fakeDeps()
      const prime = vi.fn()
      const withPrime: CodexRunDeps = { ...deps, killTree: Object.assign((c: Parameters<CodexRunDeps['killTree']>[0]) => deps.killTree(c), { prime }) }
      // Short: closes before the prime is due.
      const short = runCodexCli(cmd, { env: {}, timeoutMs: 60_000 }, withPrime)
      spawned[0].child.emit('close', 0)
      await short
      // Stopped before it is due.
      const ac = new AbortController()
      const stopped = runCodexCli(cmd, { env: {}, timeoutMs: 60_000, signal: ac.signal }, withPrime)
      ac.abort()
      await stopped
      // Exited (its pipes still open) before it is due.
      const exiting = runCodexCli(cmd, { env: {}, timeoutMs: 60_000 }, withPrime)
      spawned[2].child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(CODEX_TREE_PRIME_MS + 10)
      expect(prime).not.toHaveBeenCalled()
      spawned[2].child.emit('close', 0)
      await exiting
      // Long: due once.
      const long = runCodexCli(cmd, { env: {}, timeoutMs: 60_000 }, withPrime)
      await vi.advanceTimersByTimeAsync(CODEX_TREE_PRIME_MS - 10)
      expect(prime).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(20)
      expect(prime).toHaveBeenCalledTimes(1)
      expect(prime.mock.calls[0][0]).toBe(spawned[3].child)
      spawned[3].child.emit('close', 0)
      expect(await long).toMatchObject({ exitCode: 0 })
      // A prime that throws does not break the run.
      const throwing: CodexRunDeps = { ...deps, killTree: Object.assign((c: Parameters<CodexRunDeps['killTree']>[0]) => deps.killTree(c), { prime: () => { throw new Error('boom') } }) }
      const survives = runCodexCli(cmd, { env: {}, timeoutMs: 60_000 }, throwing)
      await vi.advanceTimersByTimeAsync(CODEX_TREE_PRIME_MS + 10)
      spawned[4].child.emit('close', 0)
      expect(await survives).toMatchObject({ exitCode: 0 })
      // Stopping, its kill still under way when the prime falls due: no read.
      const slowKill: CodexRunDeps = { ...deps, killTree: Object.assign(() => new Promise<void>(() => {}), { prime }) }
      const ac2 = new AbortController()
      const stopping = runCodexCli(cmd, { env: {}, timeoutMs: 60_000, signal: ac2.signal }, slowKill)
      await vi.advanceTimersByTimeAsync(500)
      ac2.abort()
      await vi.advanceTimersByTimeAsync(CODEX_TREE_PRIME_MS + 10)
      expect(prime).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS)
      await stopping
    } finally { vi.useRealTimers() }
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

// WP2 commit 5a (plan: provider review through MCP): Codex as a reviewer. One
// isolated `codex exec` per review, from a launch the accounts service
// prepared; the request on stdin, never argv; the reply read from the pinned
// CLI's JSONL (rust-v0.155.1 exec_events.rs).
describe('the Codex reviewer (WP2 5a)', () => {
  const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const turn = (input: number, cached: number, output: number) => ({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 } })
  const reply = (text: string) => ({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } })
  const input = (over: Record<string, unknown> = {}) => ({
    executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\proj', prompt: 'Review this. Focus area: race %OPENAI_API_KEY% & calc', timeoutMs: 1000,
    env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\r1', conductor_mcp_token: 't', Claude_Multi_Session_Id: 's', CCC_SESSION_WORKTREE: 'w', nodefaultcurrentdirectoryinexepath: '0' },
    ...over,
  })

  it('reads the pinned exec stream: the last agent message, usage summed over turns, the failure; anything else ignored', () => {
    const out = parseCodexExecEvents([
      'not json', '{"broken', JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'nope' } }),
      JSON.stringify(reply('draft')), JSON.stringify(turn(100, 10, 5)),
      JSON.stringify(reply('final')), JSON.stringify(turn(20, -3, Number.NaN)),
    ].join('\r\n'))
    expect(out).toEqual({ text: 'final', usage: { inputTokens: 120, cachedInputTokens: 10, outputTokens: 5 } })
    expect(parseCodexExecEvents(jsonl({ type: 'turn.failed', error: { message: 'quota' } }))).toEqual({ text: null, error: 'quota' })
    expect(parseCodexExecEvents(jsonl({ type: 'error', message: 'stream lost' }))).toEqual({ text: null, error: 'stream lost' })
    expect(parseCodexExecEvents('')).toEqual({ text: null })
  })

  it('runs the proven executable read-only and ephemeral, in the project, the request on stdin and never in argv', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    const s = spawned[0]
    expect(s.file).toBe('C:\\Tools\\codex.exe')
    expect(s.args).toEqual(['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-5.5', '-'])
    expect(s.opts).toMatchObject({ cwd: 'D:\\proj', shell: false, windowsVerbatimArguments: false })
    expect(s.child.stdin!.end).toHaveBeenCalledWith(input().prompt)
    expect(s.args.join(' ')).not.toContain('OPENAI_API_KEY')
    s.child.stdout.emit('data', jsonl(reply('1. A finding.'), turn(1200, 200, 80)))
    s.child.emit('close', 0)
    expect(await p).toEqual({ ok: true, text: '1. A finding.', usage: { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80 } })
  })

  it('a reviewer never inherits the requesting session\'s Conductor bearer or id, in any spelling; cmd.exe never looks in the project for a program', async () => {
    const { deps, spawned } = fakeDeps()
    void createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    const env = spawned[0].opts.env as Record<string, string>
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toEqual(expect.arrayContaining(['CONDUCTOR_MCP_TOKEN']))
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('CLAUDE_MULTI_SESSION_ID')
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('CCC_SESSION_WORKTREE')
    expect(Object.entries(env).filter(([k]) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')).toEqual([['NoDefaultCurrentDirectoryInExePath', '1']])
    expect(env).toMatchObject({ CODEX_HOME: 'C:\\res\\codex-realms\\r1', PATH: 'C:\\Windows' })
    // POSIX names are exact: only the exact names are the guard's; no Windows-only variable is added.
    void createCodexReviewOperations({ platform: 'linux', runDeps: () => deps }).run(input({ executable: '/usr/bin/codex', cwd: '/proj', env: { CONDUCTOR_MCP_TOKEN: 't', CLAUDE_MULTI_SESSION_ID: 's', CODEX_HOME: '/h' } }))
    expect(spawned[1].opts.env).toEqual({ CODEX_HOME: '/h' })
  })

  it('a Windows shim runs through cmd.exe with a constant verbatim line, in the project; the request stays on stdin', async () => {
    const { deps, spawned } = fakeDeps()
    void createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input({ executable: 'C:\\npm\\codex.cmd' }))
    const s = spawned[0]
    expect(s.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(s.args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\npm\\codex.cmd" exec --json --ephemeral --skip-git-repo-check --sandbox read-only -m gpt-5.5 -"'])
    expect(s.opts).toMatchObject({ cwd: 'D:\\proj', windowsVerbatimArguments: true })
    expect(s.child.stdin!.end).toHaveBeenCalledWith(input().prompt)
  })

  it('says why a review did not come back: not started, cancelled, timed out, failed (redacted), no reply; a long reply keeps its tail', async () => {
    const ops = (d: CodexRunDeps) => createCodexReviewOperations({ platform: 'win32', runDeps: () => d })
    // A path the runner refuses: nothing starts.
    const f0 = fakeDeps()
    expect(await ops(f0.deps).run(input({ executable: 'codex.exe' }))).toMatchObject({ ok: false, code: 'not-started' })
    expect(f0.spawned).toHaveLength(0)
    // Failed, with its usage, a key in the message redacted.
    const f1 = fakeDeps()
    const p1 = ops(f1.deps).run(input())
    f1.spawned[0].child.stdout.emit('data', jsonl(turn(5, 0, 0), { type: 'turn.failed', error: { message: 'bad key sk-' + 'a'.repeat(40) } }))
    f1.spawned[0].child.emit('close', 1)
    const r1 = await p1
    expect(r1).toMatchObject({ ok: false, code: 'failed', usage: { inputTokens: 5 } })
    expect(r1.ok === false && r1.message).toContain('[REDACTED]')
    expect(r1.ok === false && r1.message).not.toContain('a'.repeat(40))
    // Exit 0 with no reply.
    const f2 = fakeDeps()
    const p2 = ops(f2.deps).run(input())
    f2.spawned[0].child.stdout.emit('data', jsonl(turn(1, 0, 1)))
    f2.spawned[0].child.emit('close', 0)
    expect(await p2).toMatchObject({ ok: false, code: 'no-output', usage: { inputTokens: 1 } })
    // Cancelled.
    const f3 = fakeDeps()
    const ac = new AbortController()
    const p3 = ops(f3.deps).run(input({ signal: ac.signal }))
    ac.abort()
    expect(await p3).toMatchObject({ ok: false, code: 'cancelled' })
    expect(f3.killed).toHaveLength(1)
    // A spawn error.
    const f4 = fakeDeps()
    const p4 = ops(f4.deps).run(input())
    f4.spawned[0].child.emit('error', new Error('ENOENT'))
    expect(await p4).toMatchObject({ ok: false, code: 'not-started' })
    // Truncated to the cap, the tail kept.
    const f5 = fakeDeps()
    const p5 = ops(f5.deps).run(input())
    f5.spawned[0].child.stdout.emit('data', jsonl(reply('x'.repeat(REVIEW_MAX_TEXT) + 'THE END')))
    f5.spawned[0].child.emit('close', 0)
    const r5 = await p5
    expect(r5.ok && r5.text.startsWith('[review truncated')).toBe(true)
    expect(r5.ok && r5.text.endsWith('THE END')).toBe(true)
    expect(r5.ok && r5.text.length).toBeLessThan(REVIEW_MAX_TEXT + 100)
  })

  it('at its deadline the review is killed and says it timed out', async () => {
    vi.useFakeTimers()
    try {
      const { deps, killed } = fakeDeps()
      const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input({ timeoutMs: 50 }))
      await vi.advanceTimersByTimeAsync(60)
      expect(killed).toHaveLength(1)
      expect(await p).toMatchObject({ ok: false, code: 'timed-out' })
    } finally { vi.useRealTimers() }
  })
})

// WP2 5a, ADR-009 round 1: the stream is read as it arrives, failure text is
// redacted whole then bounded, a deadline stop is a timeout, the Conductor
// variables go by prefix, and a network-path project is refused on the shim
// route.
describe('the Codex reviewer: ADR-009 round 1 (WP2 5a)', () => {
  const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const reply = (text: string) => ({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } })
  const input = (over: Record<string, unknown> = {}) => ({
    executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\proj', prompt: 'Review this.', timeoutMs: 1000,
    env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\r1' }, ...over,
  })
  const ops = (d: CodexRunDeps, platform: NodeJS.Platform = 'win32') => createCodexReviewOperations({ platform, runDeps: () => d })

  it('a reply after more output than any cap is still the review; one event larger than the reader keeps is skipped, not fatal', async () => {
    const { deps, spawned } = fakeDeps()
    const p = ops(deps).run(input())
    const out = spawned[0].child.stdout
    out.emit('data', jsonl(reply('Let me look at the files first.')))
    // 20 MiB of ordinary events (beyond the 16 MiB the old capture kept) ...
    const filler = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(1024 * 1024) } }) + '\n'
    for (let i = 0; i < 20; i++) out.emit('data', filler)
    // ... one 9 MiB event, split across chunks ...
    const huge = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'y'.repeat(9 * 1024 * 1024) } })
    out.emit('data', huge.slice(0, 5 * 1024 * 1024))
    out.emit('data', huge.slice(5 * 1024 * 1024) + '\n')
    // ... then the real reply, itself split mid-line.
    const last = jsonl(reply('1. REAL FINDING.'))
    out.emit('data', last.slice(0, 20))
    out.emit('data', last.slice(20))
    spawned[0].child.emit('close', 0)
    expect(await p).toMatchObject({ ok: true, text: '1. REAL FINDING.' })
    // A stream arrives in pipe-sized chunks: an unterminated event past the
    // reader's bound is dropped whole, and reading resumes at the next line.
    const chunked = (emit: (s: string) => void, s: string) => { for (let i = 0; i < s.length; i += 64 * 1024) emit(s.slice(i, i + 64 * 1024)) }
    const reader = createCodexExecEventReader()
    chunked((s) => reader.push(s), huge + '\n' + jsonl(reply('after')))
    expect(reader.end()).toEqual({ text: 'after', dropped: true })
    const f2 = fakeDeps()
    const p2 = ops(f2.deps).run(input())
    chunked((s) => f2.spawned[0].child.stdout.emit('data', s), huge + '\n')
    f2.spawned[0].child.emit('close', 0)
    expect(await p2).toMatchObject({ ok: false, code: 'no-output', message: expect.stringContaining('larger than this app reads') })
  })

  it('stderr is redacted whole before its tail is kept, so a cut never exposes part of a key', async () => {
    const key = 'sk-proj-' + 'Q'.repeat(150)
    const { deps, spawned } = fakeDeps()
    const p = ops(deps).run(input())
    spawned[0].child.stderr.emit('data', `auth failed for key ${key} ` + '.'.repeat(420))
    spawned[0].child.emit('close', 1)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).not.toMatch(/Q{8}/)
  })

  it('failure and no-review messages are redacted (bearer, JWT, JSON secret fields, short keys, refresh tokens, hex keys) and bounded', async () => {
    const leaks = ['Authorization: Bearer abcdefgh12345678', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl', '{"access_token": "opaque-value-1"}', '{"refresh_token":"rt_abcdefghijkl"}', 'sk-shortkey1', '0123456789abcdef0123456789abcdef']
    for (const leak of leaks) {
      const f = fakeDeps()
      const p = ops(f.deps).run(input())
      f.spawned[0].child.stdout.emit('data', jsonl({ type: 'turn.failed', error: { message: `upstream said ${leak}` } }))
      f.spawned[0].child.emit('close', 1)
      const r = await p
      expect(r.ok === false && r.message, leak).toContain('[REDACTED]')
      for (const part of ['abcdefgh12345678', 'c2lnbmF0dXJl', 'opaque-value-1', 'rt_abcdefghijkl', 'sk-shortkey1', '0123456789abcdef0123456789abcdef']) {
        expect(r.ok === false && r.message, leak).not.toContain(part)
      }
    }
    const f = fakeDeps()
    const p = ops(f.deps).run(input())
    f.spawned[0].child.stdout.emit('data', jsonl({ type: 'error', message: 'token=sk-' + 'k'.repeat(40) + ' ' + 'z'.repeat(2_000_000) }))
    f.spawned[0].child.emit('close', 0)
    const r = await p
    expect(r).toMatchObject({ ok: false, code: 'no-output' })
    expect(r.ok === false && r.message.length).toBeLessThan(600)
    expect(r.ok === false && r.message).not.toContain('kkkkkkkk')
  })

  it('a deadline that finds the root already gone (a descendant still holding the pipes) is a timeout, not a review', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned, killed } = fakeDeps()
      const p = ops(deps).run(input({ timeoutMs: 50 }))
      spawned[0].child.stdout.emit('data', jsonl(reply('partial')))
      spawned[0].child.emit('exit', 0, null)
      await vi.advanceTimersByTimeAsync(60)
      expect(await p).toMatchObject({ ok: false, code: 'timed-out' })
      expect(killed).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  it('every Conductor variable goes, by prefix: any spelling on Windows, exact names on POSIX', async () => {
    const { deps, spawned } = fakeDeps()
    void ops(deps).run(input({ env: { PATH: 'p', SystemRoot: 'C:\\Windows', CCC_STATUS_URL: 'http://127.0.0.1:1/s?t=x', ccc_arg_secret: 's', Conductor_Anything: 'c', claude_multi_other: 'm', CODEX_HOME: 'h' } }))
    expect(Object.keys(spawned[0].opts.env as object).sort()).toEqual(['CODEX_HOME', 'NoDefaultCurrentDirectoryInExePath', 'PATH', 'SystemRoot'])
    void ops(deps, 'linux').run(input({ executable: '/usr/bin/codex', cwd: '/proj', env: { CCC_STATUS_URL: 'u', CONDUCTOR_X: 'x', CLAUDE_MULTI_Y: 'y', ccc_lower: 'kept', CODEX_HOME: '/h' } }))
    expect(spawned[1].opts.env).toEqual({ ccc_lower: 'kept', CODEX_HOME: '/h' })
  })

  it('an npm shim cannot run in a network-path project (cmd.exe would start in the Windows folder); a real executable can', async () => {
    for (const cwd of ['\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', '//server/share/proj']) {
      const f = fakeDeps()
      const r = await ops(f.deps).run(input({ executable: 'C:\\npm\\codex.cmd', cwd }))
      expect(r, cwd).toMatchObject({ ok: false, code: 'not-started', message: expect.stringContaining('network path') })
      expect(f.spawned).toHaveLength(0)
    }
    const f = fakeDeps()
    void ops(f.deps).run(input({ cwd: '\\\\server\\share\\proj' }))
    expect(f.spawned[0].opts.cwd).toBe('\\\\server\\share\\proj')
  })
})

describe('the Codex reviewer: ADR-009 round 1, environment and reply (WP2 5a)', () => {
  const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const reply = (text: string) => ({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } })
  const base = { executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\proj', prompt: 'Review this.', timeoutMs: 1000 }

  it('only absolute PATH entries reach the reviewer, under any spelling of PATH on Windows', () => {
    const { deps, spawned } = fakeDeps()
    void createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run({ ...base, env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows;.;node_modules\\.bin;;D:\\tools;"C:\\Program Files\\x";\\\\srv\\share\\bin;\\rooted;bin' } })
    expect((spawned[0].opts.env as Record<string, string>).Path).toBe('C:\\Windows;D:\\tools;"C:\\Program Files\\x";\\\\srv\\share\\bin')
    void createCodexReviewOperations({ platform: 'linux', runDeps: () => deps }).run({ ...base, executable: '/usr/bin/codex', cwd: '/proj', env: { PATH: '/usr/bin::bin:./x:/opt/b:' } })
    expect((spawned[1].opts.env as Record<string, string>).PATH).toBe('/usr/bin:/opt/b')
  })

  it('a credential the review quotes is redacted; ordinary review text (code, hashes, "token:" in code) is not', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl'
    const text = [
      '1. auth.json holds {"access_token": "at-secret-1", "refresh_token": "rt_abcdefghijkl"}',
      `2. header Authorization: Bearer abcdefgh12345678 and id ${jwt}`,
      '3. key sk-proj-' + 'A1'.repeat(20) + ' and ghp_' + 'B'.repeat(36),
      '4. In foo.ts, `token: string` is unchecked; see commit 0123456789abcdef0123456789abcdef01234567.',
    ].join('\n')
    const { deps, spawned } = fakeDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run({ ...base, env: {} })
    spawned[0].child.stdout.emit('data', jsonl(reply(text)))
    spawned[0].child.emit('close', 0)
    const r = await p
    expect(r.ok).toBe(true)
    const out = r.ok ? r.text : ''
    for (const secret of ['at-secret-1', 'rt_abcdefghijkl', 'abcdefgh12345678', 'c2lnbmF0dXJl', 'A1A1A1A1', 'B'.repeat(36)]) expect(out, secret).not.toContain(secret)
    expect(out).toContain('`token: string` is unchecked; see commit 0123456789abcdef0123456789abcdef01234567.')
    expect(out).toContain('1. auth.json holds')
  })
})

// WP2 5a, ADR-009 confirmation: the review's own text is only redacted where
// it holds a token-shaped credential; redaction reads a bounded window and a
// secret the window cuts never shows; stderr's real tail is reported.
describe('the Codex reviewer: ADR-009 confirmation fixes (WP2 5a)', () => {
  const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const reply = (text: string) => ({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } })
  const base = { executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\proj', prompt: 'Review this.', timeoutMs: 1000, env: {} }
  const ops = (d: CodexRunDeps) => createCodexReviewOperations({ platform: 'win32', runDeps: () => d })
  const pem = (c: string, n: number) => `-----BEGIN RSA PRIVATE KEY-----\n${c.repeat(n)}\n-----END RSA PRIVATE KEY-----\n`
  const chunked = (emit: (s: string) => void, s: string) => { for (let i = 0; i < s.length; i += 64 * 1024) emit(s.slice(i, i + 64 * 1024)) }
  const runWith = async (feed: (child: { stdout: EventEmitter; stderr: EventEmitter }) => void, code: number) => {
    const f = fakeDeps()
    const p = ops(f.deps).run(base)
    feed(f.spawned[0].child)
    f.spawned[0].child.emit('close', code)
    return p
  }

  it('ordinary review prose is returned untouched', async () => {
    const prose = 'This is a basic implementation. Use Bearer authentication here. Basic validation is missing. rt_sigprocmask and sk-folding-cube are fine. See `?access_token=" + token` in api.ts.'
    const r = await runWith((c) => c.stdout.emit('data', jsonl(reply(prose))), 0)
    expect(r).toEqual({ ok: true, text: prose })
  })

  it('a long review is redacted on a bounded window, and a key the window cuts never shows', async () => {
    const head = 'p'.repeat(200_000)
    const first = pem('K', 12_000)
    const second = pem('M', 16_000)
    // The window (the kept tail plus the margin) starts 4000 key characters into the first block.
    const windowStart = head.length + 32 + 4_000
    const total = windowStart + REVIEW_MAX_TEXT + 20 * 1024
    const text = head + first + second + 'z'.repeat(total - head.length - first.length - second.length)
    const r = await runWith((c) => chunked((s) => c.stdout.emit('data', s), jsonl(reply(text))), 0)
    expect(r.ok).toBe(true)
    const out = r.ok ? r.text : ''
    expect(out.startsWith('[review truncated')).toBe(true)
    expect(out).not.toMatch(/K{8}/)
    expect(out).not.toMatch(/M{8}/)
    expect(out.endsWith('zzz')).toBe(true)
  })

  it('a long failure message is redacted on a bounded window, and a key the window cuts never shows', async () => {
    // Five whole key blocks (redacted to almost nothing), then one the window's end cuts.
    const message = pem('M', 16_000).repeat(5) + pem('K', 12_000) + 'z'.repeat(1_000)
    const r = await runWith((c) => chunked((s) => c.stdout.emit('data', s), jsonl({ type: 'turn.failed', error: { message } })), 1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).not.toMatch(/K{8}/)
    expect(r.ok === false && r.message).not.toMatch(/M{8}/)
  })

  it("stderr's real tail is reported (not the tail of its first part), and a key its window cuts never shows", async () => {
    const r = await runWith((c) => chunked((s) => c.stderr.emit('data', s), 'warning: slow disk\n'.repeat(20_000) + 'FATAL: the real reason'), 1)
    expect(r.ok === false && r.message).toContain('FATAL: the real reason')
    const cut = 'p'.repeat(300_000) + pem('K', 12_000) + pem('M', 16_000).repeat(5)
    const r2 = await runWith((c) => chunked((s) => c.stderr.emit('data', s), cut), 1)
    expect(r2.ok === false && r2.message).not.toMatch(/K{8}/)
    expect(r2.ok === false && r2.message).not.toMatch(/M{8}/)
  })

  it('a review whose signal was already aborted is cancelled, not "not started"', async () => {
    const f = fakeDeps()
    const ac = new AbortController()
    ac.abort()
    expect(await ops(f.deps).run({ ...base, signal: ac.signal })).toMatchObject({ ok: false, code: 'cancelled' })
  })
})

describe('discovery at start (WP1.17; WP2 commit 6g)', () => {
  const codexView = (h: Awaited<ReturnType<typeof harness>>) => h.service.snapshot().providers.find((p) => p.providerId === 'codex')!
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

  it('a provider switched on is looked for once, in the background: a missing CLI then reads missing', async () => {
    const h = await harness({ preference: { codex: 'on' }, cli: false })
    expect(codexView(h).discoveryState).toBe('unchecked')
    expect(h.service.discoverAtStart()).toBeUndefined() // returns at once: start-up never waits
    await settle()
    expect(codexView(h).discoveryState).toBe('missing')
    expect(h.discoveries()).toBe(1)
    h.service.discoverAtStart()
    await settle()
    expect(h.discoveries()).toBe(1) // never a second time
  })

  it('an installed CLI reads found, with its version', async () => {
    const h = await harness({ preference: { codex: 'on' } })
    h.service.discoverAtStart()
    await settle()
    expect(codexView(h)).toMatchObject({ discoveryState: 'found', version: '0.155.1' })
  })

  it('a provider that is off, or not decided yet, or whose setting cannot be read, is not looked for', async () => {
    for (const pref of ['off', 'undecided', () => { throw new Error('unreadable') }] as const) {
      const h = await harness({ preference: { codex: pref as never } })
      h.service.discoverAtStart()
      await settle()
      expect(h.discoveries(), String(pref)).toBe(0)
      expect(codexView(h).discoveryState).toBe('unchecked')
    }
  })

  it('a discovery that fails lands in the snapshot as an error, and nothing throws', async () => {
    const h = await harness({ preference: { codex: 'on' } })
    const setup = h.codex.setup as { discover: () => Promise<unknown> }
    setup.discover = async () => { throw new Error('boom') }
    expect(() => h.service.discoverAtStart()).not.toThrow()
    await settle()
    expect(codexView(h).discoveryState).toBe('error')
  })
})

describe('Check again runs no CLI for a provider that is off (WP1.17; WP1.60 enable/disable)', () => {
  const codexView = (h: Awaited<ReturnType<typeof harness>>) => h.service.snapshot().providers.find((p) => p.providerId === 'codex')!
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

  it('a provider that is off is refused as off and nothing is looked for; one not decided yet is still looked for', async () => {
    const off = await harness({ preference: { codex: 'off' } })
    expect(await off.service.discover('codex')).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(off.discoveries()).toBe(0)
    expect(codexView(off).discoveryState).toBe('unchecked')
    // A user who never answered keeps working as before (isEnabled).
    const undecided = await harness({ preference: { codex: 'undecided' } })
    expect(await undecided.service.discover('codex')).toMatchObject({ ok: true, installation: { discoveryState: 'found' } })
    expect(undecided.discoveries()).toBe(1)
  })

  it('a saved on/off that cannot be read now refuses as the launch rule does, and nothing is looked for', async () => {
    const h = await harness({ preference: { codex: () => { throw new Error('unreadable') } } })
    // Check again is on Settings, Accounts: the reply says what happened, not where to look.
    expect(await h.service.discover('codex')).toMatchObject({
      ok: false, code: 'provider-state-unknown', message: 'This app could not read its settings file, so it did not check Codex. Try again, or restart the app.',
    })
    expect(h.discoveries()).toBe(0)
  })

  it('at start, an "on" read earlier is no answer once the saved on/off cannot be read', async () => {
    let readable = true
    const h = await harness({ preference: { codex: () => { if (!readable) throw new Error('unreadable'); return 'on' } } })
    expect(h.service.isEnabled('codex')).toBe(true) // the last value read is "on"
    readable = false
    // Its own check, not only discover's gate: discover is never even asked.
    const asked = vi.spyOn(h.service, 'discover')
    h.service.discoverAtStart()
    await settle()
    expect(asked).not.toHaveBeenCalled()
    expect(h.discoveries()).toBe(0)
  })
})

describe('turning a provider on looks for its CLI once the switch is saved (WP1.17; WP1.60 enable/disable)', () => {
  const codexView = (h: Awaited<ReturnType<typeof harness>>) => h.service.snapshot().providers.find((p) => p.providerId === 'codex')!
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

  it('a switch-on that is never saved runs no CLI, however often it is made', async () => {
    const h = await harness({ preference: { codex: () => 'off' } })
    for (let i = 0; i < 5; i++) expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    await settle()
    expect(h.discoveries()).toBe(0)
  })

  it('the saved switch going from off to on looks once, and the Providers row then shows what it found; later saves do not look again', async () => {
    let saved: 'off' | 'on' = 'off'
    const h = await harness({ preference: { codex: () => saved } })
    h.service.settingsChanged() // a save while it is off
    await settle()
    expect(h.discoveries()).toBe(0)
    // The Providers switch: main agrees, then the renderer saves the setting.
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    saved = 'on'
    h.service.settingsChanged()
    await settle()
    expect(h.discoveries()).toBe(1)
    expect(codexView(h)).toMatchObject({ enabled: true, discoveryState: 'found', version: '0.155.1' })
    h.service.settingsChanged()
    h.service.settingsChanged()
    await settle()
    expect(h.discoveries()).toBe(1)
    // Off, then on again, is a new switch-on: looked for once more.
    saved = 'off'
    h.service.settingsChanged()
    saved = 'on'
    h.service.settingsChanged()
    await settle()
    expect(h.discoveries()).toBe(2)
  })

  it('a provider never looked for is looked for when a save finds it on', async () => {
    const h = await harness({ preference: { codex: () => 'on' } })
    h.service.settingsChanged()
    await settle()
    expect(h.discoveries()).toBe(1)
  })

  it('a save whose settings cannot be read now looks for nothing, even after an "on" was read', async () => {
    let saved: 'off' | 'on' | 'unreadable' = 'off'
    const h = await harness({ preference: { codex: () => { if (saved === 'unreadable') throw new Error('unreadable'); return saved } } })
    h.service.settingsChanged() // recorded off
    saved = 'on'
    h.service.snapshot() // read "on" (the last value read), with no save seen
    saved = 'unreadable'
    h.service.settingsChanged()
    await settle()
    expect(h.discoveries()).toBe(0)
  })

  it('a saved "on" that a switch-off made here overrides looks for nothing', async () => {
    let saved: 'off' | 'on' = 'off'
    const h = await harness({ preference: { codex: () => saved } })
    h.service.settingsChanged() // recorded off
    saved = 'on' // the file reads on, but no save told the service
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
    h.service.settingsChanged()
    await settle()
    expect(h.discoveries()).toBe(0)
    expect(h.service.isEnabled('codex')).toBe(false)
  })

  it('a provider already on is not looked for again by a switch-on, and a review being prepared meanwhile still runs', async () => {
    const hold = { on: false, release: () => {} }
    const held = new Promise<void>((r) => { hold.release = r })
    const h = await harness({ preference: { codex: () => 'on' }, beforeDiscovery: async () => { if (hold.on) await held } })
    const a = await addCodexAccount(h)
    const looked = h.discoveries()
    expect(looked).toBeGreaterThan(0)
    // Hold the review between its account checks and its use of the proven CLI.
    let letReviewOn!: () => void
    const reviewGate = new Promise<void>((r) => { letReviewOn = r })
    const launch = h.codex.launch as { prepare: (realm: never) => Promise<unknown> }
    const prepare = launch.prepare
    launch.prepare = async (realm) => { await reviewGate; return prepare(realm) }
    hold.on = true
    const review = h.service.prepareLaunch({ kind: 'review', providerId: 'codex', ownerId: 'r' })
    await settle()
    // "Yes, I use Codex", the assistants page, the Providers switch: on again.
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    h.service.settingsChanged()
    await settle()
    letReviewOn()
    expect(await review).toMatchObject({ ok: true, reviewer: 'provider-default', binding: { providerAccountId: a } })
    expect(h.discoveries()).toBe(looked)
    hold.release()
  })
})

describe('one discovery per provider at a time (WP1.17; WP2 commit 6g)', () => {
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
  /** A discovery that can be held in flight: the package has cleared its
   *  proof by then, as it does at the start of every discovery. */
  function heldDiscovery() {
    const ctl = { hold: false, release: () => {} }
    const gate = new Promise<void>((r) => { ctl.release = r })
    return { ctl, beforeDiscovery: async () => { if (ctl.hold) await gate } }
  }

  it('overlapping discover calls (Check again, the start-up look) start one CLI discovery, and every caller gets its answer', async () => {
    const g = heldDiscovery()
    const h = await harness({ beforeDiscovery: g.beforeDiscovery })
    g.ctl.hold = true
    const a = h.service.discover('codex')
    const b = h.service.discover('codex')
    h.service.discoverAtStart()
    await settle()
    expect(h.discoveries()).toBe(1)
    g.ctl.release()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toMatchObject({ ok: true, installation: { discoveryState: 'found', version: '0.155.1' } })
    expect(rb).toEqual(ra)
    expect(h.discoveries()).toBe(1)
    // Once it has finished, the next one runs afresh.
    await h.service.discover('codex')
    expect(h.discoveries()).toBe(2)
  })

  it('a sign-in and a status check issued while a discovery is in flight wait for it, then run on its proof; none is refused', async () => {
    const g = heldDiscovery()
    const h = await harness({ beforeDiscovery: g.beforeDiscovery })
    const a = await addCodexAccount(h)
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    if (!begun.ok) throw new Error(begun.code)
    const runsBefore = h.args().length
    g.ctl.hold = true
    const again = h.service.discover('codex') // the service record still says found; the package's proof is clear
    await settle()
    const status = h.service.refreshStatus({ accountId: a })
    const signIn = h.service.signIn({ accountId: begun.accountId, method: 'browser' }, 1)
    await settle()
    expect(h.args().length).toBe(runsBefore) // nothing ran on a missing proof
    g.ctl.release()
    expect(await status).toEqual({ ok: true, state: 'signed-in' })
    expect(await signIn).toMatchObject({ ok: true })
    expect((await again).ok).toBe(true)
    expect(h.discoveries()).toBe(2) // addCodexAccount's, then the held one: the waiters started none
  })

  it('the start-up migration shares the run: its discovery is the one in flight, and its answer is recorded', async () => {
    const g = heldDiscovery()
    const h = await harness({ beforeDiscovery: g.beforeDiscovery })
    g.ctl.hold = true
    const check = h.service.discover('codex')
    await settle()
    const migrated = h.service.migrateExternalDefault('codex')
    await settle()
    expect(h.discoveries()).toBe(1)
    g.ctl.release()
    await check
    expect((await migrated).ok).toBe(true)
    expect(h.discoveries()).toBe(1)
    expect(h.service.snapshot().providers.find((p) => p.providerId === 'codex')!.discoveryState).toBe('found')
  })
})
