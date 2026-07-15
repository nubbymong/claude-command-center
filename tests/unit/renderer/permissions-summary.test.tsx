// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import PermissionsSummary from '../../../src/renderer/components/github/config/PermissionsSummary'
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

const allOff: Record<GitHubAuthFeatureKey, boolean> = {
  activePR: false,
  ci: false,
  reviews: false,
  linkedIssues: false,
  notifications: false,
  aiCredits: false,
}

function makeProfile(
  id: string,
  toggles?: Record<GitHubAuthFeatureKey, boolean>,
): AuthProfile {
  return {
    id,
    kind: 'oauth',
    label: id,
    username: id,
    scopes: [],
    capabilities: [],
    createdAt: 0,
    lastVerifiedAt: 0,
    expiryObservable: false,
    featureToggles: toggles,
  }
}

function makeConfig(
  profiles: AuthProfile[],
  featureDefaults?: Record<GitHubAuthFeatureKey, boolean>,
): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: Object.fromEntries(profiles.map((p) => [p.id, p])),
    featureToggles: {
      activePR: true,
      ci: true,
      reviews: true,
      linkedIssues: true,
      notifications: true,
      localGit: true,
      sessionContext: true,
    },
    featureDefaults: featureDefaults ?? {
      activePR: false,
      ci: false,
      reviews: false,
      linkedIssues: false,
      notifications: false,
      aiCredits: false,
    },
    appWideToggles: { localGit: true, sessionContext: true },
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

function seed(config: GitHubConfig) {
  useGitHubStore.setState({
    config,
    profiles: Object.values(config.authProfiles),
  } as never)
}

function disclosure(container: HTMLElement): HTMLElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('What each feature needs'),
  )
  return btn as HTMLElement
}

function clickDisclosure(container: HTMLElement) {
  const btn = disclosure(container)
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// Read the OAuth public-scopes <code> by its block label rather than DOM order,
// so a future markup reorder can't silently select the wrong scope block.
function publicScopesText(container: HTMLElement): string {
  const code = Array.from(container.querySelectorAll('code')).find((c) =>
    (c.closest('div')?.textContent ?? '').includes('public repos only'),
  )
  return code?.textContent ?? ''
}

beforeEach(() => {
  useGitHubStore.setState({ config: null, profiles: [] } as never)
})

describe('PermissionsSummary', () => {
  it('drawer is collapsed by default and expands on click', () => {
    seed(makeConfig([makeProfile('a', { ...allOff, activePR: true })]))
    const r = render(<PermissionsSummary />)
    // disclosure button present, body collapsed
    expect(disclosure(r.container)).toBeTruthy()
    expect(r.container.textContent).not.toContain('Fine-grained PAT permissions')
    clickDisclosure(r.container)
    expect(r.container.textContent).toContain('Fine-grained PAT permissions')
    r.unmount()
  })

  it('disclosure button keeps a visible keyboard focus ring (codebase convention)', () => {
    seed(makeConfig([makeProfile('a', allOff)]))
    const r = render(<PermissionsSummary />)
    expect(disclosure(r.container).className).toContain('focus-visible:ring-1')
    r.unmount()
  })

  it('derives required scopes from per-account state, not the global featureToggles', () => {
    // Profile enables only activePR (pulls). NOT ci / notifications / aiCredits.
    // The legacy global featureToggles has notifications:true, but that must
    // NOT leak into the derivation.
    seed(makeConfig([makeProfile('a', { ...allOff, activePR: true })]))
    const r = render(<PermissionsSummary />)
    clickDisclosure(r.container)
    const publicScopes = publicScopesText(r.container)
    expect(publicScopes).toContain('public_repo')
    expect(publicScopes).not.toContain('workflow')
    expect(publicScopes).not.toContain('notifications')
    expect(publicScopes).not.toContain('user')
    r.unmount()
  })

  it('aiCredits enabled contributes the user OAuth scope and the Plan fine-grained permission', () => {
    seed(makeConfig([makeProfile('a', { ...allOff, aiCredits: true })]))
    const r = render(<PermissionsSummary />)
    clickDisclosure(r.container)
    const publicScopes = publicScopesText(r.container)
    expect(publicScopes).toContain('user')
    expect(r.container.textContent).toContain('Plan: read (Account)')
    r.unmount()
  })

  it('zero profiles with a default-on feature derives required from featureDefaults', () => {
    seed(
      makeConfig([], {
        activePR: true,
        ci: false,
        reviews: false,
        linkedIssues: false,
        notifications: false,
        aiCredits: false,
      }),
    )
    const r = render(<PermissionsSummary />)
    clickDisclosure(r.container)
    const publicScopes = publicScopesText(r.container)
    expect(publicScopes).toContain('public_repo')
    r.unmount()
  })

  it('a feature enabled on only one of two profiles still contributes (mixed counts as on)', () => {
    seed(
      makeConfig([
        makeProfile('a', allOff),
        makeProfile('b', { ...allOff, notifications: true }),
      ]),
    )
    const r = render(<PermissionsSummary />)
    clickDisclosure(r.container)
    const publicScopes = publicScopesText(r.container)
    expect(publicScopes).toContain('notifications')
    r.unmount()
  })

  it('no enabled features anywhere renders no em dashes in the local-only copy', () => {
    seed(makeConfig([makeProfile('a', allOff)]))
    const r = render(<PermissionsSummary />)
    clickDisclosure(r.container)
    expect(r.container.textContent).not.toContain('—')
    r.unmount()
  })
})
