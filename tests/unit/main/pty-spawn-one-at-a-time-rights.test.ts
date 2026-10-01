/**
 * P3.13 round 1: the one-at-a-time rule gates NEW copies only. A session that
 * already has the right to run keeps it, through the REAL pty:spawn handler,
 * the REAL gate (src/main/launch-one-at-a-time.ts) and the REAL session load
 * path (src/main/app-session-durability.ts); only pty-manager is faked (a Set
 * of session ids with a PTY, one of spawns it is preparing), so nothing spawns.
 *
 *  M1  a session restored at this start (the ids main read from the saved
 *      session state, never a flag the renderer sends) starts, even beside
 *      another copy of a config that is not Multi Spawn; a NEW tab is refused;
 *  M2  a session accepted in this run restarts, switches account, recovers and
 *      reattaches even when another copy runs (Multi Spawn unticked meanwhile);
 *  M3  no exemption carries a config's credentials: an Ask flag, a reconnect
 *      flag and a partner-shaped name each buy nothing but the exact partner
 *      shell the renderer starts;
 *  M4  a live session's record is never re-pointed by a spawn that is refused
 *      or throws;
 *  M5  the log carries a config id made safe, never raw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
}))
const live = new Set<string>()
const pending = new Set<string>()
const spawned: Array<{ sid: string; o: Record<string, unknown> }> = []
const spawnPty = vi.fn((_win: unknown, sid: string, o: Record<string, unknown>) => { live.add(sid); spawned.push({ sid, o }) })
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: (w: unknown, s: string, o: Record<string, unknown>) => spawnPty(w, s, o),
  writePty: vi.fn(), resizePty: vi.fn(),
  killPty: (id: string) => { live.delete(id); pending.delete(id) },
  getSshFlow: () => undefined, endSshRemote: vi.fn(),
  beginSpawnPreparation: (w: unknown, sid: string) => {
    pending.add(sid)
    return { get current() { return pending.has(sid) }, spawn: (o: Record<string, unknown>) => { pending.delete(sid); spawnPty(w, sid, o) }, abandon: () => { pending.delete(sid) } }
  },
  holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionWritable: (id: string) => live.has(id),
  isSessionLiveOrStarting: (id: string) => live.has(id) || pending.has(id),
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  codexRunEnded: async () => true,
  uncertainCodexConversationIds: () => [],
  rememberUncertainCodexConversationsFrom: () => {},
}))
const state = vi.hoisted(() => ({ loaded: null as unknown }))
vi.mock('../../../src/main/session-state', () => ({
  loadSessionState: () => state.loaded,
  saveSessionState: () => true,
  readDetachedRemotesRegistry: () => [],
}))
vi.mock('../../../src/main/conversation-running-time', () => ({ conversationRunningTimesForSave: () => [], rememberConversationRunningTimesFrom: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))
vi.mock('../../../src/main/logging/transcript-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/logging/transcript-discovery')>()),
  resolveResumeTargetFromTranscript: () => null,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
const logs: string[] = []
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: (m: string) => { logs.push(m) }, logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({ readConfig: (key: string) => (key === 'configs' ? configsOnDisk : null) }))
const loadCredential = vi.fn((k: string) => 'secret-for-' + k)
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => loadCredential(k) }))
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => null,
  isExactBindSourceActive: () => true,
}))
const prepared: Array<Record<string, unknown>> = []
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: () => null,
    remoteLaunchRefusal: () => null,
    prepareLaunch: async (input: Record<string, unknown>) => {
      prepared.push(input)
      return { ok: true, lease: { release: vi.fn() }, binding: {}, realmOnly: false, home: 'C:/res/r1', executable: 'C:/proven/codex.exe', env: {}, sessionsDir: 'C:/res/r1/sessions' }
    },
  }),
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { createAppSessionDurability } = await import('../../../src/main/app-session-durability')
const { _resetConfigLaunchClaimsForTest } = await import('../../../src/main/launch-one-at-a-time')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const kill = handlers.get('pty:kill')!

const A = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const B = 'b1b2c3d4e5f6a1b2c3d4e5f6'
const C = 'c1b2c3d4e5f6a1b2c3d4e5f6'
const D = 'd1b2c3d4e5f6a1b2c3d4e5f6'
const SSH = { host: 'build-box', port: 22, username: 'nick', remotePath: '~/proj' }
const savedClaude = (over: Record<string, unknown> = {}) => ({ id: 'cfgclaude', label: 'App Dev', provider: 'claude', sessionType: 'local', workingDirectory: 'C:/w', ...over })
const savedCodex = (over: Record<string, unknown> = {}) => ({ id: 'cfgcodex', label: 'Codex Dev', provider: 'codex', sessionType: 'local', workingDirectory: 'C:/w', ...over })
const savedSsh = (over: Record<string, unknown> = {}) => ({ id: 'cfgssh', label: 'Build Box', provider: 'claude', sessionType: 'ssh', sshConfig: { ...SSH }, ...over })
const savedShell = (over: Record<string, unknown> = {}) => ({ id: 'cfgshell', label: 'Plain', provider: 'claude', shellOnly: true, sessionType: 'local', workingDirectory: 'C:/w', terminalOptions: { command: 'deploy', args: '--prod', hasSecretArg: true }, ...over })
const claudeReq = { cwd: 'C:/w', configId: 'cfgclaude' }
const codexReq = { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, configId: 'cfgcodex' }
const sshReq = { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH } }
const shellReq = { cwd: 'C:/w', configId: 'cfgshell', shellOnly: true, terminalOptions: { command: 'deploy', args: '--prod', hasSecretArg: true } }
const disk = (...c: unknown[]) => { configsOnDisk = c }
const isRefused = (r: unknown) => !!r && typeof r === 'object' && (r as { refused?: { code?: string } }).refused?.code === 'already-running'
/** The saved session state the app loads at start (what main reads from disk). */
const load = (sessions: Array<Record<string, unknown>>, detachedRemotes: Array<Record<string, unknown>> = []) => {
  state.loaded = { sessions, activeSessionId: null, savedAt: 1, detachedRemotes }
  return createAppSessionDurability().load()
}

beforeEach(() => {
  live.clear(); pending.clear(); spawned.length = 0; prepared.length = 0; logs.length = 0
  spawnPty.mockClear(); loadCredential.mockClear()
  state.loaded = null
  configsOnDisk = null
  _resetConfigLaunchClaimsForTest()
})

describe('M1: a session restored at this start keeps its right to run', () => {
  const claudeOrCodex: Array<[string, () => unknown, Record<string, unknown>, string]> = [
    ['Claude', () => savedClaude({ allowMultiSpawn: false }), claudeReq, 'cfgclaude'],
    ['Codex', () => savedCodex({ allowMultiSpawn: false }), codexReq, 'cfgcodex'],
  ]
  for (const [name, saved, req, id] of claudeOrCodex) {
    it(`both restored copies of a declined ${name} config start; a NEW tab for it while they run is refused`, async () => {
      disk(saved())
      load([{ id: A, configId: id, label: 'x' }, { id: B, configId: id, label: 'x' }])
      expect(isRefused(await spawn({}, A, req))).toBe(false)
      expect(isRefused(await spawn({}, B, req))).toBe(false)
      expect([...live].sort()).toEqual([A, B])
      expect(isRefused(await spawn({}, C, req))).toBe(true)
      expect(live.has(C)).toBe(false)
    })
  }

  it('a config that was never chosen (no flag) restores its copies too', async () => {
    disk(savedClaude())
    load([{ id: A, configId: 'cfgclaude' }, { id: B, configId: 'cfgclaude' }, { id: C, configId: 'cfgclaude' }])
    for (const id of [A, B, C]) expect(isRefused(await spawn({}, id, claudeReq))).toBe(false)
    expect(live.size).toBe(3)
  })

  it('the right is the saved session\'s own, for its own config: another config\'s spawn under a restored id gets nothing', async () => {
    disk(savedClaude(), savedCodex())
    load([{ id: A, configId: 'cfgclaude' }])
    await spawn({}, B, codexReq) // a Codex copy is already running
    expect(isRefused(await spawn({}, A, codexReq))).toBe(true) // A's saved right is for the Claude config
    expect(live.has(A)).toBe(false)
  })

  it('what a request says about itself is not a restore: only the ids main read from the saved state count', async () => {
    disk(savedClaude())
    load([{ id: A, configId: 'cfgclaude' }])
    await spawn({}, A, claudeReq)
    expect(isRefused(await spawn({}, B, { ...claudeReq, restored: true, resume: { uuid: '0f8fad5b-d9cb-469f-a165-70867728950e', cwd: 'C:/w' } }))).toBe(true)
  })

  it('only the first load of this run seeds: a later load (the resume prompt\'s Refresh) adds no right', async () => {
    disk(savedClaude())
    load([{ id: A, configId: 'cfgclaude' }])
    load([{ id: A, configId: 'cfgclaude' }, { id: B, configId: 'cfgclaude' }])
    await spawn({}, A, claudeReq)
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(true)
  })

  it('an Ask session and an entry with no config are not rights', async () => {
    disk(savedClaude())
    load([{ id: A, configId: 'cfgclaude', kind: 'ask' }, { id: B }, { id: C, configId: 'cfgclaude' }])
    await spawn({}, C, claudeReq)
    expect(isRefused(await spawn({}, A, claudeReq))).toBe(true)
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(true)
  })

  it('an SSH remote left running is reattached by its own id, with another copy live', async () => {
    disk(savedSsh())
    load([], [{ sessionId: A, configId: 'cfgssh', host: SSH.host, username: SSH.username, remotePath: SSH.remotePath }])
    await spawn({}, B, sshReq)
    expect(isRefused(await spawn({}, A, { ...sshReq, ssh: { ...SSH, reconnect: true } }))).toBe(false)
    expect(live.has(A)).toBe(true)
    // ...and a NEW id claiming to be a reattach is a new copy (M3).
    expect(isRefused(await spawn({}, C, { ...sshReq, ssh: { ...SSH, reconnect: true } }))).toBe(true)
  })
})

describe('M2: a session accepted in this run keeps its right to run again', () => {
  const shapes: Array<[string, () => unknown, Record<string, unknown>]> = [
    ['Claude', () => savedClaude({ allowMultiSpawn: true }), claudeReq],
    ['Codex', () => savedCodex({ allowMultiSpawn: true }), codexReq],
    ['SSH', () => savedSsh({ allowMultiSpawn: true }), sshReq],
    ['terminal-only', () => savedShell({ allowMultiSpawn: true }), shellReq],
  ]
  for (const [name, saved, req] of shapes) {
    it(`${name}: two live copies, Multi Spawn unticked meanwhile: a Restart or a Switch of copy 1 starts, a new copy does not`, async () => {
      disk(saved())
      await spawn({}, A, req)
      await spawn({}, B, req)
      const id = (req.configId as string)
      disk({ ...(saved() as Record<string, unknown>), allowMultiSpawn: false, id })
      spawnPty.mockClear()
      expect(isRefused(await spawn({}, A, req))).toBe(false) // Restart (the old process is replaced)
      expect(isRefused(await spawn({}, A, req))).toBe(false) // Switch account
      expect(spawnPty).toHaveBeenCalledTimes(2)
      expect(isRefused(await spawn({}, C, req))).toBe(true)
    })

    it(`${name}: a copy whose process ended or was killed (a tab left Not running) restarts while another copy runs`, async () => {
      disk(saved())
      await spawn({}, A, req)
      await spawn({}, B, req)
      disk({ ...(saved() as Record<string, unknown>), allowMultiSpawn: false })
      kill({}, A) // the renderer's Restart kills first, then spawns
      expect(live.has(A)).toBe(false)
      expect(isRefused(await spawn({}, A, req))).toBe(false)
      expect(live.has(A)).toBe(true)
    })
  }

  it('a shell-only copy that sends no terminal options (a partner-like shape) is still a copy: its Restart keeps it counted', async () => {
    disk(savedShell({ terminalOptions: undefined }))
    const req = { cwd: 'C:/w', configId: 'cfgshell', shellOnly: true }
    await spawn({}, A, req)
    expect(isRefused(await spawn({}, A, req))).toBe(false) // Restart
    expect(isRefused(await spawn({}, B, req))).toBe(true) // A is still the running copy
  })

  it('an SSH reattach of a copy of this run (Leave running, then Resume) starts beside another copy', async () => {
    disk(savedSsh({ allowMultiSpawn: true }))
    await spawn({}, A, sshReq)
    await spawn({}, B, sshReq)
    disk(savedSsh({ allowMultiSpawn: false }))
    kill({}, A) // Leave running: the local PTY goes, the remote stays
    expect(isRefused(await spawn({}, A, { ...sshReq, ssh: { ...SSH, reconnect: true } }))).toBe(false)
  })

  it('the right is for the config the session was accepted for: the same id naming another config is a new copy of it', async () => {
    disk(savedClaude(), savedCodex())
    await spawn({}, A, claudeReq)
    await spawn({}, B, codexReq)
    expect(isRefused(await spawn({}, A, codexReq))).toBe(true) // A held a Claude right; codex already runs in B
  })

  it('a spawn that never got going earns no right: a refused or failed first start is a new copy next time', async () => {
    disk(savedClaude())
    await spawn({}, A, claudeReq)
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(true) // refused: B has no right
    kill({}, A)
    await spawn({}, C, claudeReq)
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(true) // still no right for B
  })

  it('a session that is later spawned as a non-copy stops counting as a copy (no config, then a copy again)', async () => {
    disk(savedClaude())
    await spawn({}, A, claudeReq)
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(true)
    await spawn({}, A, { cwd: 'C:/w' }) // A is replaced by a session that names no config
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(false)
  })
})

describe('M3: an exemption never carries a config\'s credentials', () => {
  it('baseline: a second SSH copy is refused and loads no credential', async () => {
    disk(savedSsh())
    await spawn({}, A, sshReq)
    loadCredential.mockClear()
    expect(isRefused(await spawn({}, B, sshReq))).toBe(true)
    expect(loadCredential).not.toHaveBeenCalled()
  })

  it('an Ask flag on a config\'s spawn buys nothing: a second credentialed SSH copy is refused', async () => {
    disk(savedSsh())
    await spawn({}, A, sshReq)
    loadCredential.mockClear()
    expect(isRefused(await spawn({}, B, { ...sshReq, isAsk: true }))).toBe(true)
    expect(loadCredential).not.toHaveBeenCalled()
    expect(live.has(B)).toBe(false)
  })

  it('a partner-shaped name on an SSH spawn buys nothing: it carries an ssh block, so it is a copy and is refused', async () => {
    disk(savedSsh())
    await spawn({}, A, sshReq)
    loadCredential.mockClear()
    expect(isRefused(await spawn({}, 'deadbeef-partner', { ...sshReq, shellOnly: true }))).toBe(true)
    expect(loadCredential).not.toHaveBeenCalled()
  })

  it('a partner-shaped name on a terminal-only spawn with its secret argument is a copy, refused, and gets no secret', async () => {
    disk(savedShell())
    await spawn({}, A, shellReq)
    loadCredential.mockClear()
    expect(isRefused(await spawn({}, B, shellReq))).toBe(true)
    expect(isRefused(await spawn({}, 'cafe-partner', shellReq))).toBe(true)
    expect(spawned.find((s) => s.sid === 'cafe-partner')).toBeUndefined()
    expect(loadCredential).not.toHaveBeenCalled()
  })

  it('a reconnect flag on a NEW id (not a restored one, not one accepted in this run) buys nothing', async () => {
    disk(savedSsh())
    await spawn({}, A, sshReq)
    loadCredential.mockClear()
    expect(isRefused(await spawn({}, B, { ...sshReq, ssh: { ...SSH, reconnect: true } }))).toBe(true)
    expect(loadCredential).not.toHaveBeenCalled()
  })

  it('a reconnect flag on a non-SSH config is no right either', async () => {
    disk(savedClaude())
    await spawn({}, A, claudeReq)
    await expect(spawn({}, B, { ...claudeReq, ssh: { ...SSH, reconnect: true } })).resolves.toMatchObject({ refused: { code: 'already-running' } })
  })

  it('the renderer\'s own partner shell (shell-only, <session>-partner, no ssh, no terminal options) starts beside its running session', async () => {
    disk(savedClaude(), savedShell())
    await spawn({}, A, claudeReq)
    expect(isRefused(await spawn({}, `${A}-partner`, { cwd: 'C:/w', shellOnly: true, configId: 'cfgclaude' }))).toBe(false)
    expect(live.has(`${A}-partner`)).toBe(true)
  })

  it('its partner is exempt only for a session main holds: a partner of an id main never accepted is an ordinary copy', async () => {
    disk(savedClaude())
    await spawn({}, A, claudeReq)
    expect(isRefused(await spawn({}, `${B}-partner`, { cwd: 'C:/w', shellOnly: true, configId: 'cfgclaude' }))).toBe(true)
  })

  it('a partner of a session whose tab has ended (its process gone, accepted in this run) still opens', async () => {
    disk(savedClaude({ allowMultiSpawn: true }))
    await spawn({}, A, claudeReq)
    await spawn({}, B, claudeReq)
    disk(savedClaude({ allowMultiSpawn: false }))
    kill({}, A)
    expect(isRefused(await spawn({}, `${A}-partner`, { cwd: 'C:/w', shellOnly: true, configId: 'cfgclaude' }))).toBe(false)
  })

  it('a partner exempt shell is exact: an extra terminal-options block, an ssh block, or elevation makes it a copy', async () => {
    disk(savedClaude())
    await spawn({}, A, claudeReq)
    const p = `${A}-partner`
    const base = { cwd: 'C:/w', shellOnly: true, configId: 'cfgclaude' }
    expect(isRefused(await spawn({}, p, { ...base, terminalOptions: { command: 'x' } }))).toBe(true)
    expect(isRefused(await spawn({}, p, { ...base, ssh: { ...SSH } }))).toBe(true)
    expect(isRefused(await spawn({}, p, { ...base, elevated: true }))).toBe(true)
    expect(isRefused(await spawn({}, p, { ...base, shellOnly: false }))).toBe(true)
  })
})

describe('M4: a live session\'s record is not re-pointed by a spawn that does not start', () => {
  it('a same-id spawn naming another config that throws leaves the session counted as what it runs', async () => {
    disk(savedClaude(), savedSsh())
    await spawn({}, A, claudeReq)
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(true)
    // Same id A, naming the SSH config with a host that does not bind: throws after the gate; A's PTY is untouched.
    await expect(spawn({}, A, { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH, host: 'other-box' } })).rejects.toThrow(/SSH spawn refused/)
    expect(live.has(A)).toBe(true)
    // A still runs the Claude config: a second copy of it is refused, a first copy of the SSH config is not.
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(true)
    expect(isRefused(await spawn({}, C, sshReq))).toBe(false)
  })

  it('a same-id spawn that main refuses leaves the old record alone', async () => {
    disk(savedClaude(), savedCodex())
    await spawn({}, A, claudeReq)
    await spawn({}, B, codexReq)
    expect(isRefused(await spawn({}, A, codexReq))).toBe(true)
    expect(isRefused(await spawn({}, C, claudeReq))).toBe(true) // A is still the Claude copy
    expect(isRefused(await spawn({}, D, codexReq))).toBe(true) // and B the Codex one
  })

  it('a same-id spawn that starts is the new record: the session now counts for the config it runs', async () => {
    disk(savedClaude(), savedSsh())
    await spawn({}, A, claudeReq)
    expect(isRefused(await spawn({}, A, sshReq))).toBe(false)
    expect(isRefused(await spawn({}, B, claudeReq))).toBe(false) // A left the Claude config
    expect(isRefused(await spawn({}, C, sshReq))).toBe(true)
  })
})

describe('M5: the log carries a config id made safe', () => {
  it('a refused spawn logs the id without escape sequences, bidi controls or line breaks, and cut', async () => {
    const id = 'cfg' + String.fromCharCode(27) + '[2J' + String.fromCharCode(0x202e) + String.fromCharCode(0x2028) + '[ERROR] forged' + 'z'.repeat(5000)
    disk(savedClaude({ id }))
    const req = { cwd: 'C:/w', configId: id }
    await spawn({}, A, req)
    await spawn({}, B, req)
    const line = logs.find((l) => /refused/.test(l))!
    expect(line).toBeTruthy()
    expect(line).not.toMatch(new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e) + ']'))
    expect(line.length).toBeLessThan(300)
  })
})
