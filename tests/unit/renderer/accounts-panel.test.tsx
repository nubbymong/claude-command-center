// @vitest-environment jsdom
/**
 * AccountsPanel -- unit tests.
 *
 * Verifies:
 *   - Default row renders with the supplied email and has NO delete button.
 *   - One row per profile; profile with accountEmail '' shows "setup incomplete".
 *   - "+ Add another account" button invokes the onAdd prop.
 *   - Clicking a profile's Delete (window.confirm stubbed true) calls
 *     accountProfiles.delete with that profile's id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'
import type { AccountProfile } from '../../../src/shared/account-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Electron API mock

const listMock = vi.fn<[], Promise<AccountProfile[]>>()
const deleteMock = vi.fn<[string], Promise<{ ok: boolean }>>()
const renameMock = vi.fn<[string, string], Promise<{ ok: boolean }>>()
const globalEmailMock = vi.fn<[], Promise<string | null>>()
const refreshIdentityMock = vi.fn<[string], Promise<{ ok: boolean; email: string; configDir: string } | null>>()
const updateSettingsMock = vi.fn()

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  accountProfiles: {
    list: listMock,
    delete: deleteMock,
    rename: renameMock,
    globalEmail: globalEmailMock,
    create: vi.fn(),
    refreshIdentity: refreshIdentityMock,
  },
}

// window.confirm stub (jsdom returns false by default without a stub)
;(globalThis as any).window.confirm = vi.fn(() => true)

// ---------------------------------------------------------------------------
// Minimal renderComponent helper (same pattern as use-add-account.test.tsx)

function renderComponent(ui: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

// ---------------------------------------------------------------------------
// Import component AFTER mocks

const { default: AccountsPanel } = await import('../../../src/renderer/components/AccountsPanel')

// ---------------------------------------------------------------------------
// Fixture data

const profileWithEmail: AccountProfile = {
  id: 'profile-work',
  name: 'Work',
  accountEmail: 'work@corp.com',
  createdAt: 1_000_000,
}

const profileWithoutEmail: AccountProfile = {
  id: 'profile-new',
  name: 'New Account',
  accountEmail: '',
  createdAt: 2_000_000,
}

// ---------------------------------------------------------------------------
// Tests

describe('AccountsPanel', () => {
  let unmount: () => void

  beforeEach(() => {
    // Reset stores
    useAccountProfilesStore.setState({ profiles: [] })
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, accountAliases: {} },
    }))

    listMock.mockResolvedValue([])
    deleteMock.mockResolvedValue({ ok: true })
    renameMock.mockResolvedValue({ ok: true })
    globalEmailMock.mockResolvedValue(null)
    refreshIdentityMock.mockResolvedValue(null)
    vi.mocked((globalThis as any).window.confirm).mockReturnValue(true)
  })

  afterEach(() => {
    unmount?.()
    vi.clearAllMocks()
  })

  it('renders the Default row with the passed defaultEmail', () => {
    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { defaultEmail: 'me@example.com', onAdd: vi.fn() })
    )
    unmount = u

    const row = container.querySelector('[data-testid="default-account-row"]')
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('me@example.com')
  })

  it('shows "not signed in" when defaultEmail is null', () => {
    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { defaultEmail: null, onAdd: vi.fn() })
    )
    unmount = u

    const row = container.querySelector('[data-testid="default-account-row"]')
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('not signed in')
  })

  it('has NO delete button on the Default row', () => {
    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { defaultEmail: 'me@example.com', onAdd: vi.fn() })
    )
    unmount = u

    const defaultRow = container.querySelector('[data-testid="default-account-row"]')
    const deleteInDefault = defaultRow?.querySelector('[data-testid^="delete-profile-"]')
    expect(deleteInDefault).toBeNull()
  })

  it('renders one row per profile', () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail, profileWithoutEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { defaultEmail: 'me@example.com', onAdd: vi.fn() })
    )
    unmount = u

    expect(container.querySelector(`[data-testid="profile-row-${profileWithEmail.id}"]`)).toBeTruthy()
    expect(container.querySelector(`[data-testid="profile-row-${profileWithoutEmail.id}"]`)).toBeTruthy()
  })

  it('shows "setup incomplete" for a profile with empty accountEmail', () => {
    useAccountProfilesStore.setState({ profiles: [profileWithoutEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { defaultEmail: 'me@example.com', onAdd: vi.fn() })
    )
    unmount = u

    const profileRow = container.querySelector(`[data-testid="profile-row-${profileWithoutEmail.id}"]`)
    expect(profileRow!.textContent).toContain('setup incomplete')
  })

  it('calls onAdd when the "+ Add another account" button is clicked', async () => {
    const onAdd = vi.fn()
    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { defaultEmail: null, onAdd })
    )
    unmount = u

    const btn = container.querySelector('[data-testid="add-account-btn"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    await act(async () => { btn.click() })
    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('clicking Delete (confirm=true) calls accountProfiles.delete with the profile id', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })
    listMock.mockResolvedValue([]) // hydrate after delete returns empty

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { defaultEmail: 'me@example.com', onAdd: vi.fn() })
    )
    unmount = u

    const btn = container.querySelector(`[data-testid="delete-profile-${profileWithEmail.id}"]`) as HTMLButtonElement
    expect(btn).toBeTruthy()
    await act(async () => { btn.click() })

    expect(deleteMock).toHaveBeenCalledWith(profileWithEmail.id)
  })

  it('self-heals a setup-incomplete profile when the panel mounts', async () => {
    // Start with a profile whose accountEmail is empty (login completed after poll expired).
    useAccountProfilesStore.setState({ profiles: [profileWithoutEmail] })

    // refreshIdentity now finds the email (the profile's own .claude.json was written).
    refreshIdentityMock.mockResolvedValue({ ok: true, email: 'work@me.com', configDir: '/p/new' })
    // hydrate (list) returns the now-emailed profile.
    const healed: AccountProfile = { ...profileWithoutEmail, accountEmail: 'work@me.com' }
    listMock.mockResolvedValue([healed])

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { defaultEmail: 'me@example.com', onAdd: vi.fn() })
    )
    unmount = u

    // Flush the async self-heal effect.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // refreshIdentity was called with the incomplete profile's id.
    expect(refreshIdentityMock).toHaveBeenCalledWith(profileWithoutEmail.id)
    // hydrate (list) was called to refresh the store after the email was found.
    expect(listMock).toHaveBeenCalled()
  })
})
