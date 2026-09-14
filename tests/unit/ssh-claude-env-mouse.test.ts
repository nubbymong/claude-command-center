// #546: mouse-selection parity for SSH sessions. The LOCAL spawn disables
// CC's mouse tracking + alternate screen when classic copy/paste is on
// (default), so xterm owns the mouse and drag-selection works. The SSH launch
// never set those vars, so every remote Claude kept SGR mouse tracking on and
// selection was dead. This pins the env prefix on the remote launch line,
// both ways of the toggle.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'linux',
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
    pid: 77,
  }),
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))

// Mutable settings the SSH spawn reads fresh per session (spawnCfg).
const settingsState: { value: Record<string, unknown> } = { value: {} }
vi.mock('../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/config-manager')>()),
  readConfig: vi.fn((name: string) => (name === 'settings' ? settingsState.value : null)),
}))

const { spawnPty, getSshFlow, _getSshNonceForTest } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }

/** Drive the flow to the bare claude launch write (detachable off → no tmux
 *  ladder), and return that write. */
function claudeLaunchWrite(sessionId: string): string {
  onDataListeners.length = 0
  spawnPty(fakeWin, sessionId, { ssh: { ...SSH, detachable: false } } as never)
  writeMock.mockClear()
  getSshFlow(sessionId)!.launchClaude()
  vi.advanceTimersByTime(300)
  const nonce = _getSshNonceForTest(sessionId)
  feedPtyData(`setup ok ${nonce} tmux=none\r\n`)
  vi.advanceTimersByTime(1500)
  vi.advanceTimersByTime(300)
  const w = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('claude '))
  expect(w).toBeDefined()
  return w![0] as string
}

beforeEach(() => {
  onDataListeners.length = 0
  writeMock.mockClear()
  settingsState.value = {}
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers() })

describe('#546 — SSH launch env parity for classic copy/paste', () => {
  it('default (classic copy/paste on): the launch line carries both disable vars', () => {
    const written = claudeLaunchWrite('s-mouse-default')
    expect(written).toContain('CLAUDE_CODE_DISABLE_MOUSE=1')
    expect(written).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1')
  })

  it('explicit true behaves like the default', () => {
    settingsState.value = { classicTerminalCopyPaste: true }
    const written = claudeLaunchWrite('s-mouse-true')
    expect(written).toContain('CLAUDE_CODE_DISABLE_MOUSE=1')
    expect(written).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1')
  })

  it('opt-out (classicTerminalCopyPaste=false): both vars omitted — CC keeps its mouse mode', () => {
    settingsState.value = { classicTerminalCopyPaste: false }
    const written = claudeLaunchWrite('s-mouse-off')
    expect(written).not.toContain('CLAUDE_CODE_DISABLE_MOUSE=')
    expect(written).not.toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=')
  })
})
