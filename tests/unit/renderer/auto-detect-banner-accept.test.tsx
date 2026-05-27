// @vitest-environment jsdom
/**
 * Covers the AutoDetectBanner "Use this repo" click path.
 *
 *   #436 -- the patch must be written to BOTH the live session AND the parent
 *           CONFIG so the GH repo selection survives an app restart.
 *   #437 -- when at least one auth profile exists, the click should auto-enable
 *           the integration, auto-pick a profile, and STAY on the session view.
 *           When no profiles exist, the legacy "send to Settings" behaviour
 *           should fire so the user can sign in.
 *
 * Strategy: the click handler lives in App.tsx as an inline closure, but its
 * logic is extracted into src/renderer/utils/githubAutoDetectAccept.ts. We
 * exercise the helper directly with stubbed deps for the unit assertions, then
 * also mount the real AutoDetectBanner with a wrapper that wires the helper
 * exactly like App.tsx does -- so a future refactor that drops the helper
 * import would break the harness test too.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import {
  handleAutoDetectAccept,
  pickProfileIdForSlug,
} from '../../../src/renderer/utils/githubAutoDetectAccept'
import type {
  AutoDetectAcceptDeps,
  AutoDetectAcceptProfile,
} from '../../../src/renderer/utils/githubAutoDetectAccept'
import AutoDetectBanner from '../../../src/renderer/components/github/AutoDetectBanner'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

interface BuildDepsOpts {
  profiles?: AutoDetectAcceptProfile[]
  ipcOk?: boolean
  throwOnIpc?: boolean
}

function buildDeps(opts: BuildDepsOpts = {}) {
  const profiles = opts.profiles ?? []
  const updateSessionConfig = vi.fn(async () => {
    if (opts.throwOnIpc) throw new Error('boom')
    return { ok: opts.ipcOk ?? true }
  })
  const updateSession = vi.fn()
  const updateConfig = vi.fn()
  const navigateToGitHubSettings = vi.fn()
  const deps: AutoDetectAcceptDeps = {
    electronAPI: { github: { updateSessionConfig } },
    updateSession,
    updateConfig,
    profiles,
    navigateToGitHubSettings,
  }
  return { deps, updateSessionConfig, updateSession, updateConfig, navigateToGitHubSettings }
}

describe('pickProfileIdForSlug', () => {
  it('prefers allowedRepos exact match over username', () => {
    const profiles: AutoDetectAcceptProfile[] = [
      { id: 'p-name', username: 'octocat' },
      { id: 'p-scoped', username: 'someone-else', allowedRepos: ['octocat/hello'] },
    ]
    expect(pickProfileIdForSlug('octocat/hello', profiles)).toBe('p-scoped')
  })

  it('falls back to case-insensitive username match', () => {
    const profiles: AutoDetectAcceptProfile[] = [
      { id: 'p-other', username: 'someone-else' },
      { id: 'p-owner', username: 'OctoCat' },
    ]
    expect(pickProfileIdForSlug('octocat/hello', profiles)).toBe('p-owner')
  })

  it('returns undefined when no profile matches the owner', () => {
    const profiles: AutoDetectAcceptProfile[] = [
      { id: 'p-other', username: 'someone-else' },
    ]
    expect(pickProfileIdForSlug('octocat/hello', profiles)).toBeUndefined()
  })

  it('returns undefined for an empty slug', () => {
    const profiles: AutoDetectAcceptProfile[] = [{ id: 'p-1', username: 'octocat' }]
    expect(pickProfileIdForSlug('', profiles)).toBeUndefined()
  })
})

describe('handleAutoDetectAccept -- #436 / #437', () => {
  const baseSession = {
    id: 'sess-1',
    configId: 'cfg-1',
    githubIntegration: undefined,
  }

  it('with profiles present: writes to session AND config, enables, picks profile, does NOT navigate', async () => {
    const profiles: AutoDetectAcceptProfile[] = [
      { id: 'p-owner', username: 'octocat' },
    ]
    const { deps, updateSessionConfig, updateSession, updateConfig, navigateToGitHubSettings } =
      buildDeps({ profiles })

    await handleAutoDetectAccept('octocat/hello', baseSession, deps)

    // IPC patch -- enabled true, profile resolved
    expect(updateSessionConfig).toHaveBeenCalledTimes(1)
    const [sentSessionId, sentPatch] = updateSessionConfig.mock.calls[0]
    expect(sentSessionId).toBe('sess-1')
    expect(sentPatch).toEqual({
      repoUrl: 'https://github.com/octocat/hello',
      repoSlug: 'octocat/hello',
      autoDetected: true,
      enabled: true,
      authProfileId: 'p-owner',
    })

    // Session mirror
    expect(updateSession).toHaveBeenCalledTimes(1)
    expect(updateSession.mock.calls[0][0]).toBe('sess-1')
    expect(updateSession.mock.calls[0][1]).toEqual({
      githubIntegration: {
        enabled: true,
        autoDetected: true,
        repoUrl: 'https://github.com/octocat/hello',
        repoSlug: 'octocat/hello',
        authProfileId: 'p-owner',
      },
    })

    // #436 -- parent CONFIG mirror is the previously-missing write
    expect(updateConfig).toHaveBeenCalledTimes(1)
    expect(updateConfig.mock.calls[0][0]).toBe('cfg-1')
    expect(updateConfig.mock.calls[0][1].githubIntegration.enabled).toBe(true)
    expect(updateConfig.mock.calls[0][1].githubIntegration.repoSlug).toBe('octocat/hello')

    // #437 -- already authed, do NOT navigate to Settings
    expect(navigateToGitHubSettings).not.toHaveBeenCalled()
  })

  it('with profiles present but no owner match: enables, leaves authProfileId undefined, no nav', async () => {
    const profiles: AutoDetectAcceptProfile[] = [
      { id: 'p-other', username: 'someone-else' },
    ]
    const { deps, updateSessionConfig, navigateToGitHubSettings } = buildDeps({ profiles })

    await handleAutoDetectAccept('octocat/hello', baseSession, deps)

    const sentPatch = updateSessionConfig.mock.calls[0][1]
    expect(sentPatch.enabled).toBe(true)
    expect(sentPatch.authProfileId).toBeUndefined()
    expect(navigateToGitHubSettings).not.toHaveBeenCalled()
  })

  it('with NO profiles: still writes session + config patch, then navigates to Settings (#437 fallback)', async () => {
    const { deps, updateSessionConfig, updateSession, updateConfig, navigateToGitHubSettings } =
      buildDeps({ profiles: [] })

    await handleAutoDetectAccept('octocat/hello', baseSession, deps)

    // Patch shape -- enabled is NOT flipped on; only the detected slug fields
    const sentPatch = updateSessionConfig.mock.calls[0][1]
    expect(sentPatch).toEqual({
      repoUrl: 'https://github.com/octocat/hello',
      repoSlug: 'octocat/hello',
      autoDetected: true,
    })
    expect(sentPatch.enabled).toBeUndefined()

    expect(updateSession).toHaveBeenCalledTimes(1)
    expect(updateConfig).toHaveBeenCalledTimes(1) // #436 mirror still happens

    // #437 fallback: legacy nav fires when there's no auth to use
    expect(navigateToGitHubSettings).toHaveBeenCalledTimes(1)
  })

  it('patch always contains repoUrl, repoSlug, autoDetected (authed and unauthed)', async () => {
    // Authed
    const a = buildDeps({ profiles: [{ id: 'p1', username: 'octocat' }] })
    await handleAutoDetectAccept('octocat/hello', baseSession, a.deps)
    const authedPatch = a.updateSessionConfig.mock.calls[0][1]
    expect(authedPatch.repoUrl).toBe('https://github.com/octocat/hello')
    expect(authedPatch.repoSlug).toBe('octocat/hello')
    expect(authedPatch.autoDetected).toBe(true)

    // Unauthed
    const u = buildDeps({ profiles: [] })
    await handleAutoDetectAccept('octocat/hello', baseSession, u.deps)
    const unauthedPatch = u.updateSessionConfig.mock.calls[0][1]
    expect(unauthedPatch.repoUrl).toBe('https://github.com/octocat/hello')
    expect(unauthedPatch.repoSlug).toBe('octocat/hello')
    expect(unauthedPatch.autoDetected).toBe(true)
  })

  it('skips parent-config write when the session has no configId (orphan session)', async () => {
    const orphan = { id: 'sess-2', configId: undefined, githubIntegration: undefined }
    const { deps, updateConfig } = buildDeps({ profiles: [{ id: 'p1', username: 'octocat' }] })

    await handleAutoDetectAccept('octocat/hello', orphan, deps)
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('still navigates unauthed users to Settings when the IPC write throws', async () => {
    const { deps, updateSession, updateConfig, navigateToGitHubSettings } = buildDeps({
      profiles: [],
      throwOnIpc: true,
    })

    await handleAutoDetectAccept('octocat/hello', baseSession, deps)

    // Mirrors were skipped because the IPC threw, but the user still ends up
    // on Settings so they can configure manually -- losing the write is fine,
    // losing the navigation would be worse.
    expect(updateSession).not.toHaveBeenCalled()
    expect(updateConfig).not.toHaveBeenCalled()
    expect(navigateToGitHubSettings).toHaveBeenCalledTimes(1)
  })

  it('merges over a pre-existing integration record without dropping prior fields', async () => {
    const session = {
      id: 'sess-1',
      configId: 'cfg-1',
      githubIntegration: {
        enabled: false,
        autoDetected: false,
        panelWidth: 320,
      },
    }
    const { deps, updateSession } = buildDeps({ profiles: [{ id: 'p1', username: 'octocat' }] })

    await handleAutoDetectAccept('octocat/hello', session, deps)

    const merged = updateSession.mock.calls[0][1].githubIntegration
    expect(merged.panelWidth).toBe(320) // prior field preserved
    expect(merged.enabled).toBe(true)
    expect(merged.repoSlug).toBe('octocat/hello')
  })
})

// --- DOM-level harness: confirms the click on the real banner button flows
// into the helper exactly the way App.tsx wires it up. ---
describe('AutoDetectBanner + handleAutoDetectAccept end-to-end click', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // The banner detects the slug via window.electronAPI.github.repoDetect.
    ;(globalThis as any).window.electronAPI = {
      github: {
        repoDetect: vi.fn().mockResolvedValue({ ok: true, slug: 'octocat/hello' }),
        updateSessionConfig: vi.fn().mockResolvedValue({ ok: true }),
      },
    }
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  async function flush() {
    // Two microtask drains: one for the repoDetect promise, one for the
    // post-resolve setState in the banner.
    await Promise.resolve()
    await Promise.resolve()
  }

  it('authed user clicking "Use this repo" stays on the session view', async () => {
    const navigate = vi.fn()
    const updateSession = vi.fn()
    const updateConfig = vi.fn()
    const profiles: AutoDetectAcceptProfile[] = [{ id: 'p-owner', username: 'octocat' }]

    const Harness: React.FC = () => (
      <AutoDetectBanner
        cwd="F:/repo"
        onAccept={async (slug) => {
          await handleAutoDetectAccept(
            slug,
            { id: 'sess-1', configId: 'cfg-1', githubIntegration: undefined },
            {
              electronAPI: (globalThis as any).window.electronAPI,
              updateSession,
              updateConfig,
              profiles,
              navigateToGitHubSettings: navigate,
            },
          )
        }}
        onEdit={() => {}}
        onDismiss={() => {}}
      />
    )

    await act(async () => {
      root.render(<Harness />)
      await flush()
    })

    const useBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent ?? '').includes('Use this repo'),
    )
    expect(useBtn).toBeTruthy()

    await act(async () => {
      useBtn!.click()
      await flush()
    })

    expect(updateSession).toHaveBeenCalledTimes(1)
    expect(updateConfig).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('unauthed user clicking "Use this repo" navigates to Settings', async () => {
    const navigate = vi.fn()
    const updateSession = vi.fn()
    const updateConfig = vi.fn()

    const Harness: React.FC = () => (
      <AutoDetectBanner
        cwd="F:/repo"
        onAccept={async (slug) => {
          await handleAutoDetectAccept(
            slug,
            { id: 'sess-1', configId: 'cfg-1', githubIntegration: undefined },
            {
              electronAPI: (globalThis as any).window.electronAPI,
              updateSession,
              updateConfig,
              profiles: [],
              navigateToGitHubSettings: navigate,
            },
          )
        }}
        onEdit={() => {}}
        onDismiss={() => {}}
      />
    )

    await act(async () => {
      root.render(<Harness />)
      await flush()
    })

    const useBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent ?? '').includes('Use this repo'),
    )
    expect(useBtn).toBeTruthy()

    await act(async () => {
      useBtn!.click()
      await flush()
    })

    expect(navigate).toHaveBeenCalledTimes(1)
  })
})
