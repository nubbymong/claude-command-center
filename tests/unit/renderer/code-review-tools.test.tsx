// @vitest-environment jsdom
/**
 * Settings, General, Built-in Tools: the Code review group (WP2 commit 6,
 * F8 and the switch states of F9).
 *
 * Verifies, for each review direction: the switch is live only while that
 * review could run, and says why not in the exact words (tools master off,
 * the reviewing provider off by its saved setting OR the live snapshot, the
 * snapshot not here yet, and each reason no account can review); a disabled
 * switch never writes; the switch writes its own key over the defaults; the
 * reviewer line names the reviewer or the default, never a refused account;
 * Claude review stays usable with a note while Codex is off; the cleared-
 * reviewer notices; the switches' accessible names and descriptions; the
 * group note and callout; and that Built-in Tools hosts the group.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, AccountView, ProviderInstallationView } from '../../../src/shared/providers'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { useSettingsStore, DEFAULT_SETTINGS, DEFAULT_CONDUCTOR_TOOLS } from '../../../src/renderer/stores/settingsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { CodeReviewTools, reviewToolView } = await import('../../../src/renderer/components/settings/CodeReviewTools')
const { BuiltinToolsSection } = await import('../../../src/renderer/components/SettingsPage')

// ---------------------------------------------------------------------------
// Fixture

function provider(over: Partial<ProviderInstallationView> & Pick<ProviderInstallationView, 'providerId' | 'displayName'>): ProviderInstallationView {
  const cap = { enabled: true, labelExperimental: false }
  return {
    enabled: true, preference: 'on', discoveryState: 'found', version: '1.0.0', compatibility: 'supported', managedAccounts: over.providerId === 'codex',
    signInMethods: { browser: cap, device: cap, apiKey: cap }, status: cap, logout: cap,
    ...over,
  }
}

function account(over: Partial<AccountView> & Pick<AccountView, 'id' | 'providerId' | 'identityId'>): AccountView {
  return {
    lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'browser',
    lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active',
    external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
    ...over,
  }
}

const personal = account({ id: 'acc-personal', providerId: 'codex', identityId: 'id-personal', providerLabel: 'alex@home.example', isReviewerDefault: true })
const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', isProviderDefault: true })
const local = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })
const claudeMain = account({ id: 'acc-claude-main', providerId: 'claude', identityId: 'id-me', providerLabel: 'me@example.com', legacyId: 'profile-primary', legacyLinked: true, isProviderDefault: true })
const claudeHome = account({ id: 'acc-claude-home', providerId: 'claude', identityId: 'id-home', providerLabel: 'alex@home.example', legacyId: 'profile-home', legacyLinked: true, isReviewerDefault: true })

function snapshot(over: Partial<AccountsSnapshot> = {}, providers?: { claude?: Partial<ProviderInstallationView>; codex?: Partial<ProviderInstallationView> }): AccountsSnapshot {
  return {
    revision: 1,
    registry: { mode: 'ready' },
    providers: [
      provider({ providerId: 'claude', displayName: 'Claude Code', review: { ready: true, accountId: claudeMain.id, source: 'provider-default' }, ...providers?.claude }),
      provider({ providerId: 'codex', displayName: 'Codex', review: { ready: true, accountId: personal.id, source: 'reviewer-default' }, ...providers?.codex }),
    ],
    identities: [
      { id: 'id-personal', friendlyName: 'Personal', colourKey: 'pink' },
      { id: 'id-work', friendlyName: 'Work', colourKey: 'indigo' },
      { id: 'id-ext', friendlyName: 'External Codex sign-in (account unverified)', colourKey: 'slate-blue' },
      { id: 'id-me', friendlyName: 'Me', colourKey: 'mauve' },
      { id: 'id-home', friendlyName: 'Home', colourKey: 'lavender' },
    ],
    groups: [],
    accounts: [personal, work, local, claudeMain, claudeHome],
    pendingSetups: [],
    externalDefaults: [],
    conflicts: [],
    reviewerNotices: [],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Harness

const updateSettings = vi.fn(() => Promise.resolve())
let container: HTMLElement
const mounted: { root: Root; container: HTMLElement }[] = []
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const sw = (key: string) => q(`review-tool-${key}`)!.querySelector('[role="switch"]') as HTMLButtonElement

function setup(opts: { snap?: AccountsSnapshot | null; settings?: Record<string, unknown>; platform?: string; loaded?: boolean } = {}) {
  ;(window as any).electronPlatform = opts.platform ?? 'win32'
  useProviderAccountsStore.setState({ snapshot: opts.snap === undefined ? snapshot() : opts.snap, loaded: opts.loaded ?? true })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) } as typeof DEFAULT_SETTINGS, updateSettings } as never)
}

function render(ui: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  act(() => { root.render(ui) })
}

const onOpenAccounts = vi.fn()
const renderTools = () => render(React.createElement(CodeReviewTools, { onOpenAccounts }))
const message = (key: string) => q(`review-tool-${key}-message`)?.textContent

beforeEach(() => {
  updateSettings.mockClear()
  onOpenAccounts.mockClear()
})

afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => { m.root.unmount() })
    m.container.remove()
  }
})

// ---------------------------------------------------------------------------

describe('Code review switches: live', () => {
  it('names the Codex reviewer and the Claude default, with a link to Accounts', async () => {
    setup()
    renderTools()
    expect(q('review-tool-codexReview-reviewer')?.textContent).toBe('Reviews use: Personal (Codex reviewer). Change in Accounts.')
    // Claude accounts are known by their email.
    expect(q('review-tool-claudeReview-reviewer')?.textContent).toBe('Reviews use: me@example.com (default). Change in Accounts.')
    expect(sw('codexReview').disabled).toBe(false)
    expect(sw('codexReview').getAttribute('aria-checked')).toBe('true')
    await act(async () => { q('review-tool-codexReview-accounts-link')!.click() })
    expect(onOpenAccounts).toHaveBeenCalledTimes(1)
  })

  it('names the chosen Claude reviewer as "(Claude reviewer)" and a Codex default as "(default)"', () => {
    setup({ snap: snapshot({}, {
      claude: { review: { ready: true, accountId: claudeHome.id, source: 'reviewer-default' } },
      codex: { review: { ready: true, accountId: work.id, source: 'provider-default' } },
    }) })
    renderTools()
    expect(q('review-tool-claudeReview-reviewer')?.textContent).toBe('Reviews use: alex@home.example (Claude reviewer). Change in Accounts.')
    expect(q('review-tool-codexReview-reviewer')?.textContent).toBe('Reviews use: Work (default). Change in Accounts.')
  })

  it('never names a refused account as the reviewer', () => {
    const refused = { ...claudeHome, reviewRefusal: { reason: 'unknown' as const, message: 'x' } }
    setup({ snap: snapshot({ accounts: [personal, work, claudeMain, refused] }, { claude: { review: { ready: true, accountId: refused.id, source: 'reviewer-default' } } }) })
    renderTools()
    expect(q('review-tool-claudeReview-reviewer')).toBeNull()
    expect(q('review-tool-claudeReview')!.textContent).not.toContain('alex@home.example')
  })

  it('writes its own key over the defaults, and each switch its own', async () => {
    setup({ settings: { conductorTools: { vision: false } } })
    renderTools()
    await act(async () => { sw('codexReview').click() })
    expect(updateSettings).toHaveBeenLastCalledWith({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, vision: false, codexReview: false } })
    await act(async () => { sw('claudeReview').click() })
    expect(updateSettings).toHaveBeenLastCalledWith({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, vision: false, claudeReview: false } })
  })

  it('turns a stored-off switch back on', async () => {
    setup({ settings: { conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, claudeReview: false } } })
    renderTools()
    expect(sw('claudeReview').getAttribute('aria-checked')).toBe('false')
    await act(async () => { sw('claudeReview').click() })
    expect(updateSettings).toHaveBeenLastCalledWith({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, claudeReview: true } })
  })

  it('names each switch by its title alone and describes it by its lines', () => {
    setup({ snap: snapshot({}, { codex: { review: { ready: false } } }) })
    renderTools()
    expect(sw('codexReview').getAttribute('aria-label')).toBe('Codex review')
    expect(sw('claudeReview').getAttribute('aria-label')).toBe('Claude review')
    const described = (key: string) => (sw(key).getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent)
    expect(described('codexReview')).toContain('No Codex account can run reviews. Add a Codex account (a sign-in from ~/.codex cannot review).')
    expect(described('claudeReview')).toContain('Reviews use: me@example.com (default). Change in Accounts.')
  })

  it('says changes apply to new sessions, and explains how a review runs', () => {
    setup()
    renderTools()
    expect(q('code-review-note')?.textContent?.trim()).toBe('Changes here or in Accounts apply to sessions started after them.')
    const callout = q('code-review-explainer')!
    expect(callout.textContent).toContain('How a review runs')
    expect(callout.textContent).toContain('A separate, one-off reviewer process on the reviewer account.')
    expect(callout.textContent).toContain("Read-only, in the asking session's project; nothing is saved as a conversation.")
    expect(callout.textContent).toContain('It never uses one of your open sessions, and it cannot ask for another review.')
  })
})

describe('Code review switches: off and cannot run', () => {
  it('disables Codex review while the snapshot says Codex is off, says so plainly, and never writes', async () => {
    setup({ snap: snapshot({}, { codex: { enabled: false } }) })
    renderTools()
    expect(sw('codexReview').disabled).toBe(true)
    expect(sw('codexReview').getAttribute('aria-checked')).toBe('false')
    expect(message('codexReview')).toBe('Codex is off. Turn it on in Settings, Accounts.')
    expect(q('review-tool-codexReview-message')!.getAttribute('data-tone')).toBe('plain')
    expect(q('review-tool-codexReview-reviewer')).toBeNull()
    await act(async () => { sw('codexReview').click() })
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it("disables Codex review when the saved setting says off, even while main's snapshot says on", () => {
    setup({ settings: { codexEnabled: false } })
    renderTools()
    expect(sw('codexReview').disabled).toBe(true)
    expect(message('codexReview')).toBe('Codex is off. Turn it on in Settings, Accounts.')
  })

  it('keeps Claude review usable while Codex is off, with a note', async () => {
    for (const setupArgs of [{ settings: { codexEnabled: false } }, { snap: snapshot({}, { codex: { enabled: false } }) }]) {
      setup(setupArgs)
      renderTools()
      expect(sw('claudeReview').disabled).toBe(false)
      expect(q('review-tool-claudeReview-note')?.textContent).toBe('Only Codex sessions use it; Codex is off.')
      await act(async () => { sw('claudeReview').click() })
      expect(updateSettings).toHaveBeenLastCalledWith({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, claudeReview: false } })
    }
    setup()
    renderTools()
    expect(q('review-tool-claudeReview-note')).toBeNull()
  })

  it('disables Claude review while Claude Code is off (snapshot or saved), and never writes', async () => {
    for (const setupArgs of [{ snap: snapshot({}, { claude: { enabled: false } }) }, { settings: { claudeEnabled: false } }]) {
      setup(setupArgs)
      renderTools()
      expect(sw('claudeReview').disabled).toBe(true)
      expect(message('claudeReview')).toBe('Claude Code is off. Turn it on in Settings, Accounts.')
      await act(async () => { sw('claudeReview').click() })
      expect(updateSettings).not.toHaveBeenCalled()
    }
  })

  it('disables both switches with "Checking accounts..." until the snapshot arrives (a saved off still says off)', () => {
    setup({ snap: null, loaded: false })
    renderTools()
    for (const key of ['codexReview', 'claudeReview']) {
      expect(sw(key).disabled, key).toBe(true)
      expect(message(key), key).toBe('Checking accounts...')
    }
    setup({ snap: null, loaded: false, settings: { codexEnabled: false } })
    renderTools()
    expect(message('codexReview')).toBe('Codex is off. Turn it on in Settings, Accounts.')
  })

  it('says the account list is unavailable, not "Checking accounts...", once the answer came back empty', () => {
    setup({ snap: null, loaded: true })
    renderTools()
    for (const key of ['codexReview', 'claudeReview']) {
      expect(sw(key).disabled, key).toBe(true)
      expect(message(key), key).toBe('The account list is not available right now.')
    }
  })

  it('disables both switches while the built-in tools master is off', async () => {
    setup({ settings: { conductorToolsEnabled: false } })
    renderTools()
    expect(sw('codexReview').disabled).toBe(true)
    expect(sw('claudeReview').disabled).toBe(true)
    await act(async () => { sw('codexReview').click() })
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('says no Codex account exists, as a warning, when there is none', () => {
    setup({ snap: snapshot({}, { codex: { review: { ready: false } } }) })
    renderTools()
    expect(sw('codexReview').disabled).toBe(true)
    expect(message('codexReview')).toBe('No Codex account can run reviews. Add a Codex account (a sign-in from ~/.codex cannot review).')
    expect(q('review-tool-codexReview-message')!.getAttribute('data-tone')).toBe('warn')
    expect(q('review-tool-codexReview-message')!.style.color).toBe('var(--status-warning)')
  })

  it("says no Codex account can review when this computer's own sign-in is the only one (others unverified or blocked do not count)", () => {
    const unvManaged = account({ id: 'acc-unv', providerId: 'codex', identityId: 'id-work', unverified: true, identityAssurance: 'realm-only' })
    const blockedManaged = { ...work, operationalState: 'blocked' as const, isProviderDefault: false }
    for (const accounts of [[local, claudeMain], [local, unvManaged, blockedManaged, claudeMain]]) {
      setup({ snap: snapshot({ accounts }, { codex: { review: { ready: false, accountId: local.id, source: 'provider-default' } } }) })
      renderTools()
      expect(message('codexReview'), accounts.map((a) => a.id).join()).toBe('No Codex account can run reviews. Add a Codex account (a sign-in from ~/.codex cannot review).')
    }
  })

  it("asks for a Codex reviewer when the default is this computer's own sign-in", () => {
    setup({ snap: snapshot({}, { codex: { review: { ready: false, accountId: local.id, source: 'provider-default' } } }) })
    renderTools()
    expect(message('codexReview')).toBe('Make a Codex account the reviewer in Accounts (a sign-in from ~/.codex cannot review).')
  })

  it('names the managed account reviews cannot run on, whatever holds it back', () => {
    for (const held of [{}, { lifecycle: 'inactive' as const }, { operationalState: 'blocked' as const }, { lastKnownAuthState: 'signed-out' as const }]) {
      const p = { ...personal, ...held }
      setup({ snap: snapshot({ accounts: [p, work, claudeMain] }, { codex: { review: { ready: false, accountId: p.id, source: 'reviewer-default' } } }) })
      renderTools()
      expect(message('codexReview'), JSON.stringify(held)).toBe("Reviews can't run on Personal right now. Check it in Accounts.")
    }
  })

  it('says the account list is unavailable when the registry is not ready', () => {
    setup({ snap: snapshot({ registry: { mode: 'recovery', reason: 'unreadable' }, accounts: [] }, { codex: { review: { ready: false } }, claude: { review: { ready: false } } }) })
    renderTools()
    expect(message('codexReview')).toBe('The account list is not available right now.')
    expect(message('claudeReview')).toBe('The account list is not available right now.')
  })

  it('gives the same reasons for Claude review', () => {
    setup({ snap: snapshot({}, { claude: { review: { ready: false } } }) })
    renderTools()
    expect(message('claudeReview')).toBe('No Claude account can run reviews right now.')

    setup({ snap: snapshot({}, { claude: { review: { ready: false, accountId: claudeMain.id, source: 'provider-default' } } }) })
    renderTools()
    expect(message('claudeReview')).toBe("Reviews can't run on me@example.com right now. Check it in Accounts.")

    const unverifiedClaude = { ...claudeHome, unverified: true, identityAssurance: 'realm-only' as const }
    setup({ snap: snapshot({ accounts: [personal, claudeMain, unverifiedClaude] }, { claude: { review: { ready: false, accountId: unverifiedClaude.id, source: 'reviewer-default' } } }) })
    renderTools()
    expect(message('claudeReview')).toBe('Make another Claude account the reviewer in Accounts (an unverified sign-in cannot review).')

    setup({ snap: snapshot({ accounts: [personal, unverifiedClaude] }, { claude: { review: { ready: false, accountId: unverifiedClaude.id, source: 'reviewer-default' } } }) })
    renderTools()
    expect(message('claudeReview')).toBe('No Claude account can run reviews right now.')
  })
})

describe('Code review switches: cleared reviewers', () => {
  it('on macOS after a cleared Claude reviewer, says reviews use the normal Claude sign-in and shows the notice', () => {
    setup({ platform: 'darwin', snap: snapshot({ reviewerNotices: [{ providerId: 'claude', message: 'On macOS only the normal sign-in can review.' }] }) })
    renderTools()
    expect(sw('claudeReview').disabled).toBe(false)
    expect(q('review-tool-claudeReview-reviewer')?.textContent).toBe('Reviews use: your normal Claude sign-in')
    expect(q('review-tool-claudeReview-notice')?.textContent).toBe('Your earlier Claude reviewer was cleared: on macOS only the normal Claude sign-in can be the Claude reviewer.')
    expect(q('review-tool-codexReview-notice')).toBeNull()
  })

  it('shows a cleared Codex reviewer notice off macOS', () => {
    setup({ snap: snapshot({ reviewerNotices: [{ providerId: 'codex', message: 'That account can no longer review here.' }] }) })
    renderTools()
    expect(q('review-tool-codexReview-notice')?.textContent).toBe('Your earlier Codex reviewer was cleared. That account can no longer review here.')
    expect(q('review-tool-claudeReview-notice')).toBeNull()
  })
})

describe('reviewToolView', () => {
  it('puts the tools master before everything else', () => {
    expect(reviewToolView(snapshot({}, { codex: { enabled: false } }), 'codexReview', { masterOn: false, platform: 'win32', settings: {} }))
      .toEqual({ disabled: true, message: null, reviewer: null, notice: null })
  })
})

describe('Built-in Tools section', () => {
  it('hosts the Code review group instead of a single "Code review" checkbox, and the master disables it', () => {
    setup()
    const save = vi.fn()
    render(React.createElement(BuiltinToolsSection, { settings: useSettingsStore.getState().settings, save, onOpenAccounts }))
    expect(q('code-review-tools')).toBeTruthy()
    expect(q('builtin-tools-list')!.contains(q('code-review-tools'))).toBe(true)
    const labels = [...container.querySelectorAll('label')].map((l) => l.textContent?.trim())
    expect(labels).not.toContain('Code review')

    setup({ settings: { conductorToolsEnabled: false } })
    render(React.createElement(BuiltinToolsSection, { settings: useSettingsStore.getState().settings, save, onOpenAccounts }))
    expect(q('builtin-tools-list')!.hasAttribute('inert')).toBe(true)
    expect(sw('codexReview').disabled).toBe(true)
    expect(sw('claudeReview').disabled).toBe(true)
  })
})
