// tests/unit/github-feature-actions.test.ts
// Renderer store actions for per-account feature toggles. Mocks the preload
// surface; asserts WHICH IPC each action uses (profile patch vs config
// update) because routing is the safety property here — per-account toggle
// writes MUST go through the profile-patch IPC (updateProfile), never a
// wholesale authProfiles write through updateConfig (which shallow-merges and
// could drop tokenCiphertext).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useGitHubStore } from '../../src/renderer/stores/githubStore'
import type {
  AuthProfile,
  GitHubAuthFeatureKey,
  GitHubConfig,
} from '../../src/shared/github-types'

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

const fullKeys: GitHubAuthFeatureKey[] = [
  'activePR', 'ci', 'reviews', 'linkedIssues', 'notifications', 'aiCredits',
]

function makeProfile(
  id: string,
  toggles?: Record<GitHubAuthFeatureKey, boolean>,
): AuthProfile {
  return {
    id, kind: 'oauth', label: id, username: id, scopes: [],
    capabilities: [], createdAt: 0, lastVerifiedAt: 0, expiryObservable: false,
    featureToggles: toggles,
  }
}

function makeConfig(
  profiles: Array<{ id: string; toggles?: Record<GitHubAuthFeatureKey, boolean> }>,
  featureDefaults?: Record<GitHubAuthFeatureKey, boolean>,
): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: Object.fromEntries(
      profiles.map((p) => [p.id, makeProfile(p.id, p.toggles)]),
    ),
    featureToggles: {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: true, localGit: true, sessionContext: true,
    },
    featureDefaults: featureDefaults ?? {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: true, aiCredits: false,
    },
    appWideToggles: { localGit: true, sessionContext: true },
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

function seed(
  profiles: Array<{ id: string; toggles?: Record<GitHubAuthFeatureKey, boolean> }>,
  featureDefaults?: Record<GitHubAuthFeatureKey, boolean>,
) {
  useGitHubStore.setState({ config: makeConfig(profiles, featureDefaults) })
}

const allOn: Record<GitHubAuthFeatureKey, boolean> = {
  activePR: true, ci: true, reviews: true, linkedIssues: true, notifications: true, aiCredits: true,
}
const allOff: Record<GitHubAuthFeatureKey, boolean> = {
  activePR: false, ci: false, reviews: false, linkedIssues: false, notifications: false, aiCredits: false,
}

beforeEach(() => {
  updateProfileMock.mockClear().mockResolvedValue({ ok: true })
  updateConfigMock.mockClear().mockImplementation(async (patch: Record<string, unknown>) => ({
    schemaVersion: 1,
    authProfiles: {},
    featureToggles: {},
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
    ...patch,
  }))
  getConfigMock.mockClear().mockResolvedValue(null)
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

  // F3 — sparse featureDefaults on a pre-migration config. The config predates
  // featureDefaults entirely; the persisted map must still come out complete
  // (all six auth keys) so downstream readers never see a partial defaults map.
  it('setMasterFeature backfills a complete featureDefaults from a config missing it', async () => {
    seed([], undefined)
    // Strip featureDefaults to simulate a pre-migration config.
    useGitHubStore.setState((s) => ({
      config: { ...(s.config as GitHubConfig), featureDefaults: undefined },
    }))
    await useGitHubStore.getState().setMasterFeature('notifications', true)
    const patch = updateConfigMock.mock.calls.at(-1)![0] as { featureDefaults: Record<string, boolean> }
    expect(Object.keys(patch.featureDefaults).sort()).toEqual([...fullKeys].sort())
    expect(patch.featureDefaults).toEqual({
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: true, // the toggled key
      aiCredits: false, // default
    })
  })

  // F4 — error isolation in the multi-profile loop. A rejected write for the
  // MIDDLE profile must not abort the loop: later profiles still get patched
  // and featureDefaults is still written.
  it('setMasterFeature isolates a failing per-profile write and still patches the rest', async () => {
    seed([{ id: 'a', toggles: allOn }, { id: 'b', toggles: allOn }, { id: 'c', toggles: allOn }])
    updateProfileMock.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('write failed for b')
      return { ok: true }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await useGitHubStore.getState().setMasterFeature('notifications', false)
    } finally {
      warnSpy.mockRestore()
    }
    // All three were attempted; c (after the failing b) still got patched.
    expect(updateProfileMock).toHaveBeenCalledTimes(3)
    expect(updateProfileMock).toHaveBeenCalledWith('c', expect.anything())
    // featureDefaults still persisted despite the mid-loop failure.
    expect(updateConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ featureDefaults: expect.objectContaining({ notifications: false }) }))
  })

  it('applyProfileToAll isolates a failing per-target write and still patches the rest', async () => {
    seed([{ id: 'a', toggles: allOn }, { id: 'b', toggles: allOff }, { id: 'c', toggles: allOff }])
    updateProfileMock.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('write failed for b')
      return { ok: true }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await useGitHubStore.getState().applyProfileToAll('a')
    } finally {
      warnSpy.mockRestore()
    }
    expect(updateProfileMock).toHaveBeenCalledWith('c', { featureToggles: allOn })
  })

  // Sparse featureDefaults in the per-PROFILE write path. A map-less profile on
  // a pre-migration/sparse config must inherit DEFAULT_AUTH_FEATURE_TOGGLES for
  // keys the sparse featureDefaults omits — NOT collapse them to false. The
  // settings UI renders rows from layered defaults, so the write path must layer
  // identically or toggling one feature silently turns the default-on ones off.
  const sparseDefaults = { activePR: true } as unknown as Record<GitHubAuthFeatureKey, boolean>
  const layeredFromSparse: Record<GitHubAuthFeatureKey, boolean> = {
    activePR: true, ci: true, reviews: true, linkedIssues: true, notifications: false, aiCredits: false,
  }

  it('setProfileFeature layers DEFAULT under a sparse featureDefaults for a map-less profile', async () => {
    seed([{ id: 'a', toggles: undefined }], sparseDefaults)
    await useGitHubStore.getState().setProfileFeature('a', 'notifications', true)
    expect(updateProfileMock).toHaveBeenCalledWith('a', {
      featureToggles: { ...layeredFromSparse, notifications: true },
    })
  })

  it('setMasterFeature layers DEFAULT under a sparse featureDefaults for a map-less profile', async () => {
    seed([{ id: 'a', toggles: undefined }], sparseDefaults)
    await useGitHubStore.getState().setMasterFeature('notifications', true)
    expect(updateProfileMock).toHaveBeenCalledWith('a', {
      featureToggles: { ...layeredFromSparse, notifications: true },
    })
  })

  it('applyProfileToAll layers DEFAULT under a sparse featureDefaults when the source has no map', async () => {
    seed([{ id: 'a', toggles: undefined }, { id: 'b', toggles: allOff }], sparseDefaults)
    await useGitHubStore.getState().applyProfileToAll('a')
    expect(updateProfileMock).toHaveBeenCalledWith('b', { featureToggles: layeredFromSparse })
  })

  // F2 — serialization against the RMW race. Two rapid setProfileFeature calls
  // on the SAME profile (different keys). The mocked updateProfile resolves on a
  // deferred promise and applies the written map back into store state; the
  // queue must make the SECOND call read-modify-write from the FIRST write's
  // result, not the original stale snapshot. Without serialization the second
  // write would carry ci:true and silently undo the first.
  it('serializes rapid setProfileFeature writes so neither undoes the other', async () => {
    seed([{ id: 'a', toggles: { ...allOn } }])

    // Backing store the deferred mocks read/write. getConfig (loadConfig) reads
    // it; updateProfile applies featureToggles into it when its deferred resolves.
    let backing = makeConfig([{ id: 'a', toggles: { ...allOn } }])
    getConfigMock.mockImplementation(async () => backing)

    const deferred: Array<{ resolve: () => void; apply: () => void }> = []
    updateProfileMock.mockImplementation((id: string, patch: { featureToggles: Record<GitHubAuthFeatureKey, boolean> }) => {
      return new Promise<{ ok: boolean }>((resolve) => {
        deferred.push({
          resolve: () => resolve({ ok: true }),
          apply: () => {
            backing = {
              ...backing,
              authProfiles: {
                ...backing.authProfiles,
                [id]: { ...backing.authProfiles[id], featureToggles: { ...patch.featureToggles } },
              },
            }
          },
        })
      })
    })

    const p1 = useGitHubStore.getState().setProfileFeature('a', 'ci', false)
    const p2 = useGitHubStore.getState().setProfileFeature('a', 'reviews', false)

    // Flush microtasks until the first write's updateProfile has been invoked.
    while (deferred.length < 1) await Promise.resolve()
    // Resolve write #1: apply its map to the backing store, then let its
    // loadConfig() hydrate store state, THEN write #2 dequeues and reads it.
    deferred[0].apply()
    deferred[0].resolve()
    await p1

    // Now write #2 should have fired, reading ci:false from the hydrated state.
    while (deferred.length < 2) await Promise.resolve()
    deferred[1].apply()
    deferred[1].resolve()
    await p2

    // The SECOND payload must include the first write's ci:false (proof it read
    // the updated snapshot, not the stale allOn one).
    const secondPayload = updateProfileMock.mock.calls[1][1] as {
      featureToggles: Record<GitHubAuthFeatureKey, boolean>
    }
    expect(secondPayload.featureToggles.ci).toBe(false)
    expect(secondPayload.featureToggles.reviews).toBe(false)
  })
})
