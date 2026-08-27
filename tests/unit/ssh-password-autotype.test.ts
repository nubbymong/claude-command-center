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

const sentStates: Array<{ channel: string; state: string }> = []
const fakeWin = {
  webContents: { send: (channel: string, payload?: { state?: string }) => {
    if (typeof channel === 'string' && channel.startsWith('ssh:flowState:')) {
      sentStates.push({ channel, state: payload?.state ?? '' })
    }
  } },
  isDestroyed: () => false,
} as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }

/** Everything written to the PTY since the last clear, as plain strings. */
function writes(): string[] {
  return writeMock.mock.calls.map((c) => String(c[0]))
}

beforeEach(() => {
  onDataListeners.length = 0
  writeMock.mockClear()
  sentStates.length = 0
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

  // The 2026-08-27 regression, pinned with the REAL bytes captured from a
  // Windows OpenSSH client against a live host: ConPTY glues the window-title
  // OSC (and private-mode CSI, sometimes a cursor-forward) onto the SAME line
  // as the prompt. The old CSI-only escape strip left those in place, the
  // end-anchored match failed, and the saved password was never typed — the
  // idle fallback then advanced the flow over the waiting prompt ("asks to
  // Launch Claude at the password prompt").
  it('types the password on the real Windows-OpenSSH prompt chunk (glued title OSC)', () => {
    platformMock.value = 'win32'
    spawnPty(fakeWin, 's-pw-conpty', { ssh: { ...SSH, password: 'hunter2' } } as never)
    writeMock.mockClear()

    feedPtyData("\x1b[?25lpi@192.168.50.201's password: \x1b]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\x07\x1b[?25h")
    vi.advanceTimersByTime(500)

    expect(writes().some((w) => w.includes('hunter2'))).toBe(true)
  })

  it('types the password on the cursor-forward variant of the same chunk', () => {
    platformMock.value = 'win32'
    spawnPty(fakeWin, 's-pw-conpty2', { ssh: { ...SSH, password: 'hunter2' } } as never)
    writeMock.mockClear()

    feedPtyData("pi@192.168.50.201's password:\x1b[1C\x1b]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\x07\x1b[?25h")
    vi.advanceTimersByTime(500)

    expect(writes().some((w) => w.includes('hunter2'))).toBe(true)
  })
})

describe('idle fallback vs a waiting auth prompt', () => {
  const flowStates = () => sentStates.map((s) => s.state)

  it('holds connecting over a visible password prompt instead of advancing at 1.5s', () => {
    // No saved password: the user must type it. The fallback used to advance
    // to awaiting-claude after 1.5s of prompt silence anyway ("asks to Launch
    // Claude at the password prompt").
    spawnPty(fakeWin, 's-idle-authhold', { ssh: { ...SSH } } as never)
    feedPtyData("dev@box.example.com's password: ")
    vi.advanceTimersByTime(10_000) // several idle-fallback periods, inside the hold budget
    expect(flowStates()).not.toContain('awaiting-claude')

    // The user types the password; auth output + a shell prompt arrive —
    // the ladder advances normally.
    feedPtyData('Last login: today\r\ndev@box:~$ ')
    vi.advanceTimersByTime(2_000)
    expect(flowStates()).toContain('awaiting-claude')
  })

  it('a bare \\r\\n ack or a pure control repaint does not clear the auth hold', () => {
    spawnPty(fakeWin, 's-idle-authhold2', { ssh: { ...SSH } } as never)
    feedPtyData("dev@box.example.com's password: ")
    feedPtyData('\r\n')          // strips to '' — prompt still on screen
    feedPtyData('\x1b[?25l\x1b[?25h') // cursor-blink repaint, strips to ''
    vi.advanceTimersByTime(10_000)
    expect(flowStates()).not.toContain('awaiting-claude')
  })

  it('the hold is BOUNDED: a stale sticky can delay but never wedge the flow', () => {
    // A host whose post-login prompt strips to '' (a ❯-glyph PS1) never
    // overwrites the sticky "password:" — the cap must let the fallback
    // advance eventually rather than pinning connecting forever.
    spawnPty(fakeWin, 's-idle-authbound', { ssh: { ...SSH } } as never)
    feedPtyData("dev@box.example.com's password: ")
    vi.advanceTimersByTime(30_000) // well past MAX_AUTH_HOLD_FIRES × 1.5s
    expect(flowStates()).toContain('awaiting-claude')
  })

  it('fresh output resets the hold budget (a repainting prompt keeps its window)', () => {
    spawnPty(fakeWin, 's-idle-authreset', { ssh: { ...SSH } } as never)
    feedPtyData("dev@box.example.com's password: ")
    vi.advanceTimersByTime(9_000)                    // 6 quiet holds
    feedPtyData("dev@box.example.com's password: ")  // prompt repaints — budget resets
    vi.advanceTimersByTime(9_000)                    // 6 more, still under the cap
    expect(flowStates()).not.toContain('awaiting-claude')
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
