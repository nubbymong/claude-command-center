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
import { codexLeftoverPids, codexChainAlone, codexRecordRunMembers, CODEX_EXEC_EXIT_SETTLE_MS, CODEX_OBSERVE_AT_MS, CODEX_OBSERVE_MAX_READS, CODEX_OBSERVE_MAX_IN_FLIGHT, CODEX_OBSERVE_QUIET_READS } from '../../src/main/providers/codex'
import type { CodexRunMember } from '../../src/main/providers/codex'
import { codexCommandLine, cliCommandLine, codexShellEnv, runCodexCli, discoverCodex, verifyCodexExecutable, codexCompatibilityAllowsUse, makeCodexKillTree, extractMarkedPath, CODEX_TREE_PRIME_MS, CODEX_PRIME_TABLE_TIMEOUT_MS, codexWrapperLinePids } from '../../src/main/providers/codex'
import { codexChainPids, parseWindowsProcessTable, parsePosixProcessTable, parseLinuxStat, makeCodexProcessLister, CODEX_KILL_SETTLE_MS, CODEX_PROCESS_TABLE_TIMEOUT_MS, CODEX_TASKKILL_TIMEOUT_MS, CODEX_KILL_WORST_MS, flushPendingCodexKills, WINDOWS_PROCESS_QUERY } from '../../src/main/providers/codex'
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

  it('P3.9 round 3: the ps rows carry their start time (lstart, C locale) when ps prints it', () => {
    const rows = parsePosixProcessTable('   20     1 Tue Sep 29 17:33:53 2026 node\n   21    20 Mon Sep  1 07:03:05 2026 /Applications/My App.app/Contents/MacOS/codex\n   22    20 Xyz Abc 99 99:99:99 2026 odd\n')
    expect(rows.map((r) => [r.pid, r.ppid, r.name])).toEqual([[20, 1, 'node'], [21, 20, '/Applications/My App.app/Contents/MacOS/codex'], [22, 20, 'odd']])
    expect(rows[0].created).toBe(Date.parse('Tue Sep 29 17:33:53 2026'))
    expect(rows[1].created).toBe(Date.parse('Mon Sep  1 07:03:05 2026'))
    expect(rows[2].created).toBeUndefined()
    const calls: Array<readonly string[]> = []
    const list = makeCodexProcessLister('darwin', undefined, { exists: (f) => f === '/bin/ps', execFile: (_f, args, _o, cb) => { calls.push(args); cb(null, '') } })
    void list!()
    expect(calls[0]).toEqual(['-ww', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='])
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

  it('an EARLIER read stands in for a failed kill-time read -- once older than CODEX_PROCESS_TABLE_TIMEOUT_MS, with its wrapper line only, never a helper the codex binary may have reaped', async () => {
    vi.useFakeTimers()
    try {
      for (const [age, expected] of [[CODEX_PROCESS_TABLE_TIMEOUT_MS + 1000, [10, 11, 12]], [CODEX_PROCESS_TABLE_TIMEOUT_MS - 1000, [10, 11, 12, 15]]] as const) {
        const { calls, spawn } = taskkills()
        let reads = 0
        const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { reads++; throw new Error('timed out') }, async () => { reads++; return table })
        const c = child()
        kill.prime!(c as never)
        await vi.advanceTimersByTimeAsync(age)
        await kill(c as never)
        expect(reads, String(age)).toBe(2)
        expect(named(calls[0]), String(age)).toEqual(new Set(expected))
      }
    } finally { vi.useRealTimers() }
  })

  // How long 60ea77be let a kill wait for an early read (then the root alone).
  const KILL_READ_BUDGET = CODEX_KILL_SETTLE_MS - CODEX_TASKKILL_TIMEOUT_MS
  const fails = (why = 'timed out') => async (): Promise<CodexProcessEntry[]> => { throw new Error(why) }
  const pending = () => { let answer!: (t: CodexProcessEntry[]) => void; let fail!: (e: Error) => void; const read = () => new Promise<CodexProcessEntry[]>((r, j) => { answer = r; fail = j }); return { read, answer: (t: CodexProcessEntry[]) => answer(t), fail: (e: Error) => fail(e) } }

  // Windows CI (14ad7475): an early read outlasted the kill's 10 s wait, the
  // root alone was killed, and the codex process below it kept running. Once
  // the root is gone nothing vouches for the pids below it, so the kill leaves
  // the root running and keeps waiting (the run settles at its bound anyway).
  it('an early read still running past the old 10 s wait is waited for up to its own timeout, the root left running; the wait is bounded', async () => {
    vi.useFakeTimers()
    try {
      const { calls, spawn } = taskkills()
      const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', fails(), () => new Promise<CodexProcessEntry[]>(() => {}))
      const c = child()
      kill.prime!(c as never)
      let finished = false
      const done = Promise.resolve(kill(c as never)).then(() => { finished = true })
      await vi.advanceTimersByTimeAsync(KILL_READ_BUDGET + 10)
      expect(finished).toBe(false)
      expect(calls).toEqual([])
      expect(c.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(CODEX_PRIME_TABLE_TIMEOUT_MS - KILL_READ_BUDGET - 20)
      expect(finished).toBe(false)
      expect(calls).toEqual([])
      // Bounded: it never waits past the early read's own timeout (the retry here fails at once).
      await vi.advanceTimersByTimeAsync(20)
      await done
      expect(calls).toEqual([['/F', '/PID', '10']])
    } finally { vi.useRealTimers() }
  })

  // Round 2 (ADR-009 F1): the snapshot in a table can be as old as its read.
  // A kill-time read is used whole because its timeout caps that age at
  // CODEX_PROCESS_TABLE_TIMEOUT_MS; an older table may name a helper the codex
  // binary has reaped, whose pid a stranger may hold now.
  it('an early read that answers more than CODEX_PROCESS_TABLE_TIMEOUT_MS after it STARTED names the wrapper line only; a timely one names the whole chain; nothing is killed before it answers', async () => {
    vi.useFakeTimers()
    try {
      const late = taskkills()
      const r1 = pending()
      const k1 = makeCodexKillTree('win32', late.spawn, 'C:\\Windows', fails('kill-time read must not run'), r1.read)
      const c = child()
      k1.prime!(c as never)
      const done1 = Promise.resolve(k1(c as never))
      await vi.advanceTimersByTimeAsync(CODEX_PROCESS_TABLE_TIMEOUT_MS + 1000)
      expect(late.calls).toEqual([])
      expect(c.kill).not.toHaveBeenCalled()
      r1.answer(table)
      await vi.advanceTimersByTimeAsync(10)
      await done1
      expect(late.calls).toHaveLength(1)
      expect(named(late.calls[0])).toEqual(new Set([10, 11, 12]))
      // Timely: the whole chain, the codex helper included.
      const timely = taskkills()
      const r2 = pending()
      const k2 = makeCodexKillTree('win32', timely.spawn, 'C:\\Windows', fails('kill-time read must not run'), r2.read)
      const d = child()
      k2.prime!(d as never)
      const done2 = Promise.resolve(k2(d as never))
      await vi.advanceTimersByTimeAsync(CODEX_PROCESS_TABLE_TIMEOUT_MS - 1000)
      r2.answer(table)
      await vi.advanceTimersByTimeAsync(10)
      await done2
      expect(named(timely.calls[0])).toEqual(new Set([10, 11, 12, 15]))
      // The age counts from the read's start, not the kill's: a read started
      // before the kill can be old by the time it answers, however soon after.
      const early = taskkills()
      const r3 = pending()
      const k3 = makeCodexKillTree('win32', early.spawn, 'C:\\Windows', fails('kill-time read must not run'), r3.read)
      const e = child()
      k3.prime!(e as never)
      await vi.advanceTimersByTimeAsync(CODEX_PROCESS_TABLE_TIMEOUT_MS - 1000)
      const done3 = Promise.resolve(k3(e as never))
      await vi.advanceTimersByTimeAsync(2000)
      r3.answer(table)
      await vi.advanceTimersByTimeAsync(10)
      await done3
      expect(named(early.calls[0])).toEqual(new Set([10, 11, 12]))
    } finally { vi.useRealTimers() }
  })

  it('a root that exits while the kill waits for the early read is not killed by pid', async () => {
    vi.useFakeTimers()
    try {
      const late = taskkills()
      const r = pending()
      const k2 = makeCodexKillTree('win32', late.spawn, 'C:\\Windows', fails('kill-time read must not run'), r.read)
      const d = child()
      k2.prime!(d as never)
      const done2 = Promise.resolve(k2(d as never))
      await vi.advanceTimersByTimeAsync(KILL_READ_BUDGET + 1000)
      // Its chain went first (cmd.exe waits for node, node for codex): those pids may be strangers' by now.
      d.exitCode = 0
      r.answer(table)
      await vi.advanceTimersByTimeAsync(10)
      await done2
      expect(late.calls).toEqual([])
      expect(d.kill).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  // Round 2 (ADR-009 P1): an awaited early read that failed after the old
  // wait left the root alone with no second read.
  // Round 3 (B4): every read is judged by its own age. The retry is a fresh
  // kill-time read, bounded by CODEX_PROCESS_TABLE_TIMEOUT_MS, so it is used whole.
  it('an early read that FAILS while the kill waits for it, early or late, gets one retry with the kill\'s own reader, a fresh read that names the whole chain', async () => {
    vi.useFakeTimers()
    try {
      for (const failAt of [1500, KILL_READ_BUDGET + 5000]) {
        const { calls, spawn } = taskkills()
        const r = pending()
        let own = 0
        const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { own++; return table }, r.read)
        const c = child()
        kill.prime!(c as never)
        const done = Promise.resolve(kill(c as never))
        await vi.advanceTimersByTimeAsync(failAt)
        expect(calls, String(failAt)).toEqual([])
        r.fail(new Error('powershell failed'))
        await vi.advanceTimersByTimeAsync(10)
        await done
        expect(own, String(failAt)).toBe(1)
        expect(named(calls[0]), String(failAt)).toEqual(new Set([10, 11, 12, 15]))
      }
    } finally { vi.useRealTimers() }
  })

  it('an early read that never answers gets the same one retry once its own timeout has passed', async () => {
    vi.useFakeTimers()
    try {
      const { calls, spawn } = taskkills()
      let own = 0
      const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { own++; return table }, () => new Promise<CodexProcessEntry[]>(() => {}))
      const c = child()
      kill.prime!(c as never)
      const done = Promise.resolve(kill(c as never))
      await vi.advanceTimersByTimeAsync(CODEX_PRIME_TABLE_TIMEOUT_MS - 10)
      expect(own).toBe(0)
      await vi.advanceTimersByTimeAsync(20)
      await done
      expect(own).toBe(1)
      expect(named(calls[0])).toEqual(new Set([10, 11, 12, 15]))
    } finally { vi.useRealTimers() }
  })

  it('the retry after a failed early read is bounded by the kill-time budget; one that fails, throws as it starts or answers with a non-list leaves the root alone', async () => {
    vi.useFakeTimers()
    try {
      const retries: Array<[string, () => Promise<CodexProcessEntry[]>]> = [
        ['never answers', () => new Promise<CodexProcessEntry[]>(() => {})],
        ['throws as it starts', (() => { throw new Error('no powershell') }) as never],
        ['a non-list', async () => new Set(table) as never],
        ['rejects', fails()],
      ]
      for (const [why, retry] of retries) {
        const { calls, spawn } = taskkills()
        const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', retry, fails('the early read failed'))
        const c = child()
        kill.prime!(c as never)
        let finished = false
        const done = Promise.resolve(kill(c as never)).then(() => { finished = true })
        await vi.advanceTimersByTimeAsync(CODEX_PROCESS_TABLE_TIMEOUT_MS - 10)
        if (why === 'never answers') { expect(finished, why).toBe(false); expect(calls, why).toEqual([]) }
        await vi.advanceTimersByTimeAsync(20)
        await done
        expect(calls, why).toEqual([['/F', '/PID', '10']])
      }
    } finally { vi.useRealTimers() }
  })

  // Round 2 (ADR-009 P3): every reader answer is checked before use; a throw
  // or a non-list never rejects the kill with nothing killed.
  it('the kill\'s own read answering with a non-list, or throwing as it starts, still kills at least the root and never rejects', async () => {
    const odd = taskkills()
    await expect(Promise.resolve(makeCodexKillTree('win32', odd.spawn, 'C:\\Windows', async () => new Set(table) as never, fails())(child() as never))).resolves.toBeUndefined()
    expect(odd.calls).toEqual([['/F', '/PID', '10']])
    const none = taskkills()
    await expect(Promise.resolve(makeCodexKillTree('win32', none.spawn, 'C:\\Windows', async () => null as never)(child() as never))).resolves.toBeUndefined()
    expect(none.calls).toEqual([['/F', '/PID', '10']])
    const thrown = taskkills()
    await expect(Promise.resolve(makeCodexKillTree('win32', thrown.spawn, 'C:\\Windows', (() => { throw new Error('no powershell') }) as never)(child() as never))).resolves.toBeUndefined()
    expect(thrown.calls).toEqual([['/F', '/PID', '10']])
    // A read that throws as it starts is a failed read like any other: the
    // retry still runs, and answering at once it is fresh, so it is used whole.
    const retried = taskkills()
    await makeCodexKillTree('win32', retried.spawn, 'C:\\Windows', (() => { throw new Error('no powershell') }) as never, async () => table)(child() as never)
    expect(named(retried.calls[0])).toEqual(new Set([10, 11, 12, 15]))
  })

  it('a kill with no early read (stopped inside CODEX_TREE_PRIME_MS) whose own read fails reads once more with the early read\'s reader, the root left running: the whole chain if it answers within CODEX_PROCESS_TABLE_TIMEOUT_MS of its start, else the wrapper line', async () => {
    vi.useFakeTimers()
    try {
      for (const [answerAt, expected] of [[KILL_READ_BUDGET + 1000, [10, 11, 12]], [CODEX_PROCESS_TABLE_TIMEOUT_MS - 1000, [10, 11, 12, 15]]] as const) {
        const { calls, spawn } = taskkills()
        let own = 0
        let longReads = 0
        const r = pending()
        const kill = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => { own++; throw new Error('timed out') }, () => { longReads++; return r.read() })
        const c = child()
        const done = Promise.resolve(kill(c as never))
        await vi.advanceTimersByTimeAsync(answerAt)
        expect([own, longReads], String(answerAt)).toEqual([1, 1])
        expect(calls, String(answerAt)).toEqual([])
        expect(c.kill).not.toHaveBeenCalled()
        r.answer(table)
        await vi.advanceTimersByTimeAsync(10)
        await done
        expect(named(calls[0]), String(answerAt)).toEqual(new Set(expected))
      }
    } finally { vi.useRealTimers() }
  })

  it('with no early read: unreadable both ways, the retry even throwing as it starts, leaves the root alone', async () => {
    const failed = taskkills()
    await makeCodexKillTree('win32', failed.spawn, 'C:\\Windows', fails(), () => { throw new Error('no powershell') })(child() as never)
    expect(failed.calls).toEqual([['/F', '/PID', '10']])
  })

  it('with no early read: a retry answering with something other than a list (even an iterable of rows) counts as failed', async () => {
    const odd = taskkills()
    await makeCodexKillTree('win32', odd.spawn, 'C:\\Windows', fails(), async () => new Set(table) as never)(child() as never)
    expect(odd.calls).toEqual([['/F', '/PID', '10']])
  })

  it('an early read that already FAILED used the longer budget: no second long read after the kill\'s own read fails', async () => {
    const spent = taskkills()
    let primeReads = 0
    const k4 = makeCodexKillTree('win32', spent.spawn, 'C:\\Windows', fails(), async () => { primeReads++; throw new Error('also') })
    const e = child()
    k4.prime!(e as never)
    await new Promise((r) => setTimeout(r, 0))
    await k4(e as never)
    expect(primeReads).toBe(1)
    expect(spent.calls).toEqual([['/F', '/PID', '10']])
  })

  it('with no early read: a retry that never answers is bounded by the early read\'s budget, then the root alone', async () => {
    vi.useFakeTimers()
    try {
      const stuck = taskkills()
      let finished = false
      const done3 = Promise.resolve(makeCodexKillTree('win32', stuck.spawn, 'C:\\Windows', fails(), () => new Promise<CodexProcessEntry[]>(() => {}))(child() as never)).then(() => { finished = true })
      await vi.advanceTimersByTimeAsync(CODEX_PRIME_TABLE_TIMEOUT_MS - 10)
      expect(finished).toBe(false)
      expect(stuck.calls).toEqual([])
      await vi.advanceTimersByTimeAsync(20)
      await done3
      expect(stuck.calls).toEqual([['/F', '/PID', '10']])
    } finally { vi.useRealTimers() }
  })

  it('the kill\'s worst case is its own read, the longer read and taskkill, with a margin', () => {
    const phases = CODEX_PROCESS_TABLE_TIMEOUT_MS + CODEX_PRIME_TABLE_TIMEOUT_MS + CODEX_TASKKILL_TIMEOUT_MS
    expect(CODEX_KILL_WORST_MS).toBeGreaterThanOrEqual(phases + 1000)
    expect(CODEX_KILL_WORST_MS).toBeLessThanOrEqual(phases + 2000)
  })

  // Round 3 (B5): a taskkill ended by its own timeout reports a moment after
  // it; the bound on killSettled leaves room for that.
  it('killSettled waits for a kill that ends just past its phases\' sum (a taskkill ended by its own timeout), within the margin', async () => {
    vi.useFakeTimers()
    try {
      const cmd = { file: 'C:\\x\\codex.exe', args: ['login'], verbatim: false, cwd: 'C:\\x' }
      const { deps } = fakeDeps()
      const phases = CODEX_PROCESS_TABLE_TIMEOUT_MS + CODEX_PRIME_TABLE_TIMEOUT_MS + CODEX_TASKKILL_TIMEOUT_MS
      const late: CodexRunDeps = { ...deps, killTree: () => new Promise<void>((res) => { setTimeout(res, phases + 500) }) }
      const ac = new AbortController()
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 60_000, signal: ac.signal }, late)
      ac.abort()
      await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
      let done = false
      void (await p).killSettled!.then(() => { done = true })
      await vi.advanceTimersByTimeAsync(phases + 500 - CODEX_KILL_SETTLE_MS - 20)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
      expect(done).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('the runner settles at its bound while its kill still waits for a slow early read, and the kill then ends the wrapper line', async () => {
    vi.useFakeTimers()
    try {
      const cmd = { file: 'C:/x/codex.cmd', args: ['login'], verbatim: false, cwd: 'C:/x' }
      const { deps } = fakeDeps()
      // A root that keeps running until killed (the fake taskkill ends nothing).
      const spawnRunning: CodexRunDeps['spawn'] = (f, a, o) => Object.assign(deps.spawn(f, a, o), { exitCode: null, signalCode: null })
      const { calls, spawn } = taskkills()
      const r = pending()
      const killTree = makeCodexKillTree('win32', spawn, 'C:\\Windows', fails('kill-time read must not run'), r.read)
      let settled = false
      const deadline = CODEX_TREE_PRIME_MS + 1000
      const run = runCodexCli(cmd, { env: {}, timeoutMs: deadline }, { ...deps, spawn: spawnRunning, killTree }).then((x) => { settled = true; return x })
      await vi.advanceTimersByTimeAsync(deadline + CODEX_KILL_SETTLE_MS - 10)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
      expect(settled).toBe(true)
      const result = await run
      expect(result).toMatchObject({ timedOut: true, exitCode: null, stopped: 'deadline' })
      // Settled with nothing killed yet: the root still vouches for its chain.
      expect(calls).toEqual([])
      let killDone = false
      void result.killSettled!.then(() => { killDone = true })
      r.answer([
        { pid: 4242, ppid: 1, name: 'cmd.exe', created: 1 },
        { pid: 4243, ppid: 4242, name: 'node.exe', created: 2 },
        { pid: 4244, ppid: 4243, name: 'codex.exe', created: 3 },
        { pid: 4245, ppid: 4244, name: 'chrome.exe', created: 4 },
        { pid: 4246, ppid: 4244, name: 'codex-command-runner.exe', created: 5 },
      ])
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)
      // The table answered long after its read began: the wrapper line only.
      expect(named(calls[0])).toEqual(new Set([4242, 4243, 4244]))
      expect(killDone).toBe(true)
    } finally { vi.useRealTimers() }
  })

  // Round 2 (A3): a caller holding a realm or a lease for the run lets go only
  // once the kill has finished, not when the run settles at its bound.
  it('a run that settles at its bound with its kill still under way carries killSettled, which resolves once the kill finishes, or after CODEX_KILL_WORST_MS; a kill finished in time, or a run not stopped, carries none', async () => {
    vi.useFakeTimers()
    try {
      const cmd = { file: 'C:\\x\\codex.exe', args: ['login'], verbatim: false, cwd: 'C:\\x' }
      const { deps, spawned } = fakeDeps()
      // A kill that finishes when told; the root never exits.
      let finishKill!: () => void
      const slow: CodexRunDeps = { ...deps, killTree: () => new Promise<void>((res) => { finishKill = res }) }
      const ac = new AbortController()
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 60_000, signal: ac.signal }, slow)
      ac.abort()
      await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
      const r = await p
      expect(r).toMatchObject({ spawnError: 'cancelled', stopped: 'cancel' })
      let done = false
      void r.killSettled!.then(() => { done = true })
      await vi.advanceTimersByTimeAsync(1000)
      expect(done).toBe(false)
      finishKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(true)
      // A kill that never finishes: bounded by its own worst case, from the stop.
      const stuck: CodexRunDeps = { ...deps, killTree: () => new Promise<void>(() => {}) }
      const ac2 = new AbortController()
      const q = runCodexCli(cmd, { env: {}, timeoutMs: 60_000, signal: ac2.signal }, stuck)
      ac2.abort()
      await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
      let done2 = false
      void (await q).killSettled!.then(() => { done2 = true })
      await vi.advanceTimersByTimeAsync(CODEX_KILL_WORST_MS - CODEX_KILL_SETTLE_MS - 20)
      expect(done2).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
      expect(done2).toBe(true)
      // A kill that rejects has finished too; with the root still running, the run settles at the bound.
      const rejecting: CodexRunDeps = { ...deps, killTree: () => Promise.reject(new Error('taskkill missing')) }
      const ac3 = new AbortController()
      const t = runCodexCli(cmd, { env: {}, timeoutMs: 60_000, signal: ac3.signal }, rejecting)
      ac3.abort()
      await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
      expect('killSettled' in (await t)).toBe(false)
      // The kill landed in time (the fake root exits): nothing is still under way.
      const fast = runCodexCli(cmd, { env: {}, timeoutMs: 50 }, deps)
      await vi.advanceTimersByTimeAsync(60)
      expect('killSettled' in (await fast)).toBe(false)
      // Not stopped at all.
      const plain = runCodexCli(cmd, { env: {}, timeoutMs: 60_000 }, deps)
      spawned[spawned.length - 1].child.emit('close', 0)
      expect('killSettled' in (await plain)).toBe(false)
    } finally { vi.useRealTimers() }
  })

  // Round 2 (A7): a quit during the wait would otherwise leave node and codex
  // running once the app is gone (the job that ends cmd.exe at exit does not
  // reach below it).
  // Round 3 (B2, B3): the quit-time kill runs synchronously, like
  // killSpawnedBrowser, so the app's exit cannot cut it off; a kill whose read
  // lands after it does not kill again. Every call here passes a fake
  // synchronous runner: the default would run the real taskkill.
  it('at app quit, ONE synchronous taskkill names what each kill still reading knows -- an earlier table\'s wrapper line, else the root alone -- nothing for a root that has exited or a kill that has finished, and nothing again when a read lands later', async () => {
    flushPendingCodexKills(() => {})
    const syncCalls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
    const runSync = (file: string, args: string[], opts: Record<string, unknown>) => { syncCalls.push({ file, args, opts }) }
    // Waiting on an early read: nothing known yet, the root alone.
    const a = taskkills()
    const ra = pending()
    const ka = makeCodexKillTree('win32', a.spawn, 'C:\\Windows', async () => table, ra.read)
    const ca = child(30)
    ka.prime!(ca as never)
    const doneA = Promise.resolve(ka(ca as never))
    // An earlier table, the kill's own read still under way: its wrapper line.
    const b = taskkills()
    const rb = pending()
    const kb = makeCodexKillTree('win32', b.spawn, 'C:\\Windows', rb.read, async () => table)
    const cb = child(10)
    kb.prime!(cb as never)
    await new Promise((r) => setTimeout(r, 0))
    const doneB = Promise.resolve(kb(cb as never))
    // A root that has exited since its kill began: nothing by pid.
    const e = taskkills()
    const ke = makeCodexKillTree('win32', e.spawn, 'C:\\Windows', () => new Promise<CodexProcessEntry[]>(() => {}))
    const ce = child(40)
    void ke(ce as never)
    ce.exitCode = 0
    // A kill that has finished is no longer pending.
    const f = taskkills()
    await makeCodexKillTree('win32', f.spawn, 'C:\\Windows', async () => table)(child(50) as never)
    expect(f.calls).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 0))
    flushPendingCodexKills(runSync)
    expect(syncCalls).toHaveLength(1)
    expect(syncCalls[0].file).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(syncCalls[0].args[0]).toBe('/F')
    expect(syncCalls[0].args).not.toContain('/T')
    expect(named(syncCalls[0].args)).toEqual(new Set([30, 10, 11, 12]))
    expect(syncCalls[0].opts).toMatchObject({ cwd: 'C:\\Windows', windowsHide: true })
    expect(syncCalls[0].opts.timeout as number).toBeGreaterThan(0)
    expect(syncCalls[0].opts.timeout as number).toBeLessThanOrEqual(5000)
    expect([a.calls, b.calls, e.calls, f.calls.length]).toEqual([[], [], [], 1])
    // The reads land after the flush, the roots not yet reported gone: no second kill by pid.
    ra.answer(table)
    rb.answer(table)
    await doneA
    await doneB
    expect([a.calls, b.calls]).toEqual([[], []])
    // Flushed once: a second flush adds nothing.
    flushPendingCodexKills(runSync)
    expect(syncCalls).toHaveLength(1)
  })

  it('a quit-time taskkill that fails or times out makes sure of each root and never throws; a kill with no usable Windows root kills its root directly', () => {
    flushPendingCodexKills(() => {})
    const a = taskkills()
    const ca = child(30)
    void makeCodexKillTree('win32', a.spawn, 'C:\\Windows', () => new Promise<CodexProcessEntry[]>(() => {}))(ca as never)
    const n = taskkills()
    const cn = child(31)
    void makeCodexKillTree('win32', n.spawn, 'Windows', () => new Promise<CodexProcessEntry[]>(() => {}))(cn as never)
    let syncRuns = 0
    expect(() => flushPendingCodexKills(() => { syncRuns++; throw new Error('ETIMEDOUT') })).not.toThrow()
    expect(syncRuns).toBe(1)
    expect(ca.kill).toHaveBeenCalled()
    expect(cn.kill).toHaveBeenCalled()
    expect([a.calls, n.calls]).toEqual([[], []])
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

  it('a version check whose kill is still under way removes its throwaway home only once the kill has finished', async () => {
    let finishKill!: () => void
    const killSettled = new Promise<void>((res) => { finishKill = res })
    const d = discoveryDeps({}, { exitCode: null, stdout: '', timedOut: true, stopped: 'deadline', killSettled })
    expect(await discoverCodex(d.deps)).toMatchObject({ state: 'error', detail: 'the Codex CLI did not answer --version in time' })
    expect(d.homes.map((h) => h.disposed)).toEqual([false])
    finishKill()
    await new Promise((r) => setTimeout(r, 0))
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

  it('a review stopped with its kill still under way (a cancel or its deadline) passes killSettled on, so its lease is held until the kill has finished', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = fakeDeps()
      for (const how of ['cancel', 'deadline'] as const) {
        let finishKill!: () => void
        const slow: CodexRunDeps = { ...deps, killTree: () => new Promise<void>((res) => { finishKill = res }) }
        const ac = new AbortController()
        const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => slow }).run(input({ signal: ac.signal, timeoutMs: 1000 }) as never)
        if (how === 'cancel') ac.abort()
        await vi.advanceTimersByTimeAsync(1000 + CODEX_KILL_SETTLE_MS + 10)
        const r = await p
        expect(r, how).toMatchObject({ ok: false, code: how === 'cancel' ? 'cancelled' : 'timed-out' })
        let done = false
        void (r as { killSettled?: Promise<void> }).killSettled!.then(() => { done = true })
        await vi.advanceTimersByTimeAsync(0)
        expect(done, how).toBe(false)
        finishKill()
        await vi.advanceTimersByTimeAsync(0)
        expect(done, how).toBe(true)
      }
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

// P3.9 round 1: Sentinel's analysis of a Codex update is a text-only run of
// a prompt that carries all its material. Its own constant argv: no user
// config or rules, no tool that runs, browses, connects or views, web search
// off, no project instructions, and the working folder is the project root.
// P3.9 round 2 (G1): the VM saw codex exit 0.2 s after a failed request
// while a helper it had started (a suspended git) held the output pipes, and
// the run waited out its whole deadline, then read as a timeout. An exec run
// now settles soon after its root exits, ends what is provably left of it,
// and a stop takes everything below a still-running root.
describe('an exec run settles after its root exits (P3.9 round 2)', () => {
  const cmd = { file: 'C:\\x\\codex.exe', args: ['exec'], verbatim: false, cwd: 'C:\\x' }

  it('settles soon after the exit even while the pipes stay open, with the exit code, not as a stop; the leftovers are ended first', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned, killed } = fakeDeps()
      const windows: Array<{ since: number; until: number }> = []
      let leftoversFor: unknown = null
      const killTree = Object.assign((c: unknown) => { killed.push(c as never) }, { leftovers: async (c: unknown, w: { since: number; until: number }) => { leftoversFor = c; windows.push(w) } })
      let settled = false
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 600_000, settleAfterExitMs: 2000 }, { ...deps, killTree }).then((r) => { settled = true; return r })
      const c = spawned[0].child
      c.stdout.emit('data', '{"type":"turn.failed"}\n')
      c.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(1999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(10)
      const r = await p
      expect(r).toMatchObject({ exitCode: 1, timedOut: false, stdout: '{"type":"turn.failed"}\n' })
      expect(r.stopped).toBeUndefined()
      expect(leftoversFor).toBe(c)
      expect(windows).toHaveLength(1)
      expect(windows[0].since).toBeLessThanOrEqual(windows[0].until)
      expect(killed).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('a close inside the grace settles at once and ends nothing; without the option a run waits for close, as before', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned } = fakeDeps()
      const leftovers = vi.fn(async () => {})
      const killTree = Object.assign(() => {}, { leftovers })
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 600_000, settleAfterExitMs: 2000 }, { ...deps, killTree })
      spawned[0].child.emit('exit', 0)
      spawned[0].child.emit('close', 0)
      expect(await p).toMatchObject({ exitCode: 0, timedOut: false })
      await vi.advanceTimersByTimeAsync(3000)
      expect(leftovers).not.toHaveBeenCalled()
      const q = runCodexCli(cmd, { env: {}, timeoutMs: 5000 }, { ...deps, killTree })
      let done = false
      void q.then(() => { done = true })
      spawned[1].child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(4000)
      expect(done).toBe(false)
      expect(leftovers).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1100)
      expect(await q).toMatchObject({ exitCode: 0, stopped: 'deadline' })
    } finally { vi.useRealTimers() }
  })

  it('a leftovers kill that never answers does not hold the run past its bound; an unusable grace starts nothing', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned } = fakeDeps()
      const killTree = Object.assign(() => {}, { leftovers: () => new Promise<void>(() => {}) })
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 600_000, settleAfterExitMs: 10 }, { ...deps, killTree })
      spawned[0].child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(10 + CODEX_KILL_SETTLE_MS + 5)
      expect(await p).toMatchObject({ exitCode: 0, timedOut: false })
    } finally { vi.useRealTimers() }
    const { deps, spawned } = fakeDeps()
    for (const bad of [-1, Number.NaN, Infinity, 2 ** 31]) expect(await runCodexCli(cmd, { env: {}, timeoutMs: 1000, settleAfterExitMs: bad }, deps), String(bad)).toMatchObject({ spawnError: 'invalid settle' })
    expect(spawned).toHaveLength(0)
  })

  it('a stop passes the scope asked for to the kill (default: the chain)', async () => {
    const scopes: unknown[] = []
    for (const killScope of ['tree', undefined] as const) {
      const { deps, spawned } = fakeDeps()
      const killTree = (c: EventEmitter, o?: { scope?: string }) => { scopes.push(o?.scope); queueMicrotask(() => c.emit('exit', null, 'SIGKILL')) }
      const ac = new AbortController()
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 60_000, signal: ac.signal, ...(killScope ? { killScope } : {}) }, { ...deps, killTree: killTree as never })
      void spawned
      ac.abort()
      await p
    }
    expect(scopes).toEqual(['tree', 'chain'])
  })

  it('the whole tree below a live root, any image, for a tree stop; the chain alone otherwise', () => {
    const table: CodexProcessEntry[] = [
      { pid: 10, ppid: 1, name: 'cmd.exe', created: 100 }, { pid: 11, ppid: 10, name: 'node.exe', created: 101 },
      { pid: 12, ppid: 11, name: 'codex.exe', created: 102 }, { pid: 13, ppid: 12, name: 'git.exe', created: 103 },
      { pid: 14, ppid: 13, name: 'conhost.exe', created: 104 }, { pid: 15, ppid: 12, name: 'old.exe', created: 50 },
    ]
    expect(codexChainPids(10, table).sort()).toEqual([10, 11, 12])
    expect(codexChainPids(10, table, 'all').sort()).toEqual([10, 11, 12, 13, 14])
  })

  // P3.9 round 3 (K1): a process is ended only when the records the reads
  // taken while the run ran made prove it is the run's. The table of ADR-009
  // pass 3's probe (r3-kill): a stranger has reused the pid of an exited
  // chain member; neither it nor its child may be touched.
  const FT = 11_644_473_600_000
  const at = (unixMs: number) => unixMs + FT
  const T0 = 1_790_000_000_000
  const records = (table: CodexProcessEntry[], started: number, rootPid = 1000, since = T0) => {
    const members = new Map<string, CodexRunMember>()
    codexRecordRunMembers(rootPid, table, { started, since, filetime: true, recordedAt: started + 5_000 }, members)
    return members
  }
  const primedK1: CodexProcessEntry[] = [
    { pid: 1000, ppid: 500, name: 'cmd.exe', created: at(T0) },
    { pid: 1004, ppid: 1000, name: 'node.exe', created: at(T0 + 100) },
    { pid: 1008, ppid: 1004, name: 'codex.exe', created: at(T0 + 200) },
    { pid: 1012, ppid: 1008, name: 'git.exe', created: at(T0 + 1500) },
  ]

  it('K1: a stranger that reused an exited member\'s pid, and its child, are never ended; a recorded helper still running is', () => {
    const members = records(primedK1, T0 + 1_200)
    expect([...members.values()].map((m) => m.pid).sort()).toEqual([1000, 1004, 1008, 1012])
    const now: CodexProcessEntry[] = [
      { pid: 1016, ppid: 1008, name: 'git.exe', created: at(T0 + 1_600) },     // codex's, but no read saw codex alive then
      { pid: 1012, ppid: 7777, name: 'cmd.exe', created: at(T0 + 30_000) },   // another app's shell on git's old pid
      { pid: 2020, ppid: 1012, name: 'node.exe', created: at(T0 + 31_000) },  // that shell's child
      { pid: 7777, ppid: 4, name: 'Code.exe', created: at(T0 - 3_600_000) },
    ]
    expect(codexLeftoverPids(1000, now, members, { since: T0, until: T0 + 60_000 })).toEqual([])
    // The recorded helper, still running with the start time recorded, is the run's.
    const still: CodexProcessEntry[] = [{ pid: 1012, ppid: 1008, name: 'git.exe', created: at(T0 + 1_500) }, { pid: 1013, ppid: 1012, name: 'conhost.exe', created: at(T0 + 1_510) }]
    expect(codexLeftoverPids(1000, still, members, { since: T0, until: T0 + 60_000 })).toEqual([1013, 1012])
  })

  it("K1: a child of a recorded member that has gone is the run's only if it started while a read saw that member running", () => {
    // A busy machine: the read's table holds a process started at T0 + 1700,
    // so every process in it was seen running at T0 + 1700 at least.
    const members = records([...primedK1, { pid: 3000, ppid: 4, name: 'powershell.exe', created: at(T0 + 1_700) }], T0 + 1_200)
    const now: CodexProcessEntry[] = [
      { pid: 1016, ppid: 1008, name: 'git.exe', created: at(T0 + 1_600) },   // started while codex was seen running
      { pid: 1020, ppid: 1008, name: 'git.exe', created: at(T0 + 1_800) },   // after: codex may have gone and its pid moved on
    ]
    expect(codexLeftoverPids(1000, now, members, { since: T0, until: T0 + 60_000 })).toEqual([1016])
    // A recorded member running now with its recorded start time vouches for a child started after it.
    const alive = [...now, { pid: 1008, ppid: 1004, name: 'codex.exe', created: at(T0 + 200) }]
    expect(codexLeftoverPids(1000, alive, members, { since: T0, until: T0 + 60_000 }).sort()).toEqual([1008, 1016, 1020])
    // ...but not one holding its pid with another start time.
    const moved = [...now, { pid: 1008, ppid: 9, name: 'other.exe', created: at(T0 + 50_000) }]
    expect(codexLeftoverPids(1000, moved, members, { since: T0, until: T0 + 60_000 })).toEqual([1016])
    // Never a pid the records hold with another start time, whatever its parent says;
    // never a child that says it started before its recorded parent did.
    const odd: CodexProcessEntry[] = [
      { pid: 1012, ppid: 1008, name: 'git.exe', created: at(T0 + 1_550) },
      { pid: 1040, ppid: 1008, name: 'x.exe', created: at(T0 + 150) },
    ]
    expect(codexLeftoverPids(1000, odd, members, { since: T0, until: T0 + 60_000 })).toEqual([])
  })

  // PR-level ADR-009 round 1 (D1): the walk below a process it names takes no
  // pid the records hold with another start time either, though it started
  // after that process and says it is that process's child.
  it("K1: below a process the walk names, a pid the records hold with another start time is never named; one they do not hold is", () => {
    const members = records(primedK1, T0 + 1_200)
    const now: CodexProcessEntry[] = [
      { pid: 900, ppid: 1000, name: 'git.exe', created: at(T0 + 2_000) },       // the root's own child, inside its lifetime
      { pid: 1012, ppid: 900, name: 'node.exe', created: at(T0 + 30_000) },    // git's old pid, now held by another process
      { pid: 2030, ppid: 1012, name: 'conhost.exe', created: at(T0 + 30_100) },
      { pid: 901, ppid: 900, name: 'conhost.exe', created: at(T0 + 2_010) },   // a pid the records do not hold
    ]
    expect(codexLeftoverPids(1000, now, members, { since: T0, until: T0 + 60_000 })).toEqual([901, 900])
  })

  it("the root's own children: started inside its lifetime only, with no read at all; nothing when its pid is in use again", () => {
    const w = { since: T0, until: T0 + 5_000 }
    const now: CodexProcessEntry[] = [
      { pid: 900, ppid: 1000, name: 'git.exe', created: at(T0 + 200) },
      { pid: 901, ppid: 900, name: 'conhost.exe', created: at(T0 + 210) },
      { pid: 902, ppid: 1000, name: 'git.exe', created: at(T0 - 1) },         // before the root started
      { pid: 903, ppid: 1000, name: 'git.exe', created: at(T0 + 5_001) },     // after it exited
      { pid: 905, ppid: 1000, name: 'git.exe' },                               // no start time
      { pid: 906, ppid: 900, name: 'stale.exe', created: at(T0 + 100) },      // says it started before its parent
    ]
    expect(codexLeftoverPids(1000, now, new Map(), w)).toEqual([901, 900])
    expect(codexLeftoverPids(1000, [...now, { pid: 1000, ppid: 3, name: 'x.exe', created: at(T0 + 6_000) }], new Map(), w)).toEqual([])
    expect(codexLeftoverPids(1000, now, new Map(), { since: 5, until: 1 })).toEqual([])
    expect(codexLeftoverPids(0, now, new Map(), w)).toEqual([])
  })

  it('the records: the root only when its row is its own; below it by start time; a pid another process holds now never', () => {
    // A root row started after the read began is a later holder of its pid.
    expect(records([{ pid: 1000, ppid: 1, name: 'x.exe', created: at(T0 + 5_000) }], T0 + 1_000).size).toBe(0)
    expect(records([{ pid: 1000, ppid: 1, name: 'x.exe', created: at(T0 - 5_000) }], T0 + 1_000).size).toBe(0)
    // A child that says it started before its parent is not provably its child.
    const m = records([{ pid: 1000, ppid: 1, name: 'cmd.exe', created: at(T0) }, { pid: 5, ppid: 1000, name: 'old.exe', created: at(T0 - 10) }], T0 + 1_000)
    expect([...m.values()].map((x) => x.pid)).toEqual([1000])
    // A later read learns the orphan of a member it saw before, but not one under a pid now held by another.
    const members = records(primedK1, T0 + 1_200)
    codexRecordRunMembers(1000, [
      { pid: 1030, ppid: 1008, name: 'git.exe', created: at(T0 + 1_400) },
      { pid: 1004, ppid: 9, name: 'stranger.exe', created: at(T0 + 9_000) },
      { pid: 1031, ppid: 1004, name: 'child.exe', created: at(T0 + 9_100) },
    ], { started: T0 + 10_000, since: T0, filetime: true, recordedAt: T0 + 11_000 }, members)
    const pids = [...members.values()].map((x) => x.pid)
    expect(pids).toContain(1030)
    expect(pids).not.toContain(1031)
    expect([...members.values()].filter((x) => x.pid === 1004)).toHaveLength(1)
    // The time a read saw its members running: its newest start time, but never one dated after the read was recorded.
    const future = records([...primedK1, { pid: 3001, ppid: 4, name: 'skewed.exe', created: at(T0 + 999_999) }], T0 + 1_200)
    expect([...future.values()].every((x) => x.lastSeen === T0 + 1_500)).toBe(true)
  })

  it('PG (POSIX): the group is signalled only while a member the reads saw still runs with its start time', async () => {
    const groups: number[] = []
    const kid = (exitCode: number | null) => Object.assign(new EventEmitter(), { pid: 12, exitCode, signalCode: null, kill: vi.fn() })
    const run = kid(null)
    let table: CodexProcessEntry[] = [{ pid: 12, ppid: 1, name: 'node', created: 100 }, { pid: 13, ppid: 12, name: 'git', created: 101 }]
    const posix = makeCodexKillTree('linux', (() => { throw new Error('no spawn') }) as never, undefined, async () => table, null, (g) => { groups.push(g) })
    posix.observe!(run as never, Date.now())
    await new Promise((r) => setTimeout(r, 0))
    // Still running: the leftovers step does nothing.
    await posix.leftovers!(run as never, { since: 0, until: 1 })
    expect(groups).toEqual([])
    run.exitCode = 1
    table = [{ pid: 13, ppid: 1, name: 'git', created: 101 }]
    await posix.leftovers!(run as never, { since: 0, until: 1 })
    expect(groups).toEqual([12])
    // A process holding the member's pid with another start time: no signal.
    table = [{ pid: 13, ppid: 1, name: 'other', created: 999 }]
    await posix.leftovers!(run as never, { since: 0, until: 1 })
    expect(groups).toEqual([12])
    // Never observed: no signal.
    const other = kid(1)
    await posix.leftovers!(other as never, { since: 0, until: 1 })
    expect(groups).toEqual([12])
  })

  it('Windows: the reads taken while it ran name the leftovers; taskkill gets exactly those pids, no /T', async () => {
    const calls: Array<readonly string[]> = []
    const spawn = ((_f: string, args: readonly string[]) => { calls.push(args); const k = new EventEmitter(); queueMicrotask(() => k.emit('exit', 0)); return k }) as never
    const now = Date.now()
    let table: CodexProcessEntry[] = [
      { pid: 12, ppid: 1, name: 'cmd.exe', created: at(now - 50) }, { pid: 13, ppid: 12, name: 'node.exe', created: at(now - 40) },
      { pid: 14, ppid: 13, name: 'codex.exe', created: at(now - 30) }, { pid: 15, ppid: 14, name: 'git.exe', created: at(now - 20) },
    ]
    const run = Object.assign(new EventEmitter(), { pid: 12, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
    // The read taken while it ran answers only after the run has exited: the
    // leftovers step waits for it rather than judge without it.
    let answer!: () => void
    const late = new Promise<void>((r) => { answer = r })
    let first = true
    const win = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => {
      if (first) { first = false; const seen = table; await late; return seen }
      return table
    }, null)
    win.observe!(run as never, now - 100)
    await new Promise((r) => setTimeout(r, 0))
    run.exitCode = 1
    table = [{ pid: 15, ppid: 14, name: 'git.exe', created: at(now - 20) }, { pid: 77, ppid: 14, name: 'late.exe', created: at(now + 60_000) }]
    const done = win.leftovers!(run as never, { since: now - 100, until: now })
    await new Promise((r) => setTimeout(r, 0))
    answer()
    await done
    expect(calls).toEqual([['/F', '/PID', '15']])
  })

  it('K2: an exec run is observed at its start, at its first output and on a bounded schedule; a run that is not an exec run never', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned } = fakeDeps()
      const seen: number[] = []
      const killTree = Object.assign(() => {}, { observe: () => { seen.push(Date.now()) }, leftovers: async () => {} })
      const cmd = { file: 'C:\\x\\codex.exe', args: ['exec'], verbatim: false, cwd: 'C:\\x' }
      const p = runCodexCli(cmd, { env: {}, timeoutMs: 600_000, settleAfterExitMs: 2000 }, { ...deps, killTree })
      expect(seen).toHaveLength(1)
      spawned[0].child.stdout.emit('data', 'x')
      spawned[0].child.stdout.emit('data', 'y')
      expect(seen).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(CODEX_OBSERVE_AT_MS[CODEX_OBSERVE_AT_MS.length - 1] + 1)
      expect(seen).toHaveLength(2 + CODEX_OBSERVE_AT_MS.length)
      expect(2 + CODEX_OBSERVE_AT_MS.length).toBeLessThanOrEqual(CODEX_OBSERVE_MAX_READS)
      spawned[0].child.emit('exit', 0)
      spawned[0].child.emit('close', 0)
      await p
      const q = runCodexCli(cmd, { env: {}, timeoutMs: 600_000 }, { ...deps, killTree })
      spawned[1].child.stdout.emit('data', 'x')
      await vi.advanceTimersByTimeAsync(40_000)
      expect(seen).toHaveLength(2 + CODEX_OBSERVE_AT_MS.length)
      spawned[1].child.emit('exit', 0)
      spawned[1].child.emit('close', 0)
      await q
    } finally { vi.useRealTimers() }
  })

  it('round 5: a helper codex starts after a chain-alone read at the start is still found by the schedule, and ended', async () => {
    const FT2 = 11_644_473_600_000
    const now = Date.now()
    const calls: Array<readonly string[]> = []
    const spawn = ((_f: string, args: readonly string[]) => { calls.push(args); const k = new EventEmitter(); queueMicrotask(() => k.emit('exit', 0)); return k }) as never
    const chain: CodexProcessEntry[] = [
      { pid: 12, ppid: 1, name: 'cmd.exe', created: now - 50 + FT2 }, { pid: 13, ppid: 12, name: 'node.exe', created: now - 40 + FT2 }, { pid: 14, ppid: 13, name: 'codex.exe', created: now - 30 + FT2 },
    ]
    let table = chain
    const run = Object.assign(new EventEmitter(), { pid: 12, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
    const win = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => table, null, undefined, () => {})
    expect(codexChainAlone(12, chain)).toBe(true)
    win.observe!(run as never, now - 100, 'start')
    await new Promise((r) => setTimeout(r, 0))
    win.observe!(run as never, now - 100, 'output')
    await new Promise((r) => setTimeout(r, 0))
    // Codex starts its helper after both of those reads began (so no rule
    // about when codex was seen covers it); the schedule reads and records it.
    const later = Date.now() + 1_000
    const helper: CodexProcessEntry = { pid: 15, ppid: 14, name: 'git.exe', created: later + FT2 }
    table = [...chain, helper]
    win.observe!(run as never, now - 100, 'schedule')
    await new Promise((r) => setTimeout(r, 0))
    run.exitCode = 1
    table = [helper]
    await win.leftovers!(run as never, { since: now - 100, until: later + 1_000 })
    expect(calls).toEqual([['/F', '/PID', '15']])
  })

  it('round 5: the schedule stops only after two scheduled reads in a row find the chain alone; a read with a helper starts the count again', async () => {
    const chain: CodexProcessEntry[] = [
      { pid: 12, ppid: 1, name: 'cmd.exe', created: 100 }, { pid: 13, ppid: 12, name: 'node.exe', created: 101 }, { pid: 14, ppid: 13, name: 'codex.exe', created: 102 },
    ]
    expect(codexChainAlone(12, chain.slice(0, 2))).toBe(false)                                   // codex not started yet
    expect(codexChainAlone(12, [...chain, { pid: 15, ppid: 14, name: 'git.exe', created: 103 }])).toBe(false)
    expect(codexChainAlone(12, chain.slice(1))).toBe(false)                                       // no root
    expect(CODEX_OBSERVE_QUIET_READS).toBe(2)
    let reads = 0
    let table = chain
    const run = Object.assign(new EventEmitter(), { pid: 12, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
    const win = makeCodexKillTree('win32', (() => { throw new Error('no') }) as never, 'C:\\Windows', async () => { reads++; return table }, null)
    const read = async (why: 'start' | 'output' | 'schedule') => { win.observe!(run as never, Date.now(), why); await new Promise((r) => setTimeout(r, 0)) }
    await read('start')
    await read('output')
    await read('schedule')                          // chain alone: 1
    table = [...chain, { pid: 15, ppid: 14, name: 'git.exe', created: 103 }]
    await read('schedule')                          // a helper: the count starts again
    table = chain
    await read('schedule')                          // 1
    await read('schedule')                          // 2: the schedule stops
    expect(reads).toBe(6)
    await read('schedule')
    expect(reads).toBe(6)
    await read('output')                            // not on the schedule: still read
    expect(reads).toBe(7)
  })

  it('round 4: a leftover kill says what taskkill answered, in one line', async () => {
    const FT2 = 11_644_473_600_000
    const lines: string[] = []
    const spawn = ((_f: string, _args: readonly string[], opts: Record<string, unknown>) => {
      expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe'])
      const stderr = new EventEmitter()
      const k = Object.assign(new EventEmitter(), { stderr })
      queueMicrotask(() => { stderr.emit('data', 'ERROR: The process with PID 15 could not be terminated.\r\nReason: Access is denied.\r\n'); k.emit('exit', 128) })
      return k
    }) as never
    const now = Date.now()
    const run = Object.assign(new EventEmitter(), { pid: 12, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
    let table: CodexProcessEntry[] = [{ pid: 12, ppid: 1, name: 'codex.exe', created: now - 50 + FT2 }, { pid: 15, ppid: 12, name: 'git.exe', created: now - 20 + FT2 }]
    const win = makeCodexKillTree('win32', spawn, 'C:\\Windows', async () => table, null, undefined, (l) => { lines.push(l) })
    win.observe!(run as never, now - 100, 'start')
    await new Promise((r) => setTimeout(r, 0))
    run.exitCode = 1
    table = [{ pid: 15, ppid: 12, name: 'git.exe', created: now - 20 + FT2 }]
    await win.leftovers!(run as never, { since: now - 100, until: now })
    expect(lines).toEqual(['[codex] leftover kill of 15: taskkill exit 128: ERROR: The process with PID 15 could not be terminated. Reason: Access is denied.'])
  })

  it('K2: the reads are bounded per run and at once', async () => {
    let reads = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const run = Object.assign(new EventEmitter(), { pid: 12, exitCode: null as number | null, signalCode: null, kill: vi.fn() })
    const win = makeCodexKillTree('win32', (() => { throw new Error('no') }) as never, 'C:\\Windows', async () => { reads++; await gate; return [] }, null)
    for (let i = 0; i < 20; i++) win.observe!(run as never, Date.now())
    await new Promise((r) => setTimeout(r, 0))
    expect(reads).toBe(CODEX_OBSERVE_MAX_IN_FLIGHT)
    release()
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 20; i++) { win.observe!(run as never, Date.now()); await new Promise((r) => setTimeout(r, 0)) }
    expect(reads).toBe(CODEX_OBSERVE_MAX_READS)
  })

  it('a stopped review or analysis takes the whole tree below codex', async () => {
    const { deps, spawned } = fakeDeps()
    const scopes: unknown[] = []
    const killTree = (c: EventEmitter, o?: { scope?: string }) => { scopes.push(o?.scope); queueMicrotask(() => c.emit('exit', null, 'SIGKILL')) }
    const ac = new AbortController()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => ({ ...deps, killTree: killTree as never }) }).run({
      executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\p', prompt: 'x', timeoutMs: 60_000, env: { SystemRoot: 'C:\\Windows' }, purpose: 'analysis', signal: ac.signal,
    })
    expect(spawned).toHaveLength(1)
    ac.abort()
    expect(await p).toMatchObject({ ok: false, code: 'cancelled' })
    expect(scopes).toEqual(['tree'])
  })

  it("the reviewer, codex failing at once while a helper holds the pipes: the real error, soon, not a timeout", async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned } = fakeDeps()
      const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run({
        executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\p', prompt: 'x', timeoutMs: 180_000, env: { SystemRoot: 'C:\\Windows' }, purpose: 'analysis',
      })
      const c = spawned[0].child
      c.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 400 Bad Request' } }) + '\n')
      c.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(CODEX_EXEC_EXIT_SETTLE_MS + 10)
      const r = await p
      expect(r).toMatchObject({ ok: false, code: 'failed' })
      expect(r.ok ? '' : r.message).toContain('unexpected status 400 Bad Request')
    } finally { vi.useRealTimers() }
  })
})

describe('the text-only analysis run (P3.9 round 1)', () => {
  const ANALYSIS = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'plugins', '--disable', 'browser_use',
    '--disable', 'computer_use', '--disable', 'image_generation', '--disable', 'view_image', '--disable', 'multi_agent', '--disable', 'hooks',
    '--disable', 'code_mode', '--disable', 'code_mode_host',
    '-c', 'web_search=disabled', '-c', 'project_doc_max_bytes=0', '-c', 'project_root_markers=[]', '-',
  ]
  const REVIEW = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-5.5', '-']
  const input = (over: Record<string, unknown> = {}) => ({
    executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\runs\\ccc-sentinel-codex-x', prompt: 'Analyse these notes.', timeoutMs: 1000,
    env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\r1' },
    ...over,
  })

  it('purpose analysis runs the analysis argv; a review, or no purpose, runs the review argv unchanged', () => {
    const { deps, spawned } = fakeDeps()
    const ops = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps })
    void ops.run(input({ purpose: 'analysis' }))
    void ops.run(input({ purpose: 'review' }))
    void ops.run(input())
    expect(spawned.map((s) => s.args)).toEqual([ANALYSIS, REVIEW, REVIEW])
    expect(spawned[0].opts).toMatchObject({ cwd: 'D:\\runs\\ccc-sentinel-codex-x', shell: false })
    expect(spawned[0].child.stdin!.end).toHaveBeenCalledWith('Analyse these notes.')
  })

  it('through a Windows shim the same constant line is written verbatim, the empty list included', () => {
    const { deps, spawned } = fakeDeps()
    void createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input({ purpose: 'analysis', executable: 'C:\\npm\\codex.cmd' }))
    expect(spawned[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spawned[0].args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\npm\\codex.cmd" ' + ANALYSIS.join(' ') + '"'])
    expect(codexCommandLine('/usr/bin/codex', 'analysis', 'linux', {})).toEqual({ file: '/usr/bin/codex', args: ANALYSIS, verbatim: false, cwd: '/usr/bin' })
  })

  it('a square bracket is plain text on every route; the characters a shell or cmd.exe reads are still refused', () => {
    expect(cliCommandLine('C:\\npm\\x.cmd', ['-c', 'k=[]'], 'win32', { SystemRoot: 'C:\\Windows' }, 'X')).not.toHaveProperty('refused')
    for (const bad of ['k=[ ]', 'k=["a"]', 'k=[%x%]', 'k=[!x!]', 'k=[a&b]', 'k=(x)', 'k=[a^b]', 'k=[a|b]', 'k=[<a]']) {
      expect(cliCommandLine('C:\\npm\\x.cmd', ['-c', bad], 'win32', { SystemRoot: 'C:\\Windows' }, 'X'), bad).toHaveProperty('refused')
    }
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

  it('a provider that is off is refused as off and nothing is looked for; one not decided yet is refused as not set up, and nothing is looked for either', async () => {
    const off = await harness({ preference: { codex: 'off' } })
    expect(await off.service.discover('codex')).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(off.discoveries()).toBe(0)
    expect(codexView(off).discoveryState).toBe('unchecked')
    // A user who has not answered whether they use Codex has it not set up
    // (owner decision 2026-09-26): its CLI runs for nothing, a look included.
    const undecided = await harness({ preference: { codex: 'undecided' } })
    expect(await undecided.service.discover('codex')).toMatchObject({ ok: false, code: 'provider-not-set-up', message: 'Codex is not set up yet, so it was not checked. Turn it on first.' })
    expect(undecided.discoveries()).toBe(0)
    expect(codexView(undecided).discoveryState).toBe('unchecked')
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

  it('the check of this computer\'s sign-in shares the run: its discovery is the one in flight', async () => {
    const g = heldDiscovery()
    const h = await harness({ beforeDiscovery: g.beforeDiscovery })
    g.ctl.hold = true
    const check = h.service.discover('codex')
    await settle()
    const probed = h.service.probeExternalDefault({ providerId: 'codex' })
    await settle()
    expect(h.discoveries()).toBe(1)
    g.ctl.release()
    await check
    expect((await probed).ok).toBe(true)
    expect(h.discoveries()).toBe(1)
    expect(h.service.snapshot().providers.find((p) => p.providerId === 'codex')!.discoveryState).toBe('found')
  })
})
