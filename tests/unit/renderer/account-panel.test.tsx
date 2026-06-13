// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import AccountPanel from '../../../src/renderer/components/github/config/AccountPanel'
import AccountsSection from '../../../src/renderer/components/github/config/AccountsSection'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import type {
  AuthProfile,
  Capability,
  GitHubAuthFeatureKey,
  GitHubConfig,
} from '../../../src/shared/github-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(ui)
  })
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

const allOn: Record<GitHubAuthFeatureKey, boolean> = {
  activePR: true, ci: true, reviews: true, linkedIssues: true, notifications: true, aiCredits: true,
}

// Capabilities that cover all six auth features (pulls, actions, issues,
// notifications, plan). Profile 'a' is fully covered; profile 'b' is missing
// `plan` so aiCredits-on -> pending re-auth.
const FULL_CAPS: Capability[] = ['pulls', 'actions', 'issues', 'notifications', 'plan']
const CAPS_NO_PLAN: Capability[] = ['pulls', 'actions', 'issues', 'notifications']

function makeProfile(
  id: string,
  caps: Capability[],
  toggles?: Record<GitHubAuthFeatureKey, boolean>,
): AuthProfile {
  return {
    id,
    kind: 'oauth',
    label: id === 'a' ? 'Work' : 'Personal',
    username: id === 'a' ? 'work-user' : 'personal-user',
    scopes: ['repo', 'workflow'],
    capabilities: caps,
    createdAt: 0,
    lastVerifiedAt: 0,
    expiryObservable: false,
    featureToggles: toggles,
  }
}

function makeConfig(profiles: AuthProfile[]): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: Object.fromEntries(profiles.map((p) => [p.id, p])),
    featureToggles: {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: true, localGit: true, sessionContext: true,
    },
    featureDefaults: {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: false, aiCredits: false,
    },
    appWideToggles: { localGit: true, sessionContext: true },
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

function makeSession(id: string, label: string, authProfileId?: string): Session {
  return {
    id,
    label,
    workingDirectory: '/repo',
    model: 'opus',
    color: '#fff',
    status: 'idle',
    createdAt: 0,
    sessionType: 'local',
    githubIntegration: authProfileId
      ? { enabled: true, authProfileId, autoDetected: false }
      : undefined,
  }
}

function seedGitHub(
  config: GitHubConfig,
  actions?: {
    setProfileFeature?: ReturnType<typeof vi.fn>
    applyProfileToAll?: ReturnType<typeof vi.fn>
    removeProfile?: ReturnType<typeof vi.fn>
    renameProfile?: ReturnType<typeof vi.fn>
  },
) {
  useGitHubStore.setState({
    config,
    profiles: Object.values(config.authProfiles),
    setProfileFeature: actions?.setProfileFeature ?? vi.fn(),
    applyProfileToAll: actions?.applyProfileToAll ?? vi.fn(),
    removeProfile: actions?.removeProfile ?? vi.fn(),
    renameProfile: actions?.renameProfile ?? vi.fn(),
  } as never)
}

function seedSessions(sessions: Session[]) {
  useSessionStore.setState({ sessions } as never)
}

function switchFor(container: HTMLElement, label: string): HTMLElement {
  return container.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLElement
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined
}

function featuresTabButton(container: HTMLElement): HTMLButtonElement {
  // The Features tab label gains a trailing warning glyph when pending, so match
  // by includes rather than exact text.
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Features'),
  ) as HTMLButtonElement
}

beforeEach(() => {
  useGitHubStore.setState({ config: null, profiles: [] } as never)
  useSessionStore.setState({ sessions: [] } as never)
  vi.restoreAllMocks()
})

describe('AccountPanel', () => {
  it('header shows pending chip + primary Re-auth for an uncovered profile, plain Re-auth for a covered one', () => {
    // profile b: missing `plan`, aiCredits ON -> pending
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]))
    const rb = render(<AccountPanel profile={b} index={0} />)
    expect(rb.container.textContent).toContain('re-auth needed')
    expect(rb.container.textContent).toContain('AI credits usage')
    // primary Re-auth button uses the blue primary style
    const reauthB = buttonByText(rb.container, 'Re-auth')
    expect(reauthB).toBeTruthy()
    expect(reauthB!.className).toContain('bg-blue')
    rb.unmount()

    // profile a: fully covered, all on -> NOT pending
    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]))
    const ra = render(<AccountPanel profile={a} index={0} />)
    expect(ra.container.textContent).not.toContain('re-auth needed')
    const reauthA = buttonByText(ra.container, 'Re-auth')
    expect(reauthA).toBeTruthy()
    expect(reauthA!.className).not.toContain('bg-blue')
    ra.unmount()
  })

  it('status tab shows "Powers 5 of 6" and the bound live session for the missing-plan profile', () => {
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]))
    seedSessions([
      makeSession('s1', 'fix the parser', 'b'),
      makeSession('s2', 'unrelated', undefined),
    ])
    const r = render(<AccountPanel profile={b} index={0} />)
    expect(r.container.textContent).toContain('Powers 5 of 6')
    expect(r.container.textContent).toContain('fix the parser')
    r.unmount()
  })

  it('status tab shows "no live sessions right now" when none are bound', () => {
    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]))
    seedSessions([makeSession('s1', 'something', undefined)])
    const r = render(<AccountPanel profile={a} index={0} />)
    expect(r.container.textContent).toContain('no live sessions right now')
    r.unmount()
  })

  it('features tab: uncovered+on row shows "activates after re-auth" with switch ON; toggling calls setProfileFeature with the inverse', () => {
    const setProfileFeature = vi.fn()
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]), { setProfileFeature })
    const r = render(<AccountPanel profile={b} index={0} />)
    // switch to the Features tab
    const featuresTab = featuresTabButton(r.container)
    act(() => {
      featuresTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(r.container.textContent).toContain('activates after re-auth')
    const sw = switchFor(r.container, 'AI credits usage')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    act(() => {
      sw.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(setProfileFeature).toHaveBeenCalledWith('b', 'aiCredits', false)
    r.unmount()
  })

  it('"Apply to all accounts" calls applyProfileToAll and is absent with a single profile', () => {
    const applyProfileToAll = vi.fn()
    const a = makeProfile('a', FULL_CAPS, allOn)
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([a, b]), { applyProfileToAll })
    const r = render(<AccountPanel profile={a} index={0} />)
    const featuresTab = featuresTabButton(r.container)
    act(() => {
      featuresTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const applyBtn = buttonByText(r.container, 'Apply to all accounts')
    expect(applyBtn).toBeTruthy()
    act(() => {
      applyBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(applyProfileToAll).toHaveBeenCalledWith('a')
    r.unmount()

    // single profile -> no Apply button
    seedGitHub(makeConfig([a]), { applyProfileToAll })
    const r2 = render(<AccountPanel profile={a} index={0} />)
    const featuresTab2 = featuresTabButton(r2.container)
    act(() => {
      featuresTab2.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(buttonByText(r2.container, 'Apply to all accounts')).toBeUndefined()
    r2.unmount()
  })

  it('Features tab label carries the warning glyph only when pending', () => {
    const warn = String.fromCodePoint(0x26a0)
    // pending profile -> glyph present
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]))
    const rb = render(<AccountPanel profile={b} index={0} />)
    const featTabB = Array.from(rb.container.querySelectorAll('button')).find((x) =>
      x.textContent?.includes('Features'),
    )!
    expect(featTabB.textContent).toContain(warn)
    rb.unmount()

    // covered profile -> no glyph
    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]))
    const ra = render(<AccountPanel profile={a} index={0} />)
    const featTabA = Array.from(ra.container.querySelectorAll('button')).find((x) =>
      x.textContent?.includes('Features'),
    )!
    expect(featTabA.textContent).not.toContain(warn)
    ra.unmount()
  })

  it('Remove keeps the confirm() guard: confirm=false does not call removeProfile', () => {
    const removeProfile = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]), { removeProfile })
    const r = render(<AccountPanel profile={a} index={0} />)
    const removeBtn = buttonByText(r.container, 'Remove')
    act(() => {
      removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(removeProfile).not.toHaveBeenCalled()
    r.unmount()
  })
})

describe('AccountsSection', () => {
  it('renders the empty card when there are no profiles', () => {
    seedGitHub(makeConfig([]))
    seedSessions([])
    const r = render(<AccountsSection />)
    expect(r.container.textContent).toContain('No auth profiles yet')
    // and the primary add button
    expect(r.container.textContent).toContain('Sign in with GitHub')
    r.unmount()
  })

  it('renders one AccountPanel per profile', () => {
    seedGitHub(makeConfig([makeProfile('a', FULL_CAPS, allOn), makeProfile('b', CAPS_NO_PLAN, allOn)]))
    seedSessions([])
    const r = render(<AccountsSection />)
    expect(r.container.textContent).toContain('Work')
    expect(r.container.textContent).toContain('Personal')
    r.unmount()
  })
})
