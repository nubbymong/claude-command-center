import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'

// Patch `window.electronAPI.github` onto the existing window rather than
// replacing `globalThis.window` wholesale. The Vitest global setup installs a
// shared window.electronAPI mock that other renderer tests rely on; clobbering
// it here leaked across files and broke unrelated suites when this test ran
// first.
let originalElectronAPI: unknown
let windowCreatedByTest = false

function buildGithubMock() {
  return {
    getConfig: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      authProfiles: {
        p1: {
          id: 'p1',
          kind: 'oauth',
          label: 'nub',
          username: 'nub',
          scopes: ['public_repo'],
          capabilities: ['pulls'],
          createdAt: 0,
          lastVerifiedAt: 0,
          expiryObservable: false,
        },
      },
      featureToggles: {
        activePR: true,
        ci: true,
        reviews: true,
        linkedIssues: true,
        notifications: false,
        localGit: true,
        sessionContext: true,
      },
      syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
      enabledByDefault: false,
      transcriptScanningOptIn: false,
    }),
    updateConfig: vi.fn().mockImplementation(async (patch: Record<string, unknown>) => ({
      schemaVersion: 1,
      authProfiles: {},
      featureToggles: {},
      syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
      enabledByDefault: false,
      transcriptScanningOptIn: false,
      ...patch,
    })),
    removeProfile: vi.fn().mockResolvedValue({ ok: true }),
    renameProfile: vi.fn().mockResolvedValue({ ok: true }),
    onDataUpdate: vi.fn().mockImplementation(() => () => {}),
    onSyncStateUpdate: vi.fn().mockImplementation(() => () => {}),
  }
}

function setupMockElectron() {
  const root = globalThis as unknown as { window?: Record<string, unknown> }
  if (root.window) {
    originalElectronAPI = root.window.electronAPI
    root.window.electronAPI = {
      ...((root.window.electronAPI as Record<string, unknown> | undefined) ?? {}),
      github: buildGithubMock(),
    }
  } else {
    windowCreatedByTest = true
    root.window = { electronAPI: { github: buildGithubMock() } }
  }
}

function restoreMockElectron() {
  const root = globalThis as unknown as { window?: Record<string, unknown> }
  if (!root.window) return
  if (windowCreatedByTest) {
    delete root.window
    windowCreatedByTest = false
    return
  }
  if (originalElectronAPI === undefined) {
    delete (root.window as Record<string, unknown>).electronAPI
  } else {
    root.window.electronAPI = originalElectronAPI as Record<string, unknown>
  }
  originalElectronAPI = undefined
}

describe('githubStore', () => {
  beforeEach(() => {
    setupMockElectron()
    useGitHubStore.setState({
      config: null,
      profiles: [],
      repoData: {},
      panelVisible: true,
      sessionStates: {},
      syncStatus: {},
    })
  })
  afterEach(() => {
    restoreMockElectron()
  })

  it('loadConfig populates config + profiles', async () => {
    await useGitHubStore.getState().loadConfig()
    expect(useGitHubStore.getState().profiles).toHaveLength(1)
    expect(useGitHubStore.getState().profiles[0].username).toBe('nub')
  })

  it('togglePanel flips visibility', () => {
    useGitHubStore.getState().togglePanel()
    expect(useGitHubStore.getState().panelVisible).toBe(false)
  })

  it('setSectionCollapsed persists per session', () => {
    useGitHubStore.getState().setSectionCollapsed('s1', 'localGit', true)
    expect(
      useGitHubStore.getState().sessionStates.s1.collapsedSections.localGit,
    ).toBe(true)
  })

  it('setPanelWidth persists per session', () => {
    useGitHubStore.getState().setPanelWidth('s1', 420)
    expect(useGitHubStore.getState().sessionStates.s1.panelWidth).toBe(420)
  })

  it('handleDataUpdate stores per slug', () => {
    useGitHubStore.getState().handleDataUpdate({
      slug: 'a/b',
      data: { etags: {}, lastSynced: 1, accessedAt: 1 },
    })
    expect(useGitHubStore.getState().repoData['a/b']).toBeDefined()
  })

  it('handleSyncStateUpdate stores per slug', () => {
    useGitHubStore.getState().handleSyncStateUpdate({
      slug: 'a/b',
      state: 'synced',
      at: 123,
    })
    expect(useGitHubStore.getState().syncStatus['a/b'].state).toBe('synced')
  })
})
