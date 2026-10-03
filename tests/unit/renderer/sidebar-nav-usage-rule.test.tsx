// @vitest-environment jsdom
//
// Usage track MP4, D4 (approved as drawn): the Account usage entry on the nav
// rail shows with 2+ accounts in total across the providers that are on:
// Claude Code's profiles while Claude Code is on, plus Codex's listed
// (non-archived) accounts once Codex is answered on. One Claude account and
// one Codex account are two. A provider that is off, or Codex not set up,
// counts nothing.
//
// PURE: the real SidebarNav with its stores set directly; no IPC.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountProfile } from '../../../src/shared/account-types'
import type { AccountsSnapshot, AccountView } from '../../../src/shared/providers'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: SidebarNav } = await import('../../../src/renderer/components/sidebar/SidebarNav')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { choiceSettings } = await import('../../../src/renderer/onboarding/provider-choice')

const profile = (id: string): AccountProfile => ({ id, name: id, accountEmail: `${id}@example.com`, createdAt: 0 })
const account = (id: string, over: Partial<AccountView> = {}): AccountView => ({
  id, providerId: 'codex', identityId: `identity-${id}`, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false,
  authMethod: 'browser', lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted',
  realmLifecycle: 'active', external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
  ...over,
})
const snapshotOf = (accounts: AccountView[]): AccountsSnapshot => ({
  revision: 1, registry: { mode: 'ready' } as AccountsSnapshot['registry'], providers: [], identities: [], groups: [], accounts,
  pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
})

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useAccountProfilesStore.setState({ profiles: [] })
  useProviderAccountsStore.setState({ snapshot: null, loaded: false })
})

function shown(o: { claudeOn: boolean; answer: 'on' | 'off' | 'not set up'; claude: number; codexAccounts: AccountView[] }): boolean {
  // The switches as Settings saves them; "not set up" is no answer at all.
  const answer = o.answer === 'not set up' ? {} : choiceSettings(o.answer === 'on' ? 'both' : 'claude')
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...answer, claudeEnabled: o.claudeOn }, isLoaded: true })
  useAccountProfilesStore.setState({ profiles: Array.from({ length: o.claude }, (_, i) => profile(`profile-${i}`)) })
  useProviderAccountsStore.setState({ snapshot: snapshotOf(o.codexAccounts), loaded: true })
  act(() => root.render(React.createElement(SidebarNav, {
    currentView: 'sessions', onViewChange: () => {}, insightsStatus: null, insightsMessage: null, cloudAgentRunning: 0, onShowAccountUsage: () => {},
  } as React.ComponentProps<typeof SidebarNav>)))
  return container.querySelector('[aria-label="Account usage"]') !== null
}

describe('the Account usage rail entry (D4)', () => {
  it('two Claude Code profiles, Claude Code on: shown, as before', () => {
    expect(shown({ claudeOn: true, answer: 'off', claude: 2, codexAccounts: [] })).toBe(true)
  })

  it('one Claude Code profile alone: not shown', () => {
    expect(shown({ claudeOn: true, answer: 'off', claude: 1, codexAccounts: [] })).toBe(false)
  })

  it('one Claude Code account and one Codex account, both on: shown', () => {
    expect(shown({ claudeOn: true, answer: 'on', claude: 1, codexAccounts: [account('a')] })).toBe(true)
  })

  it('a Codex account does not count while Codex is off or not set up', () => {
    expect(shown({ claudeOn: true, answer: 'off', claude: 1, codexAccounts: [account('a')] })).toBe(false)
    expect(shown({ claudeOn: true, answer: 'not set up', claude: 1, codexAccounts: [account('a')] })).toBe(false)
  })

  it('Claude Code profiles do not count while Claude Code is off', () => {
    expect(shown({ claudeOn: false, answer: 'off', claude: 3, codexAccounts: [] })).toBe(false)
    expect(shown({ claudeOn: false, answer: 'on', claude: 3, codexAccounts: [account('a')] })).toBe(false)
  })

  it('two Codex accounts with Claude Code off: shown', () => {
    expect(shown({ claudeOn: false, answer: 'on', claude: 0, codexAccounts: [account('a'), account('b')] })).toBe(true)
  })

  it('an archived Codex account does not count; an inactive one does', () => {
    expect(shown({ claudeOn: true, answer: 'on', claude: 1, codexAccounts: [account('a', { lifecycle: 'archived' })] })).toBe(false)
    expect(shown({ claudeOn: true, answer: 'on', claude: 1, codexAccounts: [account('a', { lifecycle: 'inactive' })] })).toBe(true)
  })
})
