import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'

function setupMockElectron() {
  // Per codebase convention the bridge is exposed as `window.electronAPI`
  // (not `window.electron`). Matches preload + all existing renderer call sites.
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    electronAPI: {
      github: {
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
      },
    },
  }
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
