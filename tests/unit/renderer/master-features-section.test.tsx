// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import MasterFeaturesSection from '../../../src/renderer/components/github/config/MasterFeaturesSection'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'
import type {
  AuthProfile,
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
const allOff: Record<GitHubAuthFeatureKey, boolean> = {
  activePR: false, ci: false, reviews: false, linkedIssues: false, notifications: false, aiCredits: false,
}

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
  profiles: AuthProfile[],
  opts?: {
    featureDefaults?: Record<GitHubAuthFeatureKey, boolean>
    appWideToggles?: GitHubConfig['appWideToggles']
  },
): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: Object.fromEntries(profiles.map((p) => [p.id, p])),
    featureToggles: {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: true, localGit: true, sessionContext: true,
    },
    featureDefaults: opts?.featureDefaults ?? {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: false, aiCredits: false,
    },
    appWideToggles:
      opts && 'appWideToggles' in opts
        ? opts.appWideToggles
        : { localGit: true, sessionContext: true },
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

function seed(
  config: GitHubConfig,
  actions?: { setMasterFeature?: ReturnType<typeof vi.fn>; setAppWideToggle?: ReturnType<typeof vi.fn> },
) {
  useGitHubStore.setState({
    config,
    profiles: Object.values(config.authProfiles),
    setMasterFeature: actions?.setMasterFeature ?? vi.fn(),
    setAppWideToggle: actions?.setAppWideToggle ?? vi.fn(),
  } as never)
}

const AUTH_ORDER: GitHubAuthFeatureKey[] = [
  'activePR', 'ci', 'reviews', 'linkedIssues', 'notifications', 'aiCredits',
]

function switchFor(container: HTMLElement, label: string): HTMLElement {
  return container.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLElement
}

function clickSwitch(container: HTMLElement, label: string) {
  const sw = switchFor(container, label)
  act(() => {
    sw.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const AUTH_LABELS: Record<GitHubAuthFeatureKey, string> = {
  activePR: 'Active PR card',
  ci: 'CI / Actions',
  reviews: 'Reviews & comments',
  linkedIssues: 'Linked issues',
  notifications: 'Notifications inbox',
  aiCredits: 'AI credits usage',
}

beforeEach(() => {
  useGitHubStore.setState({ config: null, profiles: [] } as never)
})

describe('MasterFeaturesSection', () => {
  it('renders six auth rows in AUTH_FEATURE_KEYS order plus two app-wide rows', () => {
    seed(makeConfig([makeProfile('a', allOn)]))
    const r = render(<MasterFeaturesSection />)
    const switches = Array.from(r.container.querySelectorAll('[role="switch"]'))
    const labels = switches.map((s) => s.getAttribute('aria-label'))
    // six auth rows first, in order
    expect(labels.slice(0, 6)).toEqual(AUTH_ORDER.map((k) => AUTH_LABELS[k]))
    // then the two app-wide rows
    expect(labels.slice(6)).toEqual(['Local git state', 'Session context'])
    expect(switches.length).toBe(8)
    r.unmount()
  })

  it('mixed feature shows the "on for 1 of 2 accounts" chip and aria-checked="mixed"', () => {
    seed(
      makeConfig([
        makeProfile('a', { ...allOff, ci: true }),
        makeProfile('b', allOff),
      ]),
    )
    const r = render(<MasterFeaturesSection />)
    const sw = switchFor(r.container, AUTH_LABELS.ci)
    expect(sw.getAttribute('aria-checked')).toBe('mixed')
    expect(r.container.textContent).toContain('on for 1 of 2 accounts')
    r.unmount()
  })

  it('clicking a mixed master calls setMasterFeature(key, true)', () => {
    const setMasterFeature = vi.fn()
    seed(
      makeConfig([
        makeProfile('a', { ...allOff, ci: true }),
        makeProfile('b', allOff),
      ]),
      { setMasterFeature },
    )
    const r = render(<MasterFeaturesSection />)
    clickSwitch(r.container, AUTH_LABELS.ci)
    expect(setMasterFeature).toHaveBeenCalledTimes(1)
    expect(setMasterFeature).toHaveBeenCalledWith('ci', true)
    r.unmount()
  })

  it('clicking an all-on master calls setMasterFeature(key, false)', () => {
    const setMasterFeature = vi.fn()
    seed(makeConfig([makeProfile('a', allOn), makeProfile('b', allOn)]), { setMasterFeature })
    const r = render(<MasterFeaturesSection />)
    clickSwitch(r.container, AUTH_LABELS.ci)
    expect(setMasterFeature).toHaveBeenCalledWith('ci', false)
    r.unmount()
  })

  it('zero profiles: rows render the "needs an account" chip and master click still fires', () => {
    const setMasterFeature = vi.fn()
    seed(
      makeConfig([], {
        featureDefaults: {
          activePR: false, ci: false, reviews: false, linkedIssues: false,
          notifications: false, aiCredits: false,
        },
      }),
      { setMasterFeature },
    )
    const r = render(<MasterFeaturesSection />)
    expect(r.container.textContent).toContain('needs an account')
    clickSwitch(r.container, AUTH_LABELS.ci)
    // ci default is off -> click turns it on
    expect(setMasterFeature).toHaveBeenCalledWith('ci', true)
    r.unmount()
  })

  it('zero profiles with a default-on feature chips "on · needs an account"', () => {
    seed(
      makeConfig([], {
        featureDefaults: {
          activePR: true, ci: false, reviews: false, linkedIssues: false,
          notifications: false, aiCredits: false,
        },
      }),
    )
    const r = render(<MasterFeaturesSection />)
    expect(r.container.textContent).toContain('on · needs an account')
    r.unmount()
  })

  it('app-wide row click calls setAppWideToggle("localGit", false) when currently on', () => {
    const setAppWideToggle = vi.fn()
    seed(makeConfig([makeProfile('a', allOn)]), { setAppWideToggle })
    const r = render(<MasterFeaturesSection />)
    const sw = switchFor(r.container, 'Local git state')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    clickSwitch(r.container, 'Local git state')
    expect(setAppWideToggle).toHaveBeenCalledWith('localGit', false)
    r.unmount()
  })

  it('tolerates appWideToggles undefined by falling back to the legacy featureToggles field', () => {
    const setAppWideToggle = vi.fn()
    const config = makeConfig([makeProfile('a', allOn)], { appWideToggles: undefined })
    // legacy featureToggles.localGit = true -> the switch reads ON
    seed(config, { setAppWideToggle })
    const r = render(<MasterFeaturesSection />)
    const sw = switchFor(r.container, 'Local git state')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    clickSwitch(r.container, 'Local git state')
    expect(setAppWideToggle).toHaveBeenCalledWith('localGit', false)
    r.unmount()
  })

  it('"All off" button calls setMasterFeature once per auth key with false', () => {
    const setMasterFeature = vi.fn()
    seed(makeConfig([makeProfile('a', allOn)]), { setMasterFeature })
    const r = render(<MasterFeaturesSection />)
    const allOffBtn = Array.from(r.container.querySelectorAll('button')).find(
      (b) => b.textContent === 'All off',
    ) as HTMLElement
    expect(allOffBtn).toBeTruthy()
    act(() => {
      allOffBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(setMasterFeature).toHaveBeenCalledTimes(AUTH_ORDER.length)
    for (const k of AUTH_ORDER) {
      expect(setMasterFeature).toHaveBeenCalledWith(k, false)
    }
    r.unmount()
  })
})
