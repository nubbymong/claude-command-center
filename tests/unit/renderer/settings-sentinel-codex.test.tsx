// @vitest-environment jsdom
/**
 * P3.9 (row 42): Settings, General, Sentinel, the same way for Codex. The line
 * under "Enable Sentinel" says what it watches (the assistants in use) and
 * what its analysis spends; the "Analysis account" select lists the accounts
 * of the assistant the analysis runs on (the one in use; with both on, the
 * one Ask Conductor runs on, Claude Code by default), and a Codex choice is
 * saved as its own setting. Claude Code alone reads exactly as before.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot } from '../../../src/shared/providers'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const store = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, updateSettings: null as null | ((u: Record<string, unknown>) => Promise<void>) }))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: [], activeSessionId: null }),
}))
vi.mock('../../../src/renderer/stores/settingsStore', async (orig) => {
  const real = await orig<typeof import('../../../src/renderer/stores/settingsStore')>()
  const state = () => ({ settings: { ...real.DEFAULT_SETTINGS, ...store.settings }, updateSettings: store.updateSettings })
  const hook: any = (selector: any) => selector(state())
  hook.getState = state
  hook.setState = () => {}
  hook.subscribe = () => () => {}
  return { ...real, useSettingsStore: hook }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  const state = { profiles: [{ id: 'p1', name: 'Home', accountEmail: 'home@example.com', isPrimary: true }], hydrate: vi.fn() }
  const hook: any = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state)
  hook.getState = () => state
  return { useAccountProfilesStore: hook }
})

if (typeof window !== 'undefined') {
  (window as any).electronAPI = {
    debug: { isEnabled: vi.fn().mockResolvedValue(false) },
    accountProfiles: { globalEmail: vi.fn().mockResolvedValue(null) },
  }
}

const { default: SettingsPage } = await import('../../../src/renderer/components/SettingsPage')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')

const account = (id: string, over: Record<string, unknown> = {}) => ({
  id, providerId: 'codex', identityId: `i-${id}`, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'browser',
  lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active', external: false,
  unverified: false, legacyLinked: false, ...over,
})
const SNAPSHOT = {
  revision: 1, registry: { mode: 'ready' }, providers: [], groups: [], pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
  identities: [{ id: 'i-work', friendlyName: 'Work', colourKey: 'blue' }, { id: 'i-play', friendlyName: 'Play', colourKey: 'pink' }, { id: 'i-unv', friendlyName: 'Unverified', colourKey: 'teal' }, { id: 'i-old', friendlyName: 'Old', colourKey: 'teal' }],
  accounts: [
    account('work'), account('play'),
    account('unv', { unverified: true, identityAssurance: 'realm-only' }),
    account('old', { lifecycle: 'inactive' }),
  ],
} as unknown as AccountsSnapshot

describe('Settings, Sentinel for Codex (P3.9)', () => {
  let container: HTMLDivElement
  let root: Root
  let saved: Array<Record<string, unknown>>

  beforeEach(() => {
    saved = []
    store.updateSettings = async (u) => { saved.push(u) }
    store.settings = { sentinelEnabled: true }
    act(() => useProviderAccountsStore.setState({ snapshot: SNAPSHOT, loaded: true }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  const render = () => act(() => { root.render(React.createElement(SettingsPage as React.ComponentType<{ initialTab?: string }>, { initialTab: 'general' })) })
  const analysisSelect = () => {
    const label = [...container.querySelectorAll('label, span, div')].find((e) => e.textContent === 'Analysis account')
    expect(label, 'the Analysis account field').toBeTruthy()
    const select = label!.parentElement!.querySelector('select')!
    return select as HTMLSelectElement
  }
  const options = (s: HTMLSelectElement) => [...s.options].map((o) => `${o.value}=${o.textContent}`)

  it('Claude Code alone: the line and the Claude account select, exactly as before', () => {
    render()
    expect(container.textContent).toContain('Detects Claude Code updates and proposes registry fixes. Off by default because it spends Claude tokens on a Claude update. Takes effect after restart.')
    expect(options(analysisSelect())).toEqual(['=Primary account (default)', 'p1=Home (home@example.com)'])
  })

  it("Codex alone: the line names Codex, and the select lists the Codex accounts that can run it unattended; a choice is saved as Codex's own", () => {
    store.settings = { sentinelEnabled: true, claudeEnabled: false, codexEnabled: true, codexAnswered: true }
    render()
    expect(container.textContent).toContain('Detects Codex updates and proposes registry fixes. Off by default because it spends Codex usage on a Codex update. Takes effect after restart.')
    const select = analysisSelect()
    expect(select.getAttribute('aria-label')).toBe("Codex account for Sentinel's analysis")
    // The unverified and the inactive accounts are not offered.
    expect(options(select)).toEqual(['=Codex review account (default)', 'work=Work', 'play=Play'])
    act(() => {
      select.value = 'play'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(saved).toEqual([{ sentinelCodexAccountId: 'play' }])
    expect(saved[0]).not.toHaveProperty('sentinelAccountProfileId')
  })

  it('a stored Codex choice that is no longer offered shows the default', () => {
    store.settings = { sentinelEnabled: true, claudeEnabled: false, codexEnabled: true, codexAnswered: true, sentinelCodexAccountId: 'unv' }
    render()
    expect(analysisSelect().value).toBe('')
    store.settings = { ...store.settings, sentinelCodexAccountId: 'work' }
    render()
    expect(analysisSelect().value).toBe('work')
  })

  it('both on: the analysis runs on Claude Code by default, and on Codex when Ask Conductor does', () => {
    store.settings = { sentinelEnabled: true, claudeEnabled: true, codexEnabled: true, codexAnswered: true }
    render()
    expect(container.textContent).toContain('Detects Claude Code and Codex updates and proposes registry fixes. Off by default because its analysis spends Claude tokens on an update. Takes effect after restart.')
    expect(options(analysisSelect())[0]).toBe('=Primary account (default)')
    store.settings = { ...store.settings, askConductorProvider: 'codex' }
    render()
    expect(container.textContent).toContain('its analysis spends Codex usage on an update.')
    expect(options(analysisSelect())[0]).toBe('=Codex review account (default)')
  })
})
