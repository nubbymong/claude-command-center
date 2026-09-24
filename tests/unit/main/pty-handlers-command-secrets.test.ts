/**
 * The pty:spawn handler is the ONLY place command secrets are allowed to enter
 * the spawn options, and it builds them from disk + keychain, never from what
 * the renderer sent. This drives the real handler (registered through a fake
 * ipcMain) rather than the schema, because the property lives in the handler's
 * body: the zod parse result is discarded and `options` is forwarded, so a field
 * the schema does not know would otherwise flow straight through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
const spawnPty = vi.fn()
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty, writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), endSshRemote: vi.fn(),
  // WP2: a spawn that awaits work in main registers for the wait; here it
  // always stays current and hands straight to spawnPty.
  beginSpawnPreparation: (win: unknown, sid: string) => ({ current: true, spawn: (o: unknown) => spawnPty(win, sid, o), abandon: vi.fn() }),
  holdsCodexLaunchLease: () => false,
  codexLaunchLeaseTaken: () => false,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))

let commandsOnDisk: unknown = null
let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'commands' ? commandsOnDisk : key === 'configs' ? configsOnDisk : null),
}))
const vault: Record<string, string> = {}
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => vault[k] ?? null }))
// WP2: the accounts service a Codex spawn is prepared by; none unless a test sets one.
const acct = vi.hoisted(() => ({ service: null as null | Record<string, unknown> }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => acct.service }))

const { registerPtyHandlers, MAIN_INTERNAL_SPAWN_FIELDS } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'

beforeEach(() => {
  spawnPty.mockClear()
  acct.service = null
  commandsOnDisk = null
  configsOnDisk = null
  for (const k of Object.keys(vault)) delete vault[k]
})

describe('pty:spawn and command secrets', () => {
  it('STRIPS commandSecrets the renderer sent -- a renderer cannot name its own secrets', async () => {
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfg1', commandSecrets: { evil: 'x' } })
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnPty.mock.calls[0][2].commandSecrets).toBeUndefined()
  })

  it('STRIPS refreshAwaited too (rc.15 review R3): the flag that skips the profile-refresh wait is main-internal, never the renderer\'s to set', async () => {
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfg1', refreshAwaited: true })
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnPty.mock.calls[0][2].refreshAwaited).toBeUndefined()
  })

  it('STRIPS projectGate: a renderer cannot hand the spawn a "clean" project-settings verdict and skip the gate', async () => {
    // The deferred re-entry carries the gate's verdict in `projectGate`, and
    // spawnPty runs the gate only when that field is undefined. refreshAwaited
    // was deleted here and projectGate was not, so a renderer that sent
    // `projectGate: { status: 'clean' }` launched a managed session in a
    // directory nobody had scanned (adversarial review, BLOCKER).
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfg1', profileId: 'p1', projectGate: { status: 'clean' }, projectGateDirs: ['C:/w'] })
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnPty.mock.calls[0][2].projectGate).toBeUndefined()
    expect(spawnPty.mock.calls[0][2].projectGateDirs, 'the gated-directory set is main-internal too').toBeUndefined()
    expect(spawnPty.mock.calls[0][2].profileId, 'the strip removed more than the main-internal fields').toBe('p1')
  })

  it('...and EVERY main-internal field the manager reads is on the strip list, by name', () => {
    // The list is what the handler deletes; this pins its contents so a new
    // re-entry field added to SpawnPtyOptions without an entry here is a test
    // failure rather than a silent bypass.
    expect([...MAIN_INTERNAL_SPAWN_FIELDS].sort()).toEqual(['codexLaunch', 'projectGate', 'projectGateDirs', 'refreshAwaited'])
  })

  it('STRIPS codexLaunch (WP2): a renderer cannot hand a spawn its own executable, environment or account lease', async () => {
    const forged = { lease: { release: vi.fn() }, executable: 'C:/evil/codex.exe', env: { CODEX_HOME: 'C:/elsewhere' }, sessionsDir: 'C:/elsewhere/sessions' }
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfg1', codexLaunch: forged })
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnPty.mock.calls[0][2].codexLaunch).toBeUndefined()
    // A Codex session builds its launch only from the accounts service: with
    // none ready it is refused, whatever launch the request carried.
    await expect(spawn({}, SID, {
      cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: forged,
    })).rejects.toThrow(/Codex session refused/)
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(forged.lease.release).not.toHaveBeenCalled()
    // ...and with one ready, the launch the service prepared is the one that
    // reaches the spawn, never the one the request carried.
    const lease = { release: vi.fn() }
    acct.service = {
      prepareLaunch: async () => ({ ok: true, lease, binding: {}, realmOnly: false, home: 'C:/res/r1', executable: 'C:/proven/codex.exe', env: { CODEX_HOME: 'C:/res/r1' }, sessionsDir: 'C:/res/r1/sessions' }),
    }
    await spawn({}, SID, { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: forged })
    expect(spawnPty).toHaveBeenCalledTimes(2)
    expect(spawnPty.mock.calls[1][2].codexLaunch).toEqual({ lease, executable: 'C:/proven/codex.exe', env: { CODEX_HOME: 'C:/res/r1' }, sessionsDir: 'C:/res/r1/sessions' })
  })

  it('rebuilds them from the commands file on disk and the keychain, for a SHELL spawn with a config', async () => {
    commandsOnDisk = [
      { id: 'aaa111', hasSecretArg: true, scope: 'global' },
      { id: 'bbb222', hasSecretArg: true, scope: 'config', configId: 'other' },
    ]
    vault['aaa111_cmdsecret'] = 'tok-a'
    vault['bbb222_cmdsecret'] = 'tok-b'
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfg1', commandSecrets: { aaa111: 'renderer-lie' } })
    // The renderer's value for aaa111 is ignored; the keychain's is used. The
    // other-config command is not visible here.
    expect(spawnPty.mock.calls[0][2].commandSecrets).toEqual({ aaa111: 'tok-a' })
  })

  it('gives a CLAUDE spawn none, even with secrets on disk', async () => {
    commandsOnDisk = [{ id: 'aaa111', hasSecretArg: true, scope: 'global' }]
    vault['aaa111_cmdsecret'] = 'tok-a'
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: false, configId: 'cfg1' })
    expect(spawnPty.mock.calls[0][2].commandSecrets).toBeUndefined()
  })

  it('gives a shell spawn with NO config its GLOBAL secrets and nothing config-scoped -- a Global button runs in every session it can run in', async () => {
    // Ask Conductor's partner shell, a resumed folder: no config, but the
    // Global buttons are on its bar and may carry a secret. Before the ADR-009
    // pass on #386 this spawn got nothing and the button typed a reference to
    // an unset variable -- "runs with an empty credential unannounced".
    commandsOnDisk = [
      { id: 'aaa111', hasSecretArg: true, scope: 'global' },
      { id: 'bbb222', hasSecretArg: true, scope: 'config', configId: 'other' },
    ]
    vault['aaa111_cmdsecret'] = 'tok-a'
    vault['bbb222_cmdsecret'] = 'tok-b'
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true })
    expect(spawnPty.mock.calls[0][2].commandSecrets).toEqual({ aaa111: 'tok-a' })
  })

  it('gives an SSH shell spawn none -- the env never leaves this PC, so nothing is decrypted for it', async () => {
    commandsOnDisk = [{ id: 'aaa111', hasSecretArg: true, scope: 'global' }]
    vault['aaa111_cmdsecret'] = 'tok-a'
    // The spawn-credential binding refuses an SSH spawn whose block is not the
    // saved config's own, so the harness saves the config this spawn names.
    configsOnDisk = [{ id: 'cfg1', sessionType: 'ssh', sshConfig: { host: 'box', port: 22, username: 'u', remotePath: '~' } }]
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfg1', ssh: { host: 'box', port: 22, username: 'u', remotePath: '~' } })
    expect(spawnPty.mock.calls[0][2].commandSecrets).toBeUndefined()
  })
})
