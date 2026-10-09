// Ending an SSH session on a Windows host removes the session's files there.
//
// End reaches the host over its own ssh exec. On a POSIX host it kills the
// session's tmux session and removes its files (`tmux kill-session ...; rm -f
// ...`), byte for byte as before. A Windows host has neither tmux nor `rm`,
// and its shell is cmd.exe or PowerShell: End sends the Windows removal
// instead, with no tmux kill and no container step, over the same two exec
// shapes (the key exec, and the password PTY that answers only ssh's prompt).
// The real endSshRemote; child_process and node-pty faked, nothing is dialled.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
const h = vi.hoisted(() => ({
  execs: [] as Array<{ bin: string; args: string[] }>,
  ptys: [] as Array<{ args: string[]; writes: string[]; data: ((d: string) => void) | null; exit: ((e: { exitCode: number }) => void) | null }>,
}))
vi.mock('node-pty', () => ({
  spawn: (_bin: string, args: string[]) => {
    const { EventEmitter } = require('events') as typeof import('events')
    const out = new EventEmitter()
    out.on('error', () => {})
    const rec = { args, writes: [] as string[], data: null as ((d: string) => void) | null, exit: null as ((e: { exitCode: number }) => void) | null }
    h.ptys.push(rec)
    return {
      pid: 999, process: 'ssh',
      onData: (cb: (d: string) => void) => { rec.data = cb; return { dispose: () => {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { rec.exit = cb; return { dispose: () => {} } },
      write: (d: string) => { rec.writes.push(d) }, resize: () => {}, kill: () => {},
      on: (ev: string, l: (...a: unknown[]) => void) => { out.on(ev, l) },
      _agent: { inSocket: new EventEmitter() },
    }
  },
}))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (bin: string, args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string) => void) => {
    h.execs.push({ bin, args })
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

const { endSshRemote, _setSshTargetForTest } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
const { buildWindowsRemoteSessionCleanupCommand, buildRemoteTmuxKillCommand } = await import('../../src/main/providers/claude/ssh-shim')
registerProvider(new ClaudeProvider())

const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const KEY_TARGET = { username: 'me', host: 'winbox.example.com', port: 22 }
/** The remote command of an exec: ssh's last argument, after the destination. */
const last = (args: string[]): string => args[args.length - 1]

beforeEach(() => {
  h.execs = []
  h.ptys = []
})

describe('End on a Windows host', () => {
  // Mutation to prove this can fail: send the POSIX End command whatever the host.
  it('sends the Windows removal: no rm, no tmux kill', async () => {
    _setSshTargetForTest(SID, { ...KEY_TARGET, remoteOs: 'windows' })
    await expect(endSshRemote(SID)).resolves.toBe('completed')
    expect(h.execs).toHaveLength(1)
    const command = last(h.execs[0].args)
    expect(command).toBe(buildWindowsRemoteSessionCleanupCommand(SID))
    expect(command).not.toContain('rm -f')
    expect(command).not.toContain('kill-session')
  })

  // Mutation to prove this can fail: take the container step on a Windows host.
  it('a container runtime on a Windows host takes no container step (no sudo prompt to answer)', async () => {
    _setSshTargetForTest(SID, { ...KEY_TARGET, remoteOs: 'windows', runtime: { type: 'container', container: 'dev', sudo: true } as never, sudoPassword: 'sudo-1' })
    await endSshRemote(SID)
    expect(h.ptys).toEqual([])
    expect(h.execs).toHaveLength(1)
    expect(last(h.execs[0].args)).toBe(buildWindowsRemoteSessionCleanupCommand(SID))
  })

  it('a saved password: the same removal, through the PTY that answers only ssh\'s prompt', async () => {
    _setSshTargetForTest(SID, { ...KEY_TARGET, remoteOs: 'windows', password: 'pw-1' })
    const done = endSshRemote(SID)
    expect(h.ptys).toHaveLength(1)
    expect(last(h.ptys[0].args)).toBe(buildWindowsRemoteSessionCleanupCommand(SID))
    h.ptys[0].data?.('me@winbox.example.com\'s password: ')
    expect(h.ptys[0].writes).toEqual(['pw-1\r'])
    h.ptys[0].exit?.({ exitCode: 0 })
    await expect(done).resolves.toBe('completed')
    expect(h.execs).toEqual([])
  })
})

describe('End on a POSIX host is unchanged', () => {
  for (const remoteOs of [undefined, 'unix', 'auto'] as const) {
    it(`remoteOs ${String(remoteOs)}: the tmux kill and file removal, byte for byte`, async () => {
      _setSshTargetForTest(SID, { ...KEY_TARGET, ...(remoteOs ? { remoteOs } : {}) })
      await endSshRemote(SID)
      expect(last(h.execs[0].args)).toBe(buildRemoteTmuxKillCommand(SID))
    })
  }
})
