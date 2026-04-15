import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock dependencies before importing config-manager
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  join: vi.fn(),
}))

vi.mock('path', () => ({
  join: (...parts: string[]) => parts.join('/'),
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => '/mock/resources',
}))

vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

import * as fs from 'fs'

// Now import config-manager — its deps are mocked
const configManagerModule = await import('../../src/main/config-manager')
const { readConfig, writeConfig, loadAllConfig, ensureConfigDir, configHasData, getConfigDir } = configManagerModule

const mockedFs = vi.mocked(fs)

describe('config-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the cached _configDir by re-assigning via module internals
    // The module caches _configDir, but since getResourcesDirectory is mocked
    // it will just return /mock/resources/CONFIG consistently
  })

  describe('getConfigDir', () => {
    it('returns a path ending with CONFIG', () => {
      const dir = getConfigDir()
      expect(dir).toContain('CONFIG')
    })

    it('returns consistent path from mocked resources directory', () => {
      const dir = getConfigDir()
      expect(dir).toBe('/mock/resources/CONFIG')
    })
  })

  describe('ensureConfigDir', () => {
    it('creates directory if not exists', () => {
      mockedFs.existsSync.mockReturnValue(false)
      ensureConfigDir()
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('CONFIG'),
        { recursive: true }
      )
    })

    it('does not create if already exists', () => {
      mockedFs.existsSync.mockReturnValue(true)
      ensureConfigDir()
      expect(mockedFs.mkdirSync).not.toHaveBeenCalled()
    })
  })

  describe('readConfig', () => {
    it('reads and parses JSON from config file', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ key: 'value' }))
      const result = readConfig('commands')
      expect(result).toEqual({ key: 'value' })
    })

    it('returns null if file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)
      const result = readConfig('commands')
      expect(result).toBeNull()
    })

    it('returns null on parse error', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue('not json{{{')
      const result = readConfig('commands')
      expect(result).toBeNull()
    })
  })

  describe('writeConfig', () => {
    it('writes JSON to .tmp then renames', () => {
      mockedFs.existsSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.endsWith('.tmp')) return false
        if (typeof p === 'string' && p.endsWith('.json')) return false
        return true // CONFIG dir exists
      })
      const data = { items: [1, 2, 3] }
      const result = writeConfig('commands', data)
      expect(result).toBe(true)
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('"items"'),
        'utf-8'
      )
      expect(mockedFs.renameSync).toHaveBeenCalled()
    })

    it('unlinks existing file before rename', () => {
      mockedFs.existsSync.mockReturnValue(true)
      writeConfig('settings', { x: 1 })
      expect(mockedFs.unlinkSync).toHaveBeenCalled()
    })

    it('returns false on write error', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.writeFileSync.mockImplementation(() => { throw new Error('disk full') })
      const result = writeConfig('settings', {})
      expect(result).toBe(false)
    })
  })

  describe('configHasData', () => {
    it('returns true if known config files exist', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readdirSync.mockReturnValue(['commands.json', 'settings.json'] as any)
      expect(configHasData()).toBe(true)
    })

    it('returns false if directory does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)
      expect(configHasData()).toBe(false)
    })

    it('returns false if no known files exist', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readdirSync.mockReturnValue(['random.txt'] as any)
      expect(configHasData()).toBe(false)
    })
  })

  describe('loadAllConfig', () => {
    it('loads all config keys into data object', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readdirSync.mockReturnValue(['commands.json'] as any)
      mockedFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('commands')) return JSON.stringify([{ id: 'c1' }])
        return 'null'
      })
      const { data, needsMigration } = loadAllConfig()
      expect(needsMigration).toBe(false)
      expect(data).toHaveProperty('commands')
      expect(data).toHaveProperty('configs')
      expect(data).toHaveProperty('settings')
      expect(data).toHaveProperty('cloudAgents')
    })

    it('includes agentTeams and agentTeamRuns keys', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readdirSync.mockReturnValue(['agent-teams.json'] as any)
      mockedFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('agent-teams')) return JSON.stringify([{ id: 'team-1' }])
        if (typeof p === 'string' && p.includes('agent-team-runs')) return JSON.stringify([{ id: 'tr-1' }])
        return 'null'
      })
      const { data } = loadAllConfig()
      expect(data).toHaveProperty('agentTeams')
      expect(data).toHaveProperty('agentTeamRuns')
    })

    it('returns needsMigration=true when no config files exist', () => {
      mockedFs.existsSync.mockImplementation((p: any) => {
        // CONFIG dir doesn't exist for configHasData check
        if (typeof p === 'string' && p.endsWith('CONFIG')) return false
        return false
      })
      mockedFs.readdirSync.mockReturnValue([] as any)
      const { needsMigration } = loadAllConfig()
      expect(needsMigration).toBe(true)
    })
  })
})
