/**
 * [host] WP2 PR 4, P4.5 (row 57): a Codex cloud agent, in the cloud-agent
 * manager. The same contract as a Claude Code agent -- refused while its
 * provider is off (before a record, an account or a process), counted as
 * that provider in use from the dispatch on, the record kept with the
 * output, Stop and Retry -- run through the Codex package's background port
 * in a launch the accounts service prepared (kind `background`): the account
 * named or the provider default, an acknowledgement only with the account it
 * names, the lease held until the run and any kill still under way have
 * ended and released on every path, the launch rule asked once more right
 * before the process starts. A Codex agent never counts as Claude Code in use.
 *
 * The REAL manager and the REAL launch gate; the accounts service and the
 * package's background run are scripted, and child_process is faked, so
 * nothing runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockSpawn = vi.fn()
vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => mockSpawn(...a), execSync: vi.fn(), spawnSync: vi.fn() }))
const saved = vi.hoisted(() => ({ agents: null as unknown }))
const writeConfig = vi.fn((_k: string, _v: unknown) => true)
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'cloudAgents' ? saved.agents : null),
  readConfigChecked: (key: string) => (key === 'cloudAgents' && saved.agents != null ? { value: saved.agents, outcome: 'ok' } : { value: null, outcome: 'absent' }),
  writeConfig: (k: string, v: unknown) => writeConfig(k, v),
  getConfigDir: () => '/unused/CONFIG',
  ensureConfigDir: vi.fn(),
}))
vi.mock('../../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: vi.fn(() => null), isVersionInstalled: vi.fn(() => false),
  installVersion: vi.fn(async () => ({ ok: false, error: 'not in this test' })), legacyCliPin: vi.fn(() => undefined),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  getProfileConfigDir: (id: string) => `/nonexistent/profiles/${id}`,
  setupProfileLinks: vi.fn(),
  listProfiles: () => [],
}))
vi.mock('../../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env }))
vi.mock('../../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => () => {}, waitForProfileRefresh: async () => {} }))
const gateManagedLaunch = vi.fn(async () => null)
vi.mock('../../../src/main/managed-launch-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/managed-launch-diagnostics')>()),
  gateManagedLaunch: (...a: unknown[]) => gateManagedLaunch(...(a as [])),
}))

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
const deferred = <T>(): Deferred<T> => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

const ACCT = 'acct-' + 'a'.repeat(32)
const OTHER = 'acct-' + 'b'.repeat(32)
const OFF = { code: 'provider-off', providerId: 'codex', message: 'Codex is off. Turn it on in Settings, Accounts.' }

const s = vi.hoisted(() => ({
  codex: 'on' as 'on' | 'off',
  /** Flipped to off by the first launchRefusal('codex') after prepare. */
  offAfterPrepare: false,
  prepared: 0,
  prepareInputs: [] as Array<Record<string, unknown>>,
  prepareResult: null as null | Record<string, unknown>,
  prepareGate: null as null | Promise<void>,
  released: [] as string[],
  /** Leases handed out and not yet released (what the accounts service counts in use). */
  held: 0,
  runs: [] as Array<{ input: Record<string, unknown>; finish: (r: unknown) => void }>,
  noPort: false,
}))
const lease = (ownerId: string) => ({ id: 1, accountId: ACCT, providerId: 'codex', kind: 'background', ownerId, released: false, release: vi.fn(() => { s.released.push(ownerId); s.held-- }) })
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => (id === 'codex' && s.codex === 'off' ? OFF : null),
    snapshot: () => ({ accounts: [{ id: ACCT, providerLabel: 'dev@example.com' }, { id: OTHER, providerLabel: 'Work key' }], identities: [] }),
    prepareLaunch: async (input: Record<string, unknown>) => {
      s.prepared++
      s.prepareInputs.push(input)
      if (s.prepareGate) await s.prepareGate
      if (s.offAfterPrepare) s.codex = 'off'
      if (s.prepareResult) return s.prepareResult
      const accountId = (input.providerAccountId as string | undefined) ?? ACCT
      s.held++
      return {
        ok: true, lease: { ...lease(input.ownerId as string), accountId }, binding: { providerAccountId: accountId, authRealmId: 'realm-1' }, realmOnly: false,
        home: 'C:\\res\\codex-realms\\realm-1', executable: 'C:\\Tools\\codex.exe', env: { CODEX_HOME: 'C:\\res\\codex-realms\\realm-1' }, sessionsDir: 'x',
      }
    },
  }),
}))
vi.mock('../../../src/main/providers/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/providers/core')>()),
  tryGetProviderPackage: (id: string) => (id === 'codex' && !s.noPort ? {
    background: {
      run: (input: Record<string, unknown>) => new Promise((resolve) => { s.runs.push({ input, finish: resolve }) }),
    },
  } : null),
}))

const {
  initCloudAgentManager, dispatchAgent, retryAgent, cancelAgent, removeAgent, listAgents, countClaudeAgentsInUse, countCodexAgentsInUse,
  stopBackgroundAgentRuns, killAllAgents, _resetCloudAgentLatchForTest,
} = await import('../../../src/main/cloud-agent-manager')

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
// A full project path is the running platform's own (the manager's
// isFullProjectPath): a drive or UNC path on Windows, a rooted path on macOS
// and Linux. The other platform's form is not a full path here.
const PROJECT = process.platform === 'win32' ? 'C:\\dev\\project' : '/home/dev/project'
const FOREIGN_PROJECT = process.platform === 'win32' ? '/home/dev/project' : 'C:\\dev\\project'
const PARAMS = { name: 'Tidy', description: 'Tidy the imports', projectPath: PROJECT, provider: 'codex' as const }
const agentOf = (id: string) => listAgents().find((a) => a.id === id)!

beforeEach(() => {
  mockSpawn.mockReset()
  writeConfig.mockClear()
  gateManagedLaunch.mockClear()
  Object.assign(s, { codex: 'on', offAfterPrepare: false, prepared: 0, prepareInputs: [], prepareResult: null, prepareGate: null, released: [], held: 0, runs: [], noPort: false })
  saved.agents = []
  _resetCloudAgentLatchForTest()
  initCloudAgentManager(() => null)
})

describe('a Codex agent while Codex is off', () => {
  it('is refused with the typed refusal: no record, no account prepared, nothing run', async () => {
    s.codex = 'off'
    await expect(dispatchAgent(PARAMS)).resolves.toEqual({ refused: OFF })
    expect(s.prepared).toBe(0)
    expect(s.runs).toHaveLength(0)
    expect(listAgents()).toHaveLength(0)
    expect(writeConfig).not.toHaveBeenCalled()
    expect(countCodexAgentsInUse()).toBe(0)
  })

  it('switched off while its launch was prepared: failed with the reason, the lease released, nothing run', async () => {
    s.offAfterPrepare = true
    const a = await dispatchAgent(PARAMS)
    if (!('id' in a)) throw new Error('refused')
    expect(agentOf(a.id)).toMatchObject({ status: 'failed', error: OFF.message })
    expect(s.runs).toHaveLength(0)
    expect(s.released).toEqual([`cloud-agent:${a.id}`])
  })
})

describe('a Codex agent', () => {
  it('runs through the package with a background launch of its own; never the Claude path', async () => {
    const a = await dispatchAgent({ ...PARAMS, providerAccountId: OTHER, acknowledgeRealmOnly: true, skipPermissions: true, codexOptions: { model: 'gpt-5.5', reasoningEffort: 'high' } })
    if (!('id' in a)) throw new Error('refused')
    expect(s.prepareInputs).toEqual([{ kind: 'background', providerId: 'codex', ownerId: `cloud-agent:${a.id}`, remote: false, providerAccountId: OTHER, acknowledgeRealmOnly: true }])
    await tick()
    expect(s.runs).toHaveLength(1)
    expect(s.runs[0].input).toMatchObject({
      executable: 'C:\\Tools\\codex.exe', env: { CODEX_HOME: 'C:\\res\\codex-realms\\realm-1' }, cwd: PROJECT, prompt: 'Tidy the imports',
      skipPermissions: true, model: 'gpt-5.5', effort: 'high',
    })
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(gateManagedLaunch).not.toHaveBeenCalled()
    expect(agentOf(a.id)).toMatchObject({ provider: 'codex', providerAccountId: OTHER, status: 'running', codexOptions: { model: 'gpt-5.5', reasoningEffort: 'high' } })
    // The run's own account label is not an email: none recorded.
    expect(agentOf(a.id).accountEmail).toBeUndefined()
    s.runs[0].finish({ ok: true })
    await tick()
  })

  it('no account named: the provider default; an acknowledgement without the account it names is dropped', async () => {
    const a = await dispatchAgent({ ...PARAMS, acknowledgeRealmOnly: true })
    if (!('id' in a)) throw new Error('refused')
    expect(s.prepareInputs[0]).toEqual({ kind: 'background', providerId: 'codex', ownerId: `cloud-agent:${a.id}`, remote: false })
    expect(agentOf(a.id)).toMatchObject({ providerAccountId: ACCT, accountEmail: 'dev@example.com' })
    expect(s.runs[0].input.skipPermissions).toBe(false)
    expect(s.runs[0].input).not.toHaveProperty('model')
    expect(s.runs[0].input).not.toHaveProperty('effort')
    s.runs[0].finish({ ok: true })
    await tick()
  })

  it('streams each reply and the diagnostics into the kept output, then completes with its tokens and cost; the lease goes at the end', async () => {
    const chunks: string[] = []
    initCloudAgentManager(() => ({ isDestroyed: () => false, webContents: { send: (ch: string, d: { chunk?: string }) => { if (ch === 'cloudAgent:outputChunk') chunks.push(d.chunk!) } } }) as never)
    const a = await dispatchAgent(PARAMS)
    if (!('id' in a)) throw new Error('refused')
    await tick()
    const run = s.runs[0].input as { onText: (t: string) => void; onDiagnostic: (t: string) => void }
    run.onText('first')
    run.onDiagnostic('patch rejected: writing is blocked\n')
    run.onText('second')
    expect(agentOf(a.id).output).toBe('first\n\npatch rejected: writing is blocked\n\nsecond')
    expect(chunks.join('')).toBe(agentOf(a.id).output)
    expect(s.released).toEqual([])
    // In use once, through its lease.
    expect([s.held, countCodexAgentsInUse()]).toEqual([1, 0])
    s.runs[0].finish({ ok: true, usage: { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 34 }, costUsd: 0.0021 })
    await tick()
    expect(agentOf(a.id)).toMatchObject({ status: 'completed', tokenUsage: { inputTokens: 1200, outputTokens: 34 }, cost: 0.0021 })
    expect(agentOf(a.id).error).toBeUndefined()
    expect(s.released).toEqual([`cloud-agent:${a.id}`])
    expect(countCodexAgentsInUse()).toBe(0)
  })

  it('a failed run keeps its message; a run that throws fails the record; both let the account go', async () => {
    const a = await dispatchAgent(PARAMS)
    if (!('id' in a)) throw new Error('refused')
    await tick()
    s.runs[0].finish({ ok: false, code: 'failed', message: 'Codex exited with code 1: quota.' })
    await tick()
    expect(agentOf(a.id)).toMatchObject({ status: 'failed', error: 'Codex exited with code 1: quota.' })
    expect(s.released).toHaveLength(1)
  })

  it('Stop aborts the run; the account goes only once the kill still under way has ended', async () => {
    const a = await dispatchAgent(PARAMS)
    if (!('id' in a)) throw new Error('refused')
    await tick()
    const signal = s.runs[0].input.signal as AbortSignal
    expect(cancelAgent(a.id)).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(agentOf(a.id).status).toBe('cancelled')
    const kill = deferred<void>()
    s.runs[0].finish({ ok: false, code: 'cancelled', message: 'The agent was stopped.', killSettled: kill.promise })
    await tick()
    expect(agentOf(a.id).status).toBe('cancelled')
    expect(agentOf(a.id).error).toBeUndefined()
    expect(s.released).toEqual([])
    kill.resolve()
    await tick()
    expect(s.released).toEqual([`cloud-agent:${a.id}`])
  })

  it('cancelled while its launch is prepared: nothing runs and the lease is released', async () => {
    const gate = deferred<void>()
    s.prepareGate = gate.promise
    const pending = dispatchAgent(PARAMS)
    await tick()
    const id = listAgents()[0].id
    expect(countCodexAgentsInUse()).toBe(1)
    expect(cancelAgent(id)).toBe(true)
    gate.resolve()
    await pending
    expect(s.runs).toHaveLength(0)
    expect(s.released).toEqual([`cloud-agent:${id}`])
    expect(agentOf(id).status).toBe('cancelled')
    expect(countCodexAgentsInUse()).toBe(0)
  })

  it('removed while its launch is prepared: nothing runs and the lease is released', async () => {
    const gate = deferred<void>()
    s.prepareGate = gate.promise
    const pending = dispatchAgent(PARAMS)
    await tick()
    const id = listAgents()[0].id
    expect(removeAgent(id)).toMatchObject({ ok: true, removed: true })
    gate.resolve()
    await pending
    expect(s.runs).toHaveLength(0)
    expect(s.released).toEqual([`cloud-agent:${id}`])
  })

  it('a launch the accounts service refuses: failed with its message, nothing run, no lease to release', async () => {
    s.prepareResult = { ok: false, code: 'acknowledgement-required', message: 'This sign-in is unverified: confirm that this launch may use it.' }
    const a = await dispatchAgent(PARAMS)
    if (!('id' in a)) throw new Error('refused')
    expect(agentOf(a.id)).toMatchObject({ status: 'failed', error: 'This agent could not start: This sign-in is unverified: confirm that this launch may use it.' })
    expect(s.runs).toHaveLength(0)
    expect(countCodexAgentsInUse()).toBe(0)
  })

  it('a package without a background run: failed with the reason, before any account is prepared', async () => {
    s.noPort = true
    const a = await dispatchAgent(PARAMS)
    if (!('id' in a)) throw new Error('refused')
    expect(agentOf(a.id)).toMatchObject({ status: 'failed', error: 'This agent could not start: this assistant does not run cloud agents in this version of the app.' })
    expect(s.prepared).toBe(0)
    expect(countCodexAgentsInUse()).toBe(0)
  })

  it('a project that is not a full path is failed before any account is prepared', async () => {
    for (const projectPath of ['project', '.\\project', '\\project', FOREIGN_PROJECT]) {
      const a = await dispatchAgent({ ...PARAMS, projectPath })
      if (!('id' in a)) throw new Error('refused')
      expect(agentOf(a.id)).toMatchObject({ status: 'failed', error: 'The project folder must be a full path.' })
    }
    expect(s.prepared).toBe(0)
  })

  it('counts as Codex in use, never as Claude Code', async () => {
    const a = await dispatchAgent(PARAMS)
    if (!('id' in a)) throw new Error('refused')
    await tick()
    expect(s.held + countCodexAgentsInUse()).toBe(1)
    expect(countClaudeAgentsInUse()).toBe(0)
    s.runs[0].finish({ ok: true })
    await tick()
    expect(s.held + countCodexAgentsInUse()).toBe(0)
  })

  // [host] PR 4 review C-4: a running agent counted here AND through its
  // lease, so a switch-off read "Codex is in use (2)" for one agent.
  it('one agent counts once as Codex in use: here while its launch is prepared (no lease yet), through its lease from then on, until a kill still under way has ended', async () => {
    const gate = deferred<void>()
    s.prepareGate = gate.promise
    const pending = dispatchAgent(PARAMS)
    await tick()
    expect([s.held, countCodexAgentsInUse()]).toEqual([0, 1])
    gate.resolve()
    const a = await pending
    if (!('id' in a)) throw new Error('refused')
    await tick()
    expect([s.held, countCodexAgentsInUse()]).toEqual([1, 0])
    expect(cancelAgent(a.id)).toBe(true)
    const kill = deferred<void>()
    s.runs[0].finish({ ok: false, code: 'cancelled', message: 'The agent was stopped.', killSettled: kill.promise })
    await tick()
    expect([s.held, countCodexAgentsInUse()]).toEqual([1, 0])
    kill.resolve()
    await tick()
    expect([s.held, countCodexAgentsInUse()]).toEqual([0, 0])
  })

  // [host] PR 4 review C-2: a Stop in the run's settle window, after codex
  // had exited on its own, left the finished run recorded as cancelled.
  it('a Stop after the run had finished on its own: the run\'s own result stands (completed, or failed with its reason), not cancelled', async () => {
    const a = await dispatchAgent(PARAMS)
    if (!('id' in a)) throw new Error('refused')
    await tick()
    expect(cancelAgent(a.id)).toBe(true)
    expect(agentOf(a.id).status).toBe('cancelled')
    s.runs[0].finish({ ok: true, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 } })
    await tick()
    expect(agentOf(a.id)).toMatchObject({ status: 'completed', tokenUsage: { inputTokens: 10, outputTokens: 2 } })
    expect(agentOf(a.id).error).toBeUndefined()
    expect(s.released).toEqual([`cloud-agent:${a.id}`])
    const b = await dispatchAgent(PARAMS)
    if (!('id' in b)) throw new Error('refused')
    await tick()
    expect(cancelAgent(b.id)).toBe(true)
    s.runs[1].finish({ ok: false, code: 'failed', message: 'Codex exited with code 1: quota.' })
    await tick()
    expect(agentOf(b.id)).toMatchObject({ status: 'failed', error: 'Codex exited with code 1: quota.' })
  })

  it('Retry: the same task on the same account and options, the permission choice not kept, the acknowledgement only when asked', async () => {
    const a = await dispatchAgent({ ...PARAMS, providerAccountId: OTHER, skipPermissions: true, codexOptions: { model: 'gpt-5.5' } })
    if (!('id' in a)) throw new Error('refused')
    await tick()
    s.runs[0].finish({ ok: true })
    await tick()
    const b = await retryAgent(a.id)
    if (!b || !('id' in b)) throw new Error('refused')
    expect(s.prepareInputs[1]).toEqual({ kind: 'background', providerId: 'codex', ownerId: `cloud-agent:${b.id}`, remote: false, providerAccountId: OTHER })
    await tick()
    expect(s.runs[1].input).toMatchObject({ skipPermissions: false, model: 'gpt-5.5' })
    s.runs[1].finish({ ok: true })
    const c = await retryAgent(a.id, { acknowledgeRealmOnly: true })
    if (!c || !('id' in c)) throw new Error('refused')
    expect(s.prepareInputs[2]).toMatchObject({ providerAccountId: OTHER, acknowledgeRealmOnly: true })
    await tick()
    s.runs[2].finish({ ok: true })
    await tick()
  })

  it('Retry while Codex is off: refused, the earlier agent kept as it was', async () => {
    saved.agents = [{ id: 'ca-old', name: 'Old', description: 'd', status: 'failed', createdAt: 1, updatedAt: 1, projectPath: 'C:\\p', provider: 'codex', providerAccountId: ACCT, output: '' }]
    initCloudAgentManager(() => null)
    s.codex = 'off'
    await expect(retryAgent('ca-old')).resolves.toEqual({ refused: OFF })
    expect(listAgents()).toHaveLength(1)
    expect(s.prepared).toBe(0)
  })

  it('stopBackgroundAgentRuns and killAllAgents abort every running Codex agent', async () => {
    const a = await dispatchAgent(PARAMS)
    const b = await dispatchAgent(PARAMS)
    if (!('id' in a) || !('id' in b)) throw new Error('refused')
    await tick()
    const signals = s.runs.map((r) => r.input.signal as AbortSignal)
    stopBackgroundAgentRuns()
    expect(signals.every((x) => x.aborted)).toBe(true)
    for (const r of s.runs) r.finish({ ok: false, code: 'cancelled', message: 'stopped' })
    await tick()
    const c = await dispatchAgent(PARAMS)
    if (!('id' in c)) throw new Error('refused')
    await tick()
    killAllAgents()
    expect((s.runs[2].input.signal as AbortSignal).aborted).toBe(true)
    s.runs[2].finish({ ok: false, code: 'cancelled', message: 'stopped' })
    await tick()
  })
})
