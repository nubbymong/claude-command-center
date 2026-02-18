import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { ChildProcess } from 'child_process'

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
} from '../../src/main/cloud-agent-manager'

// Create a mock ChildProcess
function createMockProcess(): any {
  const stdout = { on: vi.fn() }
  const stderr = { on: vi.fn() }
  return {
    pid: 12345,
    stdout,
    stderr,
    on: vi.fn(),
    kill: vi.fn(),
  }
}

describe('cloud-agent-manager', () => {
  let mockWindow: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockReadConfig.mockReturnValue(null) // No persisted agents
    mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    }
    initCloudAgentManager(() => mockWindow)
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
    it('spawns claude process with correct args', async () => {
      const mockProc = createMockProcess()
      mockSpawn.mockReturnValue(mockProc)

      const agent = await dispatchAgent({
        name: 'Test',
        description: 'Fix the bug',
        projectPath: 'C:\\dev\\project',
      })

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        ['-p', 'Fix the bug', '--dangerously-skip-permissions'],
        expect.objectContaining({
          cwd: 'C:\\dev\\project',
          shell: true,
          windowsHide: true,
        })
      )
      expect(agent.status).toBe('running')
      expect(agent.name).toBe('Test')
      expect(agent.id).toMatch(/^ca-/)
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
})
