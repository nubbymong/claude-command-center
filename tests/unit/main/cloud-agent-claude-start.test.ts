// A cloud agent starts Claude Code by its full path, never through a shell,
// whatever its project folder holds. On Windows the installed CLI is found by
// the REAL PATH walk (windows-programs.ts) over a PATH this test sets, whose
// relative entries hold a file of every name that must never be chosen; the
// walk runs off the event loop; the prompt reaches the agent on its stdin; the
// agent looks for the
// programs it starts by name only in PATH's folders; and its tree is ended by
// taskkill from the system folder. On macOS/Linux it is an argument list with
// no `sh -c`. The file test is injected (no real file is read), child_process
// is mocked (no process starts), and the platform is forced per case.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  present: new Set<string>(),
  spawn: [] as Array<{ file: string; args: string[]; opts: Record<string, any>; child: any }>,
  spawnSync: [] as Array<{ file: string; args: string[] }>,
  execSync: [] as string[],
  pin: null as string | null,
  syncWalks: 0,
  /** Run while the walk off the event loop is under way. */
  onAsyncWalk: null as (() => void) | null,
  /** What a taskkill start fails with (none: it ran). */
  spawnSyncError: null as Error | null,
}))

vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ gateManagedLaunch: async () => ({ status: 'clean' }), peekGateVerdict: () => undefined }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: (file: string, args: string[], opts: Record<string, any>) => {
    const child = { pid: 777, stdin: { on: vi.fn(), end: vi.fn(), write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() }
    h.spawn.push({ file, args, opts, child })
    return child
  },
  spawnSync: (file: string, args: string[]) => { h.spawnSync.push({ file, args }); return h.spawnSyncError ? { status: null, error: h.spawnSyncError } : { status: 0 } },
  execSync: (cmd: string) => { h.execSync.push(cmd); return '' },
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...real,
    // A walk on the event loop is recorded: the agent's start never makes one.
    findOnWindowsPath: (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => {
      h.syncWalks += 1
      return real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order)
    },
    findOnWindowsPathAsync: async (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => {
      h.onAsyncWalk?.()
      return real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order)
    },
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
  resolveVersionBinary: () => h.pin,
  isVersionInstalled: () => h.pin !== null,
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

const { composeProviders } = await import('../../../src/main/providers/compose')
const { initCloudAgentManager, dispatchAgent, cancelAgent, killAllAgents, listAgents, _resetCloudAgentLatchForTest } = await import('../../../src/main/cloud-agent-manager')
const { CLAUDE_NOT_ON_PATH, _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')

/** Relative entries first, then the real folders. */
const PATH = '.;rel\\bin;%APPDATA%\\npm;C:\\Npm;C:\\Tools'
/** A file of every name in every relative entry (never to be chosen). */
const IN_RELATIVE_ENTRIES = ['claude.exe', 'claude.cmd', 'claude.bat', 'node.exe', 'node.cmd'].flatMap((n) => [`.\\${n}`, `rel\\bin\\${n}`, n])
const PROMPT = 'Summarise the open issues.'

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
// The agent's environment is built from this process's own, so PATH and
// SystemRoot are set on it per case and put back after (on Windows the names
// are case-insensitive, so PATH reaches the variable whatever its spelling).
const saved = { path: process.env.PATH, root: process.env.SystemRoot }

function have(...files: string[]): void {
  h.present = new Set([...IN_RELATIVE_ENTRIES, ...files].map((f) => f.toLowerCase()))
}
function platform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeAll(() => { composeProviders() })
beforeEach(() => {
  h.spawn.length = 0
  h.spawnSync.length = 0
  h.execSync.length = 0
  h.pin = null
  h.syncWalks = 0
  h.spawnSyncError = null
  h.onAsyncWalk = null
  have()
  platform('win32')
  process.env.PATH = PATH
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
})

/** The prompt the agent received on its stdin. */
function promptSent(i = 0): string {
  const end = h.spawn[i].child.stdin.end as ReturnType<typeof vi.fn>
  expect(end).toHaveBeenCalledTimes(1)
  return Buffer.from(end.mock.calls[0][0] as Buffer).toString('utf8')
}

describe('a cloud agent starts claude code by its full path, without a shell (Windows)', () => {
  it('claude.exe from PATH\'s folders, -p, the prompt on stdin, and no current-folder lookup', async () => {
    have('C:\\Npm\\claude.cmd', 'C:\\Tools\\claude.exe')
    const agent = await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' }) as { status: string }
    expect(agent.status).toBe('running')
    expect(h.spawn).toHaveLength(1)
    const { file, args, opts } = h.spawn[0]
    expect(file).toBe('C:\\Tools\\claude.exe')
    expect(args).toEqual(['-p'])
    expect(opts).not.toHaveProperty('shell')
    expect(opts.cwd).toBe('C:\\dev\\project')
    expect(opts.stdio[0]).toBe('pipe')
    expect(opts.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(promptSent()).toBe(PROMPT)
    expect(h.execSync).toEqual([])
  })

  it('an npm claude.cmd runs through the system cmd.exe, the skip flag one plain argument', async () => {
    have('C:\\Npm\\claude.cmd')
    await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project', skipPermissions: true })
    expect(h.spawn).toHaveLength(1)
    expect(h.spawn[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(h.spawn[0].args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\Npm\\claude.cmd" -p --dangerously-skip-permissions"'])
    expect(h.spawn[0].opts).toMatchObject({ windowsVerbatimArguments: true })
    expect(h.spawn[0].opts).not.toHaveProperty('shell')
    expect(promptSent()).toBe(PROMPT)
  })

  it('a legacy pin under a folder with a space stays one argument', async () => {
    h.pin = 'C:\\My Resources\\claude-versions\\2.1.0\\node_modules\\.bin\\claude.cmd'
    have('C:\\Tools\\claude.exe')
    await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project', legacyVersion: { enabled: true, version: '2.1.0' } })
    expect(h.spawn).toHaveLength(1)
    expect(h.spawn[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(h.spawn[0].args[4]).toBe('""C:\\My Resources\\claude-versions\\2.1.0\\node_modules\\.bin\\claude.cmd" -p"')
  })

  it('with Claude Code only in relative entries, nothing starts and the agent says why', async () => {
    const agent = await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' }) as { id: string; status: string; error?: string }
    expect(h.spawn).toEqual([])
    expect(agent.status).toBe('failed')
    expect(agent.error).toBe(CLAUDE_NOT_ON_PATH)
    expect(fs.existsSync(path.join(os.tmpdir(), `ccc-agent-${agent.id}.txt`))).toBe(false)
  })

  it('claude.bat, alone in PATH\'s folders, starts through the system cmd.exe like an npm claude.cmd', async () => {
    have('C:\\Tools\\claude.bat')
    await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' })
    expect(h.spawn).toHaveLength(1)
    expect(h.spawn[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(h.spawn[0].args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\Tools\\claude.bat" -p"'])
  })

  it('an agent cancelled while Claude Code is being looked for starts nothing and stays cancelled, whatever the lookup found', async () => {
    for (const present of [['C:\\Tools\\claude.exe'], []]) {
      _resetClaudeWindowsLookupForTest()
      have(...present)
      h.onAsyncWalk = () => { for (const a of listAgents()) cancelAgent(a.id) }
      const agent = await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' }) as { status: string; error?: string }
      expect(h.spawn, present.join()).toEqual([])
      expect(agent.status, present.join()).toBe('cancelled')
      expect(agent.error, present.join()).toBeUndefined()
    }
  })

  it('the agent\'s start never walks PATH on the event loop', async () => {
    have('C:\\Tools\\claude.exe')
    await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' })
    expect(h.spawn).toHaveLength(1)
    expect(h.spawn[0].file).toBe('C:\\Tools\\claude.exe')
    expect(h.syncWalks).toBe(0)
  })

  it('a stop ends the agent\'s tree with taskkill from the system folder', async () => {
    have('C:\\Tools\\claude.exe')
    const agent = await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' }) as { id: string }
    expect(cancelAgent(agent.id)).toBe(true)
    expect(h.spawnSync).toEqual([{ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/pid', '777', '/T', '/F'] }])
    await dispatchAgent({ name: 'B', description: PROMPT, projectPath: 'C:\\dev\\project' })
    h.spawnSync.length = 0
    killAllAgents()
    expect(h.spawnSync.length).toBeGreaterThan(0)
    for (const c of h.spawnSync) expect(c).toEqual({ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/pid', '777', '/T', '/F'] })
    expect(h.execSync).toEqual([])
  })

  it('a taskkill that could not start leaves the stop to the agent itself', async () => {
    have('C:\\Tools\\claude.exe')
    const agent = await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' }) as { id: string }
    h.spawnSyncError = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
    expect(cancelAgent(agent.id)).toBe(true)
    expect(h.spawnSync).toHaveLength(1)
    expect(h.spawn[0].child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('a taskkill that ran ends the tree, and the agent is not signalled as well', async () => {
    have('C:\\Tools\\claude.exe')
    const agent = await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' }) as { id: string }
    expect(cancelAgent(agent.id)).toBe(true)
    expect(h.spawn[0].child.kill).not.toHaveBeenCalled()
  })

  it('with no plain system folder, a stop signals the agent itself and starts no taskkill', async () => {
    have('C:\\Tools\\claude.exe')
    const agent = await dispatchAgent({ name: 'A', description: PROMPT, projectPath: 'C:\\dev\\project' }) as { id: string }
    process.env.SystemRoot = 'Windows'
    expect(cancelAgent(agent.id)).toBe(true)
    expect(h.spawnSync).toEqual([])
    expect(h.spawn[0].child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

describe('a cloud agent starts claude code with an argument list, never sh -c (macOS/Linux)', () => {
  it('claude with -p as arguments, the prompt on stdin, no shell', async () => {
    platform('linux')
    await dispatchAgent({ name: 'A', description: PROMPT, projectPath: '/work/project', skipPermissions: true })
    expect(h.spawn).toHaveLength(1)
    expect(h.spawn[0].file).toBe('claude')
    expect(h.spawn[0].args).toEqual(['-p', '--dangerously-skip-permissions'])
    expect(h.spawn[0].opts).not.toHaveProperty('shell')
    expect(promptSent()).toBe(PROMPT)
  })

  it('a legacy pin starts by its own path', async () => {
    platform('darwin')
    h.pin = '/res/claude-versions/2.1.0/node_modules/.bin/claude'
    await dispatchAgent({ name: 'A', description: PROMPT, projectPath: '/work/project', legacyVersion: { enabled: true, version: '2.1.0' } })
    expect(h.spawn[0].file).toBe('/res/claude-versions/2.1.0/node_modules/.bin/claude')
    expect(h.spawn[0].args).toEqual(['-p'])
  })
})
