// A persistent SSH session is issued the tools credential that outlasts an
// app restart; every other SSH session the per-run form.
//
// The launch's first credential issue (made as the tunnel comes up, before
// any setup is written) fixes the credential's form for the whole launch
// (conductor-mcp-server.ts). It asks for the form that outlasts an app
// restart only for a session that can be left running: persistence on, not a
// container, not a Windows host. Every other session asks for the per-run
// form. The real spawnPty SSH branch; node-pty, Electron and the credential
// issuer faked; nothing is dialled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ issues: [] as Array<[string, string, unknown]> }))

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 5353, process: 'ssh',
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: () => {}, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({ getWatchdogManager: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()),
  getConductorMcpPort: () => 4100,
  issueMcpSessionToken: (sid: string, provider: string, opts?: unknown) => { h.issues.push([sid, provider, opts]); return 'tok' },
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }
let seq = 0
let SID = ''

beforeEach(() => {
  SID = `sshform${String(++seq).padStart(17, '0')}`
  h.issues = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* gone */ }
})

/** What the launch's first credential issue asked for. */
const firstIssue = (): unknown => h.issues.find(([sid]) => sid === SID)?.[2]

describe('the launch\'s first credential issue asks for the form its persistence calls for', () => {
  // Mutation to prove this can fail: drop the third argument at the first issue.
  it('a persistent session on a POSIX host asks for the form that outlasts a restart', () => {
    spawnPty(fakeWin, SID, { ssh: SSH } as never)
    expect(h.issues[0]).toEqual([SID, 'claude', { persistent: true }])
  })

  it('a session with persistence off asks for the per-run form', () => {
    spawnPty(fakeWin, SID, { ssh: { ...SSH, detachable: false } } as never)
    expect(firstIssue()).toEqual({ persistent: false })
  })

  // Mutation to prove this can fail: ask for the restart-proof form on a Windows host too.
  it('a Windows host (no persistence there) asks for the per-run form', () => {
    spawnPty(fakeWin, SID, { ssh: { ...SSH, remoteOs: 'windows' } } as never)
    expect(firstIssue()).toEqual({ persistent: false })
  })

  it('a container session (persistence off by design) asks for the per-run form', () => {
    spawnPty(fakeWin, SID, { ssh: { ...SSH, runtime: { type: 'container', container: 'ccc-test' } } } as never)
    expect(firstIssue()).toEqual({ persistent: false })
  })
})
