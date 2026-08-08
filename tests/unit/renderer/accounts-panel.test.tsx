// @vitest-environment jsdom
/**
 * AccountsPanel -- unit tests.
 *
 * Verifies:
 *   - Primary profile shows a "primary" badge and has NO delete button.
 *   - Non-primary profiles have a delete button.
 *   - One row per profile; profile with accountEmail '' shows "setup incomplete".
 *   - "+ Add another account" button invokes the onAdd prop.
 *   - Clicking a non-primary profile's Delete (window.confirm stubbed true) calls
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
const deleteMock = vi.fn<[string], Promise<{ ok: boolean; error?: string }>>()
const renameMock = vi.fn<[string, string], Promise<{ ok: boolean }>>()
const setActiveMock = vi.fn<[string, boolean], Promise<{ ok: boolean; error?: string }>>()
const globalEmailMock = vi.fn<[], Promise<string | null>>()
const refreshIdentityMock = vi.fn<[string], Promise<{ ok: boolean; email: string; configDir: string } | null>>()
const updateSettingsMock = vi.fn()

const configSaveMock = vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue(undefined)

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  accountProfiles: {
    list: listMock,
    delete: deleteMock,
    rename: renameMock,
    setActive: setActiveMock,
    globalEmail: globalEmailMock,
    create: vi.fn(),
    refreshIdentity: refreshIdentityMock,
  },
  config: {
    save: configSaveMock,
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

const primaryProfile: AccountProfile = {
  id: 'profile-primary',
  name: 'Personal',
  accountEmail: 'me@example.com',
  isPrimary: true,
  createdAt: 500_000,
}

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
      settings: { ...s.settings, accountAliases: {}, accountColourOverrides: {} },
    }))

    listMock.mockResolvedValue([])
    deleteMock.mockResolvedValue({ ok: true })
    renameMock.mockResolvedValue({ ok: true })
    setActiveMock.mockResolvedValue({ ok: true })
    globalEmailMock.mockResolvedValue(null)
    refreshIdentityMock.mockResolvedValue(null)
    configSaveMock.mockResolvedValue(undefined)
    vi.mocked((globalThis as any).window.confirm).mockReturnValue(true)
  })

  afterEach(() => {
    unmount?.()
    vi.clearAllMocks()
  })

  it('shows a "primary" badge on the primary profile row', () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const row = container.querySelector(`[data-testid="profile-row-${primaryProfile.id}"]`)
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('primary')
  })

  it('has NO delete button on the primary profile row', () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const primaryRow = container.querySelector(`[data-testid="profile-row-${primaryProfile.id}"]`)
    const deleteInPrimary = primaryRow?.querySelector('[data-testid^="delete-profile-"]')
    expect(deleteInPrimary).toBeNull()
  })

  it('has a delete button on non-primary profiles', () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    expect(container.querySelector(`[data-testid="delete-profile-${profileWithEmail.id}"]`)).toBeTruthy()
    expect(container.querySelector(`[data-testid="delete-profile-${primaryProfile.id}"]`)).toBeNull()
  })

  it('renders one row per profile', () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail, profileWithoutEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    expect(container.querySelector(`[data-testid="profile-row-${profileWithEmail.id}"]`)).toBeTruthy()
    expect(container.querySelector(`[data-testid="profile-row-${profileWithoutEmail.id}"]`)).toBeTruthy()
  })

  it('shows "setup incomplete" for a profile with empty accountEmail', () => {
    useAccountProfilesStore.setState({ profiles: [profileWithoutEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const profileRow = container.querySelector(`[data-testid="profile-row-${profileWithoutEmail.id}"]`)
    expect(profileRow!.textContent).toContain('setup incomplete')
  })

  it('calls onAdd when the "+ Add another account" button is clicked', async () => {
    const onAdd = vi.fn()
    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd })
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
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const btn = container.querySelector(`[data-testid="delete-profile-${profileWithEmail.id}"]`) as HTMLButtonElement
    expect(btn).toBeTruthy()
    await act(async () => { btn.click() })

    expect(deleteMock).toHaveBeenCalledWith(profileWithEmail.id)
  })

  it('surfaces a failed delete (in-use session) instead of swallowing it', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })
    const hydrateSpy = vi.spyOn(useAccountProfilesStore.getState(), 'hydrate')
    deleteMock.mockResolvedValue({
      ok: false,
      error: 'This account is in use by an open session. Close its sessions and try again.',
    })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const btn = container.querySelector(`[data-testid="delete-profile-${profileWithEmail.id}"]`) as HTMLButtonElement
    await act(async () => { btn.click() })

    const err = container.querySelector(`[data-testid="delete-error-${profileWithEmail.id}"]`)
    expect(err).toBeTruthy()
    expect(err!.textContent).toContain('in use by an open session')
    // The row is NOT removed (no hydrate on failure).
    expect(hydrateSpy).not.toHaveBeenCalled()
    expect(container.querySelector(`[data-testid="profile-row-${profileWithEmail.id}"]`)).toBeTruthy()
    hydrateSpy.mockRestore()
  })

  it('clicking a colour swatch calls updateSettings with accountColourOverrides keyed by canonical email', async () => {
    // A profile with a resolved email -- the colour picker is shown.
    useAccountProfilesStore.setState({ profiles: [primaryProfile] })
    // Seed an override for a different email so we can verify the merge.
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, accountColourOverrides: { 'other@example.com': 'rose' as const } },
    }))

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    // The colour picker should be present for the profile with an email.
    const picker = container.querySelector(`[data-testid="colour-picker-${primaryProfile.id}"]`)
    expect(picker).toBeTruthy()

    // Click the 'indigo' swatch.
    const indigoSwatch = container.querySelector(
      `[data-testid="colour-swatch-${primaryProfile.id}-indigo"]`
    ) as HTMLButtonElement
    expect(indigoSwatch).toBeTruthy()

    await act(async () => { indigoSwatch.click() })

    // updateSettings should have been called. Because the real store is used,
    // we verify the store was updated with the right override key.
    const overrides = useSettingsStore.getState().settings.accountColourOverrides
    // canonical email = 'me@example.com' (primaryProfile.accountEmail lowercase+trim)
    expect(overrides?.['me@example.com']).toBe('indigo')
    // Pre-existing override for other email is preserved.
    expect(overrides?.['other@example.com']).toBe('rose')
  })

  it('shows an active/inactive toggle on non-primary profiles but not the primary', () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const primaryRow = container.querySelector(`[data-testid="profile-row-${primaryProfile.id}"]`)!
    const workRow = container.querySelector(`[data-testid="profile-row-${profileWithEmail.id}"]`)!
    expect(primaryRow.querySelector('[role="switch"]')).toBeNull()
    expect(workRow.querySelector('[role="switch"]')).toBeTruthy()
  })

  it('toggling an active account calls setActive(id, false)', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const toggle = container.querySelector(
      `[data-testid="profile-row-${profileWithEmail.id}"] [role="switch"]`
    ) as HTMLButtonElement
    expect(toggle).toBeTruthy()
    await act(async () => { toggle.click() })

    expect(setActiveMock).toHaveBeenCalledWith(profileWithEmail.id, false)
  })

  it('shows an "inactive" badge and re-activates on toggle for an inactive account', async () => {
    const inactive: AccountProfile = { ...profileWithEmail, active: false }
    useAccountProfilesStore.setState({ profiles: [inactive] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    expect(container.querySelector(`[data-testid="inactive-badge-${inactive.id}"]`)).toBeTruthy()

    const toggle = container.querySelector(
      `[data-testid="profile-row-${inactive.id}"] [role="switch"]`
    ) as HTMLButtonElement
    await act(async () => { toggle.click() })

    expect(setActiveMock).toHaveBeenCalledWith(inactive.id, true)
  })

  it('does NOT show a colour picker for a setup-incomplete profile (no email)', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithoutEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const picker = container.querySelector(`[data-testid="colour-picker-${profileWithoutEmail.id}"]`)
    expect(picker).toBeNull()
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
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
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
