// SSH password / sudo-password auto-type.
//
// This path had NO test coverage at all, on either platform, which is why a
// report of "saved SSH configs stopped typing the password" could not be
// answered by running the suite. The credential itself never crosses IPC (main
// resolves it from the keychain by configId at spawn time), so what is pinned
// here is the half that lives in the PTY flow: given an SSHOptions carrying a
// password, a real prompt gets it and a passing mention of the word does not.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const platformMock = vi.hoisted(() => ({ value: 'linux' as NodeJS.Platform }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => platformMock.value,
}))

const onDataListeners: Array<(data: string) => void> = []
function feedPtyData(chunk: string): void {
  for (const cb of onDataListeners) cb(chunk)
}

const writeMock = vi.fn()

vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (cb: (d: string) => void) => { onDataListeners.push(cb) },
    onExit: () => {},
    write: writeMock,
    kill: () => {},
    pid: 4242,
  }),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))

const { spawnPty } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }

/** Everything written to the PTY since the last clear, as plain strings. */
function writes(): string[] {
  return writeMock.mock.calls.map((c) => String(c[0]))
}

beforeEach(() => {
  onDataListeners.length = 0
  writeMock.mockClear()
  platformMock.value = 'linux'
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ssh password auto-type', () => {
  // The reported symptom, on the platform it was reported from.
  it.each(['linux', 'win32'] as const)('types the password on a real prompt (%s client)', (platform) => {
    platformMock.value = platform
    spawnPty(fakeWin, `s-pw-${platform}`, { ssh: { ...SSH, password: 'hunter2' } } as never)
    writeMock.mockClear()

    feedPtyData("dev@box.example.com's password: ")
    vi.advanceTimersByTime(500)

    expect(writes().some((w) => w.includes('hunter2'))).toBe(true)
  })

  it('sends the password exactly once, however many prompts arrive', () => {
    spawnPty(fakeWin, 's-pw-once', { ssh: { ...SSH, password: 'hunter2' } } as never)
    writeMock.mockClear()

    feedPtyData("dev@box.example.com's password: ")
    vi.advanceTimersByTime(500)
    feedPtyData("dev@box.example.com's password: ")
    vi.advanceTimersByTime(500)

    expect(writes().filter((w) => w.includes('hunter2'))).toHaveLength(1)
  })

  // The reason the match is anchored: an MOTD that merely mentions the word
  // would otherwise put the password into the remote's shell as stray input.
  it.each([
    ['expiry notice', 'Your password expires in 30 days\r\n'],
    ['policy banner', 'Please change your password regularly.\r\n'],
    ['mid-line mention', 'NOTICE: password rotation is enforced here\r\n'],
  ])('does NOT type it on a passing mention: %s', (_label, motd) => {
    spawnPty(fakeWin, `s-pw-motd-${_label.replace(/\W/g, '')}`, { ssh: { ...SSH, password: 'hunter2' } } as never)
    writeMock.mockClear()

    feedPtyData(motd)
    vi.advanceTimersByTime(500)

    expect(writes().some((w) => w.includes('hunter2'))).toBe(false)
  })

  it('writes nothing when the config carries no password', () => {
    spawnPty(fakeWin, 's-pw-none', { ssh: { ...SSH } } as never)
    writeMock.mockClear()

    feedPtyData("dev@box.example.com's password: ")
    vi.advanceTimersByTime(500)

    expect(writes()).toHaveLength(0)
  })
})

describe('sudo password auto-type', () => {
  // The sudo password is gated on `postCommandSent`: it is only ever offered
  // once CCC has actually run the user's postCommand, so a sudo prompt that
  // shows up before then (a login banner, a remote's own rc file) cannot
  // collect it. Driving the far side of that gate needs the full flow harness
  // (see pty-manager-ssh-tmux.test.ts); what is pinned here is the gate
  // itself, which is the part that protects the secret.
  it.each([
    ['bracketed', '[sudo] password for dev: '],
    ['bare', 'Password: '],
    ['for-user', 'password for dev: '],
  ])('does NOT type it before the postCommand has been sent: %s', (_label, prompt) => {
    spawnPty(fakeWin, `s-sudo-${_label}`, {
      ssh: { ...SSH, sudoPassword: 'sudo-secret', postCommand: 'sudo -i' },
    } as never)
    writeMock.mockClear()

    feedPtyData(prompt)
    vi.advanceTimersByTime(500)

    expect(writes().some((w) => w.includes('sudo-secret'))).toBe(false)
  })

  it('does NOT type it on a line that merely names sudo', () => {
    spawnPty(fakeWin, 's-sudo-motd', {
      ssh: { ...SSH, sudoPassword: 'sudo-secret', postCommand: 'sudo -i' },
    } as never)
    writeMock.mockClear()

    feedPtyData('dev is not in the sudoers file. This incident will be reported.')
    vi.advanceTimersByTime(500)

    expect(writes().some((w) => w.includes('sudo-secret'))).toBe(false)
  })
})
