// ADR-025: a cloud agent starts a claude.exe found in PATH's folders directly
// on Windows, on the main thread. Before that start it awaits the first-start
// warm-up of that same program, with Claude's --version environment; an agent
// cancelled during the wait starts nothing and stays cancelled; an npm
// claude.cmd (started through cmd.exe) is not warmed. The PATH walk's file
// test, the warm-up and child_process are faked, and the platform is forced:
// nothing is started.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  present: new Set<string>(),
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  gate: null as null | Promise<void>,
}))

vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: (file: string) => {
    h.order.push(`spawn ${file}`)
    return { pid: 777, stdin: { on: vi.fn(), end: vi.fn(), write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() }
  },
  spawnSync: () => ({ status: 0 }),
  execSync: () => '',
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
    findOnWindowsPathAsync: async (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
  }
})
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
  writeConfig: () => true,
  getConfigDir: () => '/mock/CONFIG',
  ensureConfigDir: vi.fn(),
}))
vi.mock('../../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: () => null,
  isVersionInstalled: () => false,
  installVersion: async () => ({ ok: false, error: 'not in this test' }),
  legacyCliPin: () => undefined,
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  getProfileConfigDir: (id: string) => `/nonexistent/profiles/${id}`,
  setupProfileLinks: vi.fn(),
  listProfiles: () => [],
}))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

const { composeProviders } = await import('../../../src/main/providers/compose')
const { initCloudAgentManager, dispatchAgent, cancelAgent, killAllAgents, listAgents, _resetCloudAgentLatchForTest } = await import('../../../src/main/cloud-agent-manager')
const { _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')

const EXE = 'C:\\Tools\\claude.exe'
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved = { path: process.env.PATH, root: process.env.SystemRoot }

beforeAll(() => { composeProviders() })
beforeEach(() => {
  h.order.length = 0
  h.warm.length = 0
  h.gate = null
  h.present = new Set()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = 'C:\\Npm;C:\\Tools'
  process.env.SystemRoot = 'C:\\Windows'
  _resetClaudeWindowsLookupForTest()
  _resetCloudAgentLatchForTest()
  initCloudAgentManager(() => null)
})
afterEach(() => {
  killAllAgents()
  Object.defineProperty(process, 'platform', hostPlatform)
  if (saved.path === undefined) delete process.env.PATH
  else process.env.PATH = saved.path
  if (saved.root === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = saved.root
  delete process.env.CCC_FIRST_START_MARK
})

describe('a cloud agent on Windows (ADR-025)', () => {
  it('awaits the warm-up of the claude.exe found in PATH\'s folders before it starts it', async () => {
    h.present = new Set([EXE.toLowerCase()])
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const dispatched = dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.order).toEqual([`warm ${EXE}`])
    release()
    expect(((await dispatched) as { status: string }).status).toBe('running')
    expect(h.order).toEqual([`warm ${EXE}`, `spawn ${EXE}`])
  })

  it('warms with Claude\'s --version environment, never the agent\'s own', async () => {
    h.present = new Set([EXE.toLowerCase()])
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    await dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('an agent cancelled while the warm-up runs starts nothing and stays cancelled', async () => {
    h.present = new Set([EXE.toLowerCase()])
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const dispatched = dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    for (const a of listAgents()) cancelAgent(a.id)
    release()
    const agent = (await dispatched) as { status: string; error?: string }
    expect(agent.status).toBe('cancelled')
    expect(agent.error).toBeUndefined()
    expect(h.order).toEqual([`warm ${EXE}`])
  })

  it('an npm claude.cmd, which cmd.exe starts, is not warmed', async () => {
    h.present = new Set(['c:\\npm\\claude.cmd'])
    await dispatchAgent({ name: 'A', description: 'Summarise.', projectPath: 'C:\\dev\\project' })
    expect(h.warm).toEqual([])
    expect(h.order).toEqual(['spawn C:\\Windows\\System32\\cmd.exe'])
  })
})
