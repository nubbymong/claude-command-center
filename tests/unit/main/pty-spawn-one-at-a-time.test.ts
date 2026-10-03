/**
 * P3.13 (row 72; the C item "the one-at-a-time Multi Spawn rule is enforced
 * only in the renderer"): main enforces the rule at pty:spawn, the one path
 * every launch takes (a new launch, a restored session, a Restart, Multi
 * Spawn's copies, Quick Start). A saved config that is not Multi Spawn runs ONE
 * copy at a time; the second copy is refused before anything is prepared,
 * leased or spawned, with the typed refusal the tab already knows how to say.
 *
 * Driven through the REAL pty:spawn handler on a fake ipcMain, with the REAL
 * rule (src/main/launch-one-at-a-time.ts) over the saved configs as main reads
 * them from disk; only pty-manager is faked (a Set of session ids with a PTY,
 * and one of spawns it is still preparing), so nothing spawns. The same
 * rule, on the real pty-manager and a real lease registry, is
 * codex-multi-spawn-leases.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
  app: { getVersion: () => '0.0.0-test' },
}))
// What pty-manager would answer: ids with a PTY, and ids whose spawn main is
// still preparing (a registered preparation).
const live = new Set<string>()
const pending = new Set<string>()
const spawnPty = vi.fn((_win: unknown, sid: string, _o: unknown) => { live.add(sid) })
const beginSpawnPreparation = vi.fn((win: unknown, sid: string) => {
  pending.add(sid)
  // A close or a sweep (killPty) cancels it, as pty-manager's does.
  return { get current() { return pending.has(sid) }, spawn: (o: unknown) => { pending.delete(sid); spawnPty(win, sid, o) }, abandon: () => { pending.delete(sid) } }
})
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: (w: unknown, s: string, o: unknown) => spawnPty(w, s, o),
  writePty: vi.fn(), resizePty: vi.fn(),
  killPty: (id: string) => { live.delete(id); pending.delete(id) },
  getSshFlow: () => undefined, endSshRemote: vi.fn(),
  beginSpawnPreparation: (w: unknown, s: string) => beginSpawnPreparation(w, s),
  holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionWritable: (id: string) => live.has(id),
  isSessionLiveOrStarting: (id: string) => live.has(id) || pending.has(id),
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  codexRunEnded: async () => true,
  // ADR-009 round 1: no run is working in the help folder.
  endAgentRunsInFolder: async () => true,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
const logWarn = vi.fn()
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: (m: string) => logWarn(m), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
// WP2 PR 4, P4.3: every Ask spawn rebuilds the help folder in main first (and
// fails closed); here it stands in, so no real folder is written.
vi.mock('../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: vi.fn(() => '/res/help') }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({ readConfig: (key: string) => (key === 'configs' ? configsOnDisk : null) }))
const loadCredential = vi.fn((_k: string) => 'pw')
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => loadCredential(k) }))
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => null,
}))

const acct = vi.hoisted(() => ({ state: { claude: 'on', codex: 'on' } as Record<string, 'on' | 'off'>, prepareLaunch: null as unknown }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => {
      const name = id === 'claude' ? 'Claude Code' : 'Codex'
      return acct.state[id] === 'off' ? { code: 'provider-off', providerId: id, message: `${name} is off. Turn it on in Settings, Accounts.` } : null
    },
    remoteLaunchRefusal: () => null,
    prepareLaunch: acct.prepareLaunch,
  }),
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { spawnRefusalOf, refusedTabText } = await import('../../../src/shared/providers')
const { _resetConfigLaunchClaimsForTest } = await import('../../../src/main/launch-one-at-a-time')
const { alreadyRunningRefusalMessage } = await import('../../../src/shared/multi-spawn-rule')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const kill = handlers.get('pty:kill')!

const A = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const B = 'b1b2c3d4e5f6a1b2c3d4e5f6'
const C = 'c1b2c3d4e5f6a1b2c3d4e5f6'
const SSH = { host: 'build-box', port: 22, username: 'nick', remotePath: '~/proj' }
const lease = { release: vi.fn() }
const codex = { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' } }

const savedCodex = (over: Record<string, unknown> = {}) => ({ id: 'cfgcodex', label: 'Codex Dev', provider: 'codex', sessionType: 'local', workingDirectory: 'C:/w', ...over })
const savedClaude = (over: Record<string, unknown> = {}) => ({ id: 'cfgclaude', label: 'App Dev', provider: 'claude', sessionType: 'local', workingDirectory: 'C:/w', ...over })
const savedShell = (over: Record<string, unknown> = {}) => ({ id: 'cfgshell', label: 'Plain', provider: 'claude', shellOnly: true, sessionType: 'local', workingDirectory: 'C:/w', ...over })
const savedSsh = (over: Record<string, unknown> = {}) => ({ id: 'cfgssh', label: 'Build Box', provider: 'claude', sessionType: 'ssh', sshConfig: { ...SSH }, ...over })
const disk = (...c: unknown[]) => { configsOnDisk = c }

const REFUSED = (label: string, providerId: string) => ({ started: false, refused: { code: 'already-running', providerId, message: alreadyRunningRefusalMessage(label) } })

beforeEach(() => {
  live.clear(); pending.clear()
  spawnPty.mockClear(); beginSpawnPreparation.mockClear(); loadCredential.mockClear(); logWarn.mockClear(); lease.release.mockClear()
  acct.state = { claude: 'on', codex: 'on' }
  _resetConfigLaunchClaimsForTest()
  let n = 0
  acct.prepareLaunch = vi.fn(async () => { n++; return { ok: true, lease, binding: {}, realmOnly: false, home: 'C:/res/r1', executable: 'C:/proven/codex.exe', env: {}, sessionsDir: `C:/res/r1/sessions${n}` } })
  configsOnDisk = null
})

type Shape = { name: string; saved: (o?: Record<string, unknown>) => Record<string, unknown>; options: Record<string, unknown>; provider: string }
const shapes: Shape[] = [
  { name: 'a Codex config', saved: savedCodex, options: { ...codex, configId: 'cfgcodex' }, provider: 'codex' },
  { name: 'a Claude config', saved: savedClaude, options: { cwd: 'C:/w', configId: 'cfgclaude' }, provider: 'claude' },
  { name: 'a terminal-only config', saved: savedShell, options: { cwd: 'C:/w', shellOnly: true, configId: 'cfgshell' }, provider: 'claude' },
  { name: 'an SSH config', saved: savedSsh, options: { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH } }, provider: 'claude' },
]

describe('a config that is not Multi Spawn runs one copy at a time, in main', () => {
  for (const shape of shapes) {
    for (const flag of [undefined, false] as const) {
      const stored = flag === undefined ? 'never chosen' : 'declined'
      it(`${shape.name} (${stored}): the second copy is refused before anything starts`, async () => {
        disk(shape.saved(flag === undefined ? {} : { allowMultiSpawn: flag }))
        await spawn({}, A, shape.options)
        expect(live.has(A)).toBe(true)
        spawnPty.mockClear(); beginSpawnPreparation.mockClear(); loadCredential.mockClear()
        const prepares = (acct.prepareLaunch as ReturnType<typeof vi.fn>).mock.calls.length
        const r = await spawn({}, B, shape.options)
        expect(r).toEqual(REFUSED(String(shape.saved().label), shape.provider))
        expect(spawnPty).not.toHaveBeenCalled()
        expect(beginSpawnPreparation).not.toHaveBeenCalled()
        expect(loadCredential).not.toHaveBeenCalled()
        // No account is prepared or leased for a copy that does not start.
        expect((acct.prepareLaunch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(prepares)
        expect(live.has(B)).toBe(false)
      })
    }

    it(`${shape.name}: a Multi Spawn config runs several at once`, async () => {
      disk(shape.saved({ allowMultiSpawn: true }))
      for (const id of [A, B, C]) expect(await spawn({}, id, shape.options)).not.toMatchObject({ refused: expect.anything() })
      expect([...live].sort()).toEqual([A, B, C])
    })

    it(`${shape.name}: once the other copy has gone, another may start (a kill, then a natural exit)`, async () => {
      disk(shape.saved())
      await spawn({}, A, shape.options)
      expect(await spawn({}, B, shape.options)).toMatchObject({ started: false })
      kill({}, A)
      expect(await spawn({}, B, shape.options)).not.toMatchObject({ refused: expect.anything() })
      expect(live.has(B)).toBe(true)
      live.delete(B) // its process ended by itself
      expect(await spawn({}, C, shape.options)).not.toMatchObject({ refused: expect.anything() })
      expect(live.has(C)).toBe(true)
    })

    it(`${shape.name}: a Restart (the same session id) is not a second copy`, async () => {
      disk(shape.saved())
      await spawn({}, A, shape.options)
      spawnPty.mockClear()
      expect(await spawn({}, A, shape.options)).not.toMatchObject({ refused: expect.anything() })
      expect(spawnPty).toHaveBeenCalledTimes(1)
    })
  }

  it('the refusal is the one the tab already says, in the words the sidebar uses', async () => {
    disk(savedCodex())
    await spawn({}, A, { ...codex, configId: 'cfgcodex' })
    const r = await spawn({}, B, { ...codex, configId: 'cfgcodex' })
    const refusal = spawnRefusalOf(r)
    expect(refusal).toEqual({ code: 'already-running', providerId: 'codex', message: expect.stringContaining('Codex Dev is already running.') })
    expect(refusal!.message).toContain("It isn't a Multi Spawn config, so it runs one at a time.")
    // The tab: "Not started." then the reason, then what to do.
    expect(refusedTabText(refusal!)).toMatch(/^Not started\. Codex Dev is already running\..+, then Restart this tab\.$/)
  })

  it('the rule reads the SAVED flag from disk: a request that claims Multi Spawn gets nothing from it', async () => {
    disk(savedCodex())
    await spawn({}, A, { ...codex, configId: 'cfgcodex', allowMultiSpawn: true })
    const r = await spawn({}, B, { ...codex, configId: 'cfgcodex', allowMultiSpawn: true })
    expect(r).toMatchObject({ started: false, refused: { code: 'already-running' } })
  })

  it('another config is not affected: copies of one config never count toward another', async () => {
    disk(savedCodex(), savedClaude())
    await spawn({}, A, { ...codex, configId: 'cfgcodex' })
    expect(await spawn({}, B, { cwd: 'C:/w', configId: 'cfgclaude' })).not.toMatchObject({ refused: expect.anything() })
    expect(live.has(B)).toBe(true)
  })

  it('a refusal is logged without the config name', async () => {
    disk(savedCodex({ label: 'My Secret Project' }))
    await spawn({}, A, { ...codex, configId: 'cfgcodex' })
    await spawn({}, B, { ...codex, configId: 'cfgcodex' })
    const said = logWarn.mock.calls.map((c) => String(c[0])).filter((m) => /already running|one at a time/i.test(m))
    expect(said.length).toBe(1)
    expect(said[0]).not.toContain('My Secret Project')
  })
})

describe('what is not a copy of the config', () => {
  it('the partner terminal of a config (a plain shell named for the session, on the same config id) never counts and is never refused', async () => {
    disk(savedCodex())
    await spawn({}, A, { ...codex, configId: 'cfgcodex' })
    // The renderer's partner pane: shellOnly, `<session id>-partner`, same configId.
    expect(await spawn({}, `${A}-partner`, { cwd: 'C:/w', shellOnly: true, configId: 'cfgcodex' })).not.toMatchObject({ refused: expect.anything() })
    expect(live.has(`${A}-partner`)).toBe(true)
    // ...and with the session gone and only the shell left, the config is not running.
    kill({}, A)
    expect(await spawn({}, B, { ...codex, configId: 'cfgcodex' })).not.toMatchObject({ refused: expect.anything() })
  })

  it('the partner terminal of a terminal-only config is a shell too, not a second copy', async () => {
    disk(savedShell())
    await spawn({}, A, { cwd: 'C:/w', shellOnly: true, configId: 'cfgshell' })
    expect(await spawn({}, `${A}-partner`, { cwd: 'C:/w', shellOnly: true, configId: 'cfgshell' })).not.toMatchObject({ refused: expect.anything() })
    // A second terminal-only copy still is refused.
    expect(await spawn({}, B, { cwd: 'C:/w', shellOnly: true, configId: 'cfgshell' })).toMatchObject({ started: false, refused: { code: 'already-running' } })
  })

  it('a session that runs an agent cannot pass as a partner terminal by its name', async () => {
    disk(savedCodex())
    await spawn({}, A, { ...codex, configId: 'cfgcodex' })
    expect(await spawn({}, `${B}-partner`, { ...codex, configId: 'cfgcodex' })).toMatchObject({ started: false, refused: { code: 'already-running' } })
  })

  it('Ask Conductor and a spawn that names no config are not copies of anything', async () => {
    disk(savedClaude())
    await spawn({}, A, { cwd: 'C:/w', configId: 'cfgclaude' })
    // Ask Conductor's session names no config; the renderer never sends one with it.
    expect(await spawn({}, B, { cwd: 'C:/help', isAsk: true })).not.toMatchObject({ refused: expect.anything() })
    expect(await spawn({}, C, { cwd: 'C:/w' })).not.toMatchObject({ refused: expect.anything() })
    // ...and none of them makes the config count: with A gone, a launch is free.
    kill({}, A)
    expect(await spawn({}, 'd1b2c3d4e5f6a1b2c3d4e5f6', { cwd: 'C:/w', configId: 'cfgclaude' })).not.toMatchObject({ refused: expect.anything() })
  })

  it('a reconnect flag is not a right: an SSH copy that says it is a reattach is a new copy unless main already holds that session (rights: pty-spawn-one-at-a-time-rights.test.ts)', async () => {
    disk(savedSsh())
    await spawn({}, A, { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH } })
    expect(await spawn({}, B, { cwd: 'C:/w', configId: 'cfgssh', ssh: { ...SSH, reconnect: true } })).toMatchObject({ started: false, refused: { code: 'already-running' } })
    expect(live.has(B)).toBe(false)
  })

  it('a config main cannot find (deleted, never saved, a file it cannot read) has no rule to apply', async () => {
    for (const on of [null, {}, 'junk', [], [savedClaude({ id: 'other' })]] as unknown[]) {
      live.clear()
      _resetConfigLaunchClaimsForTest()
      configsOnDisk = on
      await spawn({}, A, { cwd: 'C:/w', configId: 'cfgclaude' })
      expect(await spawn({}, B, { cwd: 'C:/w', configId: 'cfgclaude' }), JSON.stringify(on)).not.toMatchObject({ refused: expect.anything() })
    }
  })
})

describe('the rule holds while a launch is still being prepared', () => {
  it('a copy asked for while the first is preparing its account is refused: nothing slips between the check and the start', async () => {
    disk(savedCodex())
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    acct.prepareLaunch = vi.fn(async () => { await gate; return { ok: true, lease, binding: {}, realmOnly: false, home: 'h', executable: 'C:/proven/codex.exe', env: {}, sessionsDir: 'C:/res/s' } })
    const first = spawn({}, A, { ...codex, configId: 'cfgcodex' })
    // Asked while the first is still mid-flight: answered at once, not after it.
    const second = spawn({}, B, { ...codex, configId: 'cfgcodex' })
    const answered = await Promise.race([second, new Promise((r) => setTimeout(() => r('still preparing'), 100))])
    expect(answered).toMatchObject({ started: false, refused: { code: 'already-running' } })
    expect(acct.prepareLaunch).toHaveBeenCalledTimes(1)
    release()
    await first
    await second
    expect(live.has(A)).toBe(true)
    expect(live.has(B)).toBe(false)
  })

  it('two copies asked for in the same tick: exactly one starts', async () => {
    disk(savedClaude())
    const results = await Promise.all([spawn({}, A, { cwd: 'C:/w', configId: 'cfgclaude' }), spawn({}, B, { cwd: 'C:/w', configId: 'cfgclaude' })])
    expect(results.filter((r) => (r as { started?: boolean } | undefined)?.started === false)).toHaveLength(1)
    expect(live.size).toBe(1)
  })

  it('a launch that fails to prepare leaves nothing behind: the next copy starts', async () => {
    disk(savedCodex())
    acct.prepareLaunch = vi.fn(async () => ({ ok: false, code: 'not-found', message: 'no account' }))
    await expect(spawn({}, A, { ...codex, configId: 'cfgcodex' })).rejects.toThrow(/refused/)
    acct.prepareLaunch = vi.fn(async () => ({ ok: true, lease, binding: {}, realmOnly: false, home: 'h', executable: 'C:/proven/codex.exe', env: {}, sessionsDir: 'C:/res/s' }))
    expect(await spawn({}, B, { ...codex, configId: 'cfgcodex' })).not.toMatchObject({ refused: expect.anything() })
    expect(live.has(B)).toBe(true)
  })

  it('a preparation that was closed or superseded leaves nothing behind', async () => {
    disk(savedCodex())
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    acct.prepareLaunch = vi.fn(async () => { await gate; return { ok: true, lease, binding: {}, realmOnly: false, home: 'h', executable: 'C:/proven/codex.exe', env: {}, sessionsDir: 'C:/res/s' } })
    const first = spawn({}, A, { ...codex, configId: 'cfgcodex' })
    kill({}, A) // the tab was closed while its account was being prepared
    release()
    await first
    expect(live.has(A)).toBe(false)
  })

  it('a refused copy holds nothing: it may start once the first has ended', async () => {
    disk(savedClaude())
    await spawn({}, A, { cwd: 'C:/w', configId: 'cfgclaude' })
    expect(await spawn({}, B, { cwd: 'C:/w', configId: 'cfgclaude' })).toMatchObject({ started: false })
    kill({}, A)
    expect(await spawn({}, B, { cwd: 'C:/w', configId: 'cfgclaude' })).not.toMatchObject({ refused: expect.anything() })
  })
})

describe('order: the provider rule comes first, and the rule is not a way round it', () => {
  it('a Codex copy while Codex is off says Codex is off, not that the config is running', async () => {
    disk(savedCodex())
    await spawn({}, A, { ...codex, configId: 'cfgcodex' })
    acct.state = { claude: 'on', codex: 'off' }
    expect(await spawn({}, B, { ...codex, configId: 'cfgcodex' })).toMatchObject({ started: false, refused: { code: 'provider-off', providerId: 'codex' } })
  })

  it('a copy refused for being a second copy is never leased, whatever the account', async () => {
    disk(savedCodex({ allowMultiSpawn: false }))
    await spawn({}, A, { ...codex, configId: 'cfgcodex', providerAccountId: 'acct1' })
    const calls = (acct.prepareLaunch as ReturnType<typeof vi.fn>).mock.calls.length
    await spawn({}, B, { ...codex, configId: 'cfgcodex', providerAccountId: 'acct2' })
    expect((acct.prepareLaunch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })
})

describe('N copies of a Multi Spawn Codex config: one launch, one lease owner each', () => {
  it('each copy is prepared on its own, for its own session, with an owner id no other copy shares', async () => {
    disk(savedCodex({ allowMultiSpawn: true }))
    const ids = [A, B, C]
    for (const id of ids) await spawn({}, id, { ...codex, configId: 'cfgcodex' })
    const asked = (acct.prepareLaunch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { kind: string; providerId: string; ownerId: string; sessionId: string })
    expect(asked).toHaveLength(3)
    expect(asked.every((a) => a.kind === 'session' && a.providerId === 'codex')).toBe(true)
    expect(asked.map((a) => a.sessionId)).toEqual(ids)
    expect(new Set(asked.map((a) => a.ownerId)).size).toBe(3)
    expect(spawnPty).toHaveBeenCalledTimes(3)
  })
})
