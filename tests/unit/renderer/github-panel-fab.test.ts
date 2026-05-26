// @vitest-environment jsdom
/**
 * UAT R2 Task B: when the GitHub panel is minimised (either because the
 * session has no integration configured, or the user has collapsed it via
 * Ctrl+/), it must NOT render a thin vertical rail. Instead it renders a
 * single floating logo button (FAB) that:
 *   - is absolutely positioned (overlays the terminal's top-right corner),
 *   - shows the octocat SVG (no literal "GH" text),
 *   - opens the setup modal when integration is not configured,
 *   - toggles the panel when integration IS configured but collapsed.
 *
 * Uses React.createElement (not JSX) so the file stays a *.test.ts under the
 * vitest include glob.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const togglePanel = vi.fn()

let githubState: any = {
  panelVisible: true,
  sessionStates: {},
  syncStatus: {},
  repoData: {},
  togglePanel,
  setPanelWidth: vi.fn(),
}

let sessionState: { sessions: any[] } = { sessions: [] }

vi.mock('../../../src/renderer/stores/githubStore', () => {
  const useGitHubStore: any = (selector: (s: typeof githubState) => unknown) => selector(githubState)
  useGitHubStore.getState = () => githubState
  return { useGitHubStore }
})

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (selector: (s: typeof sessionState) => unknown) => selector(sessionState)
  useSessionStore.getState = () => sessionState
  return { useSessionStore }
})

vi.mock('../../../src/renderer/stores/tipsStore', () => ({
  trackUsage: vi.fn(),
}))

vi.mock('../../../src/renderer/hooks/useFocusTrap', () => ({
  useFocusTrap: () => {},
}))

// Section components + the setup config form pull in heavy deps; stub them so
// the panel renders in isolation. The FAB states never mount the sections, but
// the expanded branch (and the setup modal's config form) reference them.
vi.mock('../../../src/renderer/components/session/SessionGitHubConfig', () => ({
  default: () => React.createElement('div', { 'data-testid': 'gh-config' }),
}))

const stubSection = (testid: string) => ({ default: () => React.createElement('div', { 'data-testid': testid }) })
vi.mock('../../../src/renderer/components/github/sections/SessionContextSection', () => stubSection('s-context'))
vi.mock('../../../src/renderer/components/github/sections/ActivePRSection', () => stubSection('s-pr'))
vi.mock('../../../src/renderer/components/github/sections/CISection', () => stubSection('s-ci'))
vi.mock('../../../src/renderer/components/github/sections/ReviewsSection', () => stubSection('s-reviews'))
vi.mock('../../../src/renderer/components/github/sections/IssuesSection', () => stubSection('s-issues'))
vi.mock('../../../src/renderer/components/github/sections/LocalGitSection', () => stubSection('s-localgit'))
vi.mock('../../../src/renderer/components/github/sections/NotificationsSection', () => stubSection('s-notifications'))

const { default: GitHubPanel } = await import('../../../src/renderer/components/github/GitHubPanel')

let container: HTMLDivElement
let root: Root

const SESSION_ID = 'sess-1'

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  togglePanel.mockReset()
  ;(globalThis as any).window.electronPlatform = 'win32'
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(): void {
  act(() => {
    root.render(React.createElement(GitHubPanel, { sessionId: SESSION_ID }))
  })
}

function fabButton(): HTMLButtonElement | null {
  return container.querySelector('button[data-testid="gh-fab"]') as HTMLButtonElement | null
}

describe('GitHubPanel collapsed states render a floating FAB (no rail)', () => {
  it('integration NOT configured: shows the octocat FAB, no rail, no literal "GH"', () => {
    sessionState = { sessions: [{ id: SESSION_ID, githubIntegration: { enabled: false } }] }
    githubState = { ...githubState, panelVisible: true }
    render()

    // No thin rail <aside>.
    expect(container.querySelector('aside')).toBeNull()
    // The FAB exists, is absolutely positioned, and carries the octocat SVG.
    const fab = fabButton()
    expect(fab).not.toBeNull()
    expect(fab!.className).toContain('absolute')
    expect(fab!.querySelector('svg')).not.toBeNull()
    // No literal "GH" text anywhere.
    expect(container.textContent).not.toContain('GH')
  })

  it('integration NOT configured: clicking the FAB opens the setup modal', () => {
    sessionState = { sessions: [{ id: SESSION_ID, githubIntegration: { enabled: false } }] }
    githubState = { ...githubState, panelVisible: true }
    render()

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    act(() => { fabButton()!.click() })
    const dialog = container.querySelector('[role="dialog"][aria-modal="true"]')
    expect(dialog).not.toBeNull()
    // The FAB opens setup, it does NOT toggle the panel.
    expect(togglePanel).not.toHaveBeenCalled()
  })

  it('integration configured but collapsed: shows the octocat FAB, no rail', () => {
    sessionState = { sessions: [{ id: SESSION_ID, githubIntegration: { enabled: true, repoSlug: 'o/r' } }] }
    githubState = { ...githubState, panelVisible: false }
    render()

    expect(container.querySelector('aside')).toBeNull()
    const fab = fabButton()
    expect(fab).not.toBeNull()
    expect(fab!.className).toContain('absolute')
    expect(fab!.querySelector('svg')).not.toBeNull()
  })

  it('integration configured but collapsed: clicking the FAB toggles the panel', () => {
    sessionState = { sessions: [{ id: SESSION_ID, githubIntegration: { enabled: true, repoSlug: 'o/r' } }] }
    githubState = { ...githubState, panelVisible: false }
    render()

    act(() => { fabButton()!.click() })
    expect(togglePanel).toHaveBeenCalledTimes(1)
    // It must NOT pop the setup modal.
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('integration configured AND visible: renders the full panel aside, no FAB', () => {
    sessionState = { sessions: [{ id: SESSION_ID, githubIntegration: { enabled: true, repoSlug: 'o/r' } }] }
    githubState = { ...githubState, panelVisible: true }
    render()

    expect(container.querySelector('aside[aria-label="GitHub panel"]')).not.toBeNull()
    expect(fabButton()).toBeNull()
  })
})
