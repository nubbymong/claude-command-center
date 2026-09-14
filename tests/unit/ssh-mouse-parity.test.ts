// tests/unit/ssh-mouse-parity.test.ts
//
// #546: mouse-selection parity between a LOCAL and an SSH Claude session.
//
// The local spawn (buildClaudeLocalSpawn, spawn.ts) sets
// CLAUDE_CODE_DISABLE_MOUSE=1 + CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 when
// classicTerminalCopyPaste is on (the default) so xterm owns the mouse ->
// classic drag-selection + right-click copy/paste. The SSH launch builds its
// own env prefix (claudeEnvVars in pty-manager.ts) and, before #546, never
// carried those two vars -- so remote Claude kept SGR mouse tracking on and
// selection was dead over SSH. classic-mouse-env.test.ts locks the LOCAL
// behaviour; this locks the SSH side, both toggle states.
//
// The default-on case rides pty-manager-ssh-tmux.test.ts (readConfig returns
// null there = default on). This file exists for the OFF case, which needs
// readConfig('settings') to return { classicTerminalCopyPaste: false } -- so it
// mocks only that one export via vi.hoisted, leaving every other config-manager
// export (getConfigDir, saveConfig, ...) real for the provider/flow code.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'linux',
}))

const hoisted = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null }))
vi.mock('../../src/main/config-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config-manager')>()
  return {
    ...actual,
    // Only 'settings' is steered; every other key falls through to the real
    // reader (which returns null in this harness -- no config files on disk).
    readConfig: (key: string) =>
      key === 'settings' ? hoisted.settings : (actual.readConfig as (k: string) => unknown)(key),
  }
})

const onDataListeners: Array<(data: string) => void> = []
function feedPtyData(chunk: string): void {
  for (const cb of onDataListeners) cb(chunk)
}
const writeMock = vi.fn()
const spawnMock = vi.fn(() => {
  const exits: Array<(e: { exitCode: number }) => void> = []
  const inst = {
    onData: (cb: (data: string) => void) => { onDataListeners.push(cb) },
    onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb) },
    write: writeMock,
    kill: () => {},
    pid: 123,
    __fireExit: (exitCode = 0) => { for (const cb of exits.slice()) cb({ exitCode }) },
  }
  return inst
})
vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))

const { spawnPty, getSshFlow, _getSshNonceForTest } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never
const SSH = { username: 'dev', host: 'box.example.com', port: 2222, remotePath: '~' }

// detachable:false bypasses the tmux ladder entirely, so a tmux=path sentinel
// writes a BARE claude launch straight after setup -- the env prefix appears
// unwrapped, the cleanest surface to assert the mouse vars on.
function driveToBareClaudeWrite(sessionId: string): string {
  onDataListeners.length = 0
  spawnPty(fakeWin, sessionId, { ssh: { ...SSH, detachable: false } } as never)
  writeMock.mockClear()
  getSshFlow(sessionId)!.launchClaude()
  vi.advanceTimersByTime(300)
  const nonce = _getSshNonceForTest(sessionId)!
  feedPtyData(`setup ok ${nonce} tmux=path\r\n`)
  vi.advanceTimersByTime(1500)
  vi.advanceTimersByTime(300)
  const claudeWrite = writeMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('claude '))
  expect(claudeWrite).toBeDefined()
  return claudeWrite![0] as string
}

describe('#546 SSH mouse-selection parity — CLAUDE_CODE_DISABLE_MOUSE on the remote launch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hoisted.settings = null
  })
  afterEach(() => {
    vi.useRealTimers()
    hoisted.settings = null
  })

  it('classic on (default, settings null) → remote launch sets DISABLE_MOUSE + DISABLE_ALTERNATE_SCREEN', () => {
    const written = driveToBareClaudeWrite('s-546-on-default')
    expect(written).toContain('CLAUDE_CODE_DISABLE_MOUSE=1')
    expect(written).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1')
  })

  it('classic explicitly true → remote launch sets both vars', () => {
    hoisted.settings = { classicTerminalCopyPaste: true }
    const written = driveToBareClaudeWrite('s-546-on-explicit')
    expect(written).toContain('CLAUDE_CODE_DISABLE_MOUSE=1')
    expect(written).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1')
  })

  it('classic off → remote launch omits both vars (CC mouse mode preserved), matching the local opt-out', () => {
    hoisted.settings = { classicTerminalCopyPaste: false }
    const written = driveToBareClaudeWrite('s-546-off')
    expect(written).not.toContain('CLAUDE_CODE_DISABLE_MOUSE=1')
    expect(written).not.toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1')
    // The launch itself still happens -- only the two mouse vars are gated.
    expect(written).toContain('claude ')
  })
})
