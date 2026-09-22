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
 *
 * Since 2026-09-22 a MANAGED spawn -- one that resolves a profile -- is deferred
 * once behind the project-settings gate and re-enters `spawnPty` asynchronously
 * with the verdict. The hold is taken BEFORE that wait, so the profile reads as
 * in use from the moment `spawnPty` returns, PTY or no PTY; the PTY itself lands
 * a turn of the event loop later. An UNMANAGED spawn (no profile) is untouched
 * and still synchronous, which is what the bare-shell case below holds it to.
 *
 * Every spawn runs in the SANDBOX rather than the real home. The gate reads the
 * working directory's own `.claude/settings.json`, so pointing these at
 * `homedir()` would make them depend on whatever the developer running them
 * keeps in their own settings -- green here, red on the next machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
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
const { registerFakeClaudePackage } = await import('../helpers/claude-package')
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
  registerFakeClaudePackage(fakeProvider)
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
/** Wait for a condition the project-settings gate has to answer first. It does
 *  real file I/O, so the deferred re-entry lands on a MACROTASK and no
 *  microtask drain brings it forward. Bounded past the gate's own 3000 ms
 *  deadline, so a spawn that never lands fails the assertion instead of
 *  hanging the suite. */
const until = async (cond: () => boolean, why: string) => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting for ${why}`)
}
const untilSpawned = (n: number) => until(() => ptys.length === n, `${n} PTY(s) to start after the gate`)
/** Start a MANAGED shell in the sandbox and wait for its deferred PTY. */
const shell = async (sid: string, n: number) => {
  spawnPty(fakeWin, sid, { shellOnly: true, profileId: PROFILE, cwd: sandbox })
  await untilSpawned(n)
}

describe('shell-only sessions hold their profile (#48)', () => {
  it('a profile-pinned shell reads as in use from the moment it is asked for, until its PTY exits', async () => {
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
    spawnPty(fakeWin, 'sidshellhold1', { shellOnly: true, profileId: PROFILE, cwd: sandbox })
    // The gate defers the spawn, and the hold is taken BEFORE that wait -- which
    // is the whole point of #48 here: the window in which the usage page could
    // rotate the token, or the account be deleted, now INCLUDES the wait.
    expect(ptys, 'the managed spawn was not deferred behind the gate').toHaveLength(0)
    expect(isProfileInUseByLiveSession(PROFILE), 'the deferred shell held nothing').toBe(true)
    await untilSpawned(1)
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    exitLatest()
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
  })

  it('a bare shell (no profile) holds nothing, and is still SYNCHRONOUS', () => {
    // The unmanaged control. No profile resolves, so there is no account to
    // redirect and nothing to gate: the PTY exists the moment spawnPty returns,
    // exactly as it always did.
    spawnPty(fakeWin, 'sidshellhold2', { shellOnly: true, cwd: sandbox })
    expect(ptys).toHaveLength(1)
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
    exitLatest()
  })

  it('a restart re-establishes the hold: the stale exit of the OLD pty does not drop the NEW shell\'s hold', async () => {
    await shell('sidshellhold3', 1)
    const first = ptys[0]
    // The renderer's restart: same session id, new PTY. spawnPty kills the old
    // one first (killPty -> cleanupSessionResources releases the old hold) and
    // the new spawn holds again.
    await shell('sidshellhold3', 2)
    expect(ptys).toHaveLength(2)
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    // node-pty's exit callback is async, so the OLD pty's exit lands after the
    // new one is registered -- the restart-race guard skips its cleanup.
    first.exitCb!({ exitCode: 0 })
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    exitLatest()
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
  })

  it('two shells on one profile: in use until the LAST one exits', async () => {
    await shell('sidshellhold4a', 1)
    await shell('sidshellhold4b', 2)
    ptys[0].exitCb!({ exitCode: 0 })
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    ptys[1].exitCb!({ exitCode: 0 })
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
  })

  // Adversarial pass on #598: the hold is taken only AFTER pty.spawn succeeded. A
  // spawn that throws must leave no ref behind -- nothing would ever release it,
  // and the profile would read as in use (undeletable, never refreshed) forever.
  //
  // The gate moved WHERE that throw lands without changing the rule. node-pty now
  // refuses on the deferred RE-ENTRY, so nothing is thrown to the IPC caller and
  // the ref that has to come back is the one the WAIT took -- released by
  // deferSpawnUntil's own finally rather than by the synchronous catch.
  it('a spawn that THROWS on the deferred re-entry leaves no hold behind, and the next spawn on the id holds and releases cleanly', async () => {
    ptyMocks.throwNext = true
    expect(() => spawnPty(fakeWin, 'sidshellhold5', { shellOnly: true, profileId: PROFILE, cwd: sandbox }))
      .not.toThrow()   // deferred: the refusal has not happened yet
    expect(isProfileInUseByLiveSession(PROFILE), 'the wait took no hold').toBe(true)
    await until(() => !isProfileInUseByLiveSession(PROFILE), 'the failed re-entry to release the hold')
    expect(ptys, 'a PTY survived a refused spawn').toHaveLength(0)
    await shell('sidshellhold5', 1)
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true)
    exitLatest()
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
  })
})
