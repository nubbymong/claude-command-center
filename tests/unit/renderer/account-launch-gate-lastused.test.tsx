// @vitest-environment jsdom
// AccountLaunchGate "Last used" line — it is a one-click shortcut that bypasses
// the account dropdown, so it must apply the SAME active-only gate the dropdown
// does. Adversarial review found it offered (and launched) a PARKED account.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const gateState: any = { queue: [], resolveChoice: vi.fn(), cancelChoice: vi.fn() }
const profilesState: any = { profiles: [] }
const settingsState: any = { settings: { accountAliases: {}, accountColourOverrides: {}, lastUsedAccountId: undefined } }

vi.mock('../../../src/renderer/stores/accountGateStore', () => ({ useAccountGateStore: (sel: any) => sel(gateState) }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({ useAccountProfilesStore: (sel: any) => sel(profilesState) }))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({ useSettingsStore: (sel: any) => sel(settingsState) }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: AccountLaunchGate } = await import('../../../src/renderer/components/AccountLaunchGate')

function profile(over: Partial<any> = {}): any {
  return { id: 'p1', name: 'Acct', accountEmail: 'a@b.co', isPrimary: false, active: true, ...over }
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  gateState.resolveChoice = vi.fn()
  gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: undefined, resolve: () => {} }]
  profilesState.profiles = []
  settingsState.settings = { accountAliases: {}, accountColourOverrides: {}, lastUsedAccountId: undefined }
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const render = () => act(() => root.render(<AccountLaunchGate />))
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null

describe('AccountLaunchGate — Last used line', () => {
  it('shows the Last used line for an ACTIVE last-used account', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-active', accountEmail: 'used@b.co' })]
    settingsState.settings.lastUsedAccountId = 'p-active'
    render()
    expect(q('[data-testid="account-launch-lastused"]')).not.toBeNull()
    expect(container.textContent).toContain('Last used')
  })

  it('does NOT show the Last used line when the last-used account has been PARKED (inactive)', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-parked', accountEmail: 'parked@b.co', active: false })]
    settingsState.settings.lastUsedAccountId = 'p-parked'
    render()
    // The parked account must not be offered as a one-click launch shortcut.
    expect(q('[data-testid="account-launch-lastused"]')).toBeNull()
    expect(q('[data-testid="account-launch-lastused-use"]')).toBeNull()
  })

  it('still shows a parked last-used account IF it is the session’s own pinned account (relaunch stays possible)', () => {
    // isSelectable keeps the session's currently pinned account selectable even
    // when parked, so a session already on it can relaunch — the Last used line
    // must follow the same rule, not a blanket active-only one.
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-pinned', accountEmail: 'pinned@b.co', active: false })]
    settingsState.settings.lastUsedAccountId = 'p-pinned'
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'p-pinned', resolve: () => {} }]
    render()
    expect(q('[data-testid="account-launch-lastused"]')).not.toBeNull()
  })

  it('does not show the line when there is no last-used account, or it was deleted', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true })]
    settingsState.settings.lastUsedAccountId = undefined
    render()
    expect(q('[data-testid="account-launch-lastused"]')).toBeNull()
    act(() => root.unmount()); root = createRoot(container)
    settingsState.settings.lastUsedAccountId = 'gone'
    render()
    expect(q('[data-testid="account-launch-lastused"]')).toBeNull()
  })

  it('#446: a session pinned to a DELETED account pre-selects a real account, not blank', () => {
    // The 'ask' resume path routes an already-pinned profileId through this
    // gate; if that account was deleted, the pre-select must fall through to
    // primary rather than pointing at a non-existent <option> (a blank picker
    // that then launches a dead id).
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-other', accountEmail: 'o@b.co' })]
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'deleted-acct', resolve: () => {} }]
    render()
    const select = q('[data-testid="account-launch-select"]') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    expect(select!.value).toBe('primary') // fell through to primary, not '' or the dead id
    // Launch resolves a REAL account.
    const launchBtn = Array.from(container.querySelectorAll('button')).find((b) => /launch|start/i.test(b.textContent || '')) as HTMLButtonElement
    act(() => launchBtn.click())
    expect(gateState.resolveChoice).toHaveBeenCalledWith('primary')
  })

  it('Use → then Launch resolves the gate with an ACTIVE last-used account', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-active', accountEmail: 'used@b.co' })]
    settingsState.settings.lastUsedAccountId = 'p-active'
    render()
    act(() => q('[data-testid="account-launch-lastused-use"]')!.click())
    // Launch is the primary button; find it by text.
    const launchBtn = Array.from(container.querySelectorAll('button')).find((b) => /launch|start/i.test(b.textContent || '')) as HTMLButtonElement
    expect(launchBtn, 'a launch button').toBeTruthy()
    act(() => launchBtn.click())
    expect(gateState.resolveChoice).toHaveBeenCalledWith('p-active')
  })
})
