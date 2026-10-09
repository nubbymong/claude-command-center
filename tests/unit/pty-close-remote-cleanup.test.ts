// Closing an SSH session removes its files on the host over its own
// connection.
//
// A session that is not left running in tmux ends with its connection, and
// the files the app wrote for it on the host when it set Claude up (its
// settings, its tools config, its status-URL file) are removed when it is
// CLOSED: over a separate ssh exec (the End machinery, files only), on a POSIX
// host and a Windows host alike, and also when its connection has already
// ended. Nothing is typed into the session's own terminal. A Restart, or a
// spawn's own kill, removes nothing: the next launch of the same session
// re-creates the same files, and a close before it does removes the ones the
// earlier run wrote, also when that launch never started connecting. A session
// left running in tmux writes and dispatches nothing (Leave running keeps its
// files; End removes them), across a Restart, a new launch over it or a
// dropped connection too, until its next run writes its setup again; a
// session whose End already ran gets no second exec, a Restart after the End
// included, and a session that never set Claude up there (a terminal over SSH)
// has nothing to remove and opens no second connection. The real spawnPty SSH
// branch and killPty; node-pty and child_process faked; nothing is dialled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
const h = vi.hoisted(() => ({
  ptys: [] as Array<{ args: string[]; writes: string[]; kills: number; feed: (d: string) => void; exit: (code: number) => void }>,
  execs: [] as Array<{ bin: string; args: string[] }>,
}))
vi.mock('node-pty', () => ({
  spawn: (_bin: string, args: string[]) => {
    const { EventEmitter } = require('events') as typeof import('events')
    const out = new EventEmitter()
    out.on('error', () => {})
    const dataCbs: Array<(d: string) => void> = []
    const exitCbs: Array<(e: { exitCode: number }) => void> = []
    const rec = {
      args, writes: [] as string[], kills: 0,
      feed: (d: string) => { for (const cb of dataCbs) cb(d) },
      /** The connection ends by itself (a dropped network, a remote exit). */
      exit: (code: number) => { for (const cb of exitCbs) cb({ exitCode: code }) },
    }
    h.ptys.push(rec)
    return {
      pid: 6161, process: 'ssh',
      onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { exitCbs.push(cb); return { dispose: () => {} } },
      write: (d: string) => { rec.writes.push(String(d)) }, resize: () => {}, kill: () => { rec.kills++ },
      on: (ev: string, l: (...a: unknown[]) => void) => { out.on(ev, l) },
      _agent: { inSocket: new EventEmitter() },
    }
  },
}))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (bin: string, args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string) => void) => {
    h.execs.push({ bin, args: [...args] })
    queueMicrotask(() => cb?.(null, ''))
    return { unref: () => {} }
  },
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))

const { spawnPty, killPty, getSshFlow, endSshRemoteDetailed, _getSshNonceForTest, _hasSshTargetForTest } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
const { buildWindowsRemoteSessionCleanupCommand } = await import('../../src/main/providers/claude/ssh-shim')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }
let seq = 0
let SID = ''
const posixRemoval = (sid: string): string => `rm -f ~/.claude/settings-${sid}.json ~/.claude/mcp-${sid}.json ~/.claude/ccc-status-${sid}.url`
/** ssh's last argument: the remote command. */
const last = (args: string[]): string => args[args.length - 1]
/** What was typed into the session's own terminal. */
const typedIntoSession = (): string => h.ptys[0].writes.join('')
/** A session started over SSH whose Claude setup has been written to its host. */
const setUp = (ssh: Record<string, unknown>): void => {
  spawnPty(fakeWin, SID, { ssh } as never)
  getSshFlow(SID)!.launchClaude()
  vi.advanceTimersByTime(300)
  expect(typedIntoSession()).not.toBe('')
}
/** A session whose launch was left running in tmux on its host. */
const setUpLeftRunning = (): void => {
  spawnPty(fakeWin, SID, { ssh: SSH } as never)
  getSshFlow(SID)!.launchClaude()
  vi.advanceTimersByTime(300)
  h.ptys[0].feed(`setup ok ${_getSshNonceForTest(SID)} tmux=path\r\n`)
  vi.advanceTimersByTime(1500)
  vi.advanceTimersByTime(300)
  expect(typedIntoSession()).toContain('has-session')
}

beforeEach(() => {
  vi.useFakeTimers()
  SID = `closecln${String(++seq).padStart(16, '0')}`
  h.ptys = []; h.execs = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* gone */ }
  vi.useRealTimers()
})

describe('closing a session that is not left running', () => {
  // Mutation to prove this can fail: drop the exec at close.
  it('closing a session removes its remote files over a separate connection', () => {
    setUp(SSH)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    expect(h.execs[0].args).toContain('dev@box.example.com')
    expect(last(h.execs[0].args)).toBe(posixRemoval(SID))
    expect(last(h.execs[0].args)).not.toContain('kill-session')
  })

  // Mutation to prove this can fail: type the removal line into the session's terminal again.
  it('closing a session types nothing into the remote terminal, and ends it at once', () => {
    setUp(SSH)
    const before = typedIntoSession()
    killPty(SID, { reason: 'close' })
    expect(typedIntoSession()).not.toContain('rm -f')
    expect(typedIntoSession()).toBe(before)
    expect(h.ptys[0].kills).toBe(1)
  })

  it('a Windows host gets the Windows removal', () => {
    setUp({ ...SSH, remoteOs: 'windows' })
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    expect(last(h.execs[0].args)).toBe(buildWindowsRemoteSessionCleanupCommand(SID))
  })

  it('a saved password: the removal runs through the PTY that answers only ssh\'s prompt', () => {
    setUp({ ...SSH, password: 'pw-1' })
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(h.ptys).toHaveLength(2)
    expect(last(h.ptys[1].args)).toBe(posixRemoval(SID))
    h.ptys[1].feed('dev@box.example.com\'s password: ')
    expect(h.ptys[1].writes).toEqual(['pw-1\r'])
    expect(typedIntoSession()).not.toContain('pw-1')
  })

  // Mutation to prove this can fail: drop the setup mark at a Restart or a spawn's own kill.
  it('a session restarted after its setup was written has those files removed at close, even when its next run never set Claude up', () => {
    setUp(SSH)
    killPty(SID, { reason: 'restart' })
    h.ptys = []
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    expect(last(h.execs[0].args)).toBe(posixRemoval(SID))
    expect(typedIntoSession()).toBe('')
    // The same after a spawn's own kill (a new launch over the running one).
    SID = `closecln${String(++seq).padStart(16, '0')}`
    h.ptys = []; h.execs = []
    setUp(SSH)
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    expect(last(h.execs[0].args)).toBe(posixRemoval(SID))
  })

  // Mutation to prove this can fail: drop the session's host at a Restart or a spawn's own kill.
  it('a session restarted after its setup was written has those files removed at close, even when its next launch never started connecting', () => {
    setUp(SSH)
    killPty(SID, { reason: 'restart' })
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    expect(h.execs[0].args).toContain('dev@box.example.com')
    expect(last(h.execs[0].args)).toBe(posixRemoval(SID))
    expect(h.ptys).toHaveLength(1)
    // The same after a spawn's own kill whose launch went no further, on a Windows host.
    SID = `closecln${String(++seq).padStart(16, '0')}`
    h.ptys = []; h.execs = []
    setUp({ ...SSH, remoteOs: 'windows' })
    killPty(SID)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    expect(last(h.execs[0].args)).toBe(buildWindowsRemoteSessionCleanupCommand(SID))
    // A saved password answers ssh's prompt for that removal, and is typed nowhere else.
    SID = `closecln${String(++seq).padStart(16, '0')}`
    h.ptys = []; h.execs = []
    setUp({ ...SSH, password: 'pw-3' })
    killPty(SID, { reason: 'restart' })
    expect(_hasSshTargetForTest(SID)).toBe(true)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(h.ptys).toHaveLength(2)
    expect(last(h.ptys[1].args)).toBe(posixRemoval(SID))
    h.ptys[1].feed('dev@box.example.com\'s password: ')
    expect(h.ptys[1].writes).toEqual(['pw-3\r'])
    expect(typedIntoSession()).not.toContain('pw-3')
    // The close drops the session's host and its saved password.
    expect(_hasSshTargetForTest(SID)).toBe(false)
  })

  // Mutation to prove this can fail: remove the files at close only while the session's terminal is still there.
  it('closing a session whose connection already ended removes its files', () => {
    setUp(SSH)
    h.ptys[0].exit(255)
    const before = typedIntoSession()
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    expect(last(h.execs[0].args)).toBe(posixRemoval(SID))
    expect(typedIntoSession()).toBe(before)
    // A Windows host the same way, with the Windows removal.
    SID = `closecln${String(++seq).padStart(16, '0')}`
    h.ptys = []; h.execs = []
    setUp({ ...SSH, remoteOs: 'windows' })
    h.ptys[0].exit(0)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    expect(last(h.execs[0].args)).toBe(buildWindowsRemoteSessionCleanupCommand(SID))
  })
})

describe('what removes nothing', () => {
  // Mutation to prove this can fail: run the removal on any kill, not only a close.
  it('a restart leaves the next launch\'s files alone', () => {
    setUp(SSH)
    const before = typedIntoSession()
    killPty(SID, { reason: 'restart' })
    expect(h.execs).toEqual([])
    expect(typedIntoSession()).toBe(before)
  })

  it('a spawn\'s own kill (no reason) removes nothing', () => {
    setUp(SSH)
    const before = typedIntoSession()
    killPty(SID)
    expect(h.execs).toEqual([])
    expect(typedIntoSession()).toBe(before)
  })

  // Mutation to prove this can fail: run the removal at close whether or not the setup was written.
  it('a session that never set Claude up there (a terminal over SSH) opens no second connection at close', () => {
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(h.ptys).toHaveLength(1)
    expect(typedIntoSession()).toBe('')
    // A saved password is not used for it either.
    SID = `closecln${String(++seq).padStart(16, '0')}`
    h.ptys = []
    spawnPty(fakeWin, SID, { ssh: { ...SSH, password: 'pw-2' } } as never)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(h.ptys).toHaveLength(1)
  })

  // Mutation to prove this can fail: mark the setup when the session spawns, before it is written.
  it('a session that never set Claude up in any of its runs opens no second connection at close', () => {
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    killPty(SID, { reason: 'restart' })
    h.ptys = []
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(h.ptys).toHaveLength(1)
  })

  it('a session left running in tmux writes and dispatches nothing at close', () => {
    setUpLeftRunning()
    const before = typedIntoSession()
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(typedIntoSession()).toBe(before)
  })

  // Mutation to prove this can fail: keep the setup mark at a Restart of a session left running in tmux.
  it('a session left running in tmux and then restarted removes nothing at close before its next run sets Claude up', () => {
    setUpLeftRunning()
    killPty(SID, { reason: 'restart' })
    h.ptys = []
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(h.ptys).toHaveLength(1)
  })

  // Mutation to prove this can fail: keep the setup mark at a spawn's own kill of a session left running in tmux.
  it('a session left running in tmux and then launched over removes nothing at close before its next run sets Claude up', () => {
    setUpLeftRunning()
    h.ptys = []
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(h.ptys).toHaveLength(1)
  })

  // Mutation to prove this can fail: once the session's terminal is gone, remove the files whether or not it was left running in tmux.
  it('a session left running in tmux whose connection dropped removes nothing at close', () => {
    setUpLeftRunning()
    h.ptys[0].exit(255)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toEqual([])
    expect(h.ptys).toHaveLength(1)
  })

  // Mutation to prove this can fail: ignore an End already dispatched for the session.
  it('a session whose End already ran gets no second exec at close', () => {
    setUp({ ...SSH, runtime: { type: 'container', container: 'ccc-test' } })
    void endSshRemoteDetailed(SID)
    expect(h.execs).toHaveLength(1)
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
  })

  // Mutation to prove this can fail: keep the session's host and setup mark at a Restart after its End.
  it('a session whose End already ran gets no second exec at close after a Restart either', () => {
    setUp(SSH)
    void endSshRemoteDetailed(SID)
    expect(h.execs).toHaveLength(1)
    killPty(SID, { reason: 'restart' })
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
    // An End after the Restart reaches the host the earlier run set Claude up
    // on, and the close after it opens no second connection.
    SID = `closecln${String(++seq).padStart(16, '0')}`
    h.ptys = []; h.execs = []
    setUp(SSH)
    killPty(SID, { reason: 'restart' })
    void endSshRemoteDetailed(SID)
    expect(h.execs).toHaveLength(1)
    expect(h.execs[0].args).toContain('dev@box.example.com')
    expect(last(h.execs[0].args)).toContain('kill-session')
    killPty(SID, { reason: 'close' })
    expect(h.execs).toHaveLength(1)
  })
})
