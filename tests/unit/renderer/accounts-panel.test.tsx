// @vitest-environment jsdom
/**
 * AccountsPanel -- unit tests.
 *
 * Verifies:
 *   - Primary profile shows "Primary" and offers no Remove.
 *   - Non-primary profiles offer Remove, Make inactive / Make active in the row menu.
 *   - The identity editor (the chip) edits the name and colour (P3.2).
 *   - One row per profile; profile with accountEmail '' shows "setup incomplete".
 *   - "+ Add another account" button invokes the onAdd prop.
 *   - A non-primary profile's Remove (window.confirm stubbed true) calls
 *     accountProfiles.delete with that profile's id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
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
const managedLaunchReportsMock = vi.fn()
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
    managedLaunchReports: managedLaunchReportsMock,
  },
  config: {
    save: configSaveMock,
  },
  // The panel renders AccountWebSession for every account, and that component
  // calls accountWeb.status on mount. Without this the call rejected on
  // `undefined`, which vitest reported as a dozen unhandled rejections and a
  // non-zero exit while every assertion still passed — a red suite with no red
  // test. This panel's tests are not about the web session, so the surface is
  // stubbed rather than exercised here.
  accountWeb: {
    status: vi.fn().mockResolvedValue({ ok: false, error: 'not under test' }),
    signIn: vi.fn().mockResolvedValue({ ok: false, error: 'not under test' }),
    signInState: vi.fn().mockResolvedValue({ ok: true, state: { phase: 'idle' } }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    signOut: vi.fn().mockResolvedValue({ ok: true }),
    openArtifacts: vi.fn().mockResolvedValue({ ok: true }),
    setAuthMethod: vi.fn().mockResolvedValue({ ok: true }),
    setAuthBrowser: vi.fn().mockResolvedValue({ ok: true }),
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
    managedLaunchReportsMock.mockResolvedValue([])
    configSaveMock.mockResolvedValue(undefined)
    vi.mocked((globalThis as any).window.confirm).mockReturnValue(true)
  })

  afterEach(() => {
    unmount?.()
    vi.clearAllMocks()
  })

  it('renders the account-isolation notice INSIDE each account row, asking for that account alone', async () => {
    // The notice is layer 4 of the isolation hardening made visible, and it is
    // per account by construction. This test exists because the component was
    // once imported by this panel and never rendered: the whole surface was
    // dead, and no test noticed because every other assertion here is about
    // rows, badges and buttons.
    managedLaunchReportsMock.mockImplementation(async (id: string) => (
      id === profileWithEmail.id
        ? [{
            profileId: id, sessionId: 'insights', at: 1,
            preflight: { ok: false, findings: [{ id: 'cli-below-floor', severity: 'blocked', title: 'T', detail: 'D', action: 'A' }] },
          }]
        : []
    ))
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })

    // One request per account, each naming its own id -- never one merged list.
    expect(managedLaunchReportsMock.mock.calls.map((c) => c[0]).sort())
      .toEqual([primaryProfile.id, profileWithEmail.id].sort())
    // ...and the finding appears under the account it belongs to, and only there.
    const notice = container.querySelector(`[data-testid="account-isolation-notice-${profileWithEmail.id}"]`)
    expect(notice, 'the isolation notice is not rendered in the account row').toBeTruthy()
    expect(notice!.textContent).toContain('A')
    expect(container.querySelector(`[data-testid="account-isolation-notice-${primaryProfile.id}"]`)).toBeNull()
    expect(container.querySelector(`[data-testid="profile-row-${profileWithEmail.id}"]`)!.parentElement!.contains(notice!)).toBe(true)
  })

  // P3.2: the Claude row is the shared AccountRow. Its actions are in the
  // "..." menu (portalled to document.body), and its name and colour are in
  // the identity editor the avatar chip opens (also portalled).
  const openMenu = async (id: string) => {
    const btn = document.querySelector(`[data-testid="profile-menu-btn-${id}"]`) as HTMLButtonElement | null
    if (!btn) return false
    await act(async () => { btn.click() })
    return true
  }
  const menuItem = (key: string, id: string) => document.querySelector(`[data-testid="profile-menu-${key}-${id}"]`) as HTMLButtonElement | null
  const openEditor = async (id: string) => {
    const chip = document.querySelector(`[data-testid="profile-chip-${id}"]`) as HTMLButtonElement
    await act(async () => { chip.click() })
    return document.querySelector(`[data-testid="identity-editor-${id}"]`) as HTMLElement | null
  }

  it('shows "Primary" on the primary profile row', () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const row = container.querySelector(`[data-testid="profile-row-${primaryProfile.id}"]`)
    expect(row).toBeTruthy()
    expect(row!.querySelector(`[data-testid="primary-badge-${primaryProfile.id}"]`)!.textContent).toBe('Primary')
  })

  it('offers NO Remove on the primary profile row', async () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile] })

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    // Nothing to do on the primary without the registry: no menu at all.
    expect(await openMenu(primaryProfile.id)).toBe(false)
    expect(menuItem('remove', primaryProfile.id)).toBeNull()
  })

  it('offers Remove in the menu of a non-primary profile', async () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    expect(await openMenu(profileWithEmail.id)).toBe(true)
    expect(menuItem('remove', profileWithEmail.id)?.textContent).toBe('Remove')
  })

  it('an unnamed profile shows its email once (VM finding 1)', () => {
    const unnamed: AccountProfile = { id: 'profile-unnamed', name: '', accountEmail: 'solo@example.com', createdAt: 3 }
    useAccountProfilesStore.setState({ profiles: [unnamed, profileWithEmail] })
    const { container, unmount: u } = renderComponent(React.createElement(AccountsPanel, { onAdd: vi.fn() }))
    unmount = u
    const row = container.querySelector(`[data-testid="profile-row-${unnamed.id}"]`)!
    expect(row.textContent!.split('solo@example.com').length - 1).toBe(1)
    expect(row.querySelector(`[data-testid="profile-email-${unnamed.id}"]`)).toBeNull()
    // A named profile keeps its email under its name.
    expect(container.querySelector(`[data-testid="profile-email-${profileWithEmail.id}"]`)!.textContent).toBe('work@corp.com')
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

  it('Remove (confirm=true) calls accountProfiles.delete with the profile id', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })
    listMock.mockResolvedValue([]) // hydrate after delete returns empty

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('remove', profileWithEmail.id)!.click() })

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

    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('remove', profileWithEmail.id)!.click() })

    const err = container.querySelector(`[data-testid="delete-error-${profileWithEmail.id}"]`)
    expect(err).toBeTruthy()
    expect(err!.textContent).toContain('in use by an open session')
    // The row is NOT removed (no hydrate on failure).
    expect(hydrateSpy).not.toHaveBeenCalled()
    expect(container.querySelector(`[data-testid="profile-row-${profileWithEmail.id}"]`)).toBeTruthy()
    hydrateSpy.mockRestore()
  })

  it('a removal refused while this window runs sessions on the account names them, each with Go to (design 5.3)', async () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })
    const base = { sessionType: 'local', provider: 'claude', status: 'idle', workingDirectory: 'C:/w', model: '', color: '' }
    useSessionStore.setState({
      sessions: [
        { ...base, id: 's-docs', label: 'Docs site', profileId: profileWithEmail.id },
        { ...base, id: 's-blog', label: 'blog', customName: 'Blog drafts', profileId: profileWithEmail.id },
        { ...base, id: 's-ended', label: 'Ended', profileId: profileWithEmail.id, ptyExited: true },
        { ...base, id: 's-other', label: 'Other', profileId: primaryProfile.id },
        { ...base, id: 's-shell', label: 'Shell', profileId: profileWithEmail.id, shellOnly: true },
      ] as never,
    })
    deleteMock.mockResolvedValue({ ok: false, code: 'in-use', error: 'This account is in use by an open session. Close its sessions and try again.', sessions: ['s-docs', 's-blog'] } as never)
    const heard: string[] = []
    const onGo = (e: Event) => { heard.push(((e as CustomEvent).detail as { sessionId: string }).sessionId) }
    window.addEventListener('app:goToSession', onGo)

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    // "N running" counts the live Claude sessions on the profile only.
    expect(container.querySelector(`[data-testid="profile-running-${profileWithEmail.id}"]`)!.textContent).toBe('2 running')
    expect(container.querySelector(`[data-testid="profile-running-${primaryProfile.id}"]`)!.textContent).toBe('1 running')

    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('remove', profileWithEmail.id)!.click() })

    const blocker = container.querySelector(`[data-testid="profile-blocker-${profileWithEmail.id}"]`)!
    expect(blocker.textContent).toContain("Work can't be removed while these use it:")
    const go = [...blocker.querySelectorAll('button')].map((b) => b.textContent)
    expect(go).toEqual(['Go to Docs site', 'Go to Blog drafts'])
    expect(container.querySelector(`[data-testid="delete-error-${profileWithEmail.id}"]`)).toBeNull()
    await act(async () => { (blocker.querySelector(`[data-testid="profile-blocker-${profileWithEmail.id}-go-s-blog"]`) as HTMLButtonElement).click() })
    expect(heard).toEqual(['s-blog'])
    window.removeEventListener('app:goToSession', onGo)
    useSessionStore.setState({ sessions: [] })
  })

  it('a removal refused for anything else keeps main\'s words, even with sessions running on it (review Q3)', async () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })
    useSessionStore.setState({ sessions: [{ id: 's-docs', label: 'Docs site', sessionType: 'local', provider: 'claude', profileId: profileWithEmail.id }] as never })
    deleteMock.mockResolvedValue({ ok: false, error: "The account's claude.ai session could not be cleared, so the account was not removed: locked" })
    const { container, unmount: u } = renderComponent(React.createElement(AccountsPanel, { onAdd: vi.fn() }))
    unmount = u
    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('remove', profileWithEmail.id)!.click() })
    expect(container.querySelector(`[data-testid="profile-blocker-${profileWithEmail.id}"]`)).toBeNull()
    expect(container.querySelector(`[data-testid="delete-error-${profileWithEmail.id}"]`)!.textContent).toContain('could not be cleared')
    useSessionStore.setState({ sessions: [] })
  })

  it('Make inactive refused while sessions run on the profile names them with Go to (design 5.3, review S1); none open here: main\'s words', async () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })
    useSessionStore.setState({ sessions: [{ id: 's-docs', label: 'Docs site', sessionType: 'local', provider: 'claude', profileId: profileWithEmail.id }] as never })
    setActiveMock.mockResolvedValue({ ok: false, code: 'in-use', error: 'This account is in use by an open session. Close its sessions and try again.', sessions: ['s-docs'] } as never)
    const { container, unmount: u } = renderComponent(React.createElement(AccountsPanel, { onAdd: vi.fn() }))
    unmount = u
    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('make-inactive', profileWithEmail.id)!.click() })
    const blocker = container.querySelector(`[data-testid="profile-blocker-${profileWithEmail.id}"]`)!
    expect(container.querySelector(`[data-testid="profile-blocker-${profileWithEmail.id}-more"]`)).toBeNull()
    expect(blocker.textContent).toContain("Work can't be made inactive while these use it:")
    expect([...blocker.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Go to Docs site'])
    expect(container.querySelector(`[data-testid="profile-error-${profileWithEmail.id}"]`)).toBeNull()
    // An SSH session (not listed here) holds it: main's words.
    useSessionStore.setState({ sessions: [] })
    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('make-inactive', profileWithEmail.id)!.click() })
    expect(container.querySelector(`[data-testid="profile-blocker-${profileWithEmail.id}"]`)).toBeNull()
    expect(container.querySelector(`[data-testid="profile-error-${profileWithEmail.id}"]`)!.textContent).toBe('This account is in use by an open session. Close its sessions and try again.')
  })

  it('a removal refused after its claude.ai sign-in was cleared keeps main\'s words beside the blocker, with "and N more" for holders not named here', async () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })
    useSessionStore.setState({ sessions: [{ id: 's-docs', label: 'Docs site', sessionType: 'local', provider: 'claude', profileId: profileWithEmail.id }] as never })
    deleteMock.mockResolvedValue({
      ok: false, code: 'in-use-cleared', error: 'This account is in use by an open session. Its claude.ai sign-in was cleared; close its sessions and try again.',
      sessions: ['s-docs', 's-other-window'], unnamed: 1,
    } as never)
    const { container, unmount: u } = renderComponent(React.createElement(AccountsPanel, { onAdd: vi.fn() }))
    unmount = u
    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('remove', profileWithEmail.id)!.click() })
    const blocker = container.querySelector(`[data-testid="profile-blocker-${profileWithEmail.id}"]`)!
    expect([...blocker.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Go to Docs site'])
    expect(container.querySelector(`[data-testid="profile-blocker-${profileWithEmail.id}-more"]`)!.textContent).toBe('and 2 more')
    expect(container.querySelector(`[data-testid="delete-error-${profileWithEmail.id}"]`)!.textContent).toContain('sign-in was cleared')
    useSessionStore.setState({ sessions: [] })
  })

  it('a change that throws says so and frees the row (review Q1)', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })
    setActiveMock.mockRejectedValue(new Error('ipc gone'))
    const { container, unmount: u } = renderComponent(React.createElement(AccountsPanel, { onAdd: vi.fn() }))
    unmount = u
    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('make-inactive', profileWithEmail.id)!.click() })
    expect(container.querySelector(`[data-testid="profile-error-${profileWithEmail.id}"]`)!.textContent).toBe('That did not work; try again.')
    expect((document.querySelector(`[data-testid="profile-menu-btn-${profileWithEmail.id}"]`) as HTMLButtonElement).disabled).toBe(false)
  })

  it('the identity editor sets the colour by canonical email while the account list is not available (the legacy store)', async () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile] })
    // Seed an override for a different email so we can verify the merge.
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, accountColourOverrides: { 'other@example.com': 'rose' as const } },
    }))

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const editor = await openEditor(primaryProfile.id)
    expect(editor).toBeTruthy()
    const indigoSwatch = editor!.querySelector(`[data-testid="identity-editor-${primaryProfile.id}-colour-indigo"]`) as HTMLButtonElement
    expect(indigoSwatch).toBeTruthy()

    await act(async () => { indigoSwatch.click() })

    const overrides = useSettingsStore.getState().settings.accountColourOverrides
    // canonical email = 'me@example.com' (primaryProfile.accountEmail lowercase+trim)
    expect(overrides?.['me@example.com']).toBe('indigo')
    // Pre-existing override for other email is preserved.
    expect(overrides?.['other@example.com']).toBe('rose')
  })

  it('the identity editor renames the profile while the account list is not available', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const editor = await openEditor(profileWithEmail.id)
    const input = editor!.querySelector(`[data-testid="identity-editor-${profileWithEmail.id}-name"]`) as HTMLInputElement
    expect(input.value).toBe('Work')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'Day job')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(renameMock).toHaveBeenCalledWith(profileWithEmail.id, 'Day job')
  })

  it('a rename that throws says so in the editor and frees it (review Q1)', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })
    renameMock.mockRejectedValue(new Error('ipc gone'))
    const { unmount: u } = renderComponent(React.createElement(AccountsPanel, { onAdd: vi.fn() }))
    unmount = u
    const editor = await openEditor(profileWithEmail.id)
    const input = editor!.querySelector(`[data-testid="identity-editor-${profileWithEmail.id}-name"]`) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'Day job'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(document.querySelector(`[data-testid="identity-editor-${profileWithEmail.id}-error"]`)!.textContent).toBe('That did not work; try again.')
    expect(input.disabled).toBe(false)
    renameMock.mockResolvedValue({ ok: true })
  })

  it('offers Make inactive on non-primary profiles but not the primary', async () => {
    useAccountProfilesStore.setState({ profiles: [primaryProfile, profileWithEmail] })

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    expect(await openMenu(primaryProfile.id)).toBe(false)
    await openMenu(profileWithEmail.id)
    expect(menuItem('make-inactive', profileWithEmail.id)).toBeTruthy()
  })

  it('Make inactive calls setActive(id, false)', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('make-inactive', profileWithEmail.id)!.click() })

    expect(setActiveMock).toHaveBeenCalledWith(profileWithEmail.id, false)
  })

  it('shows an "inactive" badge and re-activates from the menu for an inactive account', async () => {
    const inactive: AccountProfile = { ...profileWithEmail, active: false }
    useAccountProfilesStore.setState({ profiles: [inactive] })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    expect(container.querySelector(`[data-testid="inactive-badge-${inactive.id}"]`)).toBeTruthy()

    await openMenu(inactive.id)
    await act(async () => { menuItem('make-active', inactive.id)!.click() })

    expect(setActiveMock).toHaveBeenCalledWith(inactive.id, true)
  })

  it('a setActive refusal is shown on the row', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithEmail] })
    setActiveMock.mockResolvedValue({ ok: false, error: 'At least one account must stay active.' })

    const { container, unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    await openMenu(profileWithEmail.id)
    await act(async () => { menuItem('make-inactive', profileWithEmail.id)!.click() })
    expect(container.querySelector(`[data-testid="profile-error-${profileWithEmail.id}"]`)!.textContent).toBe('At least one account must stay active.')
  })

  it('offers no colour for a setup-incomplete profile (no email), only its name', async () => {
    useAccountProfilesStore.setState({ profiles: [profileWithoutEmail] })

    const { unmount: u } = renderComponent(
      React.createElement(AccountsPanel, { onAdd: vi.fn() })
    )
    unmount = u

    const editor = await openEditor(profileWithoutEmail.id)
    expect(editor!.querySelector(`[data-testid="identity-editor-${profileWithoutEmail.id}-colour-indigo"]`)).toBeNull()
    expect(editor!.querySelector(`[data-testid="identity-editor-${profileWithoutEmail.id}-name"]`)).toBeTruthy()
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
