// An SSH session's setup reads the built-in tools switch through the checked
// read.
//
// The host setup and the container setup decide whether the remote session
// gets the built-in tools entry from ONE checked read of the saved settings
// (conductor-tools-switch.ts): settings that are there but cannot be read
// leave the tools off until they can be, whatever an unchecked read says.
// The real spawnPty SSH branch; node-pty, Electron and the credential issuer
// faked; nothing is dialled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  outcome: 'ok' as 'ok' | 'absent' | 'failed' | 'unparseable',
  issues: [] as Array<[string, string, unknown]>,
  setupOpts: [] as Array<{ includeConductorMcp?: boolean; includeStatusLine?: boolean }>,
  dataCbs: [] as Array<(d: string) => void>,
}))

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 5151, process: 'ssh',
    onData: (cb: (d: string) => void) => { h.dataCbs.push(cb); return { dispose: () => {} } },
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
// An unchecked read says the tools are on; the checked read decides.
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: (key: string) => (key === 'settings' ? { conductorToolsEnabled: true, statusLineEnabled: true } : null),
  readConfigChecked: (key: string) => (key === 'settings'
    ? (h.outcome === 'ok' ? { value: { conductorToolsEnabled: true }, outcome: 'ok' } : { value: null, outcome: h.outcome })
    : { value: null, outcome: 'absent' }),
}))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()),
  getConductorMcpPort: () => 4100,
  issueMcpSessionToken: (sid: string, provider: string, opts?: unknown) => { h.issues.push([sid, provider, opts]); return 'tok' },
}))

const { spawnPty, getSshFlow, killPty, _getSshEntryNonceForTest } = await import('../../../src/main/pty-manager')
const { entrySentinel } = await import('../../../src/shared/container-command')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')

const real = new ClaudeProvider()
registerProvider(Object.assign(Object.create(ClaudeProvider.prototype) as object, real, {
  configureRemoteSettings: (_sid: string, _path: string, _hooks: unknown, opts: { includeConductorMcp?: boolean }) => { h.setupOpts.push({ ...opts }); return 'echo setup' },
  windowsRemoteSetupCommand: (_sid: string, opts: { includeConductorMcp?: boolean }) => { h.setupOpts.push({ ...opts }); return 'echo setup' },
}) as never)

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }
const feed = (d: string): void => { for (const cb of h.dataCbs) cb(d) }
let seq = 0
let SID = ''

beforeEach(() => {
  vi.useFakeTimers()
  SID = `sshtools${String(++seq).padStart(16, '0')}`
  h.outcome = 'ok'; h.issues = []; h.setupOpts = []; h.dataCbs = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* gone */ }
  vi.useRealTimers()
})

/** The host flow: Launch Claude writes the host setup 200 ms later. */
const hostSetup = (ssh: Record<string, unknown> = SSH): void => {
  spawnPty(fakeWin, SID, { ssh } as never)
  getSshFlow(SID)!.launchClaude()
  vi.advanceTimersByTime(300)
}
/** The container flow up to its setup write (pty-manager-ssh-tmux.test.ts). */
const containerSetup = (): void => {
  spawnPty(fakeWin, SID, { ssh: { ...SSH, runtime: { type: 'container', container: 'ccc-test' } } } as never)
  feed('Welcome\r\n')
  vi.advanceTimersByTime(1500)
  getSshFlow(SID)!.runPostCommand()
  vi.advanceTimersByTime(300)
  feed(`${entrySentinel(_getSshEntryNonceForTest(SID)!, 'IN')}\r\nuser@container:~$ `)
  getSshFlow(SID)!.launchClaude()
  feed(`${entrySentinel(_getSshEntryNonceForTest(SID)!, 'HERE')}\r\n`)
  vi.advanceTimersByTime(300)
}

describe('the SSH setups read the built-in tools switch through the checked read', () => {
  // Mutation to prove this can fail: read the host setup's switch from readConfig again.
  it('host setup: settings that cannot be read give the remote session no built-in tools', () => {
    h.outcome = 'unparseable'
    hostSetup()
    expect(h.setupOpts).toHaveLength(1)
    expect(h.setupOpts[0].includeConductorMcp).toBe(false)
  })

  it('host setup: settings read and on give the tools, as before', () => {
    hostSetup()
    expect(h.setupOpts[0].includeConductorMcp).toBe(true)
  })

  // Mutation to prove this can fail: read the container setup's switch from readConfig again.
  it('container setup: settings that cannot be read give the remote session no built-in tools', () => {
    h.outcome = 'failed'
    containerSetup()
    expect(h.setupOpts).toHaveLength(1)
    expect(h.setupOpts[0].includeConductorMcp).toBe(false)
  })

  it('container setup: settings read and on give the tools, as before', () => {
    containerSetup()
    expect(h.setupOpts[0].includeConductorMcp).toBe(true)
  })
})
