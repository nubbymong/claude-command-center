/**
 * P3.11 round 1 (B2): what a launch does with a Codex session's extra CLI
 * arguments, through the REAL pty:spawn handler on a fake ipcMain (pty-manager
 * faked, so nothing spawns; the mocks are pty-spawn-provider-off.test.ts's).
 * pty:spawn repairs every spawn's persisted fields before its strict parse
 * (sanitizeRestoredSpawnOptions), so a value the rule refuses, however it
 * reached the launch (a config saved before the dialog checked it, a hand
 * edit, a saved session), is dropped with one log line and the session starts
 * without it; a value the rule takes reaches the launch unchanged. The dialog
 * refuses such a value before it is saved
 * (tests/unit/renderer/session-dialog-codex-extra-args.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
}))
const spawnPty = vi.fn()
const beginSpawnPreparation = vi.fn((win: unknown, sid: string) => ({ current: true, spawn: (o: unknown) => spawnPty(win, sid, o), abandon: vi.fn() }))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty, writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: () => ({ launchClaude: vi.fn() }), endSshRemote: vi.fn(),
  beginSpawnPreparation, holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionWritable: () => false,
  // P3.13: no session is held here (the one-at-a-time rule has its own files).
  isSessionLiveOrStarting: () => false,
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  codexRunEnded: async () => true,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
const logInfo = vi.hoisted(() => vi.fn())
vi.mock('../../../src/main/debug-logger', () => ({ logInfo, logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => false, installVersion: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => 'pw' }))
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => null,
}))
const lease = { release: vi.fn() }
const prepareLaunch = vi.fn(async () => ({ ok: true, lease, binding: {}, realmOnly: false, home: 'C:/res/r1', executable: 'C:/proven/codex.exe', env: {}, sessionsDir: 'C:/res/r1/sessions' }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({ launchRefusal: () => null, remoteLaunchRefusal: () => null, prepareLaunch }),
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const launch = (extraArgs: string) => spawn({}, SID, { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard', extraArgs } })

beforeEach(() => { spawnPty.mockClear(); logInfo.mockClear() })

describe('a Codex launch with extra arguments the rule refuses', () => {
  for (const bad of ['--sandbox=danger-full-access', '--model=x', 'login', '-c model_provider=x', '--add-dir a;b', '--worktree', '--not-so-yolo']) {
    it(`${JSON.stringify(bad)}: starts without them, with one log line`, async () => {
      await expect(launch(bad)).resolves.toEqual({ started: true, launched: { codexPreset: 'standard' } })
      expect(spawnPty).toHaveBeenCalledTimes(1)
      expect(spawnPty.mock.calls[0][2].codexOptions.extraArgs).toBeUndefined()
      expect(spawnPty.mock.calls[0][2].codexOptions.permissionsPreset).toBe('standard')
      expect(logInfo).toHaveBeenCalledWith(expect.stringMatching(/dropping invalid persisted Codex extra CLI arguments; the session launches without them/))
    })
  }
})

describe('a Codex launch with extra arguments the rule takes', () => {
  it('reaches pty-manager unchanged, with nothing logged about them', async () => {
    await launch('--search --add-dir ./docs')
    expect(spawnPty.mock.calls[0][2].codexOptions.extraArgs).toBe('--search --add-dir ./docs')
    expect(logInfo).not.toHaveBeenCalledWith(expect.stringMatching(/extra CLI arguments/))
  })
})
