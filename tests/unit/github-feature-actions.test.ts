// tests/unit/github-feature-actions.test.ts
// Renderer store actions for per-account feature toggles. Mocks the preload
// surface; asserts WHICH IPC each action uses (profile patch vs config
// update) because routing is the safety property here — per-account toggle
// writes MUST go through the profile-patch IPC (updateProfile), never a
// wholesale authProfiles write through updateConfig (which shallow-merges and
// could drop tokenCiphertext).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useGitHubStore } from '../../src/renderer/stores/githubStore'

const updateProfileMock = vi.fn().mockResolvedValue({ ok: true })
const updateConfigMock = vi.fn().mockImplementation(async (patch: Record<string, unknown>) => ({
  schemaVersion: 1,
  authProfiles: {},
  featureToggles: {},
  syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
  enabledByDefault: false,
  transcriptScanningOptIn: false,
  ...patch,
}))
// loadConfig() re-hydrates after every write. Return null so the store falls
// back to emptyGitHubConfig() — the actions complete; we assert on the routing
// mocks above, not on post-refresh state.
const getConfigMock = vi.fn().mockResolvedValue(null)

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  github: {
    ...((globalThis as any).window?.electronAPI?.github ?? {}),
    getConfig: getConfigMock,
    updateProfile: updateProfileMock,
    updateConfig: updateConfigMock,
  },
}

function seed(profiles: Array<{ id: string; toggles?: Record<string, boolean> }>) {
  useGitHubStore.setState({
    config: {
      schemaVersion: 1,
      authProfiles: Object.fromEntries(profiles.map((p) => [p.id, {
        id: p.id, kind: 'oauth', label: p.id, username: p.id, scopes: [],
        capabilities: [], createdAt: 0, lastVerifiedAt: 0, expiryObservable: false,
        featureToggles: p.toggles as never,
      }])),
      featureToggles: {
        activePR: true, ci: true, reviews: true, linkedIssues: true,
        notifications: true, localGit: true, sessionContext: true,
      },
      featureDefaults: {
        activePR: true, ci: true, reviews: true, linkedIssues: true,
        notifications: true, aiCredits: false,
      },
      appWideToggles: { localGit: true, sessionContext: true },
      syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
      enabledByDefault: false,
      transcriptScanningOptIn: false,
    } as never,
  })
}

const allOn = { activePR: true, ci: true, reviews: true, linkedIssues: true, notifications: true, aiCredits: true }
const allOff = { activePR: false, ci: false, reviews: false, linkedIssues: false, notifications: false, aiCredits: false }

beforeEach(() => {
  updateProfileMock.mockClear()
  updateConfigMock.mockClear()
  getConfigMock.mockClear()
})

describe('per-account feature actions', () => {
  it('setProfileFeature patches that profile only, via the profile IPC', async () => {
    seed([{ id: 'a', toggles: allOn }, { id: 'b', toggles: allOn }])
    await useGitHubStore.getState().setProfileFeature('a', 'ci', false)
    expect(updateProfileMock).toHaveBeenCalledTimes(1)
    expect(updateProfileMock).toHaveBeenCalledWith('a', { featureToggles: { ...allOn, ci: false } })
    expect(updateConfigMock).not.toHaveBeenCalled()
  })
  it('setMasterFeature patches every profile AND persists featureDefaults', async () => {
    seed([{ id: 'a', toggles: allOn }, { id: 'b', toggles: allOff }])
    await useGitHubStore.getState().setMasterFeature('notifications', true)
    expect(updateProfileMock).toHaveBeenCalledTimes(2)
    expect(updateConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ featureDefaults: expect.objectContaining({ notifications: true }) }))
  })
  it('applyProfileToAll copies the source map to every other profile', async () => {
    seed([{ id: 'a', toggles: allOn }, { id: 'b', toggles: allOff }, { id: 'c', toggles: allOff }])
    await useGitHubStore.getState().applyProfileToAll('a')
    expect(updateProfileMock).toHaveBeenCalledTimes(2) // b and c, not a
    expect(updateProfileMock).toHaveBeenCalledWith('b', { featureToggles: allOn })
    expect(updateProfileMock).toHaveBeenCalledWith('c', { featureToggles: allOn })
  })
  it('setMasterFeature with zero profiles writes featureDefaults only', async () => {
    seed([])
    await useGitHubStore.getState().setMasterFeature('aiCredits', true)
    expect(updateProfileMock).not.toHaveBeenCalled()
    expect(updateConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ featureDefaults: expect.objectContaining({ aiCredits: true }) }))
  })
  it('setAppWideToggle writes appWideToggles via config update', async () => {
    seed([{ id: 'a', toggles: allOn }])
    await useGitHubStore.getState().setAppWideToggle('localGit', false)
    expect(updateConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ appWideToggles: expect.objectContaining({ localGit: false }) }))
    expect(updateProfileMock).not.toHaveBeenCalled()
  })
})
