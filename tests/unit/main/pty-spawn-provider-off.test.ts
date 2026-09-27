/**
 * WP2: main refuses every launch of a provider that is switched off, at
 * pty:spawn and at the SSH flow's "Launch Claude", BEFORE anything starts.
 * Driven through the REAL handlers on a fake ipcMain and the REAL launch gate
 * (src/main/provider-launch-gate.ts); only the accounts service's answer is
 * scripted here (its rule is proven against real settings in
 * provider-launch-gate.test.ts), and pty-manager is faked so nothing spawns.
 *
 * pty:spawn is the one path a new launch, a restored session, a Restart and
 * Ask Conductor all take (TerminalView's spawn; see
 * tests/unit/renderer/terminalview-account-launch.test.tsx), and the one an SSH
 * session takes. Each shape is refused with the typed refusal and starts
 * nothing -- no preparation, no legacy install, no credential read, no
 * account lease -- while the provider is off, and goes ahead while it is on.
 * A terminal-only session runs no provider and always goes ahead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
}))
const spawnPty = vi.fn()
const beginSpawnPreparation = vi.fn((win: unknown, sid: string) => ({ current: true, spawn: (o: unknown) => spawnPty(win, sid, o), abandon: vi.fn() }))
const flow = { launchClaude: vi.fn() }
// Session ids with a live PTY (what pty-manager's isSessionWritable answers).
const live = new Set<string>()
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty, writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: () => flow, endSshRemote: vi.fn(),
  beginSpawnPreparation, holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionWritable: (id: string) => live.has(id),
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
const installVersion = vi.fn(async () => ({ ok: true }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => false, installVersion }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({ readConfig: (key: string) => (key === 'configs' ? configsOnDisk : null) }))
const loadCredential = vi.fn((_k: string) => 'pw')
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => loadCredential(k) }))

// The accounts service's answer, per provider: on, off, or a saved setting
// that could not be read. `null` = no service at all.
type State = 'on' | 'off' | 'unreadable' | 'throws'
const acct = vi.hoisted(() => ({ state: { claude: 'on', codex: 'on' } as Record<string, 'on' | 'off' | 'unreadable' | 'throws'>, present: true, prepareLaunch: null as unknown }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => acct.present ? {
    launchRefusal: (id: string) => {
      if (acct.state[id] === 'throws') throw new Error('the service could not answer')
      const name = id === 'claude' ? 'Claude Code' : 'Codex'
      if (acct.state[id] === 'off') return { code: 'provider-off', providerId: id, message: `${name} is off. Turn it on in Settings, Accounts.` }
      if (acct.state[id] === 'unreadable') return { code: 'provider-state-unknown', providerId: id, message: `This app could not read whether ${name} is on. Check Settings, Accounts.` }
      return null
    },
    remoteLaunchRefusal: () => null,
    prepareLaunch: acct.prepareLaunch,
  } : null,
}))

const { registerPtyHandlers, countSshClaudeLaunches } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const launchClaude = handlers.get('ssh:flow:launchClaude')!
const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const CLAUDE_OFF = { started: false, refused: { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' } }
const SSH = { host: 'build-box', port: 22, username: 'nick', remotePath: '~/proj' }
const lease = { release: vi.fn() }

const set = (claude: State, codex: State = 'on') => { acct.state = { claude, codex } }

beforeEach(() => {
  spawnPty.mockClear()
  beginSpawnPreparation.mockClear()
  installVersion.mockClear()
  loadCredential.mockClear()
  flow.launchClaude.mockClear()
  lease.release.mockClear()
  acct.present = true
  set('on')
  acct.prepareLaunch = vi.fn(async () => ({ ok: true, lease, binding: {}, realmOnly: false, home: 'C:/res/r1', executable: 'C:/proven/codex.exe', env: {}, sessionsDir: 'C:/res/r1/sessions' }))
  configsOnDisk = [{ id: 'cfgssh', sessionType: 'ssh', sshConfig: { ...SSH } }]
})

describe('pty:spawn refuses a launch of a provider that is off', () => {
  const claudeShapes: Array<[string, Record<string, unknown>]> = [
    ['a new local Claude launch', { cwd: 'C:/w' }],
    ['a restored session (its exact-conversation target)', { cwd: 'C:/w', resume: { uuid: '0f8fad5b-d9cb-469f-a165-70867728950e', cwd: 'C:/w' }, useResumePicker: false }],
    ['a Restart (the resume picker)', { cwd: 'C:/w', useResumePicker: true }],
    ['Ask Conductor', { cwd: 'C:/help', askPrompt: 'what is on my canvas?', isAsk: true }],
    ['a pinned legacy CLI (whose install is not attempted)', { cwd: 'C:/w', legacyVersion: { enabled: true, version: '2.0.1' } }],
    ['an SSH session that runs Claude on the remote', { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH } }],
    ['an SSH reattach (its ladder may start a fresh claude --continue)', { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH, reconnect: true } }],
  ]
  for (const [what, options] of claudeShapes) {
    it(`${what}: refused with the typed refusal while Claude Code is off, and nothing starts`, async () => {
      set('off')
      await expect(spawn({}, SID, options)).resolves.toEqual(CLAUDE_OFF)
      expect(spawnPty).not.toHaveBeenCalled()
      expect(beginSpawnPreparation).not.toHaveBeenCalled()
      expect(installVersion).not.toHaveBeenCalled()
      expect(loadCredential).not.toHaveBeenCalled()
    })
    it(`${what}: goes ahead while Claude Code is on`, async () => {
      const r = await spawn({}, SID, options)
      expect(r).toBeUndefined()
      expect(spawnPty).toHaveBeenCalledTimes(1)
    })
  }

  it('a saved setting that cannot be read refuses (fail closed), with its own code', async () => {
    set('unreadable')
    const r = await spawn({}, SID, { cwd: 'C:/w' }) as { refused: { code: string; message: string } }
    expect(r.refused.code).toBe('provider-state-unknown')
    expect(r.refused.message).toBe('This app could not read whether Claude Code is on. Check Settings, Accounts.')
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('a service that cannot answer refuses (fail closed), never throws at the renderer', async () => {
    set('throws')
    const r = await spawn({}, SID, { cwd: 'C:/w' }) as { refused: { code: string; message: string } }
    expect(r.refused).toMatchObject({ code: 'provider-state-unknown', providerId: 'claude' })
    expect(r.refused.message).toMatch(/^This app could not read whether .+ is on\. Check Settings, Accounts\.$/)
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('no accounts service at all refuses (fail closed)', async () => {
    acct.present = false
    const r = await spawn({}, SID, { cwd: 'C:/w' }) as { refused: { code: string } }
    expect(r.refused.code).toBe('provider-state-unknown')
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('a Codex launch while Codex is off: refused before any account is prepared or leased', async () => {
    set('on', 'off')
    const r = await spawn({}, SID, { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' } })
    expect(r).toEqual({ started: false, refused: { code: 'provider-off', providerId: 'codex', message: 'Codex is off. Turn it on in Settings, Accounts.' } })
    expect(acct.prepareLaunch).not.toHaveBeenCalled()
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('a Codex launch while Codex is on is prepared and spawned; Claude being off does not touch it', async () => {
    set('off', 'on')
    await spawn({}, SID, { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' } })
    expect(acct.prepareLaunch).toHaveBeenCalledTimes(1)
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('a terminal-only session runs no provider: it starts while every provider is off', async () => {
    set('off', 'off')
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true })
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('a shell-only SSH session still connects while Claude Code is off', async () => {
    set('off')
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, configId: 'cfgssh', ssh: { ...SSH } })
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(spawnPty.mock.calls[0][2].ssh).toMatchObject({ host: 'build-box', password: 'pw' })
  })
})

describe('the SSH flow\'s "Launch Claude" is a Claude launch', () => {
  it('refused while Claude Code is off: the flow writes nothing, and the overlay is told why', async () => {
    set('off')
    await expect(launchClaude({}, SID)).resolves.toEqual({ refused: CLAUDE_OFF.refused })
    expect(flow.launchClaude).not.toHaveBeenCalled()
  })

  it('refused when the setting cannot be read', async () => {
    set('unreadable')
    const r = await launchClaude({}, SID) as { refused: { code: string } }
    expect(r.refused.code).toBe('provider-state-unknown')
    expect(flow.launchClaude).not.toHaveBeenCalled()
  })

  it('goes ahead while Claude Code is on', async () => {
    await expect(launchClaude({}, SID)).resolves.toBeUndefined()
    expect(flow.launchClaude).toHaveBeenCalledTimes(1)
  })
})

describe('a shell-only SSH session\'s accepted "Launch Claude" is Claude Code in use', () => {
  const OTHER = 'b1b2c3d4e5f6a1b2c3d4e5f6'
  const shellSsh = { cwd: 'C:/w', shellOnly: true, configId: 'cfgssh', ssh: { ...SSH } }
  const kill = () => handlers.get('pty:kill')!({}, SID)
  beforeEach(() => { live.clear(); kill() })

  it('counted once main accepts it, while its PTY runs; not once the PTY is gone', async () => {
    await spawn({}, SID, shellSsh)
    live.add(SID)
    expect(countSshClaudeLaunches()).toBe(0)
    await launchClaude({}, SID)
    expect(countSshClaudeLaunches()).toBe(1)
    live.delete(SID)
    expect(countSshClaudeLaunches()).toBe(0)
  })

  it('not counted when main refused it', async () => {
    await spawn({}, SID, shellSsh)
    live.add(SID)
    set('off')
    await launchClaude({}, SID)
    expect(countSshClaudeLaunches()).toBe(0)
  })

  it('not counted for a Claude SSH session (pty-manager counts that one already), nor for a session that is not shell-only SSH', async () => {
    await spawn({}, SID, { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH } })
    live.add(SID)
    await launchClaude({}, SID)
    await launchClaude({}, OTHER)
    live.add(OTHER)
    expect(countSshClaudeLaunches()).toBe(0)
  })

  it('a kill, or a new spawn of the same id, ends it', async () => {
    await spawn({}, SID, shellSsh)
    live.add(SID)
    await launchClaude({}, SID)
    kill()
    expect(countSshClaudeLaunches()).toBe(0)
    await spawn({}, SID, shellSsh)
    await launchClaude({}, SID)
    expect(countSshClaudeLaunches()).toBe(1)
    await spawn({}, SID, shellSsh)
    expect(countSshClaudeLaunches()).toBe(0)
  })
})

describe('the legacy Claude Code CLI install is for a Claude launch only', () => {
  const pinned = { legacyVersion: { enabled: true, version: '2.0.1' } }
  it('not for a terminal-only session', async () => {
    set('off', 'off')
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, ...pinned })
    expect(installVersion).not.toHaveBeenCalled()
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('not for a Codex session', async () => {
    await spawn({}, SID, { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, ...pinned })
    expect(installVersion).not.toHaveBeenCalled()
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })

  it('for a Claude session while Claude Code is on (the control)', async () => {
    await spawn({}, SID, { cwd: 'C:/w', ...pinned })
    expect(installVersion).toHaveBeenCalledTimes(1)
  })
})
