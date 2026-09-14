// rc.14 review F13 (aicc_planning#57): credentials are routed by STAGE.
//
// Key authentication leaves `passwordSent` false, so a later sudo prompt shaped
// as a bare `Password:` (the macOS shape) matched the SSH-password branch
// first: the saved SSH secret was typed into sudo and the handler returned
// before the sudo branch could act -- even with a distinct saved sudo secret.
// The SSH-password branch is open only while the flow is still `connecting`
// (round 2: the first fix gated on the post-command having been sent, which
// left the common no-post-command session typing the SSH secret into a sudo
// the user ran by hand). Past the first shell prompt the connection is up: a
// password prompt is sudo's, answered by the sudo branch (post-command flows
// with a saved sudo secret) or left to the user. Real pty-manager SSH flow,
// mocked transport (the harness shape the external review used).
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
const SSH_SECRET = 'synthetic-ssh-secret'
const SUDO_SECRET = 'synthetic-sudo-secret'
const CONTAINER = { type: 'container', engine: 'docker', container: 'review', sudo: true }

function spawn(id: string, cfg: Record<string, unknown>) {
  ids.push(id)
  spawnPty(win, id, { ssh: { ...ssh, ...cfg } } as never)
}

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
    spawn(id, { password: SSH_SECRET, sudoPassword: SUDO_SECRET, runtime: CONTAINER })
    feed('user@host:~$ ')
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-postcommand')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    // Key auth won: no SSH password prompt ever appeared. This is sudo's.
    feed('Password: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([`${SUDO_SECRET}\r`])
    expect(writes()).not.toContain(`${SSH_SECRET}\r`)
  })

  it('the standard Linux [sudo] password for <user>: prompt gets the SUDO secret too', () => {
    const id = 'stage-sudo-linux'
    spawn(id, { password: SSH_SECRET, sudoPassword: SUDO_SECRET, runtime: CONTAINER })
    feed('user@host:~$ ')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed('[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([`${SUDO_SECRET}\r`])
  })

  it('with no sudo secret saved, the prompt is left to the user: the SSH secret is not typed into sudo', () => {
    const id = 'stage-no-sudo'
    spawn(id, { password: SSH_SECRET, runtime: CONTAINER })
    feed('user@host:~$ ')
    getSshFlow(id)!.runPostCommand()
    vi.advanceTimersByTime(201)
    writeMock.mockClear()
    feed('Password: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([])
  })
})

// Round 2 (review MAJOR): the common configuration has NO post-command. The
// user is on the host shell and runs sudo by hand; nothing has been "sent", so
// the first fix's gate was still open.
describe('a sudo prompt on a session with NO post-command', () => {
  it('REGRESSION: a bare Password: (macOS sudo, run by hand) after the host prompt gets NOTHING', () => {
    const id = 'stage-nopost-mac'
    spawn(id, { password: SSH_SECRET })
    feed('user@mac:~$ ')
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-claude')
    writeMock.mockClear()
    feed('sudo ls\r\nPassword: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([])
  })

  it('the standard Linux [sudo] password for <user>: after the host prompt gets NOTHING (SSH or sudo secret)', () => {
    const id = 'stage-nopost-linux'
    spawn(id, { password: SSH_SECRET, sudoPassword: SUDO_SECRET })
    feed('user@host:~$ ')
    writeMock.mockClear()
    feed('sudo apt update\r\n[sudo] password for user: ')
    vi.advanceTimersByTime(101)
    // The sudo secret is only ever offered to the post-command's own sudo; a
    // hand-run sudo is the user's to answer. Nothing leaves the app.
    expect(writes()).toEqual([])
  })

  it('a zsh host (`%` prompt the regex never matches, idle fallback carried the flow): a later Password: gets NOTHING', () => {
    const id = 'stage-nopost-zsh'
    spawn(id, { password: SSH_SECRET })
    feed('user@mac ~ % ')
    vi.advanceTimersByTime(1600)
    expect(getSshFlow(id)?.getState().state).toBe('awaiting-claude')
    writeMock.mockClear()
    feed('Password: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([])
  })

  it('after Skip (the user drives the shell) a Password: gets NOTHING either', () => {
    const id = 'stage-nopost-skip'
    spawn(id, { password: SSH_SECRET })
    feed('user@host:~$ ')
    getSshFlow(id)!.skip()
    writeMock.mockClear()
    feed('Password: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([])
  })
})

describe('positive control: the SSH password prompt during authentication', () => {
  it('still gets the SSH secret (nothing has been sent past auth yet)', () => {
    const id = 'stage-auth'
    spawn(id, { password: SSH_SECRET, sudoPassword: SUDO_SECRET })
    feed("user@invalid.example's password: ")
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([`${SSH_SECRET}\r`])
  })

  it('a bare Password: prompt before any post-command is also sshd asking (some hosts print just that)', () => {
    const id = 'stage-auth-bare'
    spawn(id, { password: SSH_SECRET })
    feed('Password: ')
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([`${SSH_SECRET}\r`])
  })

  it('a pre-auth banner followed promptly by the prompt still gets the SSH secret', () => {
    const id = 'stage-auth-banner'
    spawn(id, { password: SSH_SECRET })
    feed('*** Authorised access only ***\r\n')
    vi.advanceTimersByTime(800) // inside the idle window: still connecting
    feed("user@invalid.example's password: ")
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([`${SSH_SECRET}\r`])
  })

  it('a slow server after the password was typed does not re-open anything: one write, ever', () => {
    const id = 'stage-auth-once'
    spawn(id, { password: SSH_SECRET })
    feed("user@invalid.example's password: ")
    vi.advanceTimersByTime(5000) // server verifying; the auth hold keeps the flow in connecting
    feed('Last login: today\r\nuser@host:~$ ')
    feed('Password: ') // a hand-run sudo straight after login
    vi.advanceTimersByTime(101)
    expect(writes()).toEqual([`${SSH_SECRET}\r`])
  })
})
