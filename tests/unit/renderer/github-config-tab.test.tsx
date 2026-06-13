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
  it('renders sections in the per-account order with the drawer between Accounts and Privacy', () => {
    seed(makeConfig(), vi.fn())
    const r = render(<GitHubConfigTab />)

    const headings = h3Texts(r.container)
    expect(headings.slice(0, 4)).toEqual(['Features for all accounts', 'Accounts', 'Privacy', 'Sync'])

    // The PermissionsSummary drawer's collapsed header is a <button>, not an
    // <h3>, so verify its document position relative to the Accounts/Privacy
    // headings via compareDocumentPosition.
    const btn = drawerButton(r.container)
    const accounts = h3ByText(r.container, 'Accounts')
    const privacy = h3ByText(r.container, 'Privacy')
    expect(btn).toBeTruthy()
    // Accounts comes before the drawer button.
    expect(
      accounts.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // The drawer button comes before Privacy.
    expect(
      btn.compareDocumentPosition(privacy) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    r.unmount()
  })

  it('feature mechanism is role="switch" toggles, not legacy featureToggles checkboxes', () => {
    seed(makeConfig(), vi.fn())
    const r = render(<GitHubConfigTab />)

    // MasterFeaturesSection renders one ToggleSwitch per auth feature (6) plus
    // the two app-wide rows = 8 role="switch" buttons minimum.
    const switches = r.container.querySelectorAll('[role="switch"]')
    expect(switches.length).toBeGreaterThanOrEqual(8)

    // The legacy global-toggle checkboxes are gone. No checkbox in the document
    // drives a featureToggles write: the only checkbox wired to updateConfig is
    // the enabledByDefault one, asserted in the next case. Privacy/AiUsage own
    // their own checkboxes (transcriptScanningOptIn / githubAiUsageEnabled), so
    // we don't assert a raw checkbox count; we assert no featureToggles input
    // exists by confirming the switch mechanism is what carries features.
    // The legacy FeatureTogglesList associated each feature checkbox with its
    // label via aria-label (not a wrapping <label>), so assert no
    // input[type=checkbox] carries those per-feature aria-labels: a revert to
    // the checkbox list would reintroduce them and fail here.
    const checkboxLabels = Array.from(
      r.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).map((c) => c.getAttribute('aria-label') ?? '')
    expect(checkboxLabels).not.toContain('Active PR card')
    expect(checkboxLabels).not.toContain('Notifications inbox')
    // And confirm those feature labels DO render (as switches, which carry the
    // aria-label), so the negative assertion above can't pass on a blank tab.
    const switchLabels = Array.from(switches).map((s) => s.getAttribute('aria-label') ?? '')
    expect(switchLabels).toContain('Active PR card')
    expect(switchLabels).toContain('Notifications inbox')
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
