/**
 * #48 (rc.14 review F4): a shell-only session pinned to a profile -- a plain
 * shell, or the add-account /login shell -- runs in that profile's credential
 * home for its whole life, but by design never captures an identity (B3), so it
 * was invisible to `isProfileInUseByLiveSession`: the usage page could rotate the
 * token under a /login in progress, and the account could be deleted under an
 * open shell. It now holds a consumer ref for exactly its life.
 *
 * Drives the REAL spawnPty shell-only branch with node-pty mocked to a fake PTY
 * whose exit the test fires by hand, and the profiles root sandboxed to a temp
 * dir so no real ~/.claude is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

class FakePty {
  pid = 4242
  cols = 80
  rows = 24
  process = 'sh'
  handleFlowControl = false
  exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null
  onData(_cb: (d: string) => void) { return { dispose() {} } }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCb = cb; return { dispose() {} } }
  write = vi.fn()
  resize = vi.fn()
  kill = vi.fn()
  pause() {}
  resume() {}
  clear() {}
}
const ptys: FakePty[] = []
const ptyMocks = vi.hoisted(() => ({ throwNext: false }))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
}))
vi.mock('node-pty', () => ({
  spawn: () => {
    if (ptyMocks.throwNext) {
      ptyMocks.throwNext = false
      throw new Error('spawn failed (synthetic)')
    }
    const p = new FakePty()
    ptys.push(p)
    return p
  },
}))

const { _setRootsForTest, getProfileConfigDir } = await import('../../src/main/account-profiles')
const { spawnPty } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { isProfileInUseByLiveSession, _resetClaudeAccounts } = await import('../../src/main/claude-account-identity')
const { _resetProfileConsumersForTest } = await import('../../src/main/profile-consumers')
type SessionProvider = import('../../src/main/providers/types').SessionProvider

// spawnPty resolves the session's provider before branching on shellOnly; a
// minimal Claude provider satisfies that lookup (the shell-only branch never
// invokes it -- same shape as ssh-spawn-callsite.test.ts).
const fakeProvider = {
  id: 'claude',
  displayName: 'Claude',
  resolveBinary: () => null,
  buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false,
  ingestSessionTelemetry: () => ({ stop() {} }),
  listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }),
  configureMcpServer: async () => {},
  getSshSettingsPath: () => '',
  getSshMcpConfigPath: () => '',
  configureRemoteSettings: () => '',
} as unknown as SessionProvider

const fakeWin = { webContents: { send() {} }, isDestroyed: () => false } as never
const PROFILE = 'profile-shell-01'
let sandbox = ''

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ccc-shell-hold-'))
  _setRootsForTest({ resourcesDir: sandbox, sharedRoot: join(sandbox, '.claude') })
  mkdirSync(getProfileConfigDir(PROFILE), { recursive: true })
  ptys.length = 0
  registerProvider(fakeProvider)
  _resetClaudeAccounts()
  _resetProfileConsumersForTest()
})

afterEach(() => {
  _setRootsForTest(null)
  _resetClaudeAccounts()
  _resetProfileConsumersForTest()
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* junction cleanup is best-effort */ }
})

const exitLatest = () => ptys[ptys.length - 1].exitCb!({ exitCode: 0 })

describe('shell-only sessions hold their profile (#48)', () => {
  it('a profile-pinned shell reads as in use until its PTY exits', () => {
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
    spawnPty(fakeWin, 'sidshellhold1', { shellOnly: true, profileId: PROFILE, cwd: homedir() })
    expect(ptys).toHaveLength(1)
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    exitLatest()
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
  })

  it('a bare shell (no profile) holds nothing', () => {
    spawnPty(fakeWin, 'sidshellhold2', { shellOnly: true, cwd: homedir() })
    expect(ptys).toHaveLength(1)
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
    exitLatest()
  })

  it('a restart re-establishes the hold: the stale exit of the OLD pty does not drop the NEW shell\'s hold', () => {
    spawnPty(fakeWin, 'sidshellhold3', { shellOnly: true, profileId: PROFILE, cwd: homedir() })
    const first = ptys[0]
    // The renderer's restart: same session id, new PTY. spawnPty kills the old
    // one first (killPty -> cleanupSessionResources releases the old hold) and
    // the new spawn holds again.
    spawnPty(fakeWin, 'sidshellhold3', { shellOnly: true, profileId: PROFILE, cwd: homedir() })
    expect(ptys).toHaveLength(2)
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    // node-pty's exit callback is async, so the OLD pty's exit lands after the
    // new one is registered -- the restart-race guard skips its cleanup.
    first.exitCb!({ exitCode: 0 })
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    exitLatest()
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
  })

  it('two shells on one profile: in use until the LAST one exits', () => {
    spawnPty(fakeWin, 'sidshellhold4a', { shellOnly: true, profileId: PROFILE, cwd: homedir() })
    spawnPty(fakeWin, 'sidshellhold4b', { shellOnly: true, profileId: PROFILE, cwd: homedir() })
    ptys[0].exitCb!({ exitCode: 0 })
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    ptys[1].exitCb!({ exitCode: 0 })
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
  })

  // Adversarial pass on #598: the hold is taken only AFTER pty.spawn succeeded. A
  // spawn that throws must leave no ref behind -- nothing would ever release it,
  // and the profile would read as in use (undeletable, never refreshed) forever.
  it('a spawn that THROWS leaves no hold behind, and the next spawn on the id holds and releases cleanly', () => {
    ptyMocks.throwNext = true
    try { spawnPty(fakeWin, 'sidshellhold5', { shellOnly: true, profileId: PROFILE, cwd: homedir() }) } catch { /* the throw is the point */ }
    expect(ptys).toHaveLength(0)
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
    spawnPty(fakeWin, 'sidshellhold5', { shellOnly: true, profileId: PROFILE, cwd: homedir() })
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    exitLatest()
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
  })
})
