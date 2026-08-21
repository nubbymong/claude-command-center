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
  copyFileSync: vi.fn(),
  join: vi.fn(),
}))

// Real module + a join override. A join-only stub silently undefines whatever the
// code under test picks up later (dirname/resolve/sep, once config-manager began
// using the hardening helpers).
vi.mock('path', async (importOriginal) => {
  const real = await importOriginal<typeof import('path')>()
  const join = (...parts: string[]): string => parts.join('/')
  return { ...real, default: { ...real, join }, join }
})

// config-manager now routes writes through account-profiles' hardening helpers.
// Stub them so this stays a config-manager unit test, but keep the stubs faithful
// to what the real ones do — stage, then rename — so the assertions below still
// mean what they say.
vi.mock('../../src/main/account-profiles', async () => {
  const fs = await import('fs')
  return {
    atomicWriteSecure: (file: string, data: string, mode?: number) => {
      const tmp = `${file}.stub.tmp`
      fs.writeFileSync(tmp, data, mode != null ? { flag: 'wx', mode } : { flag: 'wx' })
      fs.renameSync(tmp, file)
    },
    mkdirSecure: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
    hardenCredentialDir: vi.fn(),
    hardenCredentialFile: vi.fn(),
  }
})

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => '/mock/resources',
}))

vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

import * as fs from 'fs'
import { logError } from '../../src/main/debug-logger'

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

    it('still ensures and re-hardens when the directory already exists', () => {
      // Deliberate change: this used to skip entirely when the dir was present.
      // It must not, because an existing CONFIG created by an older build sits at
      // the umask default and would stay world-readable forever after an upgrade.
      // mkdirSecure is idempotent and also re-checks for a planted reparse point.
      mockedFs.existsSync.mockReturnValue(true)
      ensureConfigDir()
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('CONFIG'),
        { recursive: true }
      )
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

    it('returns null (not a throw) on an unregistered config key', () => {
      const result = readConfig('totally-not-a-key' as any)
      expect(result).toBeNull()
      expect(vi.mocked(logError)).toHaveBeenCalled()
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
      // The write is staged and renamed, and the staging file is created
      // EXCLUSIVELY — a link planted at that path is refused rather than
      // followed, and an explicit mode can actually apply (open(2) honours a mode
      // only on creation).
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('"items"'),
        expect.objectContaining({ flag: 'wx' })
      )
      expect(mockedFs.renameSync).toHaveBeenCalled()
    })

    it('overwrites an existing file via rename — never the truncating copyFileSync path', () => {
      mockedFs.existsSync.mockReturnValue(true)
      const result = writeConfig('settings', { x: 1 })
      expect(result).toBe(true)
      expect(mockedFs.renameSync).toHaveBeenCalled()
      expect(mockedFs.copyFileSync).not.toHaveBeenCalled()
    })

    it('returns false on write error', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.writeFileSync.mockImplementation(() => { throw new Error('disk full') })
      const result = writeConfig('settings', {})
      expect(result).toBe(false)
    })

    it('writes the excalidraw key to excalidraw.json (regression: key was absent from CONFIG_FILES, so every draw-mode autosave failed)', () => {
      mockedFs.existsSync.mockReturnValue(true)
      // clearAllMocks() does not reset implementations, so drop the throwing
      // writeFileSync left by the preceding "write error" test.
      mockedFs.writeFileSync.mockReset()
      const result = writeConfig('excalidraw', { bySessionId: {} })
      expect(result).toBe(true)
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('excalidraw.json'),
        expect.any(String),
        expect.objectContaining({ flag: 'wx' })
      )
    })

    it('fails closed (false), never writes, on an unregistered config key', () => {
      mockedFs.existsSync.mockReturnValue(true)
      const result = writeConfig('totally-not-a-key' as any, { x: 1 })
      expect(result).toBe(false)
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
      expect(vi.mocked(logError)).toHaveBeenCalled()
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

    it('includes the excalidraw key so draw-mode drawings persist and restore', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readdirSync.mockReturnValue(['excalidraw.json'] as any)
      const scene = { bySessionId: { s1: { drawings: [{ id: 'd1', name: 'Untitled 1' }], activeDrawingId: 'd1' } } }
      mockedFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('excalidraw')) return JSON.stringify(scene)
        return 'null'
      })
      const { data } = loadAllConfig()
      expect(data).toHaveProperty('excalidraw')
      expect(data.excalidraw).toEqual(scene)
    })

    it('survives a null entry in configs.json instead of rejecting the whole load', () => {
      // The bug this pins: `for (const c of configs) c.sshConfig` threw
      // `Cannot read properties of null`, the throw escaped config:loadAll, and
      // the RENDERER's boot catch answered the rejection by hydrating from `{}`
      // -- writing an empty commands.json and default settings over the user's.
      // One bad array element cost the entire configuration.
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readdirSync.mockReturnValue(['configs.json'] as any)
      mockedFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('configs')) {
          return JSON.stringify([{ id: 'c1', provider: 'claude' }, null, { id: 'c2', provider: 'claude' }])
        }
        return 'null'
      })
      expect(() => loadAllConfig()).not.toThrow()
      const { data } = loadAllConfig()
      const configs = data.configs as unknown[]
      // The good entries survive AND the unreadable one is passed through
      // rather than being silently dropped -- we do not understand it, so we
      // are not entitled to delete it.
      expect(configs).toHaveLength(3)
      expect((configs[0] as any).id).toBe('c1')
      expect(configs[1]).toBeNull()
      expect((configs[2] as any).id).toBe('c2')
    })

    it('survives a primitive entry, and never writes a spread of one back', () => {
      // `{ ...'abc' }` is `{0:'a',1:'b',2:'c'}`, and this path PERSISTS, so the
      // old code would have written that back as though it were a config.
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readdirSync.mockReturnValue(['configs.json'] as any)
      mockedFs.writeFileSync.mockClear()
      mockedFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('configs')) {
          return JSON.stringify([{ id: 'c1', provider: 'claude', claudeOptions: {} }, 'abc'])
        }
        return 'null'
      })
      expect(() => loadAllConfig()).not.toThrow()
      // JSON.stringify here is indented, so match without depending on spacing.
      const written = mockedFs.writeFileSync.mock.calls
        .map((c) => String(c[1]).replace(/\s+/g, ''))
        .filter((body) => body.includes('"0":"a"'))
      expect(written).toEqual([])
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
