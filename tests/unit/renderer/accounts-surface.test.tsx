// @vitest-environment jsdom
/**
 * Settings, Accounts (WP2 commit 6, F4/F5): rendered from a fixture
 * snapshot, with window.electronAPI.providerAccounts mocked. Menus and
 * dialogs portal to document.body, so every query here is on the document.
 *
 * Verifies:
 *   - the Providers card: real marks, Beta on Codex only, the status line,
 *     the last-provider refusal and the in-use count under the switch;
 *   - Codex rows: labels (the external home named by its label, never by an
 *     identity name), badges, and the "..." menu for each account state,
 *     hiding what the registry always refuses; the menu is portalled and
 *     keyboard-driven; a provider that is off lists its accounts unmanaged;
 *   - "Make reviewer" never offered on refused, external (alone) or
 *     unverified accounts, in Codex menus and Claude rows alike;
 *   - the reviewer line, the macOS callout and refusal lines, the cleared
 *     notice, the Claude Make reviewer error;
 *   - the external sign-out / archive acknowledgement; a managed archive
 *     without one;
 *   - Add account: the API key through sendSecret only; output and cancel;
 *     the cancel race while beginSetup is in flight; the unmount abandon;
 *     linking to an existing identity;
 *   - Sign in again: when it is offered, the same-account gate, the method
 *     family, the API key path and its cancel race, refusals;
 *   - registry-not-ready, conflicts, the external adoption states, pending
 *     setups.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, AccountView, ProviderInstallationView, SignInOutputEvent } from '../../../src/shared/providers'
import type { AccountProfile } from '../../../src/shared/account-types'
import { useProviderAccountsStore, canOfferSignInAgain } from '../../../src/renderer/stores/providerAccountsStore'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

// The saved on/off the Providers switch writes after main agrees.
const updateSettings = vi.fn(() => Promise.resolve())

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Electron API mock

let signInOutput: ((e: SignInOutputEvent) => void) | null = null
const ok = () => Promise.resolve({ ok: true })
const pa = {
  snapshot: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  discover: vi.fn(ok),
  installRecipes: vi.fn(),
  setEnabled: vi.fn(ok),
  beginSetup: vi.fn(),
  issueSecretHandle: vi.fn(),
  sendSecret: vi.fn(),
  signIn: vi.fn(),
  signInAgain: vi.fn(),
  onSignInOutput: vi.fn((cb: (e: SignInOutputEvent) => void) => { signInOutput = cb; return () => { signInOutput = null } }),
  cancelSignIn: vi.fn(ok),
  completeSetup: vi.fn(),
  abandonSetup: vi.fn(ok),
  refreshStatus: vi.fn(ok),
  logout: vi.fn(ok),
  setLifecycle: vi.fn(ok),
  setDefault: vi.fn(ok),
  updateIdentity: vi.fn(ok),
  adoptExternal: vi.fn(ok),
  runMigration: vi.fn(ok),
  reconcileSignIn: vi.fn(ok),
  resolveConflict: vi.fn(ok),
  setReviewerDefault: vi.fn(ok),
}

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  providerAccounts: pa,
  accountProfiles: {
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    rename: vi.fn().mockResolvedValue({ ok: true }),
    setActive: vi.fn().mockResolvedValue({ ok: true }),
    globalEmail: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    refreshIdentity: vi.fn().mockResolvedValue(null),
    managedLaunchReports: vi.fn().mockResolvedValue([]),
  },
  config: { save: vi.fn().mockResolvedValue(undefined) },
  // AccountsPanel renders AccountWebSession per Claude account; not under test.
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

const { AccountsSurface } = await import('../../../src/renderer/components/settings/accounts/AccountsSurface')

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

const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', providerLabel: 'alex@work.example', planLabel: 'ChatGPT Plus', isProviderDefault: true })
const personal = account({ id: 'acc-personal', providerId: 'codex', identityId: 'id-personal', providerLabel: 'alex@home.example', isReviewerDefault: true, authMethod: 'apiKey' })
const local = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', providerLabel: 'alex@example.com', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })
const old = account({ id: 'acc-old', providerId: 'codex', identityId: 'id-old', providerLabel: 'alex@old.example', operationalState: 'blocked' })
const parked = account({ id: 'acc-parked', providerId: 'codex', identityId: 'id-parked', lifecycle: 'inactive' })
const unv = account({ id: 'acc-unv', providerId: 'codex', identityId: 'id-unv', unverified: true, identityAssurance: 'realm-only' })
const refused = account({ id: 'acc-refused', providerId: 'codex', identityId: 'id-refused', reviewRefusal: { reason: 'unknown', message: 'm' } })
const gone = account({ id: 'acc-gone', providerId: 'codex', identityId: 'id-gone', lifecycle: 'archived' })
const claudeMain = account({ id: 'acc-claude-main', providerId: 'claude', identityId: 'id-me', legacyId: 'profile-primary', legacyLinked: true, isProviderDefault: true })
const claudeHome = account({ id: 'acc-claude-home', providerId: 'claude', identityId: 'id-home', legacyId: 'profile-home', legacyLinked: true })

function snapshot(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    revision: 1,
    registry: { mode: 'ready' },
    providers: [
      provider({ providerId: 'claude', displayName: 'Claude Code', version: '2.1.281', review: { ready: true, accountId: claudeMain.id, source: 'provider-default' } }),
      provider({ providerId: 'codex', displayName: 'Codex', version: '0.155.1', review: { ready: true, accountId: personal.id, source: 'reviewer-default' } }),
    ],
    identities: [
      { id: 'id-work', friendlyName: 'Work', colourKey: 'indigo' },
      { id: 'id-personal', friendlyName: 'Personal', colourKey: 'pink' },
      { id: 'id-ext', friendlyName: 'External Codex sign-in (account unverified)', colourKey: 'slate-blue' },
      { id: 'id-old', friendlyName: 'Old', colourKey: 'rose' },
      { id: 'id-parked', friendlyName: 'Parked', colourKey: 'plum' },
      { id: 'id-unv', friendlyName: 'Unvouched', colourKey: 'violet' },
      { id: 'id-refused', friendlyName: 'Refused', colourKey: 'orchid' },
      { id: 'id-gone', friendlyName: 'Gone', colourKey: 'plum' },
      { id: 'id-me', friendlyName: 'Me', colourKey: 'mauve' },
      { id: 'id-home', friendlyName: 'Home', colourKey: 'lavender' },
    ],
    groups: [],
    accounts: [work, personal, local, old, parked, unv, refused, gone, claudeMain, claudeHome],
    pendingSetups: [],
    externalDefaults: [{ providerId: 'codex', needsConfirmation: false }],
    conflicts: [],
    reviewerNotices: [],
    ...over,
  }
}

const primaryProfile: AccountProfile = { id: 'profile-primary', name: 'Me', accountEmail: 'me@example.com', isPrimary: true, createdAt: 1 }
const homeProfile: AccountProfile = { id: 'profile-home', name: 'Home', accountEmail: 'alex@home.example', createdAt: 2 }

// ---------------------------------------------------------------------------
// Helpers

let container: HTMLElement
let root: Root
let mounted = false

function render(s: AccountsSnapshot) {
  useProviderAccountsStore.setState({ snapshot: s, loaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(React.createElement(AccountsSurface, { onAddClaudeAccount: vi.fn() })) })
  mounted = true
}
function unmountNow() {
  if (!mounted) return
  act(() => { root.unmount() })
  container.remove()
  mounted = false
}

const flush = () => act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve() })
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 5)) })
// Menus and dialogs are portalled: query the whole document.
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
async function click(id: string) {
  const el = q(id)
  expect(el, `no element ${id}`).toBeTruthy()
  await act(async () => { el!.click() })
  await flush()
}
async function menuKeys(accountId: string): Promise<string[]> {
  await click(`account-menu-btn-${accountId}`)
  const keys = [...document.querySelectorAll(`[data-testid^="account-menu-"][data-testid$="-${accountId}"][role="menuitem"]`)]
    .map((el) => el.getAttribute('data-testid')!.slice('account-menu-'.length, -(accountId.length + 1)))
  await click(`account-menu-btn-${accountId}`)
  return keys
}
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function typeKey(input: HTMLInputElement, key: string) {
  act(() => {
    input.value = key
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function pressKey(target: EventTarget, key: string) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}
function assertKeyNowhere(key: string) {
  for (const [name, fn] of Object.entries(pa)) {
    if (name === 'sendSecret') continue
    expect(JSON.stringify(fn.mock.calls), name).not.toContain(key)
  }
  expect(JSON.stringify(useProviderAccountsStore.getState())).not.toContain(key)
  expect(document.body.innerHTML).not.toContain(key)
}

beforeEach(() => {
  ;(window as any).electronPlatform = 'win32'
  useAccountProfilesStore.setState({ profiles: [primaryProfile, homeProfile] })
  for (const fn of Object.values(pa)) fn.mockClear()
  pa.setEnabled.mockImplementation(ok)
  pa.setDefault.mockImplementation(ok)
  pa.logout.mockImplementation(ok)
  pa.setLifecycle.mockImplementation(ok)
  pa.cancelSignIn.mockImplementation(ok)
  pa.abandonSetup.mockImplementation(ok)
  pa.setReviewerDefault.mockImplementation(ok)
  pa.adoptExternal.mockImplementation(ok)
  pa.runMigration.mockImplementation(ok)
  pa.beginSetup.mockReset()
  pa.signIn.mockReset()
  pa.completeSetup.mockReset()
  pa.signInAgain.mockReset()
  pa.issueSecretHandle.mockReset()
  signInOutput = null
  updateSettings.mockClear()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, updateSettings } as never)
})

afterEach(() => { unmountNow() })

// ---------------------------------------------------------------------------
// Providers card

describe('Providers card', () => {
  it('shows each provider with its real mark, Beta on Codex only, and its status', () => {
    render(snapshot())
    expect(q('provider-row-claude')!.querySelector('[data-testid="provider-mark-claude"]')).toBeTruthy()
    expect(q('provider-row-codex')!.querySelector('[data-testid="provider-mark-codex"]')).toBeTruthy()
    expect(q('provider-beta-codex')?.textContent).toBe('Beta')
    expect(q('provider-beta-claude')).toBeNull()
    expect(q('provider-status-claude')?.textContent).toBe('Claude Code 2.1.281 - ready')
  })

  it('says "At least one provider stays on." under the switch when the last one is turned off', async () => {
    pa.setEnabled.mockResolvedValue({ ok: false, code: 'last-provider', message: 'At least one provider must stay on.' })
    render(snapshot())
    await act(async () => { (q('provider-row-codex')!.querySelector('[role="switch"]') as HTMLElement).click() })
    await flush()
    expect(pa.setEnabled).toHaveBeenCalledWith('codex', false)
    expect(q('provider-error-codex')?.textContent).toBe('At least one provider stays on.')
    // Refused by main: nothing is saved.
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it("saves the provider's on/off once main agrees, so a saved off cannot bounce it back", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: false } } as never)
    const s = snapshot()
    s.providers[1] = { ...s.providers[1], enabled: false }
    render(s)
    await act(async () => { (q('provider-row-codex')!.querySelector('[role="switch"]') as HTMLElement).click() })
    await flush()
    expect(pa.setEnabled).toHaveBeenCalledWith('codex', true)
    expect(updateSettings).toHaveBeenCalledWith({ codexEnabled: true })
    expect(pa.setEnabled.mock.invocationCallOrder[0]).toBeLessThan(updateSettings.mock.invocationCallOrder[0])
    await act(async () => { (q('provider-row-claude')!.querySelector('[role="switch"]') as HTMLElement).click() })
    await flush()
    expect(updateSettings).toHaveBeenLastCalledWith({ claudeEnabled: false })
  })

  it('says the provider is in use, with the count, when something holds it', async () => {
    pa.setEnabled.mockResolvedValue({ ok: false, code: 'consumers', consumers: 3, message: 'Sessions or operations are using this account.' })
    render(snapshot())
    await act(async () => { (q('provider-row-codex')!.querySelector('[role="switch"]') as HTMLElement).click() })
    await flush()
    expect(q('provider-error-codex')?.textContent).toBe('Codex is in use (3).')
  })

  it("shows another refusal's own message", async () => {
    pa.setEnabled.mockResolvedValue({ ok: false, code: 'persist-failed', message: 'The change could not be saved.' })
    render(snapshot())
    await act(async () => { (q('provider-row-claude')!.querySelector('[role="switch"]') as HTMLElement).click() })
    await flush()
    expect(q('provider-error-claude')?.textContent).toBe('The change could not be saved.')
  })
})

// ---------------------------------------------------------------------------
// Codex rows

describe('Codex rows', () => {
  it('lists the non-archived accounts with plan, sign-in method and state', () => {
    render(snapshot())
    for (const a of [work, personal, local, old, parked]) expect(q(`provider-account-row-${a.id}`), a.id).toBeTruthy()
    expect(q('provider-account-row-acc-gone')).toBeNull()
    expect(q('account-plan-acc-work')?.textContent).toBe('ChatGPT Plus')
    expect(q('account-method-acc-work')?.textContent).toBe('ChatGPT sign-in')
    expect(q('account-method-acc-personal')?.textContent).toBe('API key')
    expect(q('account-state-acc-work')?.textContent).toBe('Signed in')
    expect(q('account-state-acc-old')?.textContent).toBe('Needs attention: signed in as a different account')
  })

  it("titles the external home with its label, leaves its method empty, and never shows an identity's 'unverified' name", () => {
    render(snapshot())
    expect(q('account-name-acc-local')?.textContent).toBe("This computer's Codex (~/.codex)")
    expect(q('account-method-acc-local')).toBeNull()
    expect(q('account-plan-cell-acc-local')?.textContent).toBe('')
    expect(q('provider-account-row-acc-local')?.textContent).toContain('alex@example.com')
    expect(document.body.textContent).not.toContain('account unverified')
  })

  it('badges Default, Reviewer, Inactive, and Confirm each launch / Cannot run reviews for external and unverified accounts', () => {
    render(snapshot())
    expect(q('account-badge-default-acc-work')?.textContent).toBe('Default')
    expect(q('account-badge-default-acc-personal')).toBeNull()
    expect(q('account-badge-reviewer-acc-personal')?.textContent).toBe('Reviewer')
    expect(q('account-badge-reviewer-acc-work')).toBeNull()
    expect(q('account-badge-inactive-acc-parked')?.textContent).toBe('Inactive')
    expect(q('account-badge-inactive-acc-work')).toBeNull()
    for (const id of ['acc-local', 'acc-unv']) {
      expect(q(`account-badge-confirm-${id}`)?.textContent).toBe('Confirm each launch')
      expect(q(`account-no-reviews-${id}`)?.textContent).toBe('Cannot run reviews')
    }
    expect(q('account-badge-confirm-acc-work')).toBeNull()
  })

  it('offers each account only the actions its state allows', async () => {
    render(snapshot())
    // The default, with other active accounts, is not offered Make inactive (the registry wants another default first).
    expect(await menuKeys('acc-work')).toEqual(['make-reviewer', 'check-sign-in', 'sign-out'])
    expect(await menuKeys('acc-personal')).toEqual(['make-default', 'check-sign-in', 'sign-out', 'make-inactive'])
    // Blocked: "This is still my account" is its check (it vouches); no plain check.
    expect(await menuKeys('acc-old')).toEqual(['sign-out', 'make-inactive'])
    expect(await menuKeys('acc-parked')).toEqual(['check-sign-in', 'sign-out', 'make-active', 'archive'])
  })

  // WP2 commit 6g: the retired Codex settings tab's "Test connection", per
  // account. It runs the provider's own status check in that account's realm
  // (refreshStatus) and shows the answer on the row; it never vouches.
  describe('Check sign-in', () => {
    it('is offered on every account the provider can check, external included, and not on a blocked one', async () => {
      render(snapshot())
      for (const id of ['acc-work', 'acc-personal', 'acc-local', 'acc-parked', 'acc-unv', 'acc-refused']) expect(await menuKeys(id), id).toContain('check-sign-in')
      expect(await menuKeys('acc-old')).not.toContain('check-sign-in')
    })

    it('is not offered while the provider cannot check a sign-in, or is off', async () => {
      const codexNoStatus = provider({ providerId: 'codex', displayName: 'Codex', status: { enabled: false, labelExperimental: false } })
      render(snapshot({ providers: [snapshot().providers[0], codexNoStatus] }))
      expect(await menuKeys('acc-work')).not.toContain('check-sign-in')
      unmountNow()
      // Off: the accounts are listed unmanaged, with no menu at all.
      render(snapshot({ providers: [snapshot().providers[0], provider({ providerId: 'codex', displayName: 'Codex', enabled: false })] }))
      expect(q('provider-account-row-acc-work')).toBeTruthy()
      expect(q('account-menu-btn-acc-work')).toBeNull()
    })

    it("runs the account's status check, shows its answer on the row, and vouches for nothing", async () => {
      pa.refreshStatus.mockResolvedValueOnce({ ok: true, state: 'signed-out' } as never)
      render(snapshot())
      await click('account-menu-btn-acc-work')
      await click('account-menu-check-sign-in-acc-work')
      expect(pa.refreshStatus).toHaveBeenCalledWith('acc-work')
      expect(pa.reconcileSignIn).not.toHaveBeenCalled()
      expect(q('account-checked-acc-work')!.textContent).toBe('Checked just now: signed out.')
      expect(q('account-checked-acc-personal')).toBeNull()
      pa.refreshStatus.mockResolvedValueOnce({ ok: true, state: 'signed-in' } as never)
      await click('account-menu-btn-acc-work')
      await click('account-menu-check-sign-in-acc-work')
      expect(q('account-checked-acc-work')!.textContent).toBe('Checked just now: signed in.')
    })

    it('shows why a check could not run in the row error line, and drops the earlier answer', async () => {
      pa.refreshStatus.mockResolvedValueOnce({ ok: true, state: 'signed-in' } as never)
      render(snapshot())
      await click('account-menu-btn-acc-personal')
      await click('account-menu-check-sign-in-acc-personal')
      expect(q('account-checked-acc-personal')).toBeTruthy()
      pa.refreshStatus.mockResolvedValueOnce({ ok: false, code: 'busy', message: 'Something else is using this account right now.' } as never)
      await click('account-menu-btn-acc-personal')
      await click('account-menu-check-sign-in-acc-personal')
      expect(q('account-error-acc-personal')!.textContent!.length).toBeGreaterThan(0)
      expect(q('account-checked-acc-personal')).toBeNull()
    })

    it('the answer goes once the record moves on: a sign-in that changes after it, a block, or a lifecycle change', async () => {
      const push = async (s: ReturnType<typeof snapshot>) => { await act(async () => { useProviderAccountsStore.setState({ snapshot: s, loaded: true }) }); await flush() }
      const checkWork = async (state: string) => {
        pa.refreshStatus.mockResolvedValueOnce({ ok: true, state } as never)
        await click('account-menu-btn-acc-work')
        await click('account-menu-check-sign-in-acc-work')
      }
      render(snapshot())
      // The answer lands before the snapshot that records it: it stays.
      await checkWork('signed-out')
      expect(q('account-checked-acc-work')!.textContent).toBe('Checked just now: signed out.')
      await push(snapshot({ accounts: [{ ...work, lastKnownAuthState: 'signed-out' }, personal] }))
      expect(q('account-checked-acc-work')!.textContent).toBe('Checked just now: signed out.')
      // Signed in again elsewhere (Sign in again worked): the answer is stale.
      await push(snapshot({ accounts: [work, personal] }))
      expect(q('account-state-acc-work')!.textContent).toBe('Signed in')
      expect(q('account-checked-acc-work')).toBeNull()
      // Blocked by a later check: gone.
      await checkWork('signed-in')
      expect(q('account-checked-acc-work')).toBeTruthy()
      await push(snapshot({ accounts: [{ ...work, operationalState: 'blocked' }, personal] }))
      expect(q('account-checked-acc-work')).toBeNull()
      // A lifecycle change: gone.
      await push(snapshot({ accounts: [work, personal] }))
      await checkWork('signed-in')
      expect(q('account-checked-acc-work')).toBeTruthy()
      await push(snapshot({ accounts: [{ ...work, lifecycle: 'inactive' }, personal] }))
      expect(q('account-checked-acc-work')).toBeNull()
    })

    it('never shows an answer on a blocked row, even when the blocking snapshot lands before the answer', async () => {
      let answer: (v: unknown) => void = () => {}
      pa.refreshStatus.mockImplementationOnce(() => new Promise((r) => { answer = r }) as never)
      render(snapshot())
      await click('account-menu-btn-acc-work')
      await click('account-menu-check-sign-in-acc-work')
      await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [{ ...work, operationalState: 'blocked' }, personal] }), loaded: true }) })
      await flush()
      await act(async () => { answer({ ok: true, state: 'signed-in' }) })
      await flush()
      expect(q('account-state-acc-work')!.textContent).toBe('Needs attention: signed in as a different account')
      expect(q('account-checked-acc-work')).toBeNull()
    })

    it('Sign in again drops an earlier answer', async () => {
      const out = { ...personal, lastKnownAuthState: 'signed-out' as const }
      pa.refreshStatus.mockResolvedValueOnce({ ok: true, state: 'signed-out' } as never)
      render(snapshot({ accounts: [work, out, old] }))
      await click('account-menu-btn-acc-personal')
      await click('account-menu-check-sign-in-acc-personal')
      expect(q('account-checked-acc-personal')).toBeTruthy()
      await click('account-menu-btn-acc-personal')
      await click('account-menu-sign-in-again-acc-personal')
      expect(q('account-checked-acc-personal')).toBeNull()
    })
  })

  // WP2 commit 6g: the app never signs in to this computer's own home (an
  // external realm refuses sign-in), so a signed-out or expired row for it
  // says how.
  describe("this computer's own sign-in", () => {
    it('a signed-out or expired row says to run codex login in a terminal, then Check sign-in', async () => {
      for (const st of ['signed-out', 'expired'] as const) {
        render(snapshot({ accounts: [work, { ...local, lastKnownAuthState: st }] }))
        expect(q('account-external-hint-acc-local')!.textContent, st).toBe('Run codex login in a terminal, then Check sign-in.')
        unmountNow()
      }
    })

    it('says nothing while it is signed in, for a managed account, for a blocked one, or while Codex is off', async () => {
      render(snapshot({ accounts: [work, local, { ...personal, lastKnownAuthState: 'signed-out' }] }))
      expect(q('account-external-hint-acc-local')).toBeNull()
      expect(q('account-external-hint-acc-personal')).toBeNull()
      unmountNow()
      render(snapshot({ accounts: [work, { ...local, lastKnownAuthState: 'signed-out', operationalState: 'blocked' }] }))
      expect(q('account-external-hint-acc-local')).toBeNull()
      unmountNow()
      const off = snapshot({ accounts: [work, { ...local, lastKnownAuthState: 'signed-out' }] })
      off.providers[1] = { ...off.providers[1], enabled: false }
      render(off)
      expect(q('account-external-hint-acc-local')).toBeNull()
    })
  })

  it('offers Make inactive on the default when it is the only active account, and never Make active on a blocked one', async () => {
    const blockedParked = { ...parked, operationalState: 'blocked' as const }
    render(snapshot({ accounts: [work, blockedParked] }))
    expect(await menuKeys('acc-work')).toContain('make-inactive')
    const keys = await menuKeys('acc-parked')
    expect(keys).not.toContain('make-active')
    expect(keys).toContain('archive')
  })

  it('never offers Make reviewer on a refused, external or unverified account', async () => {
    render(snapshot())
    for (const id of ['acc-local', 'acc-unv', 'acc-refused']) {
      const keys = await menuKeys(id)
      expect(keys, id).not.toContain('make-reviewer')
      expect(keys, id).toContain('sign-out')
    }
  })

  it('never offers Make reviewer on an external account even when it is not marked unverified', async () => {
    const externalVouched = { ...local, unverified: false, identityAssurance: 'user-asserted' as const }
    render(snapshot({ accounts: [work, externalVouched] }))
    expect(await menuKeys('acc-local')).not.toContain('make-reviewer')
  })

  it('makes an account the reviewer from its menu', async () => {
    render(snapshot())
    await click('account-menu-btn-acc-work')
    await click('account-menu-make-reviewer-acc-work')
    expect(pa.setReviewerDefault).toHaveBeenCalledWith({ providerId: 'codex', accountId: 'acc-work' })
  })

  it('makes accounts inactive and active', async () => {
    render(snapshot())
    await click('account-menu-btn-acc-personal')
    await click('account-menu-make-inactive-acc-personal')
    expect(pa.setLifecycle).toHaveBeenCalledWith({ accountId: 'acc-personal', lifecycle: 'inactive' })
    await click('account-menu-btn-acc-parked')
    await click('account-menu-make-active-acc-parked')
    expect(pa.setLifecycle).toHaveBeenCalledWith({ accountId: 'acc-parked', lifecycle: 'active' })
  })

  it('archives a managed account without asking', async () => {
    render(snapshot())
    await click('account-menu-btn-acc-parked')
    await click('account-menu-archive-acc-parked')
    expect(q('external-ack-dialog')).toBeNull()
    expect(pa.setLifecycle).toHaveBeenCalledWith({ accountId: 'acc-parked', lifecycle: 'archived' })
  })

  it('says the account is in use, with the count and what is running, when an action is refused for that', async () => {
    const busyPersonal = { ...personal, runningSessions: 1, runningReviews: 1, consumers: 2 }
    pa.setDefault.mockResolvedValue({ ok: false, code: 'consumers', consumers: 2, message: 'Sessions or operations are using this account.' })
    render(snapshot({ accounts: [work, busyPersonal] }))
    await click('account-menu-btn-acc-personal')
    await click('account-menu-make-default-acc-personal')
    expect(pa.setDefault).toHaveBeenCalledWith('acc-personal')
    expect(q('account-error-acc-personal')?.textContent).toBe('This account is in use (2). Running now: 1 session, 1 review.')
  })

  it('reconciles a blocked account with "This is still my account"', async () => {
    render(snapshot())
    expect(q('account-reconcile-acc-work')).toBeNull()
    await click('account-reconcile-acc-old')
    expect(pa.reconcileSignIn).toHaveBeenCalledWith('acc-old')
  })

  it('renders the menu in a portal outside the card, and drives it from the keyboard', async () => {
    render(snapshot())
    const trigger = q('account-menu-btn-acc-personal')!
    await click('account-menu-btn-acc-personal')
    const menu = q('account-menu-btn-acc-personal-menu')!
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.getAttribute('aria-label')).toBe('Actions for Personal')
    expect(menu.parentElement).toBe(document.body)
    expect(q('provider-accounts-codex')!.contains(menu)).toBe(false)
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(document.activeElement).toBe(items[0])
    pressKey(menu, 'ArrowDown')
    expect(document.activeElement).toBe(items[1])
    pressKey(menu, 'ArrowUp')
    pressKey(menu, 'ArrowUp')
    expect(document.activeElement).toBe(items[items.length - 1])
    pressKey(document, 'Escape')
    expect(q('account-menu-btn-acc-personal-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('focuses the first item only once the menu is visible, and Tab closes it back to the trigger', async () => {
    render(snapshot())
    // A browser ignores focus() on a hidden element: record the menu's
    // visibility at the moment each item is focused.
    const seen: string[] = []
    const realFocus = HTMLElement.prototype.focus
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, opts?: FocusOptions) {
      const menu = this.closest('[role="menu"]') as HTMLElement | null
      if (menu) seen.push(menu.style.visibility)
      return realFocus.call(this, opts)
    })
    try {
      await click('account-menu-btn-acc-personal')
    } finally {
      spy.mockRestore()
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).toEqual(seen.map(() => 'visible'))
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { document.activeElement!.dispatchEvent(tab) })
    expect(tab.defaultPrevented).toBe(true)
    expect(q('account-menu-btn-acc-personal-menu')).toBeNull()
    expect(document.activeElement).toBe(q('account-menu-btn-acc-personal'))
  })

  it('badges an external account "Confirm each launch" and never "Reviewer" even when it is not marked unverified', () => {
    const externalVouched = { ...local, unverified: false, identityAssurance: 'user-asserted' as const, isReviewerDefault: true }
    render(snapshot({ accounts: [work, externalVouched] }))
    expect(q('account-badge-confirm-acc-local')?.textContent).toBe('Confirm each launch')
    expect(q('account-no-reviews-acc-local')?.textContent).toBe('Cannot run reviews')
    expect(q('account-badge-reviewer-acc-local')).toBeNull()
  })

  it('lists the accounts of a provider that is off without managing them', () => {
    const s = snapshot()
    s.providers[1] = { ...s.providers[1], enabled: false }
    render(s)
    expect(q('provider-off-note-codex')?.textContent).toBe('Turn Codex on to manage its accounts.')
    expect(q('provider-account-row-acc-work')).toBeTruthy()
    expect(document.querySelectorAll('[data-testid^="account-menu-btn-"]')).toHaveLength(0)
    expect(q('account-reconcile-acc-old')).toBeNull()
    expect(q('add-provider-account-codex')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// External home acknowledgement

describe('external sign-in acknowledgement', () => {
  it('asks before signing out of the shared home, then passes acknowledgeExternal', async () => {
    render(snapshot())
    await click('account-menu-btn-acc-local')
    await click('account-menu-sign-out-acc-local')
    expect(pa.logout).not.toHaveBeenCalled()
    expect(q('external-ack-text')?.textContent).toContain('shared with other apps on this computer')
    expect(q('external-ack-dialog')!.closest('[data-testid="provider-accounts-codex"]')).toBeNull()
    await click('external-ack-confirm')
    expect(pa.logout).toHaveBeenCalledWith({ accountId: 'acc-local', acknowledgeExternal: true })
  })

  it('does nothing when the acknowledgement is cancelled', async () => {
    render(snapshot())
    await click('account-menu-btn-acc-local')
    await click('account-menu-sign-out-acc-local')
    await click('external-ack-cancel')
    expect(q('external-ack-dialog')).toBeNull()
    expect(pa.logout).not.toHaveBeenCalled()
  })

  it('signs a managed account out without asking', async () => {
    render(snapshot())
    await click('account-menu-btn-acc-work')
    await click('account-menu-sign-out-acc-work')
    expect(q('external-ack-dialog')).toBeNull()
    expect(pa.logout).toHaveBeenCalledWith({ accountId: 'acc-work' })
  })

  it('asks before archiving the shared home, then passes acknowledgeExternal', async () => {
    const localInactive = { ...local, lifecycle: 'inactive' as const }
    render(snapshot({ accounts: [work, localInactive] }))
    await click('account-menu-btn-acc-local')
    await click('account-menu-archive-acc-local')
    expect(pa.setLifecycle).not.toHaveBeenCalled()
    await click('external-ack-confirm')
    expect(pa.setLifecycle).toHaveBeenCalledWith({ accountId: 'acc-local', lifecycle: 'archived', acknowledgeExternal: true })
  })
})

// ---------------------------------------------------------------------------
// Claude section

describe('Claude section', () => {
  it('shows the reviewer line with "(default)", the fallback note, and says when reviews cannot run on it', () => {
    const s = snapshot()
    s.providers[0] = { ...s.providers[0], review: { ready: false, accountId: claudeMain.id, source: 'provider-default' } }
    render(s)
    expect(q('reviewer-line-claude-account')?.textContent).toBe('Me (default)')
    expect(q('reviewer-line-claude')?.textContent).toContain('When none is set, reviews use the default account.')
    expect(q('reviewer-not-ready-claude')?.textContent).toBe("Reviews can't run on it right now.")
    expect(q('reviewer-line-codex-account')?.textContent).toBe('Personal (reviewer)')
    expect(q('reviewer-not-ready-codex')).toBeNull()
  })

  it('shows the macOS review callout on macOS only', () => {
    ;(window as any).electronPlatform = 'darwin'
    render(snapshot())
    expect(q('reviewer-mac-callout')?.textContent).toBe('Claude reviews on macOS use your normal Claude sign-in.')
    unmountNow()
    ;(window as any).electronPlatform = 'win32'
    render(snapshot())
    expect(q('reviewer-mac-callout')).toBeNull()
  })

  it('on macOS marks the account that cannot review, never as the reviewer, and offers Make reviewer only on the other', () => {
    ;(window as any).electronPlatform = 'darwin'
    const homeRefused = { ...claudeHome, isReviewerDefault: true, reviewRefusal: { reason: 'platform' as const, message: 'On macOS only the normal sign-in can review.' } }
    render(snapshot({ accounts: [claudeMain, homeRefused] }))
    expect(q('claude-review-refusal-profile-home')?.textContent).toBe("Can't run Claude reviews on macOS")
    expect(q('claude-reviewer-badge-profile-home')).toBeNull()
    expect(q('claude-make-reviewer-profile-home')).toBeNull()
    expect(q('claude-make-reviewer-profile-primary')).toBeTruthy()
    expect(q('claude-review-refusal-profile-primary')).toBeNull()
  })

  it("shows a platform refusal's own message off macOS", () => {
    const homeRefused = { ...claudeHome, reviewRefusal: { reason: 'platform' as const, message: 'Only the normal sign-in can review here.' } }
    render(snapshot({ accounts: [claudeMain, homeRefused] }))
    expect(q('claude-review-refusal-profile-home')?.textContent).toBe('Only the normal sign-in can review here.')
  })

  it('says when the app could not tell whether an account can review', () => {
    const homeUnknown = { ...claudeHome, reviewRefusal: { reason: 'unknown' as const, message: 'x' } }
    render(snapshot({ accounts: [claudeMain, homeUnknown] }))
    expect(q('claude-review-refusal-profile-home')?.textContent).toBe("Can't check whether this account can run reviews right now")
    expect(q('claude-make-reviewer-profile-home')).toBeNull()
  })

  it('shows the Reviewer badge on the chosen Claude reviewer and makes another one the reviewer', async () => {
    const homeReviewer = { ...claudeHome, isReviewerDefault: true }
    render(snapshot({ accounts: [claudeMain, homeReviewer] }))
    expect(q('claude-reviewer-badge-profile-home')?.textContent).toBe('Reviewer')
    expect(q('claude-make-reviewer-profile-home')).toBeNull()
    await click('claude-make-reviewer-profile-primary')
    expect(pa.setReviewerDefault).toHaveBeenCalledWith({ providerId: 'claude', accountId: 'acc-claude-main' })
  })

  it('shows why a Claude account could not be made the reviewer', async () => {
    pa.setReviewerDefault.mockResolvedValue({ ok: false, code: 'review-unavailable', message: 'This account cannot run reviews on this computer.' })
    render(snapshot({ accounts: [claudeMain, claudeHome] }))
    await click('claude-make-reviewer-profile-primary')
    expect(q('claude-reviewer-error-profile-primary')?.textContent).toBe('This account cannot run reviews on this computer.')
  })

  it('shows the cleared-reviewer notice once, in the macOS wording', () => {
    ;(window as any).electronPlatform = 'darwin'
    render(snapshot({ reviewerNotices: [{ providerId: 'claude', message: 'On macOS only the normal sign-in can review.' }] }))
    const notices = document.querySelectorAll('[data-testid="reviewer-notice-claude"]')
    expect(notices).toHaveLength(1)
    expect(notices[0].textContent).toBe('Your earlier Claude reviewer was cleared: on macOS only the normal Claude sign-in can be the Claude reviewer.')
    expect(q('reviewer-notice-codex')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Add Codex account

describe('Add Codex account', () => {
  const KEY = 'sk-test-DO-NOT-KEEP-4d1c9a'
  const HANDLE = 'sec-0123456789abcdef0123456789abcdef'

  it('sends the API key only through sendSecret, clears the field, and keeps it nowhere else', async () => {
    pa.beginSetup.mockResolvedValue({ ok: true, accountId: 'acc-new' })
    pa.issueSecretHandle.mockResolvedValue({ ok: true, handle: HANDLE })
    pa.signIn.mockResolvedValue({ ok: true, state: 'signed-in' })
    pa.completeSetup.mockResolvedValue({ ok: true, accountId: 'acc-new' })
    render(snapshot())

    await click('add-provider-account-codex')
    expect(q('add-account-dialog')!.closest('[data-testid="provider-accounts-codex"]')).toBeNull()
    await click('add-account-method-apiKey')
    expect(pa.beginSetup).toHaveBeenCalledWith({ providerId: 'codex', method: 'apiKey' })

    const input = q('add-account-key') as HTMLInputElement
    typeKey(input, KEY)
    await click('add-account-key-continue')

    expect(input.value).toBe('')
    expect(pa.sendSecret).toHaveBeenCalledTimes(1)
    expect(pa.sendSecret).toHaveBeenCalledWith({ handle: HANDLE, secret: KEY })
    expect(pa.issueSecretHandle).toHaveBeenCalledWith('acc-new')
    expect(pa.signIn).toHaveBeenCalledWith({ accountId: 'acc-new', method: 'apiKey', secretHandle: HANDLE })

    typeInto(q('add-account-name') as HTMLInputElement, 'Second')
    await click('add-account-finish')
    expect(pa.completeSetup).toHaveBeenCalledWith({ accountId: 'acc-new', identity: expect.objectContaining({ mode: 'new', friendlyName: 'Second' }) })
    expect(q('add-account-dialog')).toBeNull()
    expect(pa.abandonSetup).not.toHaveBeenCalled()
    assertKeyNowhere(KEY)
  })

  it('shows the device code and URL from the sign-in output, and Cancel stops the sign-in and drops the setup', async () => {
    let finishSignIn: (r: unknown) => void = () => {}
    pa.beginSetup.mockResolvedValue({ ok: true, accountId: 'acc-new' })
    pa.signIn.mockImplementation(() => new Promise((r) => { finishSignIn = r }))
    pa.cancelSignIn.mockImplementation(async () => { finishSignIn({ ok: false, code: 'cancelled', message: 'Cancelled.' }); return { ok: true } })
    render(snapshot())

    await click('add-provider-account-codex')
    await click('add-account-method-device')
    expect(pa.signIn).toHaveBeenCalledWith({ accountId: 'acc-new', method: 'device' })

    act(() => { signInOutput!({ accountId: 'acc-new', text: 'Open this link: https://auth.example.com/codex/device\nThen enter the code ABCD-EFGH' }) })
    act(() => { signInOutput!({ accountId: 'acc-other', text: 'https://other.example.com/x WXYZ-QRST' }) })
    expect(q('add-account-url')?.textContent).toBe('https://auth.example.com/codex/device')
    expect(q('add-account-code')?.textContent).toBe('ABCD-EFGH')
    expect(q('add-account-log')?.textContent).toContain('Then enter the code ABCD-EFGH')
    expect(q('add-account-log')?.textContent).not.toContain('other.example.com')

    await click('add-account-cancel')
    expect(pa.cancelSignIn).toHaveBeenCalledWith('acc-new')
    expect(pa.abandonSetup).toHaveBeenCalledWith('acc-new')
    expect(q('add-account-dialog')).toBeNull()
  })

  it('never starts a sign-in after Cancel while the setup is being created, and abandons the setup it made', async () => {
    let answerBegin: (r: unknown) => void = () => {}
    pa.beginSetup.mockImplementation(() => new Promise((r) => { answerBegin = r }))
    render(snapshot())
    await click('add-provider-account-codex')
    await click('add-account-method-browser')
    await click('add-account-cancel')
    await act(async () => { answerBegin({ ok: true, accountId: 'acc-late' }) })
    await flush()
    expect(pa.signIn).not.toHaveBeenCalled()
    expect(pa.abandonSetup).toHaveBeenCalledTimes(1)
    expect(pa.abandonSetup).toHaveBeenCalledWith('acc-late')
    expect(q('add-account-dialog')).toBeNull()
  })

  it('stops the sign-in and drops the setup when the dialog goes away without Cancel', async () => {
    let finishSignIn: (r: unknown) => void = () => {}
    pa.beginSetup.mockResolvedValue({ ok: true, accountId: 'acc-new' })
    pa.signIn.mockImplementation(() => new Promise((r) => { finishSignIn = r }))
    pa.cancelSignIn.mockImplementation(async () => { finishSignIn({ ok: false, code: 'cancelled', message: 'Cancelled.' }); return { ok: true } })
    render(snapshot())
    await click('add-provider-account-codex')
    await click('add-account-method-browser')
    expect(pa.signIn).toHaveBeenCalled()
    unmountNow()
    await tick()
    await flush()
    expect(pa.cancelSignIn).toHaveBeenCalledWith('acc-new')
    expect(pa.abandonSetup).toHaveBeenCalledWith('acc-new')
  })

  it('links the new account to an existing identity', async () => {
    pa.beginSetup.mockResolvedValue({ ok: true, accountId: 'acc-new' })
    pa.signIn.mockResolvedValue({ ok: true, state: 'signed-in' })
    pa.completeSetup.mockResolvedValue({ ok: true, accountId: 'acc-new' })
    render(snapshot())
    await click('add-provider-account-codex')
    await click('add-account-method-browser')
    await click('add-account-identity-link')
    const select = q('add-account-link-select') as HTMLSelectElement
    // Only vouched-for identities: never the external home's or an unverified one's.
    const options = [...select.options].map((o) => o.value)
    expect(options).toContain('id-personal')
    expect(options).not.toContain('id-ext')
    expect(options).not.toContain('id-unv')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'id-personal')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('add-account-finish')
    expect(pa.completeSetup).toHaveBeenCalledWith({ accountId: 'acc-new', identity: { mode: 'link', identityId: 'id-personal' } })
  })

  it('offers only the enabled sign-in methods and labels experimental ones', async () => {
    const s = snapshot()
    s.providers[1] = { ...s.providers[1], signInMethods: { browser: { enabled: true, labelExperimental: false }, device: { enabled: true, labelExperimental: true }, apiKey: { enabled: false, labelExperimental: false } } }
    render(s)
    await click('add-provider-account-codex')
    expect(q('add-account-method-browser')).toBeTruthy()
    expect(q('add-account-method-apiKey')).toBeNull()
    expect(q('add-account-method-device')?.textContent).toContain('Experimental')
    expect(q('add-account-method-browser')?.textContent).not.toContain('Experimental')
  })
})

// ---------------------------------------------------------------------------
// Sign in again

describe('Sign in again', () => {
  const KEY = 'sk-again-DO-NOT-KEEP-77ab'
  const HANDLE = 'sec-fedcba9876543210fedcba9876543210'
  const expired = account({ id: 'acc-exp', providerId: 'codex', identityId: 'id-work', providerLabel: 'alex@work.example', lastKnownAuthState: 'expired', authMethod: 'device' })
  const keyAccount = account({ id: 'acc-key', providerId: 'codex', identityId: 'id-personal', providerLabel: 'alex@home.example', lastKnownAuthState: 'signed-out', authMethod: 'apiKey' })
  const signedOut = account({ id: 'acc-out', providerId: 'codex', identityId: 'id-personal', lastKnownAuthState: 'signed-out' })
  const errored = account({ id: 'acc-err', providerId: 'codex', identityId: 'id-parked', lastKnownAuthState: 'error' })
  const unknown = account({ id: 'acc-unk', providerId: 'codex', identityId: 'id-unv', lastKnownAuthState: 'unknown' })
  const externalOut = { ...local, lastKnownAuthState: 'signed-out' as const }
  const blockedOut = { ...old, lastKnownAuthState: 'signed-out' as const }

  /** Opens the dialog; by default also ticks "same account as before". */
  async function openFor(accountId: string, confirmSame = true) {
    await click(`account-menu-btn-${accountId}`)
    await click(`account-menu-sign-in-again-${accountId}`)
    expect(q('sign-in-again-dialog'), 'the sign-in-again dialog did not open').toBeTruthy()
    if (confirmSame) await click('sign-in-again-confirm')
  }

  it('is offered only on a managed, unblocked, non-archived account that is not signed in', async () => {
    render(snapshot({ accounts: [work, expired, signedOut, errored, unknown, externalOut, blockedOut] }))
    for (const id of ['acc-exp', 'acc-out', 'acc-err', 'acc-unk']) expect(await menuKeys(id), id).toContain('sign-in-again')
    for (const id of ['acc-work', 'acc-local', 'acc-old']) expect(await menuKeys(id), id).not.toContain('sign-in-again')
    expect(canOfferSignInAgain(signedOut)).toBe(true)
    expect(canOfferSignInAgain({ ...signedOut, lifecycle: 'archived' })).toBe(false)
  })

  it('runs nothing and takes no key until "same account as before" is ticked', async () => {
    pa.issueSecretHandle.mockResolvedValue({ ok: true, handle: HANDLE })
    pa.signInAgain.mockResolvedValue({ ok: true, state: 'signed-in' })
    render(snapshot({ accounts: [work, keyAccount] }))
    await openFor('acc-key', false)

    expect(q('sign-in-again-who')?.textContent).toContain('Personal')
    expect(q('sign-in-again-who')?.textContent).toContain('alex@home.example')
    expect(q('sign-in-again-confirm-label')?.textContent).toBe('Sign in to the same account as before (alex@home.example).')
    expect(q('sign-in-again-who')?.textContent).toContain('A different account is blocked until you confirm it in Accounts.')

    expect((q('sign-in-again-continue') as HTMLButtonElement).disabled).toBe(true)
    await click('sign-in-again-continue')
    expect(q('sign-in-again-key')).toBeNull()
    expect(pa.signInAgain).not.toHaveBeenCalled()
    expect(pa.issueSecretHandle).not.toHaveBeenCalled()

    await click('sign-in-again-confirm')
    await click('sign-in-again-continue')
    typeKey(q('sign-in-again-key') as HTMLInputElement, KEY)
    await click('sign-in-again-key-continue')
    expect(pa.issueSecretHandle).toHaveBeenCalledTimes(1)
    expect(pa.signInAgain).toHaveBeenCalledTimes(1)
  })

  it('asks without an address when the account has no label', async () => {
    render(snapshot({ accounts: [work, signedOut] }))
    await openFor('acc-out', false)
    expect(q('sign-in-again-confirm-label')?.textContent).toBe('Sign in to the same account as before.')
  })

  it("offers only the account's recorded method family, with the recorded one selected", async () => {
    render(snapshot({ accounts: [work, expired, keyAccount] }))
    await openFor('acc-exp')
    expect(q('sign-in-again-method-browser')).toBeTruthy()
    expect(q('sign-in-again-method-device')?.getAttribute('aria-checked')).toBe('true')
    expect(q('sign-in-again-method-apiKey')).toBeNull()
    await click('sign-in-again-cancel')
    await openFor('acc-key')
    expect(q('sign-in-again-method-apiKey')?.getAttribute('aria-checked')).toBe('true')
    expect(q('sign-in-again-method-browser')).toBeNull()
    expect(q('sign-in-again-method-device')).toBeNull()
  })

  it('sends an API key only through sendSecret, clears the field, and closes on success', async () => {
    pa.issueSecretHandle.mockResolvedValue({ ok: true, handle: HANDLE })
    pa.signInAgain.mockResolvedValue({ ok: true, state: 'signed-in' })
    render(snapshot({ accounts: [work, keyAccount] }))
    await openFor('acc-key')
    await click('sign-in-again-continue')

    const input = q('sign-in-again-key') as HTMLInputElement
    typeKey(input, KEY)
    await click('sign-in-again-key-continue')

    expect(input.value).toBe('')
    expect(pa.issueSecretHandle).toHaveBeenCalledWith('acc-key')
    expect(pa.sendSecret).toHaveBeenCalledTimes(1)
    expect(pa.sendSecret).toHaveBeenCalledWith({ handle: HANDLE, secret: KEY })
    expect(pa.signInAgain).toHaveBeenCalledWith({ accountId: 'acc-key', method: 'apiKey', secretHandle: HANDLE })
    expect(pa.signIn).not.toHaveBeenCalled()
    expect(pa.beginSetup).not.toHaveBeenCalled()
    assertKeyNowhere(KEY)
    expect(q('sign-in-again-dialog')).toBeNull()
  })

  it('never sends the key or signs in after Cancel while the handle is being issued', async () => {
    let answerHandle: (r: unknown) => void = () => {}
    pa.issueSecretHandle.mockImplementation(() => new Promise((r) => { answerHandle = r }))
    render(snapshot({ accounts: [work, keyAccount] }))
    await openFor('acc-key')
    await click('sign-in-again-continue')
    typeKey(q('sign-in-again-key') as HTMLInputElement, KEY)
    await click('sign-in-again-key-continue')
    await click('sign-in-again-cancel')
    await act(async () => { answerHandle({ ok: true, handle: HANDLE }) })
    await flush()
    expect(pa.sendSecret).not.toHaveBeenCalled()
    expect(pa.signInAgain).not.toHaveBeenCalled()
    expect(q('sign-in-again-dialog')).toBeNull()
  })

  it('never sends the key or signs in when the dialog goes away without Cancel while the handle is being issued', async () => {
    let answerHandle: (r: unknown) => void = () => {}
    pa.issueSecretHandle.mockImplementation(() => new Promise((r) => { answerHandle = r }))
    render(snapshot({ accounts: [work, keyAccount] }))
    await openFor('acc-key')
    await click('sign-in-again-continue')
    typeKey(q('sign-in-again-key') as HTMLInputElement, KEY)
    await click('sign-in-again-key-continue')
    unmountNow()
    // The handle arrives after the unmount but before the deferred cleanup.
    await act(async () => { answerHandle({ ok: true, handle: HANDLE }) })
    await flush()
    await tick()
    await flush()
    expect(pa.sendSecret).not.toHaveBeenCalled()
    expect(pa.signInAgain).not.toHaveBeenCalled()
  })

  it('keeps focus inside: Tab from the last enabled control wraps while the final button is disabled', async () => {
    render(snapshot({ accounts: [work, signedOut] }))
    await openFor('acc-out', false)
    expect((q('sign-in-again-continue') as HTMLButtonElement).disabled).toBe(true)
    act(() => { q('sign-in-again-cancel')!.focus() })
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { document.dispatchEvent(tab) })
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('sign-in-again-close'))
  })

  it('shows a failure to record the new sign-in, and does not close as a success', async () => {
    pa.signInAgain.mockResolvedValue({ ok: false, code: 'persist-failed', state: 'signed-in', message: 'The change could not be saved.' })
    render(snapshot({ accounts: [work, signedOut] }))
    await openFor('acc-out')
    await click('sign-in-again-continue')
    expect(q('sign-in-again-error')?.textContent).toBe('The change could not be saved.')
    expect(q('sign-in-again-dialog')).toBeTruthy()
  })

  it("starts on the account's recorded method", async () => {
    pa.signInAgain.mockResolvedValue({ ok: true, state: 'signed-in' })
    render(snapshot({ accounts: [work, expired] }))
    await openFor('acc-exp')
    await click('sign-in-again-continue')
    expect(pa.signInAgain).toHaveBeenCalledWith({ accountId: 'acc-exp', method: 'device' })
  })

  it('runs the browser sign-in with that method, and Cancel stops it', async () => {
    let finish: (r: unknown) => void = () => {}
    pa.signInAgain.mockImplementation(() => new Promise((r) => { finish = r }))
    pa.cancelSignIn.mockImplementation(async () => { finish({ ok: false, code: 'cancelled', message: 'Cancelled.' }); return { ok: true } })
    render(snapshot({ accounts: [work, expired] }))
    await openFor('acc-exp')
    await click('sign-in-again-method-browser')
    await click('sign-in-again-continue')
    expect(pa.signInAgain).toHaveBeenCalledWith({ accountId: 'acc-exp', method: 'browser' })
    act(() => { signInOutput!({ accountId: 'acc-exp', text: 'Opening https://auth.example.com/login' }) })
    expect(q('sign-in-again-url')?.textContent).toBe('https://auth.example.com/login')
    await click('sign-in-again-cancel')
    expect(pa.cancelSignIn).toHaveBeenCalledWith('acc-exp')
    expect(q('sign-in-again-dialog')).toBeNull()
  })

  it('says the account is in use when it is refused for that', async () => {
    pa.signInAgain.mockResolvedValue({ ok: false, code: 'consumers', consumers: 2, message: 'Sessions or operations are using this account.' })
    render(snapshot({ accounts: [work, signedOut] }))
    await openFor('acc-out')
    await click('sign-in-again-continue')
    expect(q('sign-in-again-error')?.textContent).toBe('This account is in use (2).')
    expect(q('sign-in-again-dialog')).toBeTruthy()
  })

  it('points at "This is still my account" when the new sign-in blocked the account, and does not close', async () => {
    pa.signInAgain.mockResolvedValue({ ok: false, code: 'sign-in-changed', state: 'signed-in', message: 'x' })
    render(snapshot({ accounts: [work, signedOut] }))
    await openFor('acc-out')
    await click('sign-in-again-continue')
    expect(q('sign-in-again-error')?.textContent).toContain('This is still my account')
    expect(q('sign-in-again-dialog')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// The rest of the tab

describe('registry, conflicts, adoption and pending setups', () => {
  it('says once that the account list is unavailable and keeps the rest of the tab', () => {
    render(snapshot({ registry: { mode: 'recovery', reason: 'unreadable' }, accounts: [] }))
    expect(q('accounts-registry-callout')?.textContent).toContain('The account list is not available right now.')
    expect(document.querySelectorAll('[data-testid="accounts-registry-callout"]')).toHaveLength(1)
    expect(q('provider-accounts-codex')).toBeNull()
    expect(q('provider-accounts-claude')).toBeTruthy()
    expect(q('providers-card')).toBeTruthy()
  })

  it('shows no callout when the registry is ready', () => {
    render(snapshot())
    expect(q('accounts-registry-callout')).toBeNull()
  })

  it('resolves a name conflict either way', async () => {
    const conflict = { identityId: 'id-me', field: 'friendlyName' as const, providerId: 'claude' as const, legacyId: 'profile-primary', legacyValue: 'Mine', registryValue: 'Me', detectedAt: 1 }
    render(snapshot({ conflicts: [conflict] }))
    const banner = q('identity-conflict-id-me-friendlyName')!
    expect(banner.textContent).toContain('"Me"')
    expect(banner.textContent).toContain('"Mine"')
    await click('identity-conflict-id-me-friendlyName-keep-legacy')
    expect(pa.resolveConflict).toHaveBeenCalledWith({ identityId: 'id-me', field: 'friendlyName', providerId: 'claude', legacyId: 'profile-primary', keep: 'legacy' })
    expect(q('identity-conflict-id-me-friendlyName-keep-registry')?.textContent).toBe("Keep this app's")
    expect(q('identity-conflict-id-me-friendlyName-keep-legacy')?.textContent).toBe("Use Claude Code's")
  })

  it('says why the start-up check was skipped, and offers Check again where it got no answer', async () => {
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: false, marker: { outcome: 'skipped', reason: 'unavailable', at: 1 } }] }))
    expect(q('external-adoption-text-codex')?.textContent).toContain('could not check')
    expect(q('adopt-external-codex')?.textContent).toBe('Check again')
    await click('adopt-external-codex')
    expect(pa.adoptExternal).toHaveBeenCalledWith('codex')
    unmountNow()
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: false, marker: { outcome: 'skipped', reason: 'no-answer', at: 1 } }] }))
    expect(q('adopt-external-codex')?.textContent).toBe('Check again')
  })

  it("offers to use this computer's sign-in after a signed-out or otherwise skipped check, and explains an overlap without an offer", () => {
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: false, marker: { outcome: 'none', at: 1 } }] }))
    expect(q('external-adoption-text-codex')?.textContent).toContain('signed out')
    expect(q('adopt-external-codex')?.textContent).toBe("Use this computer's Codex sign-in")
    unmountNow()
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: false, marker: { outcome: 'skipped', reason: 'no-cli', at: 1 } }] }))
    expect(q('external-adoption-text-codex')?.textContent).toContain('CLI was not found')
    expect(q('adopt-external-codex')?.textContent).toBe("Use this computer's Codex sign-in")
    unmountNow()
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: false, marker: { outcome: 'skipped', reason: 'overlap', at: 1 } }] }))
    expect(q('external-adoption-text-codex')?.textContent).toContain('overlaps')
    expect(q('adopt-external-codex')).toBeNull()
  })

  it('asks whether the user uses Codex, and on yes turns it on, runs the check again, and shows what it found', async () => {
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: true }] }))
    expect(q('adopt-external-codex')).toBeNull()
    expect(q('confirm-uses-codex')?.textContent).toBe('Yes, I use Codex')
    await click('confirm-uses-codex')
    expect(pa.setEnabled).toHaveBeenCalledWith('codex', true)
    expect(updateSettings).toHaveBeenCalledWith({ codexEnabled: true })
    expect(pa.runMigration).toHaveBeenCalledWith('codex')
    expect(pa.setEnabled.mock.invocationCallOrder[0]).toBeLessThan(pa.runMigration.mock.invocationCallOrder[0])
    expect(updateSettings.mock.invocationCallOrder[0]).toBeLessThan(pa.runMigration.mock.invocationCallOrder[0])
    // What the check found arrives with the next snapshot.
    act(() => { useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: false, marker: { outcome: 'none', at: 2 } }] }) }) })
    expect(q('confirm-uses-codex')).toBeNull()
    expect(q('external-adoption-text-codex')?.textContent).toContain('signed out')
  })

  it('does not run the check when turning the provider on is refused', async () => {
    pa.setEnabled.mockResolvedValue({ ok: false, code: 'persist-failed', message: 'The change could not be saved.' })
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: true }] }))
    await click('confirm-uses-codex')
    expect(pa.runMigration).not.toHaveBeenCalled()
    expect(q('external-adoption-codex')?.textContent).toContain('The change could not be saved.')
  })

  it('offers nothing before the start-up check settles, while that home is being set up, or once an account stands for it', () => {
    const skipped = { providerId: 'codex' as const, needsConfirmation: false, marker: { outcome: 'skipped' as const, reason: 'unavailable' as const, at: 1 } }
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: true }] }))
    expect(q('external-adoption-text-codex')?.textContent).toContain('once you confirm you use Codex')
    expect(q('adopt-external-codex')).toBeNull()
    unmountNow()
    render(snapshot({ accounts: [work], externalDefaults: [{ providerId: 'codex', needsConfirmation: false }] }))
    expect(q('external-adoption-codex')).toBeNull()
    unmountNow()
    const pendingExternal = { accountId: 'acc-ext-pending', providerId: 'codex' as const, method: 'external' as const, state: 'pending' as const, external: true, createdAt: 1, signingIn: false }
    render(snapshot({ accounts: [work], externalDefaults: [skipped], pendingSetups: [pendingExternal] }))
    expect(q('external-adoption-codex')).toBeNull()
    unmountNow()
    render(snapshot({ accounts: [work, local], externalDefaults: [skipped] }))
    expect(q('external-adoption-codex')).toBeNull()
  })

  it('lists an unfinished setup with Discard, and Resume continues it at the naming step', async () => {
    const setup = { accountId: 'acc-half', providerId: 'codex' as const, method: 'browser' as const, state: 'credentials-written' as const, external: false, createdAt: 1, signingIn: false }
    pa.completeSetup.mockResolvedValue({ ok: true, accountId: 'acc-half' })
    render(snapshot({ pendingSetups: [setup] }))
    await click('pending-setup-discard-acc-half')
    expect(pa.abandonSetup).toHaveBeenCalledWith('acc-half')
    pa.abandonSetup.mockClear()

    await click('pending-setup-resume-acc-half')
    expect(q('add-account-step-name')).toBeTruthy()
    expect(pa.signIn).not.toHaveBeenCalled()
    await click('add-account-finish')
    expect(pa.completeSetup).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-half' }))
    expect(pa.abandonSetup).not.toHaveBeenCalled()
  })
})
