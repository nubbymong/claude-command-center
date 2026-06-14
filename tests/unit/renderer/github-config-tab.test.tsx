// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import GitHubConfigTab from '../../../src/renderer/components/github/config/GitHubConfigTab'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'
import type {
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

const allOff: Record<GitHubAuthFeatureKey, boolean> = {
  activePR: false,
  ci: false,
  reviews: false,
  linkedIssues: false,
  notifications: false,
  aiCredits: false,
}

// Zero authProfiles keeps the tab test simple: AccountsSection renders its
// empty card, no AccountPanel mounts, so no useSessionStore seeding is needed.
function makeConfig(): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: {},
    featureToggles: {
      activePR: true,
      ci: true,
      reviews: true,
      linkedIssues: true,
      notifications: true,
      localGit: true,
      sessionContext: true,
    },
    featureDefaults: { ...allOff },
    appWideToggles: { localGit: true, sessionContext: true },
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

// The tab calls loadConfig() in a useEffect; loadConfig() does real IPC
// (window.electronAPI.github.getConfig()) which is undefined in jsdom. Inject a
// no-op and seed config/profiles directly so render has data without IPC.
function seed(config: GitHubConfig, updateConfig: (patch: Partial<GitHubConfig>) => void) {
  useGitHubStore.setState({
    config,
    profiles: Object.values(config.authProfiles),
    loadConfig: async () => {},
    updateConfig,
  } as never)
}

function h3Texts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('h3')).map((h) => (h.textContent ?? '').trim())
}

function drawerButton(container: HTMLElement): HTMLElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('What each feature needs'),
  )
  return btn as HTMLElement
}

function h3ByText(container: HTMLElement, text: string): HTMLElement {
  const h = Array.from(container.querySelectorAll('h3')).find(
    (el) => (el.textContent ?? '').trim() === text,
  )
  return h as HTMLElement
}

beforeEach(() => {
  useGitHubStore.setState({ config: null, profiles: [] } as never)
})

describe('GitHubConfigTab', () => {
  it('renders sections account-first with the permissions drawer at the bottom', () => {
    seed(makeConfig(), vi.fn())
    const r = render(<GitHubConfigTab />)

    const headings = h3Texts(r.container)
    expect(headings.slice(0, 4)).toEqual(['Accounts', 'App-wide (no auth)', 'Privacy', 'Sync'])

    // The PermissionsSummary drawer now sits at the BOTTOM as the collapsed
    // reference. Its collapsed header is a <button>, not an <h3>, so verify its
    // document position relative to the last real heading via
    // compareDocumentPosition: the drawer button comes AFTER Sync, not between
    // Accounts and Privacy. (The Copilot AI-credits config moved out of this tab
    // into the Status Line tab as of the cycle-meter redesign.)
    const btn = drawerButton(r.container)
    const sync = h3ByText(r.container, 'Sync')
    expect(btn).toBeTruthy()
    // Sync comes before the drawer button.
    expect(
      sync.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    r.unmount()
  })

  it('app-wide toggles are the only role="switch" controls at the tab level (zero profiles)', () => {
    seed(makeConfig(), vi.fn())
    const r = render(<GitHubConfigTab />)

    // With ZERO authProfiles there is no AccountPanel and no MasterFeaturesSection,
    // so the ONLY switches at the tab level are AppWideFeatures' two app-wide rows.
    const switches = r.container.querySelectorAll('[role="switch"]')
    const switchLabels = Array.from(switches).map((s) => s.getAttribute('aria-label') ?? '')
    expect(switchLabels).toEqual(['Local git state', 'Session context'])

    // The per-account auth features live in AccountPanel, which isn't mounted
    // with zero profiles. They must NOT appear as switches at the tab level.
    expect(switchLabels).not.toContain('Active PR card')
    expect(switchLabels).not.toContain('Notifications inbox')

    // And the legacy FeatureTogglesList checkbox mechanism is gone: no
    // input[type=checkbox] carries those per-feature aria-labels (a revert to
    // the checkbox list would reintroduce them and fail here).
    const checkboxLabels = Array.from(
      r.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).map((c) => c.getAttribute('aria-label') ?? '')
    expect(checkboxLabels).not.toContain('Active PR card')
    expect(checkboxLabels).not.toContain('Notifications inbox')
    r.unmount()
  })

  it('enable-by-default checkbox still writes updateConfig({ enabledByDefault })', () => {
    const updateConfig = vi.fn()
    seed(makeConfig(), updateConfig)
    const r = render(<GitHubConfigTab />)

    const checkbox = Array.from(
      r.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((c) => (c.closest('label')?.textContent ?? '').includes('Enable by default for new sessions'))
    expect(checkbox).toBeTruthy()

    // Dispatching a real click on the (unchecked) checkbox flips checked → true
    // and fires React's synthetic onChange for the controlled input.
    expect(checkbox!.checked).toBe(false)
    act(() => {
      checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(updateConfig).toHaveBeenCalledWith({ enabledByDefault: true })
    r.unmount()
  })
})
