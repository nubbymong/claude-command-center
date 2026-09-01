/**
 * ssh:endRemote — the DETACHED fallback (SSH Persistent, Phase 3.5).
 *
 * The gap this closes: `sshTargetBySession` is captured at spawn and dropped by
 * `killPty`, and "Leave running" IS a killPty. So every remote in the resume
 * registry had NO target in main, End resolved 'no-target', and the remote tmux
 * + claude stayed alive on the host forever — #572's orphan class arriving by
 * the detached road. After an app restart the map is empty outright.
 *
 * What is asserted here is the TRUST SHAPE, because this handler turns a
 * renderer-named id into a keychain read and an ssh exec:
 *   - the target is built ENTIRELY from the saved config on disk + that
 *     config's own keychain slots; the payload contributes two ids and nothing
 *     else, and a host smuggled into the payload is ignored;
 *   - an unknown / non-SSH / SSH-less config yields NO target (fail closed —
 *     End then no-ops rather than guessing at a host);
 *   - the id schemas reject before anything is read or spawned;
 *   - the bare-string payload the End-vs-Leave dialog still sends is unchanged.
 *
 * Driven through the real handler on a fake ipcMain, with the configs file, the
 * keychain, and pty-manager all mocked — so no ssh, no network, no keychain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
const endSshRemote = vi.fn()
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(),
  endSshRemote, probeTmuxLive: vi.fn(),
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))

let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'configs' ? configsOnDisk : null),
}))
const vault: Record<string, string> = {}
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => vault[k] ?? null }))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const endRemote = handlers.get('ssh:endRemote')!

const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const SSH = { host: 'pi.local', port: 2222, username: 'mong', remotePath: '~/work' }
const sshCfg = (id: string, extra: Record<string, unknown> = {}) => ({ id, sessionType: 'ssh', sshConfig: { ...SSH, ...extra } })

/** The (sessionId, target) endSshRemote was actually asked to run. */
const called = () => endSshRemote.mock.calls[0] as [string, unknown]

beforeEach(() => {
  endSshRemote.mockClear()
  configsOnDisk = null
  for (const k of Object.keys(vault)) delete vault[k]
})

describe('ssh:endRemote — rebuilding a DETACHED remote\'s target from the saved config', () => {
  it('builds the target from the saved config and that config\'s own keychain slots', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    vault['cfgA'] = 'pw-A'
    vault['cfgA_sudo'] = 'sudo-A'

    await endRemote({}, { sessionId: SID, configId: 'cfgA' })

    expect(endSshRemote).toHaveBeenCalledTimes(1)
    expect(called()).toEqual([SID, {
      username: 'mong', host: 'pi.local', port: 2222,
      password: 'pw-A', sudoPassword: 'sudo-A', runtime: undefined,
    }])
  })

  it('carries the saved container runtime, so a detached container session\'s claude is killed too', async () => {
    // Without this the tmux kill only drops the exec CLIENT and leaves claude
    // running inside the container forever (#572, one hop deeper).
    const runtime = { type: 'container', engine: 'podman', container: 'dev', sudo: true }
    configsOnDisk = [sshCfg('cfgA', { runtime })]
    vault['cfgA_sudo'] = 'sudo-A'

    await endRemote({}, { sessionId: SID, configId: 'cfgA' })
    expect((called()[1] as { runtime: unknown }).runtime).toEqual(runtime)
  })

  it('reads a config with no stored secrets as a KEY host — undefined, never an empty string', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    await endRemote({}, { sessionId: SID, configId: 'cfgA' })
    const target = called()[1] as { password?: string; sudoPassword?: string }
    expect(target.password).toBeUndefined()
    expect(target.sudoPassword).toBeUndefined()
  })

  it('coerces a string port from a hand-edited config file to a number', async () => {
    configsOnDisk = [{ id: 'cfgA', sessionType: 'ssh', sshConfig: { ...SSH, port: '2222' } }]
    await endRemote({}, { sessionId: SID, configId: 'cfgA' })
    expect((called()[1] as { port: unknown }).port).toBe(2222)
  })
})

describe('ssh:endRemote — the payload names IDS and nothing else', () => {
  it('IGNORES a host, port, username or credential smuggled into the payload', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    vault['cfgA'] = 'pw-A'

    await endRemote({}, {
      sessionId: SID,
      configId: 'cfgA',
      host: 'attacker.example',
      port: 4444,
      username: 'root',
      password: 'attacker-supplied',
      runtime: { type: 'container', container: 'evil' },
    })

    // Every field is the SAVED one. A compromised renderer cannot point a
    // config's keychain password at a host of its choosing.
    expect(called()[1]).toEqual({
      username: 'mong', host: 'pi.local', port: 2222,
      password: 'pw-A', sudoPassword: undefined, runtime: undefined,
    })
  })

  it('cannot name the tmux session to kill — there is no field for it', async () => {
    // The target is `ccc-<safeSid(sessionId)>`, derived locally in
    // buildRemoteTmuxKillCommand from the id validated above. The payload has
    // no route to it: an extra key is stripped by the schema, and the exec-side
    // derivation is asserted in end-remote-fallback-exec.test.ts.
    configsOnDisk = [sshCfg('cfgA')]
    await endRemote({}, { sessionId: SID, configId: 'cfgA', tmuxTarget: 'ccc-someone-else', target: 'server' })
    expect(called()[0]).toBe(SID)
    expect(Object.keys(called()[1] as object).sort()).toEqual(['host', 'password', 'port', 'runtime', 'sudoPassword', 'username'])
  })
})

describe('ssh:endRemote — fails CLOSED when there is no config to rebuild from', () => {
  it('an UNKNOWN configId yields no target (End no-ops rather than guessing a host)', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    vault['ghost'] = 'pw'
    await endRemote({}, { sessionId: SID, configId: 'ghost' })
    expect(called()).toEqual([SID, undefined])
  })

  it('a NON-SSH config, and an SSH config with no ssh block, both yield no target', async () => {
    configsOnDisk = [{ id: 'cfgL', sessionType: 'local' }, { id: 'cfgB', sessionType: 'ssh' }]
    vault['cfgL'] = 'pw'
    vault['cfgB'] = 'pw'
    await endRemote({}, { sessionId: SID, configId: 'cfgL' })
    expect(called()).toEqual([SID, undefined])
    endSshRemote.mockClear()
    await endRemote({}, { sessionId: SID, configId: 'cfgB' })
    expect(called()).toEqual([SID, undefined])
  })

  it('a missing or malformed configs file yields no target', async () => {
    for (const disk of [null, undefined, {}, 'not-an-array', [null, 42]]) {
      endSshRemote.mockClear()
      configsOnDisk = disk
      await endRemote({}, { sessionId: SID, configId: 'cfgA' })
      expect(called()).toEqual([SID, undefined])
    }
  })

  it('omitting configId entirely yields no target — the LIVE-session shape', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    await endRemote({}, { sessionId: SID })
    expect(called()).toEqual([SID, undefined])
  })
})

describe('ssh:endRemote — the id schemas reject before anything is read or spawned', () => {
  it('refuses a sessionId outside the id charset, and never reaches the keychain or the exec', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    vault['cfgA'] = 'pw-A'
    const hostile = [
      'a; tmux kill-server',       // command punctuation
      '../../etc/passwd',          // traversal
      'sess id',                   // whitespace
      'sess$(id)',                 // substitution
      '',                          // empty
      'x'.repeat(201),             // over the 200 bound
    ]
    for (const bad of hostile) {
      await expect(endRemote({}, { sessionId: bad, configId: 'cfgA' })).rejects.toThrow()
    }
    // Mutation to prove this can fail: drop `sessionId: sessionIdSchema` from
    // endRemoteSchema (pty-handlers.ts) and these all sail through.
    expect(endSshRemote).not.toHaveBeenCalled()
  })

  it('refuses a configId outside the credential-key charset', async () => {
    configsOnDisk = [sshCfg('cfgA')]
    for (const bad of ['cfg-A', 'cfg_A', '../cfgA', 'cfg A', '', 'x'.repeat(65)]) {
      await expect(endRemote({}, { sessionId: SID, configId: bad })).rejects.toThrow()
    }
    expect(endSshRemote).not.toHaveBeenCalled()
  })

  it('refuses a payload that is neither an id string nor the object shape', async () => {
    for (const bad of [null, undefined, 42, [SID], { configId: 'cfgA' }, { sessionId: 42 }]) {
      await expect(endRemote({}, bad)).rejects.toThrow()
    }
    expect(endSshRemote).not.toHaveBeenCalled()
  })
})

describe('ssh:endRemote — the LIVE-session caller is unchanged', () => {
  it('a bare id still ends a live session, with no fallback target', async () => {
    // What the End-vs-Leave dialog sends (sshCloseStore.endRemoteAndClose).
    configsOnDisk = [sshCfg('cfgA')]
    await endRemote({}, SID)
    expect(called()).toEqual([SID, undefined])
  })

  it('a bare id outside the charset is still refused', async () => {
    await expect(endRemote({}, 'a; rm -rf /')).rejects.toThrow()
    expect(endSshRemote).not.toHaveBeenCalled()
  })
})
