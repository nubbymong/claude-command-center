// A reconnect's continue flag comes before the extra arguments.
//
// An SSH session's bare launch (no tmux wrap) carries `--continue` on a
// reconnect. The user's extra CLI arguments stay the last options on the line,
// after it, on a POSIX host and a Windows host alike, and on the bare retry
// after a refused tmux launch: an option among them that takes a value can
// never take `--continue` as its value. A launch with no reconnect is
// byte-for-byte the line it always was. The real spawnPty SSH branch and the
// real Claude provider; node-pty and Electron faked; nothing is dialled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
const h = vi.hoisted(() => ({ dataCbs: [] as Array<(d: string) => void>, writes: [] as string[] }))
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 5252, process: 'ssh',
    onData: (cb: (d: string) => void) => { h.dataCbs.push(cb); return { dispose: () => {} } },
    onExit: () => ({ dispose: () => {} }),
    write: (d: string) => { h.writes.push(String(d)) }, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))

const { spawnPty, getSshFlow, killPty, _getSshNonceForTest } = await import('../../../src/main/pty-manager')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }
const WORDS = '--append-system-prompt'
const feed = (d: string): void => { for (const cb of h.dataCbs) cb(d) }
let seq = 0
let SID = ''

beforeEach(() => {
  vi.useFakeTimers()
  SID = `sshcont${String(++seq).padStart(17, '0')}`
  h.dataCbs = []; h.writes = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* gone */ }
  vi.useRealTimers()
})

/** Launch Claude and answer the host setup with `tmux`; the claude line written. */
const launchLine = (ssh: Record<string, unknown>, tmux: 'none' | 'path'): string => {
  spawnPty(fakeWin, SID, { ssh, extraArgs: WORDS } as never)
  getSshFlow(SID)!.launchClaude()
  vi.advanceTimersByTime(300)
  feed(`setup ok ${_getSshNonceForTest(SID)} tmux=${tmux} acct=\r\n`)
  vi.advanceTimersByTime(1500)
  vi.advanceTimersByTime(300)
  const line = h.writes.find((w) => w.includes('claude ') && w.includes('--settings')) ?? ''
  return line.replace(/\r$/, '')
}

describe('a bare reconnect', () => {
  // Mutation to prove this can fail: append --continue to the finished line again.
  it('POSIX host: --continue comes before the extra arguments, which stay last', () => {
    const line = launchLine({ ...SSH, detachable: false, reconnect: true }, 'none')
    expect(line).toMatch(new RegExp(`--mcp-config \\S+ --continue ${WORDS}$`))
  })

  // Mutation to prove this can fail: put the continue flag after the extra flags in the Windows builder.
  it('Windows host: --continue comes before the extra arguments, which stay last', () => {
    const line = launchLine({ ...SSH, remoteOs: 'windows', detachable: false, reconnect: true }, 'none')
    expect(line).toMatch(new RegExp(`--mcp-config "[^"]+" --continue ${WORDS}$`))
  })

  it('a first connect has no --continue and the extra arguments last, as before', () => {
    const line = launchLine({ ...SSH, detachable: false }, 'none')
    expect(line).not.toContain('--continue')
    expect(line).toMatch(new RegExp(`--mcp-config \\S+ ${WORDS}$`))
  })
})

describe('the bare retry after a refused tmux launch', () => {
  // Mutation to prove this can fail: append the retry's flag to the finished line again.
  it('carries --continue before the extra arguments on a reconnect', () => {
    launchLine({ ...SSH, reconnect: true }, 'path')
    h.writes = []
    feed('open terminal failed: missing or unsuitable terminal: xterm-256color\r\n')
    const bare = h.writes.filter((w) => w.includes('claude ') && !w.includes('has-session')).map((w) => w.replace(/\r$/, ''))
    expect(bare).toHaveLength(1)
    expect(bare[0]).toMatch(new RegExp(`--mcp-config \\S+ --continue ${WORDS}$`))
  })
})
