import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Per-test isolated config dir. mkdtempSync gives a unique path so concurrent
// tests cannot collide on session-state.json. Mocked BEFORE importing the
// module-under-test so the lazy getConfigDir() picks it up on first call.
let testRoot: string
let testConfigDir: string

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => testRoot,
}))

vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

// Reset module cache between describe blocks so getConfigDir's internal cache
// is rebuilt against the freshly-mkdtempSync'd path. Without this every test
// would resolve to the first dir created, leaking state across cases.
async function importFresh() {
  vi.resetModules()
  const sessionStateMod = await import('../../src/main/session-state')
  return sessionStateMod
}

describe('session-state -- githubIntegration round trip (regression #280)', () => {
  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'gh-persist-'))
    testConfigDir = join(testRoot, 'CONFIG')
    mkdirSync(testConfigDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  it('preserves githubIntegration.enabled across save -> load', async () => {
    const { saveSessionState, loadSessionState } = await importFresh()

    const state = {
      sessions: [{
        id: 's1',
        configId: 'cfg-web',
        label: 'Web App',
        workingDirectory: '/tmp/web',
        color: '#89B4FA',
        sessionType: 'local' as const,
        githubIntegration: {
          enabled: true,
          repoUrl: 'https://github.com/owner/repo',
          repoSlug: 'owner/repo',
          autoDetected: false,
        },
        provider: 'claude' as const,
        claudeOptions: {},
      }],
      activeSessionId: 's1',
      savedAt: Date.now(),
    }

    expect(saveSessionState(state)).toBe(true)
    expect(existsSync(join(testConfigDir, 'session-state.json'))).toBe(true)

    const loaded = loadSessionState()
    expect(loaded).not.toBeNull()
    expect(loaded!.sessions).toHaveLength(1)
    expect(loaded!.sessions[0].githubIntegration).toEqual({
      enabled: true,
      repoUrl: 'https://github.com/owner/repo',
      repoSlug: 'owner/repo',
      autoDetected: false,
    })
  })

  it('preserves githubIntegration when migrateConfigToProviderShape runs (legacy claude fields present)', async () => {
    // Simulates a legacy save written before the v1.5 migration -- the
    // session has top-level Claude fields AND githubIntegration. The
    // migration moves Claude fields into claudeOptions; githubIntegration
    // must pass through unchanged because it is not in CLAUDE_FIELDS.
    const { saveSessionState, loadSessionState } = await importFresh()

    const state = {
      sessions: [{
        id: 's1',
        label: 'legacy session',
        workingDirectory: '/tmp/old',
        color: '#A6E3A1',
        sessionType: 'local' as const,
        // Legacy top-level claude fields (pre-1.5)
        model: 'claude-opus-4-6',
        effortLevel: 'high' as const,
        flickerFree: true,
        githubIntegration: {
          enabled: true,
          repoUrl: 'https://github.com/legacy/proj',
          repoSlug: 'legacy/proj',
          autoDetected: true,
        },
      }],
      activeSessionId: 's1',
      savedAt: Date.now(),
    }

    saveSessionState(state as any)
    const loaded = loadSessionState()

    expect(loaded!.sessions[0].githubIntegration).toEqual({
      enabled: true,
      repoUrl: 'https://github.com/legacy/proj',
      repoSlug: 'legacy/proj',
      autoDetected: true,
    })
    // Sanity: migration moved claude fields into claudeOptions.
    expect((loaded!.sessions[0] as any).claudeOptions?.model).toBe('claude-opus-4-6')
    expect((loaded!.sessions[0] as any).claudeOptions?.effortLevel).toBe('high')
  })

  it('treats absent githubIntegration as undefined on round-trip (no fabrication)', async () => {
    const { saveSessionState, loadSessionState } = await importFresh()

    const state = {
      sessions: [{
        id: 's1',
        label: 'no integration',
        workingDirectory: '/tmp/x',
        color: '#FAB387',
        sessionType: 'local' as const,
        provider: 'claude' as const,
      }],
      activeSessionId: 's1',
      savedAt: Date.now(),
    }

    saveSessionState(state as any)
    const loaded = loadSessionState()

    expect(loaded!.sessions[0].githubIntegration).toBeUndefined()
  })
})
