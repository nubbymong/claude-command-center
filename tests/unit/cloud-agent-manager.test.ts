import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mock child_process
const mockSpawn = vi.fn()
const mockExecSync = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
  execSync: (...args: any[]) => mockExecSync(...args),
  spawnSync: vi.fn(),
}))

// Mock config-manager
const mockReadConfig = vi.fn()
const mockWriteConfig = vi.fn()
vi.mock('../../src/main/config-manager', () => ({
  readConfig: (...args: any[]) => mockReadConfig(...args),
  writeConfig: (...args: any[]) => mockWriteConfig(...args),
  getConfigDir: () => '/mock/CONFIG',
  ensureConfigDir: vi.fn(),
}))

// Mock legacy-version-manager
vi.mock('../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: vi.fn(() => null),
  isVersionInstalled: vi.fn(() => false),
  installVersion: vi.fn(async () => ({ ok: false, error: 'mock' })),
}))

// Mock account-profiles so dispatch NEVER touches the real profiles on disk
// (getResourcesDirectory reads the registry → the real resources dir). The
// profile env-resolution path is tested deterministically via these stubs.
const profMocks = vi.hoisted(() => ({
  getPrimaryProfileId: vi.fn<() => string | null>(() => null),
  getProfileConfigDir: vi.fn((id: string) => `/nonexistent/profiles/${id}`),
  setupProfileLinks: vi.fn(),
  listProfiles: vi.fn(() => [] as Array<{ id: string; accountEmail?: string; name?: string; isPrimary?: boolean }>),
}))
// isValidProfileId comes from the REAL module via importOriginal. The resolver's
// path guard is part of what these tests exercise, so stubbing it `true` would let
// a traversing id through here while the shipped code rejects it — but a
// hand-copied mirror of the predicate is only correct until PROFILE_ID_RE or the
// length cap changes, at which point the mock silently diverges and the test keeps
// passing against a stale rule. Importing the real one cannot drift.
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  getPrimaryProfileId: profMocks.getPrimaryProfileId,
  getProfileConfigDir: profMocks.getProfileConfigDir,
  setupProfileLinks: profMocks.setupProfileLinks,
  listProfiles: profMocks.listProfiles,
}))

import {
  initCloudAgentManager,
  dispatchAgent,
  cancelAgent,
  removeAgent,
  retryAgent,
  listAgents,
  getAgentOutput,
  clearCompletedAgents,
  killAllAgents,
  cleanupStuckAgents,
  onAgentCompletion,
} from '../../src/main/cloud-agent-manager'

// Create a mock ChildProcess
function createMockProcess(): any {
  const stdout = { on: vi.fn() }
  const stderr = { on: vi.fn() }
  const stdin = { write: vi.fn(), end: vi.fn() }
  return {
    pid: 12345,
    stdout,
    stderr,
    stdin,
    on: vi.fn(),
    kill: vi.fn(),
  }
}

describe('cloud-agent-manager', () => {
  let mockWindow: any

  const tmpDirs: string[] = []
  function makeExistingProfileDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-prof-'))
    tmpDirs.push(d)
    return d
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks resets call history but not return values — restore defaults.
    profMocks.getPrimaryProfileId.mockReturnValue(null)
    profMocks.getProfileConfigDir.mockImplementation((id: string) => `/nonexistent/profiles/${id}`)
    profMocks.setupProfileLinks.mockReset()
    profMocks.listProfiles.mockReturnValue([])
    mockReadConfig.mockReturnValue(null) // No persisted agents
    mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    }
    initCloudAgentManager(() => mockWindow)
  })

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  describe('initCloudAgentManager', () => {
    it('loads persisted agents on init', () => {
      const saved = [{ id: 'old-1', name: 'Old', status: 'completed' }]
      mockReadConfig.mockReturnValue(saved)
      initCloudAgentManager(() => mockWindow)
      expect(listAgents()).toHaveLength(1)
      expect(listAgents()[0].name).toBe('Old')
    })
  })

  describe('cleanupStuckAgents', () => {
    it('marks running agents as failed on startup', () => {
      mockReadConfig.mockReturnValue([
        { id: 'a1', name: 'Stuck', status: 'running', createdAt: 1000, updatedAt: 1000 },
        { id: 'a2', name: 'OK', status: 'completed', createdAt: 1000, updatedAt: 1000 },
      ])
      initCloudAgentManager(() => mockWindow)
      cleanupStuckAgents()
      const agents = listAgents()
      expect(agents[0].status).toBe('failed')
      expect(agents[0].error).toContain('interrupted')
      expect(agents[1].status).toBe('completed')
      expect(mockWriteConfig).toHaveBeenCalledWith('cloudAgents', expect.any(Array))
    })

    it('marks pending agents as failed too', () => {
      mockReadConfig.mockReturnValue([
        { id: 'a1', name: 'Pending', status: 'pending', createdAt: 1000, updatedAt: 1000 },
      ])
      initCloudAgentManager(() => mockWindow)
      cleanupStuckAgents()
      expect(listAgents()[0].status).toBe('failed')
    })
  })

  describe('dispatchAgent', () => {
    it('spawns claude piped from a temp file, WITHOUT --dangerously-skip-permissions by default (P1.3 safe default)', async () => {
      const mockProc = createMockProcess()
      mockSpawn.mockReturnValue(mockProc)

      const agent = await dispatchAgent({
        name: 'Test',
        description: 'Fix the bug',
        projectPath: 'C:\\dev\\project',
      })

      // Prompt is written to a temp file and piped via shell command
      const spawnCall = mockSpawn.mock.calls[0]
      const shellCmd = spawnCall[0] as string
      // Windows uses `type`, macOS/Linux uses `cat`
      const pipeCmdPattern = process.platform === 'win32'
        ? /type ".*ccc-agent-.*\.txt" \| claude\b/
        : /cat ".*ccc-agent-.*\.txt" \| claude\b/
      expect(shellCmd).toMatch(pipeCmdPattern)
      expect(shellCmd).not.toContain('--dangerously-skip-permissions')
      expect(spawnCall[1]).toEqual([])
      expect(spawnCall[2]).toEqual(expect.objectContaining({
        cwd: 'C:\\dev\\project',
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }))
      expect(agent.status).toBe('running')
      expect(agent.name).toBe('Test')
      expect(agent.id).toMatch(/^ca-/)
    })

    it('includes --dangerously-skip-permissions only when skipPermissions is true (FEAT-1 per-run opt-in)', async () => {
      mockSpawn.mockReturnValue(createMockProcess())
      await dispatchAgent({ name: 'T', description: 'd', projectPath: '/p', skipPermissions: true })
      const shellCmd = mockSpawn.mock.calls[0][0] as string
      expect(shellCmd).toContain('--dangerously-skip-permissions')
    })

    it('never skips by default, ignoring any persisted config (per-run opt-in only)', async () => {
      // The legacy global skipPermissionsForAgents setting was removed in Unit 3;
      // cloud-agent dispatch is per-run. Even if stale config still carries the
      // flag, a default dispatch must NOT skip.
      mockReadConfig.mockImplementation((key: string) => key === 'settings' ? { skipPermissionsForAgents: true } : null)
      mockSpawn.mockReturnValue(createMockProcess())
      await dispatchAgent({ name: 'T', description: 'd', projectPath: '/p' })
      const shellCmd = mockSpawn.mock.calls[0][0] as string
      expect(shellCmd).not.toContain('--dangerously-skip-permissions')
    })

    it('broadcasts status on dispatch', async () => {
      mockSpawn.mockReturnValue(createMockProcess())
      await dispatchAgent({ name: 'Test', description: 'desc', projectPath: '/p' })
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'cloudAgent:statusChanged',
        expect.objectContaining({ status: 'running' })
      )
    })

    it('persists agent list', async () => {
      mockSpawn.mockReturnValue(createMockProcess())
      await dispatchAgent({ name: 'Test', description: 'desc', projectPath: '/p' })
      expect(mockWriteConfig).toHaveBeenCalledWith('cloudAgents', expect.any(Array))
    })

    it('registers stdout data handler', async () => {
      const mockProc = createMockProcess()
      mockSpawn.mockReturnValue(mockProc)
      await dispatchAgent({ name: 'Test', description: 'desc', projectPath: '/p' })
      expect(mockProc.stdout.on).toHaveBeenCalledWith('data', expect.any(Function))
    })

    it('registers close handler', async () => {
      const mockProc = createMockProcess()
      mockSpawn.mockReturnValue(mockProc)
      await dispatchAgent({ name: 'Test', description: 'desc', projectPath: '/p' })
      expect(mockProc.on).toHaveBeenCalledWith('close', expect.any(Function))
    })
  })

  describe('dispatchAgent account isolation', () => {
    it('runs on the bare global env when no profiles exist (single-account unchanged)', async () => {
      mockSpawn.mockReturnValue(createMockProcess())
      const agent = await dispatchAgent({ name: 'T', description: 'd', projectPath: '/p' })
      expect(agent.profileId).toBeUndefined()
      expect(agent.accountEmail).toBeUndefined()
      expect(profMocks.setupProfileLinks).not.toHaveBeenCalled()
    })

    it('spawns under the requested profile fake HOME and stamps the account', async () => {
      const dir = makeExistingProfileDir()
      profMocks.getProfileConfigDir.mockImplementation((id: string) => id === 'p1' ? dir : `/nonexistent/${id}`)
      profMocks.listProfiles.mockReturnValue([{ id: 'p1', accountEmail: 'work@x.com', name: 'Work' }])
      mockSpawn.mockReturnValue(createMockProcess())

      const agent = await dispatchAgent({ name: 'T', description: 'd', projectPath: '/p', profileId: 'p1' })

      expect(profMocks.setupProfileLinks).toHaveBeenCalledWith('p1')
      expect(agent.profileId).toBe('p1')
      expect(agent.accountEmail).toBe('work@x.com')
      const env = mockSpawn.mock.calls[0][2].env
      expect(env.USERPROFILE).toBe(dir)
    })

    it('falls back to the primary profile when none is requested (clobber-proof)', async () => {
      const dir = makeExistingProfileDir()
      profMocks.getPrimaryProfileId.mockReturnValue('pp')
      profMocks.getProfileConfigDir.mockImplementation((id: string) => id === 'pp' ? dir : `/nonexistent/${id}`)
      profMocks.listProfiles.mockReturnValue([{ id: 'pp', accountEmail: 'primary@x.com', isPrimary: true }])
      mockSpawn.mockReturnValue(createMockProcess())

      const agent = await dispatchAgent({ name: 'T', description: 'd', projectPath: '/p' })

      expect(agent.profileId).toBe('pp')
      expect(agent.accountEmail).toBe('primary@x.com')
      expect(mockSpawn.mock.calls[0][2].env.USERPROFILE).toBe(dir)
    })

    it('falls back to primary when the requested profile dir is missing', async () => {
      const dir = makeExistingProfileDir()
      profMocks.getPrimaryProfileId.mockReturnValue('pp')
      profMocks.getProfileConfigDir.mockImplementation((id: string) => id === 'pp' ? dir : `/nonexistent/${id}`)
      profMocks.listProfiles.mockReturnValue([{ id: 'pp', accountEmail: 'primary@x.com', isPrimary: true }])
      mockSpawn.mockReturnValue(createMockProcess())

      const agent = await dispatchAgent({ name: 'T', description: 'd', projectPath: '/p', profileId: 'gone' })
      expect(agent.profileId).toBe('pp')
    })

    it('retry preserves the resolved profileId', async () => {
      const dir = makeExistingProfileDir()
      profMocks.getProfileConfigDir.mockImplementation((id: string) => id === 'p1' ? dir : `/nonexistent/${id}`)
      profMocks.listProfiles.mockReturnValue([{ id: 'p1', accountEmail: 'work@x.com' }])
      mockSpawn.mockReturnValue(createMockProcess())

      const first = await dispatchAgent({ name: 'T', description: 'd', projectPath: '/p', profileId: 'p1' })
      const retried = await retryAgent(first.id)
      expect(retried!.profileId).toBe('p1')
      expect(retried!.accountEmail).toBe('work@x.com')
    })
  })

  describe('cancelAgent', () => {
    it('kills process and marks cancelled', async () => {
      const mockProc = createMockProcess()
      mockSpawn.mockReturnValue(mockProc)
      const agent = await dispatchAgent({ name: 'Test', description: 'desc', projectPath: '/p' })
      const result = cancelAgent(agent.id)
      expect(result).toBe(true)
      // On Windows, uses taskkill via execSync; on other platforms, uses proc.kill('SIGTERM')
      if (process.platform === 'win32') {
        expect(mockExecSync).toHaveBeenCalled()
      } else {
        expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')
      }
    })

    it('returns false for non-running agent', () => {
      mockReadConfig.mockReturnValue([{ id: 'a1', status: 'completed' }])
      initCloudAgentManager(() => mockWindow)
      expect(cancelAgent('a1')).toBe(false)
    })
  })

  describe('removeAgent', () => {
    it('removes agent from list', () => {
      mockReadConfig.mockReturnValue([
        { id: 'a1', name: 'A', status: 'completed' },
        { id: 'a2', name: 'B', status: 'completed' },
      ])
      initCloudAgentManager(() => mockWindow)
      const result = removeAgent('a1')
      expect(result).toBe(true)
      expect(listAgents()).toHaveLength(1)
      expect(listAgents()[0].id).toBe('a2')
    })

    it('returns false for unknown id', () => {
      expect(removeAgent('nonexistent')).toBe(false)
    })
  })

  describe('retryAgent', () => {
    it('dispatches new agent with same params', async () => {
      mockReadConfig.mockReturnValue([
        { id: 'a1', name: 'Failed Task', description: 'fix it', status: 'failed', projectPath: '/p', configId: 'cfg1' },
      ])
      initCloudAgentManager(() => mockWindow)
      mockSpawn.mockReturnValue(createMockProcess())
      const newAgent = await retryAgent('a1')
      expect(newAgent).not.toBeNull()
      expect(newAgent!.name).toBe('Failed Task')
      expect(newAgent!.description).toBe('fix it')
      expect(newAgent!.projectPath).toBe('/p')
      expect(newAgent!.status).toBe('running')
    })

    it('returns null for unknown id', async () => {
      expect(await retryAgent('nonexistent')).toBeNull()
    })
  })

  describe('getAgentOutput', () => {
    it('returns output for known agent', () => {
      mockReadConfig.mockReturnValue([{ id: 'a1', output: 'Hello World' }])
      initCloudAgentManager(() => mockWindow)
      expect(getAgentOutput('a1')).toBe('Hello World')
    })

    it('returns empty string for unknown agent', () => {
      expect(getAgentOutput('nonexistent')).toBe('')
    })
  })

  describe('clearCompletedAgents', () => {
    it('removes completed and failed agents', () => {
      mockReadConfig.mockReturnValue([
        { id: 'a1', status: 'completed' },
        { id: 'a2', status: 'running' },
        { id: 'a3', status: 'failed' },
      ])
      initCloudAgentManager(() => mockWindow)
      const removed = clearCompletedAgents()
      expect(removed).toBe(2)
      expect(listAgents()).toHaveLength(1)
      expect(listAgents()[0].id).toBe('a2')
    })

    it('returns 0 when nothing to clear', () => {
      mockReadConfig.mockReturnValue([{ id: 'a1', status: 'running' }])
      initCloudAgentManager(() => mockWindow)
      expect(clearCompletedAgents()).toBe(0)
    })
  })

  describe('killAllAgents', () => {
    it('kills all active processes', () => {
      const proc1 = createMockProcess()
      const proc2 = createMockProcess()
      mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2)
      dispatchAgent({ name: 'A', description: 'd', projectPath: '/p' })
      dispatchAgent({ name: 'B', description: 'd', projectPath: '/p' })
      killAllAgents()
      if (process.platform === 'win32') {
        expect(mockExecSync).toHaveBeenCalled()
      } else {
        expect(proc1.kill).toHaveBeenCalledWith('SIGTERM')
        expect(proc2.kill).toHaveBeenCalledWith('SIGTERM')
      }
    })
  })

  describe('onAgentCompletion', () => {
    it('registers a callback', () => {
      const cb = vi.fn()
      onAgentCompletion(cb)
      // Callback is registered — it fires when an agent finishes (tested via close handler)
      expect(cb).not.toHaveBeenCalled()
    })

    it('fires callback on agent close', async () => {
      const cb = vi.fn()
      onAgentCompletion(cb)

      const mockProc = createMockProcess()
      mockSpawn.mockReturnValue(mockProc)
      const agent = await dispatchAgent({ name: 'CB Test', description: 'desc', projectPath: '/p' })

      // Find the 'close' handler registered on the process
      const closeCall = mockProc.on.mock.calls.find((c: any[]) => c[0] === 'close')
      expect(closeCall).toBeDefined()
      const closeHandler = closeCall![1]

      // Simulate the process exiting with code 0
      closeHandler(0)

      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ id: agent.id, status: 'completed' })
      )
    })

    it('fires callback on agent error', async () => {
      const cb = vi.fn()
      onAgentCompletion(cb)

      const mockProc = createMockProcess()
      mockSpawn.mockReturnValue(mockProc)
      const agent = await dispatchAgent({ name: 'Err Test', description: 'desc', projectPath: '/p' })

      // Find the 'error' handler
      const errorCall = mockProc.on.mock.calls.find((c: any[]) => c[0] === 'error')
      expect(errorCall).toBeDefined()
      const errorHandler = errorCall![1]

      errorHandler(new Error('spawn failed'))

      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ id: agent.id, status: 'failed' })
      )
    })

    it('fires multiple callbacks', async () => {
      const cb1 = vi.fn()
      const cb2 = vi.fn()
      onAgentCompletion(cb1)
      onAgentCompletion(cb2)

      const mockProc = createMockProcess()
      mockSpawn.mockReturnValue(mockProc)
      await dispatchAgent({ name: 'Multi CB', description: 'desc', projectPath: '/p' })

      const closeHandler = mockProc.on.mock.calls.find((c: any[]) => c[0] === 'close')![1]
      closeHandler(0)

      expect(cb1).toHaveBeenCalled()
      expect(cb2).toHaveBeenCalled()
    })
  })
})
