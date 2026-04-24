import { create } from 'zustand'
import type {
  GitHubConfig,
  AuthProfile,
  RepoCache,
  NotificationSummary,
} from '../../shared/github-types'
import {
  DEFAULT_FEATURE_TOGGLES,
  DEFAULT_SYNC_INTERVALS,
  GITHUB_CONFIG_SCHEMA_VERSION,
} from '../../shared/github-constants'

// First-launch default. Used client-side when no github-config.json exists yet
// so the UI renders immediately instead of sitting on "Loading…" forever.
// The first user mutation persists this + the patch via updateConfig.
function emptyConfig(): GitHubConfig {
  return {
    schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
    authProfiles: {},
    featureToggles: { ...DEFAULT_FEATURE_TOGGLES },
    syncIntervals: { ...DEFAULT_SYNC_INTERVALS },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

export interface SessionPanelState {
  panelWidth: number
  collapsedSections: Record<string, boolean>
}

export interface SyncStatus {
  state: 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'
  at: number
  nextResetAt?: number
}

interface GitHubStoreState {
  config: GitHubConfig | null
  profiles: AuthProfile[]
  repoData: Record<string, RepoCache>
  panelVisible: boolean
  sessionStates: Record<string, SessionPanelState>
  syncStatus: Record<string, SyncStatus>
  notificationsByProfile: Record<string, NotificationSummary[]>

  loadConfig: () => Promise<void>
  updateConfig: (patch: Partial<GitHubConfig>) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  renameProfile: (id: string, label: string) => Promise<void>
  togglePanel: () => void
  setSectionCollapsed: (sessionId: string, section: string, collapsed: boolean) => void
  setPanelWidth: (sessionId: string, w: number) => void
  handleDataUpdate: (p: { slug: string; data: RepoCache }) => void
  handleSyncStateUpdate: (p: {
    slug: string
    state: SyncStatus['state']
    at: number
    nextResetAt?: number
  }) => void
  handleNotificationsUpdate: (p: {
    profileId: string
    items: NotificationSummary[]
  }) => void
}

const DEFAULT_PANEL_WIDTH = 340

export const useGitHubStore = create<GitHubStoreState>((set, get) => ({
  config: null,
  profiles: [],
  repoData: {},
  panelVisible: true,
  sessionStates: {},
  syncStatus: {},
  notificationsByProfile: {},

  loadConfig: async () => {
    const config = await window.electronAPI.github.getConfig()
    if (config) {
      set({ config, profiles: Object.values(config.authProfiles) })
    } else {
      // No config file yet (first launch). Render UI with defaults; the first
      // updateConfig call will persist. Avoids a stuck "Loading…" state.
      set({ config: emptyConfig(), profiles: [] })
    }
  },

  updateConfig: async (patch) => {
    const updated = await window.electronAPI.github.updateConfig(patch)
    set({ config: updated, profiles: Object.values(updated.authProfiles) })
  },

  removeProfile: async (id) => {
    await window.electronAPI.github.removeProfile(id)
    await get().loadConfig()
  },

  renameProfile: async (id, label) => {
    await window.electronAPI.github.renameProfile(id, label)
    await get().loadConfig()
  },

  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),

  setSectionCollapsed: (sessionId, section, collapsed) =>
    set((s) => {
      const cur = s.sessionStates[sessionId] ?? {
        panelWidth: DEFAULT_PANEL_WIDTH,
        collapsedSections: {},
      }
      return {
        sessionStates: {
          ...s.sessionStates,
          [sessionId]: {
            ...cur,
            collapsedSections: { ...cur.collapsedSections, [section]: collapsed },
          },
        },
      }
    }),

  setPanelWidth: (sessionId, w) =>
    set((s) => {
      const cur = s.sessionStates[sessionId] ?? {
        panelWidth: DEFAULT_PANEL_WIDTH,
        collapsedSections: {},
      }
      return {
        sessionStates: { ...s.sessionStates, [sessionId]: { ...cur, panelWidth: w } },
      }
    }),

  handleDataUpdate: ({ slug, data }) =>
    set((s) => ({ repoData: { ...s.repoData, [slug]: data } })),

  handleSyncStateUpdate: ({ slug, state, at, nextResetAt }) =>
    set((s) => ({
      syncStatus: { ...s.syncStatus, [slug]: { state, at, nextResetAt } },
    })),

  handleNotificationsUpdate: ({ profileId, items }) =>
    set((s) => ({
      notificationsByProfile: { ...s.notificationsByProfile, [profileId]: items },
    })),
}))

// Module-local unsubscribes so setupGitHubListener is idempotent — calling it
// multiple times (e.g. in strict-mode dev) doesn't install duplicate listeners.
let unsubData: (() => void) | null = null
let unsubSync: (() => void) | null = null
let unsubNotif: (() => void) | null = null

export function setupGitHubListener(): void {
  if (unsubData) return
  unsubData = window.electronAPI.github.onDataUpdate((p) =>
    useGitHubStore.getState().handleDataUpdate(p),
  )
  unsubSync = window.electronAPI.github.onSyncStateUpdate((p) =>
    useGitHubStore.getState().handleSyncStateUpdate(p),
  )
  unsubNotif = window.electronAPI.github.onNotificationsUpdate((p) =>
    useGitHubStore.getState().handleNotificationsUpdate(p),
  )
}

export function teardownGitHubListener(): void {
  unsubData?.()
  unsubSync?.()
  unsubNotif?.()
  unsubData = null
  unsubSync = null
  unsubNotif = null
}
