import { create } from 'zustand'
import type {
  GitHubConfig,
  AuthProfile,
  RepoCache,
  NotificationSummary,
  AiUsageReport,
  AiUsageStatus,
  AiUsagePayload,
  GitHubAuthFeatureKey,
  GitHubAppWideFeatureKey,
} from '../../shared/github-types'
import { DEFAULT_AUTH_FEATURE_TOGGLES, emptyGitHubConfig } from '../../shared/github-constants'
import { effectiveToggleMap } from '../../shared/github-features'

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
  // AI-credits (Copilot) usage meter. null until the first fetch resolves or
  // the meter is disabled. Consumed by the usage-meter UI (chip, popover,
  // Settings action row, Tokenomics card).
  aiUsage: AiUsageReport | null
  // Structured reason that travels alongside aiUsage so the UI can tell apart
  // "no data yet" from "token lacks the billing scope" from "no GitHub auth".
  // 'pending' until the first fetch resolves.
  aiUsageStatus: AiUsageStatus

  loadConfig: () => Promise<void>
  updateConfig: (patch: Partial<GitHubConfig>) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  renameProfile: (id: string, label: string) => Promise<void>
  // Per-account feature toggle writes. ROUTING RULE: these patch each profile
  // through the profile-update IPC (patch semantics), never a wholesale
  // authProfiles write through updateConfig. Each write sends the FULL toggle
  // map (read-modify-write via effectiveToggle) so partial maps inherit
  // featureDefaults at write time.
  setProfileFeature: (
    profileId: string,
    key: GitHubAuthFeatureKey,
    on: boolean,
  ) => Promise<void>
  setMasterFeature: (key: GitHubAuthFeatureKey, on: boolean) => Promise<void>
  applyProfileToAll: (sourceId: string) => Promise<void>
  setAppWideToggle: (key: GitHubAppWideFeatureKey, on: boolean) => Promise<void>
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
  loadAiUsage: () => Promise<void>
  handleAiUsageUpdate: (payload: AiUsagePayload) => void
}

const DEFAULT_PANEL_WIDTH = 340

// Serializes toggle writes: each action re-reads state AFTER the previous
// write's loadConfig() so rapid UI clicks cannot read-modify-write from the
// same stale snapshot and silently undo each other.
let toggleWriteQueue: Promise<void> = Promise.resolve()
function enqueueToggleWrite(work: () => Promise<void>): Promise<void> {
  const run = toggleWriteQueue.then(work, work)
  toggleWriteQueue = run.catch(() => {})
  return run
}

export const useGitHubStore = create<GitHubStoreState>((set, get) => ({
  config: null,
  profiles: [],
  repoData: {},
  panelVisible: true,
  sessionStates: {},
  syncStatus: {},
  notificationsByProfile: {},
  aiUsage: null,
  aiUsageStatus: 'pending',

  loadConfig: async () => {
    const config = await window.electronAPI.github.getConfig()
    if (config) {
      set({ config, profiles: Object.values(config.authProfiles) })
    } else {
      // No config file yet (first launch). Render UI with defaults; the first
      // updateConfig call will persist. Avoids a stuck "Loading…" state.
      set({ config: emptyGitHubConfig(), profiles: [] })
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

  // Toggle one feature on a single account. Reads the account's effective map
  // (own toggles, falling back to featureDefaults), flips the one key, and
  // writes the WHOLE map back through the profile-patch IPC — never updateConfig.
  // Serialized (enqueueToggleWrite) so the snapshot is re-read INSIDE the thunk,
  // after any prior write's loadConfig() — rapid clicks can't RMW a stale map.
  setProfileFeature: (profileId, key, on) =>
    enqueueToggleWrite(async () => {
      const cfg = get().config
      const p = cfg?.authProfiles[profileId]
      if (!cfg || !p) return
      const next = effectiveToggleMap(p, cfg.featureDefaults)
      next[key] = on
      await window.electronAPI.github.updateProfile(profileId, { featureToggles: next })
      await get().loadConfig()
    }),

  // Master toggle: flip one feature on EVERY account (each via its own profile
  // patch) AND persist featureDefaults so the intent survives zero accounts and
  // seeds newly added ones. Profiles go through the profile IPC; featureDefaults
  // (a root field) goes through updateConfig. Serialized + snapshot re-read
  // inside the thunk (F2). Per-profile failures are isolated (F4): a rejected
  // write is logged and skipped, the remaining profiles + featureDefaults still
  // write, and loadConfig() always runs in the finally.
  setMasterFeature: (key, on) =>
    enqueueToggleWrite(async () => {
      const cfg = get().config
      if (!cfg) return
      try {
        for (const p of Object.values(cfg.authProfiles)) {
          const next = effectiveToggleMap(p, cfg.featureDefaults)
          next[key] = on
          try {
            await window.electronAPI.github.updateProfile(p.id, { featureToggles: next })
          } catch (err) {
            console.warn('[github] toggle write failed for profile', p.id, err)
          }
        }
        // Sparse pre-migration configs may carry a partial (or absent)
        // featureDefaults; layer DEFAULT_AUTH_FEATURE_TOGGLES underneath so the
        // persisted map is always complete for every auth feature key (F3).
        await window.electronAPI.github.updateConfig({
          featureDefaults: {
            ...DEFAULT_AUTH_FEATURE_TOGGLES,
            ...(cfg.featureDefaults ?? {}),
            [key]: on,
          } as Record<GitHubAuthFeatureKey, boolean>,
        })
      } finally {
        await get().loadConfig()
      }
    }),

  // Copy a source account's effective toggle map onto every OTHER account.
  // Each target is patched via the profile IPC; the source is left untouched.
  // Serialized + snapshot re-read inside the thunk (F2). A failed per-target
  // write is logged and skipped so one bad write doesn't abort the rest (F4);
  // loadConfig() always runs in the finally.
  applyProfileToAll: (sourceId) =>
    enqueueToggleWrite(async () => {
      const cfg = get().config
      const src = cfg?.authProfiles[sourceId]
      if (!cfg || !src) return
      const map = effectiveToggleMap(src, cfg.featureDefaults)
      try {
        for (const p of Object.values(cfg.authProfiles)) {
          if (p.id === sourceId) continue
          try {
            await window.electronAPI.github.updateProfile(p.id, { featureToggles: map })
          } catch (err) {
            console.warn('[github] toggle write failed for profile', p.id, err)
          }
        }
      } finally {
        await get().loadConfig()
      }
    }),

  // App-wide (no-auth) toggle. Root-level field → updateConfig, never a profile
  // patch. No account is touched. Serialized + snapshot re-read inside the thunk
  // (F2) so it can't RMW a stale appWideToggles map against a concurrent write.
  setAppWideToggle: (key, on) =>
    enqueueToggleWrite(async () => {
      const cfg = get().config
      if (!cfg) return
      await window.electronAPI.github.updateConfig({
        appWideToggles: { ...(cfg.appWideToggles ?? {}), [key]: on } as Record<
          GitHubAppWideFeatureKey,
          boolean
        >,
      })
      await get().loadConfig()
    }),

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

  loadAiUsage: async () => {
    // Drives a main-side fetch (or returns the cached report + status). Returns
    // a null report when the meter is disabled / unauthed; we still set it so
    // the UI reflects the cleared state rather than a stale report. The status
    // tells the UI WHY the report is null (scope-missing / no-auth / pending).
    const payload = await window.electronAPI.github.getAiUsage()
    set({ aiUsage: payload?.report ?? null, aiUsageStatus: payload?.status ?? 'pending' })
  },

  handleAiUsageUpdate: (payload) =>
    set({ aiUsage: payload?.report ?? null, aiUsageStatus: payload?.status ?? 'pending' }),
}))

// Module-local unsubscribes so setupGitHubListener is idempotent — calling it
// multiple times (e.g. in strict-mode dev) doesn't install duplicate listeners.
let unsubData: (() => void) | null = null
let unsubSync: (() => void) | null = null
let unsubNotif: (() => void) | null = null
let unsubAiUsage: (() => void) | null = null

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
  unsubAiUsage = window.electronAPI.github.onAiUsageUpdate((payload) =>
    useGitHubStore.getState().handleAiUsageUpdate(payload),
  )
}

export function teardownGitHubListener(): void {
  unsubData?.()
  unsubSync?.()
  unsubNotif?.()
  unsubAiUsage?.()
  unsubData = null
  unsubSync = null
  unsubNotif = null
  unsubAiUsage = null
}
