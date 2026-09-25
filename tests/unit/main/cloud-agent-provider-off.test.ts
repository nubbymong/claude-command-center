/**
 * WP2: a cloud agent is a Claude Code run (`claude -p`), so main refuses one
 * while Claude Code is off -- in the service layer every way in goes through
 * (dispatchAgent; retryAgent calls it), BEFORE the project is scanned, a
 * record is made, a legacy CLI is installed or anything is spawned -- and
 * asks again right before the agent's process starts, failing the agent with
 * the reason if the answer changed while it waited. The refusal is an answer
 * the Cloud Agents page shows, never a throw.
 *
 * While an agent is dispatching, pending or running it counts as Claude Code
 * in use (countClaudeAgentsInUse), so a switch-off in Settings is refused
 * then (provider-in-use.test.ts proves the switch reads this count).
 *
 * The REAL cloud-agent manager and the REAL launch gate; the accounts
 * service's answer is scripted (its rule is proven against real settings in
 * provider-launch-gate.test.ts), and child_process is faked, so nothing runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

interface Deferred { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }

const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))
const saved = vi.hoisted(() => ({ agents: null as unknown }))
const writeConfig = vi.fn((_k: string, _v: unknown) => true)
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'cloudAgents' ? saved.agents : null),
  readConfigChecked: (key: string) => (key === 'cloudAgents' && saved.agents != null ? { value: saved.agents, outcome: 'ok' } : { value: null, outcome: 'absent' }),
  writeConfig: (k: string, v: unknown) => writeConfig(k, v),
  getConfigDir: () => '/unused/CONFIG',
  ensureConfigDir: vi.fn(),
}))
// Held when a test says so: the dispatch then waits here, as a real one does.
const h = vi.hoisted(() => ({ install: null as null | Promise<void>, refresh: null as null | Promise<void>, scan: null as null | Promise<void>, profileDir: '', writeThrows: false, acquireThrows: false }))
// The prompt file's write, made to fail when a test says so (everything else
// in fs is the real one).
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return {
    ...real,
    writeFileSync: (...a: Parameters<typeof real.writeFileSync>) => {
      if (h.writeThrows && String(a[0]).includes('ccc-agent-')) throw new Error('disk full')
      return real.writeFileSync(...a)
    },
  }
})
const installVersion = vi.fn(async () => { if (h.install) await h.install; return { ok: false, error: 'not in this test' } })
vi.mock('../../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: vi.fn(() => null),
  isVersionInstalled: vi.fn(() => false),
  installVersion: (...a: unknown[]) => installVersion(...(a as [])),
  legacyCliPin: vi.fn(() => undefined),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  getProfileConfigDir: (id: string) => (id === 'prof-a' ? h.profileDir : `/nonexistent/profiles/${id}`),
  setupProfileLinks: vi.fn(),
  listProfiles: () => [{ id: 'prof-a', accountEmail: 'a@example.com' }],
}))
vi.mock('../../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env }))
const waitForProfileRefresh = vi.fn(async () => { if (h.refresh) await h.refresh })
vi.mock('../../../src/main/profile-consumers', () => ({
  acquireProfileConsumer: () => { if (h.acquireThrows) throw new Error('hold refused'); return () => {} },
  waitForProfileRefresh: (...a: unknown[]) => waitForProfileRefresh(...(a as [])),
}))
const gateManagedLaunch = vi.fn(async () => { if (h.scan) await h.scan; return null })
vi.mock('../../../src/main/managed-launch-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/managed-launch-diagnostics')>()),
  gateManagedLaunch: (...a: unknown[]) => gateManagedLaunch(...(a as [])),
}))
const acct = vi.hoisted(() => ({ claude: 'on' as 'on' | 'off' | 'unreadable' }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => id !== 'claude' || acct.claude === 'on' ? null
      : acct.claude === 'off' ? { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }
      : { code: 'provider-state-unknown', providerId: 'claude', message: 'This app could not read whether Claude Code is on. Check Settings, Accounts.' },
  }),
}))

const { initCloudAgentManager, dispatchAgent, retryAgent, listAgents, countClaudeAgentsInUse, _resetCloudAgentLatchForTest } = await import('../../../src/main/cloud-agent-manager')

const OFF_TEXT = 'Claude Code is off. Turn it on in Settings, Accounts.'
const OFF = { refused: { code: 'provider-off', providerId: 'claude', message: OFF_TEXT } }
const PARAMS = { name: 'Fix it', description: 'Fix the flaky test', projectPath: 'C:\\dev\\project', legacyVersion: { enabled: true, version: '2.0.1' } }
type Proc = { pid: number; stdout: { on: ReturnType<typeof vi.fn> }; stderr: { on: ReturnType<typeof vi.fn> }; stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; on: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }
const proc = (): Proc => ({ pid: 1, stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, stdin: { write: vi.fn(), end: vi.fn() }, on: vi.fn(), kill: vi.fn() })
/** Microtasks and a macrotask, so a held dispatch reaches its wait. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

beforeAll(() => { h.profileDir = mkdtempSync(join(tmpdir(), 'ccc-agent-prof-')) })
afterAll(() => { rmSync(h.profileDir, { recursive: true, force: true }) })
beforeEach(() => {
  mockSpawn.mockReset()
  mockSpawn.mockImplementation(proc)
  writeConfig.mockClear()
  installVersion.mockClear()
  gateManagedLaunch.mockClear()
  waitForProfileRefresh.mockClear()
  h.install = null
  h.refresh = null
  h.scan = null
  h.writeThrows = false
  h.acquireThrows = false
  acct.claude = 'on'
  saved.agents = [{ id: 'agent-old', name: 'Earlier', description: 'Do the thing', status: 'failed', createdAt: 1, updatedAt: 1, projectPath: 'C:\\dev\\project', output: '' }]
  _resetCloudAgentLatchForTest()
  initCloudAgentManager(() => null)
})

describe('a cloud agent while Claude Code is off', () => {
  it('dispatch: refused with the typed refusal; nothing is scanned, recorded, installed or spawned', async () => {
    acct.claude = 'off'
    await expect(dispatchAgent(PARAMS)).resolves.toEqual(OFF)
    expect(gateManagedLaunch).not.toHaveBeenCalled()
    expect(installVersion).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(writeConfig).not.toHaveBeenCalled()
    expect(listAgents().map((a) => a.id)).toEqual(['agent-old'])
    expect(countClaudeAgentsInUse()).toBe(0)
  })

  it('retry: refused the same way; the earlier agent is kept as it was', async () => {
    acct.claude = 'off'
    await expect(retryAgent('agent-old')).resolves.toEqual(OFF)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(listAgents()).toHaveLength(1)
    expect(listAgents()[0]).toMatchObject({ id: 'agent-old', status: 'failed' })
  })

  it('a setting that cannot be read refuses too (fail closed)', async () => {
    acct.claude = 'unreadable'
    const r = await dispatchAgent(PARAMS) as { refused: { code: string } }
    expect(r.refused.code).toBe('provider-state-unknown')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('with Claude Code on, dispatch and retry run as before', async () => {
    const a = await dispatchAgent(PARAMS) as { id: string; status: string }
    expect(a.status).toBe('running')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const b = await retryAgent('agent-old') as { id: string }
    expect(b.id).toBeTruthy()
    expect(mockSpawn).toHaveBeenCalledTimes(2)
  })
})

describe('switched off while a dispatch waits: the agent is failed with the reason, and nothing runs', () => {
  it('during its legacy CLI install', async () => {
    const install = deferred()
    h.install = install.promise
    const pending = dispatchAgent(PARAMS)
    await tick()
    expect(installVersion).toHaveBeenCalledTimes(1)
    acct.claude = 'off'
    install.resolve()
    const agent = await pending as { status: string; error?: string }
    expect(agent).toMatchObject({ status: 'failed', error: OFF_TEXT })
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(countClaudeAgentsInUse()).toBe(0)
  })

  it("during its account's refresh wait", async () => {
    const refresh = deferred()
    h.refresh = refresh.promise
    const pending = dispatchAgent({ ...PARAMS, legacyVersion: undefined, profileId: 'prof-a' })
    await tick()
    expect(waitForProfileRefresh).toHaveBeenCalledTimes(1)
    acct.claude = 'off'
    refresh.resolve()
    const agent = await pending as { status: string; error?: string }
    expect(agent).toMatchObject({ status: 'failed', error: OFF_TEXT })
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})

describe('an agent is Claude Code in use from its launch check to its end', () => {
  it('while its project is scanned (before its record exists)', async () => {
    const scan = deferred()
    h.scan = scan.promise
    const pending = dispatchAgent(PARAMS)
    await tick()
    expect(listAgents()).toHaveLength(1) // only the earlier, failed one
    expect(countClaudeAgentsInUse()).toBe(1)
    scan.resolve()
    await pending
  })

  it('while pending on its install, while running, and not once it has ended', async () => {
    expect(countClaudeAgentsInUse()).toBe(0)
    const install = deferred()
    h.install = install.promise
    const pending = dispatchAgent(PARAMS)
    await tick()
    expect(countClaudeAgentsInUse()).toBe(1)
    install.resolve()
    await pending
    expect(countClaudeAgentsInUse()).toBe(1)
    // The agent's process ends.
    const child = mockSpawn.mock.results[0].value as Proc
    const onClose = child.on.mock.calls.find((c) => c[0] === 'close')![1] as (code: number) => void
    onClose(0)
    expect(countClaudeAgentsInUse()).toBe(0)
  })

  it('a spawn that throws leaves no agent "running" (it would read as in use forever)', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('bad argv') })
    await expect(dispatchAgent(PARAMS)).rejects.toThrow('bad argv')
    expect(countClaudeAgentsInUse()).toBe(0)
    expect(listAgents()[0]).toMatchObject({ status: 'failed' })
  })
})

describe('a throw between the record and the spawn fails the agent (no phantom running agent)', () => {
  it("the prompt file's write", async () => {
    h.writeThrows = true
    await expect(dispatchAgent(PARAMS)).rejects.toThrow('disk full')
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(listAgents()[0]).toMatchObject({ status: 'failed' })
    expect(listAgents()[0].error).toContain('disk full')
    expect(countClaudeAgentsInUse()).toBe(0)
  })

  it("the account's hold", async () => {
    h.acquireThrows = true
    await expect(dispatchAgent({ ...PARAMS, legacyVersion: undefined, profileId: 'prof-a' })).rejects.toThrow('hold refused')
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(listAgents()[0]).toMatchObject({ status: 'failed' })
    expect(countClaudeAgentsInUse()).toBe(0)
  })

  it('a legacy CLI install that rejects falls back to the installed CLI, as a failed install does', async () => {
    installVersion.mockImplementationOnce(async () => { throw new Error('npm exploded') })
    const agent = await dispatchAgent(PARAMS) as { status: string }
    expect(agent.status).toBe('running')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })
})
