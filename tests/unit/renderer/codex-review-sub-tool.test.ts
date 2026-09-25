// @vitest-environment jsdom
/**
 * The Conductor MCP page's review cards (WP2 final fixes): each shows the
 * state main offers its tool on (conductor-mcp-server createServer,
 * offeredReviewTool): the built-in tools master, the tool's own switch, the
 * reviewing provider on, and a review that could be prepared now (the
 * snapshot's providers[].review.ready). Never a fixed "Available".
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, AccountView, ProviderInstallationView } from '../../../src/shared/providers'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: CodexReviewSubTool } = await import('../../../src/renderer/components/conductor-mcp/CodexReviewSubTool')
const { default: ClaudeReviewSubTool } = await import('../../../src/renderer/components/conductor-mcp/ClaudeReviewSubTool')
const { reviewSubToolState } = await import('../../../src/renderer/components/conductor-mcp/ReviewSubToolCard')

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
    lifecycle: 'active', isProviderDefault: true, isReviewerDefault: false, authMethod: 'browser',
    lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active',
    external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
    ...over,
  }
}

const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work' })
const me = account({ id: 'acc-me', providerId: 'claude', identityId: 'id-me', providerLabel: 'me@example.com', legacyId: 'profile-primary', legacyLinked: true })
const local = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })

function snapshot(providers: { claude?: Partial<ProviderInstallationView>; codex?: Partial<ProviderInstallationView> } = {}, accounts: AccountView[] = [work, me]): AccountsSnapshot {
  return {
    revision: 1,
    registry: { mode: 'ready' },
    providers: [
      provider({ providerId: 'claude', displayName: 'Claude Code', review: { ready: true, accountId: me.id, source: 'provider-default' }, ...providers.claude }),
      provider({ providerId: 'codex', displayName: 'Codex', review: { ready: true, accountId: work.id, source: 'provider-default' }, ...providers.codex }),
    ],
    identities: [
      { id: 'id-work', friendlyName: 'Work', colourKey: 'indigo' },
      { id: 'id-me', friendlyName: 'Me', colourKey: 'mauve' },
      { id: 'id-ext', friendlyName: 'External Codex sign-in (account unverified)', colourKey: 'slate-blue' },
    ],
    groups: [],
    accounts,
    pendingSetups: [],
    externalDefaults: [],
    conflicts: [],
    reviewerNotices: [],
  }
}

const ctx = (over: Partial<Parameters<typeof reviewSubToolState>[2]> = {}) => ({ masterOn: true, toolOn: true, platform: 'win32', loaded: true, settings: {}, ...over })

describe('reviewSubToolState: the conditions main offers each review tool on', () => {
  it('Available only with the master and the tool switch on, the reviewing provider on and a review ready', () => {
    for (const tool of ['codexReview', 'claudeReview'] as const) {
      expect(reviewSubToolState(snapshot(), tool, ctx())).toEqual({ label: 'Available', color: 'green', reason: null, note: null })
    }
  })

  it('the built-in tools master off, or the tool its own switch off: Off, saying where to turn it on', () => {
    expect(reviewSubToolState(snapshot(), 'codexReview', ctx({ masterOn: false }))).toMatchObject({ label: 'Off', reason: 'The built-in tools are off. Turn them on in Settings, General, Built-in Tools.' })
    expect(reviewSubToolState(snapshot(), 'codexReview', ctx({ toolOn: false }))).toMatchObject({ label: 'Off', reason: 'Codex review is off. Turn it on in Settings, General, Built-in Tools.' })
    expect(reviewSubToolState(snapshot(), 'claudeReview', ctx({ toolOn: false }))).toMatchObject({ label: 'Off', reason: 'Claude review is off. Turn it on in Settings, General, Built-in Tools.' })
  })

  it('the reviewing provider off, by its saved setting or the live snapshot: Off, with the way back', () => {
    expect(reviewSubToolState(snapshot(), 'codexReview', ctx({ settings: { codexEnabled: false } }))).toMatchObject({ label: 'Off', reason: 'Codex is off. Turn it on in Settings, Accounts.' })
    expect(reviewSubToolState(snapshot({ codex: { enabled: false } }), 'codexReview', ctx())).toMatchObject({ label: 'Off', reason: 'Codex is off. Turn it on in Settings, Accounts.' })
    expect(reviewSubToolState(snapshot(), 'claudeReview', ctx({ settings: { claudeEnabled: false } }))).toMatchObject({ label: 'Off', reason: 'Claude Code is off. Turn it on in Settings, Accounts.' })
  })

  it('no account that can review: Unavailable, saying why', () => {
    const noCodex = snapshot({ codex: { review: { ready: false, accountId: local.id, source: 'provider-default' } } }, [local, me])
    expect(reviewSubToolState(noCodex, 'codexReview', ctx())).toMatchObject({
      label: 'Unavailable', color: 'yellow', reason: 'No Codex account can run reviews. Add a Codex account (a sign-in from ~/.codex cannot review).',
    })
    const noClaude = snapshot({ claude: { review: { ready: false, source: 'provider-default' } } })
    expect(reviewSubToolState(noClaude, 'claudeReview', ctx())).toMatchObject({ label: 'Unavailable', reason: 'No Claude account can run reviews right now.' })
    // A provider that reports no review readiness at all is not offered either.
    expect(reviewSubToolState(snapshot({ codex: { review: undefined } }), 'codexReview', ctx())).toMatchObject({ label: 'Unavailable', reason: 'No review can run right now. Check Settings, Accounts.' })
  })

  it('before the first account list: Checking; with none to be had: Unavailable', () => {
    expect(reviewSubToolState(null, 'codexReview', ctx({ loaded: false }))).toMatchObject({ label: 'Checking', reason: 'Checking accounts...' })
    expect(reviewSubToolState(null, 'codexReview', ctx({ loaded: true }))).toMatchObject({ label: 'Unavailable', reason: 'The account list is not available right now.' })
  })

  it('Claude review while Codex is off is still offered, with a note: only Codex sessions use it', () => {
    expect(reviewSubToolState(snapshot(), 'claudeReview', ctx({ settings: { codexEnabled: false } }))).toEqual({
      label: 'Available', color: 'green', reason: null, note: 'Only Codex sessions use it; Codex is off.',
    })
  })
})

describe('the review cards on the Conductor MCP page', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as any).electronPlatform = 'win32'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  })

  const show = (card: React.FC, snap: AccountsSnapshot | null, settings: Record<string, unknown> = {}) => {
    useProviderAccountsStore.setState({ snapshot: snap, loaded: true })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...settings } as typeof DEFAULT_SETTINGS })
    act(() => { root.render(React.createElement(card)) })
    return container.textContent ?? ''
  }
  const reason = (tool: string) => container.querySelector(`[data-testid="review-sub-tool-${tool}-reason"]`)?.textContent

  it('the Codex review card: Available with the conditions it is offered under, and codex_review', () => {
    const text = show(CodexReviewSubTool, snapshot())
    expect(text).toContain('Codex review (Claude-driven)')
    expect(text).toContain('Available')
    expect(text).toContain('Offered to local Claude Code sessions with a real project folder while Codex is on (Settings, Accounts), a Codex account there can run reviews, and Codex review is on (Settings, General, Built-in Tools).')
    expect(text).toContain('codex_review')
    expect(text).not.toContain('Tokenomics')
    expect(reason('codexReview')).toBeUndefined()
  })

  it('the Codex review card with Codex off says Off and why, never Available', () => {
    const text = show(CodexReviewSubTool, snapshot(), { codexEnabled: false })
    expect(text).not.toContain('Available')
    expect(text).toContain('Off')
    expect(reason('codexReview')).toBe('Codex is off. Turn it on in Settings, Accounts.')
  })

  it('the Codex review card with its switch off, or no account that can review, is not Available', () => {
    let text = show(CodexReviewSubTool, snapshot(), { conductorTools: { vision: true, codexReview: false, claudeReview: true, hostTransfer: true, canvas: true } })
    expect(text).not.toContain('Available')
    expect(reason('codexReview')).toBe('Codex review is off. Turn it on in Settings, General, Built-in Tools.')
    act(() => { root.unmount() })
    root = createRoot(container)
    text = show(CodexReviewSubTool, snapshot({ codex: { review: { ready: false, accountId: local.id, source: 'provider-default' } } }, [local, me]))
    expect(text).toContain('Unavailable')
    expect(reason('codexReview')).toBe('No Codex account can run reviews. Add a Codex account (a sign-in from ~/.codex cannot review).')
  })

  it('the Claude review card: Available for Codex sessions with the conditions it is offered under, and claude_review', () => {
    const text = show(ClaudeReviewSubTool, snapshot())
    expect(text).toContain('Claude review (Codex-driven)')
    expect(text).toContain('Available')
    expect(text).toContain('Offered to local Codex sessions with a real project folder while Claude Code is on (Settings, Accounts), a Claude account there can run reviews, and Claude review is on (Settings, General, Built-in Tools).')
    expect(text).toContain('claude_review')
  })

  it('the Claude review card with Claude Code off, or the built-in tools off, is not Available', () => {
    let text = show(ClaudeReviewSubTool, snapshot(), { claudeEnabled: false })
    expect(text).not.toContain('Available')
    expect(reason('claudeReview')).toBe('Claude Code is off. Turn it on in Settings, Accounts.')
    act(() => { root.unmount() })
    root = createRoot(container)
    text = show(ClaudeReviewSubTool, snapshot(), { conductorToolsEnabled: false })
    expect(text).not.toContain('Available')
    expect(reason('claudeReview')).toBe('The built-in tools are off. Turn them on in Settings, General, Built-in Tools.')
  })
})
