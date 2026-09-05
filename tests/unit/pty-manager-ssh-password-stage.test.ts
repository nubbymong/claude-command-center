// rc.14 review F13 (aicc_planning#57): credentials are routed by STAGE.
//
// Key authentication leaves `passwordSent` false, so a later sudo prompt shaped
// as a bare `Password:` (the macOS shape) matched the SSH-password branch
// first: the saved SSH secret was typed into sudo and the handler returned
// before the sudo branch could act -- even with a distinct saved sudo secret.
// Once the post-command has gone out the connection is up, so that branch is
// closed and the sudo branch answers. Real pty-manager SSH flow, mocked
// transport (the harness shape the external review used).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'linux',
}))

const onDataListeners: Array<(data: string) => void> = []
const writeMock = vi.fn()
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (cb: (data: string) => void) => onDataListeners.push(cb),
    onExit: () => {},
    write: writeMock,
    kill: vi.fn(),
    pid: 4242,
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
}))

const { spawnPty, getSshFlow, killPty } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const win = { webContents: { send: vi.fn() }, isDestroyed: () => false } as never
const ssh = { username: 'user', host: 'invalid.example', port: 22, remotePath: '~' }
const feed = (text: string) => onDataListeners.forEach((cb) => cb(text))
const writes = () => writeMock.mock.calls.map(([s]) => String(s))
const ids: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  onDataListeners.length = 0
  writeMock.mockReset()
})
afterEach(() => {
  for (const id of ids.splice(0)) killPty(id)
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('a bare Password: prompt after the post-command', () => {
  it('REGRESSION: gets the SUDO secret, never the SSH one, when key auth already succeeded', () => {
    const id = 'stage-sudo'
    ids.push(id)
    spawnPty(win, id, { ssh: {
      ...ssh,
      password: 'synthetic-ssh-secret',
      sudoPassword: 'synthetic-sudo-secret',
      runtime: { type: 'container', engine: 'docker', container: 'review', sudo: true },
    } } as never)
    feed('user@host:~$ ')
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    // Key auth won: no SSH password prompt ever appeared. This is sudo's.
    feed('Password: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual(['synthetic-sudo-secret\r'])
    expect(writes()).not.toContain('synthetic-ssh-secret\r')
  })

  it('with no sudo secret saved, the prompt is left to the user: the SSH secret is not typed into sudo', () => {
    const id = 'stage-no-sudo'
    ids.push(id)
    spawnPty(win, id, { ssh: {
      ...ssh,
      password: 'synthetic-ssh-secret',
      runtime: { type: 'container', engine: 'docker', container: 'review', sudo: true },
    } } as never)
    feed('user@host:~$ ')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed('Password: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([])
  })
})

describe('positive control: the SSH password prompt during authentication', () => {
  it('still gets the SSH secret (nothing has been sent past auth yet)', () => {
    const id = 'stage-auth'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, password: 'synthetic-ssh-secret', sudoPassword: 'synthetic-sudo-secret' } } as never)
    feed("user@invalid.example's password: ")
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual(['synthetic-ssh-secret\r'])
  })

  it('a bare Password: prompt before any post-command is also sshd asking (some hosts print just that)', () => {
    const id = 'stage-auth-bare'
    ids.push(id)
    spawnPty(win, id, { ssh: { ...ssh, password: 'synthetic-ssh-secret' } } as never)
    feed('Password: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual(['synthetic-ssh-secret\r'])
  })
})
