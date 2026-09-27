// @vitest-environment jsdom
/**
 * Settings, Accounts, P3.2 of the 2.1.1 completion plan (rows 7, 8, 10, 24),
 * to the approved design (canvas "Accounts: identities across providers" v1,
 * option B, 2026-09-26; design 5.1 to 5.3). Rendered from a fixture snapshot
 * with window.electronAPI.providerAccounts mocked; the editor and menus are
 * portalled, so every query is on the document.
 *
 * Verifies:
 *   - one row for both providers: the avatar chip opens the identity editor
 *     on a Codex row and on a Claude row; "Linked with <provider>: <label>";
 *   - "N running" shows each account's running sessions (Codex: main's
 *     lease count), and nothing at zero;
 *   - the identity editor: name, colour, group (and a new group), Unlink and
 *     Link, each through the registry's own operations; a Claude account's
 *     colour is mirrored to the email-keyed setting its chips read; this
 *     computer's own sign-in edits no name and links nothing;
 *   - a refused inactivate or archive names the sessions holding the
 *     account, each with Go to, and falls back to the count when this
 *     window has none of them open;
 *   - "Archived (N)" lists archived accounts with Restore (the request makes
 *     an archived account inactive), offered only while the provider is on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, AccountView, ProviderInstallationView } from '../../../src/shared/providers'
import type { AccountProfile } from '../../../src/shared/account-types'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ok = () => Promise.resolve({ ok: true })
const pa = {
  snapshot: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  setLifecycle: vi.fn(ok),
  setDefault: vi.fn(ok),
  updateIdentity: vi.fn(ok),
  createGroup: vi.fn(() => Promise.resolve({ ok: true, groupId: 'group-new' })),
  linkIdentity: vi.fn(ok),
  unlinkIdentity: vi.fn(() => Promise.resolve({ ok: true, identityId: 'id-copy' })),
  setReviewerDefault: vi.fn(ok),
  logout: vi.fn(ok),
  refreshStatus: vi.fn(ok),
  reconcileSignIn: vi.fn(ok),
  resolveConflict: vi.fn(ok),
  adoptExternal: vi.fn(ok),
  probeExternal: vi.fn(ok),
  onSignInOutput: vi.fn(() => () => {}),
}
const accountProfiles = {
  list: vi.fn().mockResolvedValue([]),
  delete: vi.fn().mockResolvedValue({ ok: true }),
  rename: vi.fn().mockResolvedValue({ ok: true }),
  setActive: vi.fn().mockResolvedValue({ ok: true }),
  globalEmail: vi.fn().mockResolvedValue(null),
  create: vi.fn(),
  refreshIdentity: vi.fn().mockResolvedValue(null),
  managedLaunchReports: vi.fn().mockResolvedValue([]),
}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  providerAccounts: pa,
  accountProfiles,
  config: { save: vi.fn().mockResolvedValue(undefined) },
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
;(globalThis as any).window.electronPlatform = 'win32'

const { AccountsSurface } = await import('../../../src/renderer/components/settings/accounts/AccountsSurface')

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

// Work: a Codex account linked with the Claude profile work@example.com.
const codexWork = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', isProviderDefault: true, runningSessions: 2 })
const codexSpare = account({ id: 'acc-spare', providerId: 'codex', identityId: 'id-spare', lifecycle: 'inactive' })
const codexHome = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })
const codexOld = account({ id: 'acc-old', providerId: 'codex', identityId: 'id-old', lifecycle: 'archived', authMethod: 'apiKey', archivedAt: new Date(2026, 8, 12, 15, 0).getTime() })
const claudeMain = account({ id: 'acc-claude-main', providerId: 'claude', identityId: 'id-me', legacyId: 'profile-primary', legacyLinked: true, isProviderDefault: true, providerLabel: 'me@example.com' })
const claudeWork = account({ id: 'acc-claude-work', providerId: 'claude', identityId: 'id-work', legacyId: 'profile-work', legacyLinked: true, providerLabel: 'work@example.com' })

function snapshot(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    revision: 1,
    registry: { mode: 'ready' },
    providers: [provider({ providerId: 'claude', displayName: 'Claude Code' }), provider({ providerId: 'codex', displayName: 'Codex' })],
    identities: [
      { id: 'id-work', friendlyName: 'Work', colourKey: 'periwinkle' },
      { id: 'id-spare', friendlyName: 'Spare', colourKey: 'pink' },
      { id: 'id-ext', friendlyName: 'External', colourKey: 'slate-blue' },
      { id: 'id-old', friendlyName: 'Old test', colourKey: 'plum' },
      { id: 'id-me', friendlyName: 'Me', colourKey: 'mauve' },
    ],
    groups: [{ id: 'group-day', name: 'Day job', order: 0 }],
    accounts: [codexWork, codexSpare, codexHome, codexOld, claudeMain, claudeWork],
    pendingSetups: [],
    externalDefaults: [{ providerId: 'codex', home: '~/.codex' }],
    conflicts: [],
    reviewerNotices: [],
    ...over,
  }
}

const primaryProfile: AccountProfile = { id: 'profile-primary', name: 'Me', accountEmail: 'me@example.com', isPrimary: true, createdAt: 1 }
const workProfile: AccountProfile = { id: 'profile-work', name: 'Work', accountEmail: 'work@example.com', createdAt: 2 }

let container: HTMLElement
let root: Root
function render(s: AccountsSnapshot) {
  useProviderAccountsStore.setState({ snapshot: s, loaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(React.createElement(AccountsSurface, { onAddClaudeAccount: vi.fn() })) })
}
const flush = () => act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve() })
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
async function click(id: string) {
  const el = q(id)
  expect(el, `no element ${id}`).toBeTruthy()
  await act(async () => { el!.click() })
  await flush()
}
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  useAccountProfilesStore.setState({ profiles: [primaryProfile, workProfile] })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, accountAliases: {}, accountColourOverrides: { 'work@example.com': 'periwinkle', 'other@example.com': 'rose' } }, isLoaded: true })
  useSessionStore.setState({ sessions: [] })
  for (const fn of Object.values(pa)) fn.mockClear()
  pa.setLifecycle.mockImplementation(ok)
  pa.updateIdentity.mockImplementation(ok)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('one row for both providers (rows 8, 24)', () => {
  it('a Codex row and a Claude row each say who they are linked with', () => {
    render(snapshot())
    expect(q('account-linked-acc-work-acc-claude-work')?.textContent).toBe('Linked with Claude Code: work@example.com')
    expect(q('profile-linked-profile-work-acc-work')?.textContent).toBe('Linked with Codex: Work')
    expect(q('account-linked-acc-spare-acc-work')).toBeNull()
  })

  it('"N running" is the account\'s running sessions, and nothing at zero', () => {
    render(snapshot())
    expect(q('account-running-acc-work')?.textContent).toBe('2 running')
    expect(q('account-running-acc-spare')).toBeNull()
  })

  it('the chip opens the identity editor on a Codex row and on a Claude row; the same click closes it', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    expect(q('identity-editor-acc-work')).not.toBeNull()
    expect(q('identity-editor-acc-work')!.textContent).toContain('Name, colour and group show on every linked account.')
    await click('account-chip-acc-work')
    expect(q('identity-editor-acc-work')).toBeNull()
    await click('profile-chip-profile-work')
    expect((q('identity-editor-profile-work-name') as HTMLInputElement).value).toBe('Work')
  })

  it('a provider that is off lists its accounts without an editor', () => {
    const s = snapshot()
    s.providers[1] = { ...s.providers[1], enabled: false }
    render(s)
    expect(q('account-chip-acc-work')!.tagName).toBe('SPAN')
  })
})

describe('the identity editor (row 7)', () => {
  it('renames the identity, and re-reads Claude\'s profiles it was written through to', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    const name = q('identity-editor-acc-work-name') as HTMLInputElement
    typeInto(name, 'Day job')
    await act(async () => { name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(pa.updateIdentity).toHaveBeenCalledWith({ identityId: 'id-work', friendlyName: 'Day job' })
    expect(accountProfiles.list).toHaveBeenCalled()
  })

  it('shows main\'s refusal and puts the name back', async () => {
    pa.updateIdentity.mockResolvedValue({ ok: false, code: 'legacy-owned', message: 'this account keeps a name in its provider; rename it instead' } as never)
    render(snapshot())
    await click('account-chip-acc-work')
    const name = q('identity-editor-acc-work-name') as HTMLInputElement
    typeInto(name, '')
    await act(async () => { name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(pa.updateIdentity).toHaveBeenCalledWith({ identityId: 'id-work', friendlyName: null })
    expect(q('identity-editor-acc-work-error')?.textContent).toBe('This account needs a name. Type one instead of clearing it.')
    expect(name.value).toBe('Work')
  })

  it('a colour goes to the identity, and to the email-keyed setting of each linked Claude account', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    await click('identity-editor-acc-work-colour-indigo')
    expect(pa.updateIdentity).toHaveBeenCalledWith({ identityId: 'id-work', colourKey: 'indigo' })
    const overrides = useSettingsStore.getState().settings.accountColourOverrides
    expect(overrides).toEqual({ 'work@example.com': 'indigo', 'other@example.com': 'rose' })
  })

  it('a refused colour leaves the email-keyed setting alone', async () => {
    pa.updateIdentity.mockResolvedValue({ ok: false, code: 'invalid-value', message: 'colour is not in the identity palette' } as never)
    render(snapshot())
    await click('account-chip-acc-work')
    await click('identity-editor-acc-work-colour-indigo')
    expect(useSettingsStore.getState().settings.accountColourOverrides?.['work@example.com']).toBe('periwinkle')
    expect(q('identity-editor-acc-work-error')?.textContent).toBe('colour is not in the identity palette')
  })

  it('a group is chosen, or made and chosen', async () => {
    render(snapshot())
    await click('account-chip-acc-spare')
    await choose(q('identity-editor-acc-spare-group') as HTMLSelectElement, 'group-day')
    expect(pa.updateIdentity).toHaveBeenCalledWith({ identityId: 'id-spare', groupId: 'group-day' })
    await choose(q('identity-editor-acc-spare-group') as HTMLSelectElement, '__new-group__')
    typeInto(q('identity-editor-acc-spare-new-group') as HTMLInputElement, 'Side projects')
    await click('identity-editor-acc-spare-add-group')
    expect(pa.createGroup).toHaveBeenCalledWith('Side projects')
    expect(pa.updateIdentity).toHaveBeenLastCalledWith({ identityId: 'id-spare', groupId: 'group-new' })
    await choose(q('identity-editor-acc-spare-group') as HTMLSelectElement, '')
    expect(pa.updateIdentity).toHaveBeenLastCalledWith({ identityId: 'id-spare', groupId: null })
  })

  it('lists the linked accounts: Unlink gives the other one its own identity', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    const linked = q('identity-editor-acc-work-linked')!
    expect(linked.textContent).toContain('Codex: Work')
    expect(linked.textContent).toContain('this account')
    expect(linked.textContent).toContain('Claude Code: work@example.com')
    await click('identity-editor-acc-work-unlink-acc-claude-work')
    expect(pa.unlinkIdentity).toHaveBeenCalledWith('acc-claude-work')
  })

  it('"Link another account" offers vouched-for accounts on other identities and links the chosen one here', async () => {
    render(snapshot())
    await click('account-chip-acc-spare')
    const select = q('identity-editor-acc-spare-link-select') as HTMLSelectElement
    const offered = [...select.options].map((o) => o.value).filter(Boolean)
    // What main accepts: never this computer's own sign-in, an archived
    // account, or one already on this identity.
    expect(offered.sort()).toEqual(['acc-claude-main', 'acc-claude-work', 'acc-work'])
    await choose(select, 'acc-claude-main')
    await click('identity-editor-acc-spare-link')
    expect(pa.linkIdentity).toHaveBeenCalledWith('acc-claude-main', 'id-spare')
    // Claude's account now shows this identity's colour: its email-keyed setting follows.
    expect(useSettingsStore.getState().settings.accountColourOverrides?.['me@example.com']).toBe('pink')
  })

  it('a typed name is kept however the editor closes: a click elsewhere, or Escape (review Q2)', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    typeInto(q('identity-editor-acc-work-name') as HTMLInputElement, 'Typed then left')
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await flush()
    expect(q('identity-editor-acc-work')).toBeNull()
    expect(pa.updateIdentity).toHaveBeenCalledWith({ identityId: 'id-work', friendlyName: 'Typed then left' })
    pa.updateIdentity.mockClear()
    await click('account-chip-acc-work')
    const name = q('identity-editor-acc-work-name') as HTMLInputElement
    name.focus()
    typeInto(name, 'Then Escape')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await flush()
    expect(q('identity-editor-acc-work')).toBeNull()
    expect(pa.updateIdentity).toHaveBeenCalledTimes(1)
    expect(pa.updateIdentity).toHaveBeenCalledWith({ identityId: 'id-work', friendlyName: 'Then Escape' })
  })

  it('a user scrolling elsewhere closes the editor, as the row menu does (review Q5)', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    await act(async () => { container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 })) })
    await flush()
    expect(q('identity-editor-acc-work')).toBeNull()
  })

  it('the page shifting under it (its own Link or Unlink adds or removes a line) keeps it open on its chip (VM finding 2)', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    await act(async () => { container.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')) })
    await flush()
    expect(q('identity-editor-acc-work')).not.toBeNull()
    // A wheel inside the editor does not close it either.
    await act(async () => { q('identity-editor-acc-work')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 })) })
    await flush()
    expect(q('identity-editor-acc-work')).not.toBeNull()
  })

  it('is placed again when a change moves its chip without a scroll (a Link adds a line to the row)', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    const panel = q('identity-editor-acc-work')!
    const chip = q('account-chip-acc-work')!
    chip.getBoundingClientRect = () => ({ top: 200, bottom: 226, left: 40, right: 66, width: 26, height: 26, x: 40, y: 200, toJSON: () => ({}) }) as DOMRect
    const next = snapshot({ revision: 2 })
    await act(async () => { useProviderAccountsStore.setState({ snapshot: next, loaded: true }) })
    await flush()
    expect(panel.style.top).toBe('232px')
    expect(panel.style.left).toBe('40px')
  })

  it('with Codex off, the Claude editor offers no Codex account (VM finding 3)', async () => {
    const s = snapshot({ accounts: [codexWork, codexSpare, claudeMain, claudeWork], identities: [...snapshot().identities] })
    s.providers[1] = { ...s.providers[1], enabled: false }
    render(s)
    await click('profile-chip-profile-primary')
    expect(q('identity-editor-profile-primary-link-select')).toBeNull()
  })

  it('a Claude editor never offers another Claude account; a refusal reads in plain words (VM finding 4)', async () => {
    pa.linkIdentity.mockResolvedValueOnce({ ok: false, code: 'legacy-owned', message: 'two accounts from the same provider list cannot share one identity' } as never)
    render(snapshot())
    await click('profile-chip-profile-primary')
    const select = q('identity-editor-profile-primary-link-select') as HTMLSelectElement
    const offered = [...select.options].map((o) => o.value).filter(Boolean)
    // Main refuses a second profile on a profile's identity: none is offered.
    expect(offered).toEqual(['acc-work', 'acc-spare'])
    await choose(select, 'acc-spare')
    await click('identity-editor-profile-primary-link')
    expect(q('identity-editor-profile-primary-error')?.textContent).toBe('This identity already has a Codex account.')
  })

  it('the swatches are toggle buttons that say which is current (review Q6)', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    const current = q('identity-editor-acc-work-colour-periwinkle')!
    expect(current.getAttribute('aria-pressed')).toBe('true')
    expect(current.getAttribute('aria-label')).toBe('Set colour to periwinkle (current)')
    expect(q('identity-editor-acc-work-colour-indigo')!.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[data-testid="identity-editor-acc-work"] [role="radio"], [data-testid="identity-editor-acc-work"] [role="radiogroup"]')).toBeNull()
  })

  it('the editor closes when its provider is switched off while it is open (review Q8)', async () => {
    render(snapshot())
    await click('account-chip-acc-work')
    expect(q('identity-editor-acc-work')).not.toBeNull()
    const off = snapshot()
    off.providers[1] = { ...off.providers[1], enabled: false }
    await act(async () => { useProviderAccountsStore.setState({ snapshot: off, loaded: true }) })
    expect(q('identity-editor-acc-work')).toBeNull()
  })

  it('an operation that throws says so and frees the editor (review Q1)', async () => {
    pa.updateIdentity.mockRejectedValue(new Error('ipc gone'))
    render(snapshot())
    await click('account-chip-acc-work')
    await click('identity-editor-acc-work-colour-indigo')
    expect(q('identity-editor-acc-work-error')?.textContent).toBe('That did not work; try again.')
    expect((q('identity-editor-acc-work-colour-indigo') as HTMLButtonElement).disabled).toBe(false)
  })

  it('this computer\'s own sign-in edits no name and links nothing', async () => {
    render(snapshot())
    await click('account-chip-acc-local')
    expect(q('identity-editor-acc-local')).not.toBeNull()
    expect(q('identity-editor-acc-local-name')).toBeNull()
    expect(q('identity-editor-acc-local-linked')).toBeNull()
    expect(q('identity-editor-acc-local-colour-indigo')).not.toBeNull()
  })
})

describe('lifecycle blockers name the sessions (row 10, design 5.3)', () => {
  const base = { sessionType: 'local', provider: 'codex', status: 'idle', workingDirectory: 'C:/w', model: '', color: '' }

  it('a refused inactivate names each open session holding the account, with Go to', async () => {
    useSessionStore.setState({ sessions: [
      { ...base, id: 's-docs', label: 'Docs site' },
      { ...base, id: 's-blog', label: 'b', customName: 'Blog drafts' },
    ] as never })
    const spare = { ...codexSpare, lifecycle: 'active' as const }
    pa.setLifecycle.mockResolvedValue({ ok: false, code: 'consumers', message: 'x', consumers: 3, sessions: ['s-docs', 's-blog', 's-elsewhere'] } as never)
    const heard: string[] = []
    const onGo = (e: Event) => { heard.push(((e as CustomEvent).detail as { sessionId: string }).sessionId) }
    window.addEventListener('app:goToSession', onGo)
    render(snapshot({ accounts: [codexWork, spare, claudeMain, claudeWork] }))
    await click('account-menu-btn-acc-spare')
    await click('account-menu-make-inactive-acc-spare')
    expect(pa.setLifecycle).toHaveBeenCalledWith({ accountId: 'acc-spare', lifecycle: 'inactive' })
    const blocker = q('account-blocker-acc-spare')!
    expect(blocker.textContent).toContain("Spare can't be made inactive while these use it:")
    expect([...blocker.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Go to Docs site', 'Go to Blog drafts'])
    // Three consumers, two named here: the third is counted (review Q4).
    expect(q('account-blocker-acc-spare-more')?.textContent).toBe('and 1 more')
    expect(q('account-error-acc-spare')).toBeNull()
    await click('account-blocker-acc-spare-go-s-docs')
    expect(heard).toEqual(['s-docs'])
    window.removeEventListener('app:goToSession', onGo)
  })

  it('"and N more" is main\'s unnamed count: a session and its own review add nothing; sign-ins add theirs (review round 3)', async () => {
    useSessionStore.setState({ sessions: [{ ...base, id: 's-docs', label: 'Docs site' }] as never })
    pa.setLifecycle.mockResolvedValueOnce({ ok: false, code: 'consumers', message: 'x', consumers: 2, sessions: ['s-docs'] } as never)
    render(snapshot())
    await click('account-menu-btn-acc-spare')
    await click('account-menu-archive-acc-spare')
    expect(q('account-blocker-acc-spare')).not.toBeNull()
    expect(q('account-blocker-acc-spare-more')).toBeNull()
    pa.setLifecycle.mockResolvedValueOnce({ ok: false, code: 'consumers', message: 'x', consumers: 4, sessions: ['s-docs'], unnamed: 2 } as never)
    await click('account-menu-btn-acc-spare')
    await click('account-menu-archive-acc-spare')
    expect(q('account-blocker-acc-spare-more')?.textContent).toBe('and 2 more')
  })

  it('an archive refused for sessions says "archived"; with none of them open here, the count', async () => {
    useSessionStore.setState({ sessions: [{ ...base, id: 's-docs', label: 'Docs site' }] as never })
    pa.setLifecycle.mockResolvedValueOnce({ ok: false, code: 'consumers', message: 'x', consumers: 1, sessions: ['s-docs'] } as never)
    render(snapshot())
    await click('account-menu-btn-acc-spare')
    await click('account-menu-archive-acc-spare')
    expect(q('account-blocker-acc-spare')!.textContent).toContain("Spare can't be archived while these use it:")
    expect(q('account-blocker-acc-spare-more')).toBeNull()
    pa.setLifecycle.mockResolvedValueOnce({ ok: false, code: 'consumers', message: 'x', consumers: 2, sessions: ['s-elsewhere'] } as never)
    await click('account-menu-btn-acc-spare')
    await click('account-menu-archive-acc-spare')
    expect(q('account-blocker-acc-spare')).toBeNull()
    expect(q('account-error-acc-spare')?.textContent).toBe('This account is in use (2).')
  })
})

describe('Archived (N) with Restore (row 10, design 5.3)', () => {
  it('lists archived accounts under "Archived (N)" and restores one to inactive', async () => {
    render(snapshot())
    expect(q('archived-accounts-codex')!.textContent).toContain('Archived (1)')
    expect(q('archived-account-acc-old')!.textContent).toContain('Old test')
    expect(q('archived-when-acc-old')?.textContent).toBe('archived 12 Sep')
    expect(q('provider-account-row-acc-old')).toBeNull()
    await click('archived-restore-acc-old')
    expect(pa.setLifecycle).toHaveBeenCalledWith({ accountId: 'acc-old', lifecycle: 'inactive' })
  })

  it('an archived account with no time on record says nothing about when (review S3)', () => {
    render(snapshot({ accounts: [codexWork, { ...codexOld, archivedAt: undefined }, claudeMain] }))
    expect(q('archived-account-acc-old')).not.toBeNull()
    expect(q('archived-when-acc-old')).toBeNull()
  })

  it('shows why a restore was refused', async () => {
    pa.setLifecycle.mockResolvedValue({ ok: false, code: 'realm-conflict', message: 'another account now uses this sign-in location' } as never)
    render(snapshot())
    await click('archived-restore-acc-old')
    expect(q('archived-error-acc-old')?.textContent).toBe('another account now uses this sign-in location')
  })

  it('offers no Restore while the provider is off, and no section with nothing archived', () => {
    const s = snapshot()
    s.providers[1] = { ...s.providers[1], enabled: false }
    render(s)
    expect(q('archived-account-acc-old')).not.toBeNull()
    expect(q('archived-restore-acc-old')).toBeNull()
    act(() => { root.unmount() })
    container.remove()
    render(snapshot({ accounts: [codexWork, claudeMain] }))
    expect(q('archived-accounts-codex')).toBeNull()
  })
})
