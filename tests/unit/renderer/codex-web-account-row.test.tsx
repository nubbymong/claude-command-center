// @vitest-environment jsdom
// [host] WP2 PR 4, P4.6 second half (row 58): a Codex account's row in
// Settings, Accounts, carries its chatgpt.com web session: a status line and
// "Sign in to chatgpt.com" / "Sign out of chatgpt.com" in the row menu, each
// for THAT account. The CLI's own Sign out never touches the web session
// (Claude parity: its CLI sign-out never clears claude.ai). No sign-in method
// is named. An archived account, a provider that is off, and an id that is not
// a registry account id get none of it.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot } from '../../../src/shared/providers'
import { provider, account } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const A = 'acct-0123456789abcdef'
const P = 'acct-aaaaaaaaaaaaaaaa'
const G = 'acct-bbbbbbbbbbbbbbbb'
const ok = () => Promise.resolve({ ok: true })

const webStatus: Record<string, Record<string, unknown>> = {}
const codexWeb = {
  status: vi.fn((id: string) => Promise.resolve({ ok: true, web: webStatus[id] ?? { accountId: id, status: 'none' } })),
  signIn: vi.fn((id: string) => Promise.resolve({ ok: true, state: { phase: 'done', accountId: id } })),
  signInState: vi.fn(() => Promise.resolve({ ok: true, state: { phase: 'idle', accountId: null } })),
  cancel: vi.fn(ok),
  signOut: vi.fn(ok),
  paneOpen: vi.fn(ok),
}
const providerAccounts = {
  snapshot: vi.fn(() => Promise.resolve(null)),
  onChanged: vi.fn(() => () => {}),
  logout: vi.fn(() => Promise.resolve({ ok: true, state: 'signed-out' })),
  setLifecycle: vi.fn(() => Promise.resolve({ ok: false, code: 'lifecycle', message: 'refused' })),
}

const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useCodexWebStore } = await import('../../../src/renderer/stores/codexWebStore')
const { ManagedAccountsSection } = await import('../../../src/renderer/components/settings/accounts/ManagedAccountsSection')

function snapshot(over: { codexEnabled?: boolean; ids?: string[] } = {}): AccountsSnapshot {
  const [a, p, g] = over.ids ?? [A, P, G]
  return {
    revision: 1,
    registry: { mode: 'ready' },
    providers: [provider({ providerId: 'codex', displayName: 'Codex', enabled: over.codexEnabled ?? true })],
    identities: [
      { id: 'idn-work', friendlyName: 'Work', colourKey: 'indigo' },
      { id: 'idn-parked', friendlyName: 'Parked', colourKey: 'plum' },
      { id: 'idn-gone', friendlyName: 'Gone', colourKey: 'plum' },
    ],
    groups: [],
    accounts: [
      account({ id: a, providerId: 'codex', identityId: 'idn-work', providerLabel: 'alex@work.example', isProviderDefault: true }),
      account({ id: p, providerId: 'codex', identityId: 'idn-parked', lifecycle: 'inactive' }),
      account({ id: g, providerId: 'codex', identityId: 'idn-gone', lifecycle: 'archived', archivedAt: 1 }),
    ],
    pendingSetups: [],
    externalDefaults: [],
    conflicts: [],
    reviewerNotices: [],
  } as AccountsSnapshot
}

let container: HTMLElement
let root: Root
const flush = () => act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve() })
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
async function click(id: string) {
  const el = q(id)
  expect(el, `no element ${id}`).toBeTruthy()
  await act(async () => { el!.click() })
  await flush()
}
async function menu(id: string): Promise<Record<string, string>> {
  await click(`account-menu-btn-${id}`)
  const items: Record<string, string> = {}
  for (const el of document.querySelectorAll(`[data-testid^="account-menu-"][data-testid$="-${id}"][role="menuitem"]`)) {
    items[el.getAttribute('data-testid')!.slice('account-menu-'.length, -(id.length + 1))] = el.textContent ?? ''
  }
  return items
}

async function render(s: AccountsSnapshot) {
  useProviderAccountsStore.setState({ snapshot: s, loaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(React.createElement(ManagedAccountsSection, { providerId: 'codex' })) })
  await flush()
}

beforeEach(() => {
  for (const k of Object.keys(webStatus)) delete webStatus[k]
  for (const f of [...Object.values(codexWeb), ...Object.values(providerAccounts)]) (f as ReturnType<typeof vi.fn>).mockClear()
  ;(window as any).electronAPI.codexWeb = codexWeb
  ;(window as any).electronAPI.providerAccounts = { ...((window as any).electronAPI.providerAccounts ?? {}), ...providerAccounts }
  useCodexWebStore.setState({ byAccount: {}, signingIn: null, errors: {} })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  delete (window as any).electronAPI.codexWeb
})

describe('[host] a Codex account row: its chatgpt.com web session', () => {
  it('signed out: the menu offers Sign in to chatgpt.com, no sign-out, and no status line', async () => {
    await render(snapshot())
    expect(codexWeb.status).toHaveBeenCalledWith(A)
    expect(q(`account-web-${A}`)).toBeNull()
    const items = await menu(A)
    expect(items['chatgpt-sign-in']).toBe('Sign in to chatgpt.com')
    expect(items['chatgpt-sign-out']).toBeUndefined()
    // No sign-in method is named anywhere on the row.
    expect(document.body.textContent).not.toMatch(/Google|Apple|phone|Microsoft/i)
  })

  it('signed in: the row shows the email; the menu offers signing in again and signing out', async () => {
    webStatus[A] = { accountId: A, status: 'active', accountEmail: 'me@example.com', origin: 'in-app' }
    await render(snapshot())
    expect(q(`account-web-${A}`)!.textContent).toBe('chatgpt.com: signed in as me@example.com')
    const items = await menu(A)
    expect(items['chatgpt-sign-in']).toBe('Sign in to chatgpt.com again')
    expect(items['chatgpt-sign-out']).toBe('Sign out of chatgpt.com')
  })

  it('Sign in to chatgpt.com runs the sign-in for THAT account; a failure is shown on the row', async () => {
    codexWeb.signIn.mockImplementationOnce((id: string) => Promise.resolve({ ok: true, state: { phase: 'failed', accountId: id, error: 'Timed out waiting for sign-in to complete.' } }))
    await render(snapshot())
    await menu(A)
    await click(`account-menu-chatgpt-sign-in-${A}`)
    expect(codexWeb.signIn).toHaveBeenCalledWith(A)
    expect(q(`account-web-error-${A}`)!.textContent).toBe('chatgpt.com: Timed out waiting for sign-in to complete.')
  })

  it('while it runs, the row says so and offers Cancel for that account', async () => {
    let finish: (v: unknown) => void = () => {}
    codexWeb.signIn.mockImplementationOnce(() => new Promise((r) => { finish = r }))
    await render(snapshot())
    await menu(A)
    await click(`account-menu-chatgpt-sign-in-${A}`)
    expect(q(`account-web-${A}`)!.textContent).toContain('finish the sign-in in its window')
    await click(`account-web-cancel-${A}`)
    expect(codexWeb.cancel).toHaveBeenCalledWith(A)
    await act(async () => { finish({ ok: true, state: { phase: 'failed', accountId: A, error: 'Sign-in cancelled.' } }) })
    await flush()
  })

  it('Sign out of chatgpt.com signs THAT account out of chatgpt.com only', async () => {
    webStatus[A] = { accountId: A, status: 'active', accountEmail: 'me@example.com', origin: 'in-app' }
    await render(snapshot())
    await menu(A)
    await click(`account-menu-chatgpt-sign-out-${A}`)
    expect(codexWeb.signOut).toHaveBeenCalledWith(A)
    expect(providerAccounts.logout).not.toHaveBeenCalled()
  })

  it('the CLI Sign out never clears the web session (Claude parity)', async () => {
    webStatus[A] = { accountId: A, status: 'active', accountEmail: 'me@example.com', origin: 'in-app' }
    await render(snapshot())
    await menu(A)
    await click(`account-menu-sign-out-${A}`)
    expect(providerAccounts.logout).toHaveBeenCalled()
    expect(codexWeb.signOut).not.toHaveBeenCalled()
  })

  it('an inactive account keeps it; an archived account, a provider that is off, or a non-registry id get none', async () => {
    await render(snapshot())
    expect((await menu(P))['chatgpt-sign-in']).toBe('Sign in to chatgpt.com')
    expect(codexWeb.status).not.toHaveBeenCalledWith(G)
    act(() => { root.unmount() }); container.remove(); document.body.innerHTML = ''
    codexWeb.status.mockClear()
    await render(snapshot({ codexEnabled: false }))
    expect(codexWeb.status).not.toHaveBeenCalled()
    act(() => { root.unmount() }); container.remove(); document.body.innerHTML = ''
    await render(snapshot({ ids: ['acc-work', 'acc-parked', 'acc-gone'] }))
    expect(codexWeb.status).not.toHaveBeenCalled()
    expect((await menu('acc-work'))['chatgpt-sign-in']).toBeUndefined()
  })
})

describe('[host] the row follows a sign-in it did not start, and reads afresh after an archive', () => {
  it("a second sign-in main refuses never takes over the running one's line and Cancel", async () => {
    let finishA: (v: unknown) => void = () => {}
    codexWeb.signIn.mockImplementationOnce(() => new Promise((r) => { finishA = r }))
    codexWeb.signIn.mockImplementationOnce((id: string) => Promise.resolve({ ok: true, state: { phase: 'failed', accountId: id, error: 'A sign-in is already in progress. Finish or cancel it first.' } }))
    await render(snapshot())
    await menu(A)
    await click(`account-menu-chatgpt-sign-in-${A}`)
    expect(q(`account-web-cancel-${A}`)).not.toBeNull()
    await act(async () => { await useCodexWebStore.getState().signIn(P) })
    await flush()
    // A's run still owns the line and its Cancel.
    expect(useCodexWebStore.getState().signingIn).toBe(A)
    expect(q(`account-web-cancel-${A}`)).not.toBeNull()
    await act(async () => { finishA({ ok: true, state: { phase: 'done', accountId: A } }) })
    await flush()
    expect(useCodexWebStore.getState().signingIn).toBeNull()
  })

  it('a sign-in main is already running shows on its row again when the page opens', async () => {
    codexWeb.signInState.mockImplementation(() => Promise.resolve({ ok: true, state: { phase: 'awaiting-user', accountId: A } }))
    try {
      await render(snapshot())
      await flush()
      expect(q(`account-web-cancel-${A}`)).not.toBeNull()
      codexWeb.signInState.mockImplementation(() => Promise.resolve({ ok: true, state: { phase: 'failed', accountId: A, error: 'Sign-in cancelled.' } }))
      await act(async () => { await new Promise((r) => setTimeout(r, 1700)) })
      await flush()
      expect(q(`account-web-cancel-${A}`)).toBeNull()
      expect(useCodexWebStore.getState().signingIn).toBeNull()
    } finally {
      codexWeb.signInState.mockImplementation(() => Promise.resolve({ ok: true, state: { phase: 'idle', accountId: null } }))
    }
  })

  it('an archive attempt, refused or not, reads the chatgpt.com status afresh', async () => {
    await render(snapshot())
    const before = codexWeb.status.mock.calls.filter((c) => c[0] === P).length
    await menu(P)
    await click(`account-menu-archive-${P}`)
    expect(providerAccounts.setLifecycle).toHaveBeenCalled()
    expect(codexWeb.status.mock.calls.filter((c) => c[0] === P).length).toBeGreaterThan(before)
  })
})

describe('[host] a restored sign-in line follows only the run it found', () => {
  it("when another account's run is the one in flight at the next look, the first account's line goes", async () => {
    let next = { phase: 'awaiting-user', accountId: A }
    codexWeb.signInState.mockImplementation(() => Promise.resolve({ ok: true, state: next }))
    try {
      await render(snapshot())
      await flush()
      expect(q(`account-web-cancel-${A}`)).not.toBeNull()
      // A's run ended and P's started within one poll.
      next = { phase: 'awaiting-user', accountId: P }
      await act(async () => { await new Promise((r) => setTimeout(r, 1700)) })
      await flush()
      expect(q(`account-web-cancel-${A}`)).toBeNull()
      expect(useCodexWebStore.getState().signingIn).not.toBe(A)
    } finally {
      codexWeb.signInState.mockImplementation(() => Promise.resolve({ ok: true, state: { phase: 'idle', accountId: null } }))
    }
  })
})

describe('[host] a row over a record store it cannot account for', () => {
  it('says why instead of a plain none, and still offers Sign out of chatgpt.com', async () => {
    webStatus[A] = { accountId: A, status: 'none', unavailable: "This account's chatgpt.com records were written by a newer version of the app." }
    try {
      await render(snapshot())
      await flush()
      expect(q(`account-web-${A}`)!.textContent).toBe("chatgpt.com: This account's chatgpt.com records were written by a newer version of the app.")
      await menu(A)
      expect(q(`account-menu-chatgpt-sign-out-${A}`)).not.toBeNull()
    } finally {
      delete webStatus[A]
    }
  })
})
