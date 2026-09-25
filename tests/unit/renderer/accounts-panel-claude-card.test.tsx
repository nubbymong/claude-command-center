// @vitest-environment jsdom
/**
 * Settings, Accounts: the Claude card's add button and notes (VM audit
 * 2026-09-25, items 7 and 8).
 *
 * Verifies:
 *   - the add button says "Add an account" when the card lists none, and
 *     "Add another account" only once there is one;
 *   - with Claude Code off (the saved setting, or main's switch), the card
 *     offers no add button (no Claude session starts while it is off, so an
 *     account added then could not be used) and says how to turn it on, as
 *     the other providers' cards do;
 *   - the notes are drawn in --text-muted (4.5:1 or better on this card in
 *     both themes, token-contrast.test.ts), not --color-overlay0, which
 *     measured 2.1:1 (dark) and 3.2:1 (light);
 *   - (round 2) the reviewer line ("No account can run code reviews yet.
 *     When none is set, reviews use the default account.") is not shown for
 *     a provider that is off, Claude Code or Codex.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountProfile } from '../../../src/shared/account-types'
import { provider, snapshot } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  accountProfiles: {
    list: vi.fn(async () => []),
    delete: vi.fn(async () => ({ ok: true })),
    rename: vi.fn(async () => ({ ok: true })),
    setActive: vi.fn(async () => ({ ok: true })),
    globalEmail: vi.fn(async () => null),
    create: vi.fn(),
    refreshIdentity: vi.fn(async () => null),
    managedLaunchReports: vi.fn(async () => []),
  },
  config: { save: vi.fn(async () => undefined) },
  // Rendered per account; not under test here.
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

const { default: AccountsPanel } = await import('../../../src/renderer/components/AccountsPanel')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { ReviewerLineBlock } = await import('../../../src/renderer/components/settings/accounts/accounts-ui')

const primary: AccountProfile = { id: 'profile-primary', name: 'Personal', accountEmail: 'me@example.com', isPrimary: true, createdAt: 500_000 }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useAccountProfilesStore.setState({ profiles: [] })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, accountAliases: {}, accountColourOverrides: {} }, isLoaded: true })
  useProviderAccountsStore.setState({ snapshot: null, loaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

async function render() {
  await act(async () => { root.render(<AccountsPanel onAdd={vi.fn()} />) })
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })
}

describe('the Claude card\'s add button', () => {
  it('lists no account: "Add an account"', async () => {
    await render()
    expect(byTest('add-account-btn')!.textContent!.trim()).toBe('Add an account')
  })

  it('lists one: "Add another account"', async () => {
    useAccountProfilesStore.setState({ profiles: [primary] })
    await render()
    expect(byTest('add-account-btn')!.textContent!.trim()).toBe('Add another account')
  })

  it('Claude Code off in the saved setting: no add button; the card says how to turn it on', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true }, isLoaded: true })
    await render()
    expect(byTest('add-account-btn')).toBeNull()
    expect(byTest('provider-off-note-claude')!.textContent).toBe('Turn Claude Code on to add an account.')
  })

  it('Claude Code switched off in main: the same', async () => {
    useProviderAccountsStore.setState({
      snapshot: snapshot({ providers: [provider({ providerId: 'claude', displayName: 'Claude Code', enabled: false }), provider({ providerId: 'codex', displayName: 'Codex' })] }),
      loaded: true,
    })
    await render()
    expect(byTest('add-account-btn')).toBeNull()
    expect(byTest('provider-off-note-claude')).not.toBeNull()
  })
})

describe('the Claude card\'s notes are readable', () => {
  it('the account note is --text-muted, not --color-overlay0', async () => {
    await render()
    const note = byTest('accounts-claude-note')!
    expect(note.textContent).toContain('The email is the account')
    expect(note.style.color).toBe('var(--text-muted)')
    expect(note.className).not.toMatch(/overlay0/)
  })

  it('so is the macOS note', async () => {
    ;(globalThis as any).window.electronPlatform = 'darwin'
    try {
      await render()
      const note = byTest('accounts-mac-note')!
      expect(note.textContent).toContain('Multiple accounts are not available on macOS yet')
      expect(note.style.color).toBe('var(--text-muted)')
      expect(note.className).not.toMatch(/overlay0/)
    } finally {
      ;(globalThis as any).window.electronPlatform = 'win32'
    }
  })
})

describe('the reviewer line of a provider that is off', () => {
  // Both providers review here (review set) and have no reviewer account yet.
  function snap(claudeOn: boolean, codexOn: boolean) {
    return snapshot({
      providers: [
        provider({ providerId: 'claude', displayName: 'Claude Code', enabled: claudeOn, review: { ready: false } }),
        provider({ providerId: 'codex', displayName: 'Codex', enabled: codexOn, review: { ready: false } }),
      ],
      accounts: [],
    })
  }
  async function line(providerId: 'claude' | 'codex') {
    await act(async () => { root.render(<ReviewerLineBlock providerId={providerId} />) })
    return byTest(`reviewer-line-${providerId}`)
  }

  it('on: the line says which account reviews use', async () => {
    useProviderAccountsStore.setState({ snapshot: snap(true, true), loaded: true })
    expect((await line('claude'))!.textContent).toContain('No account can run code reviews yet.')
    expect((await line('codex'))!.textContent).toContain('When none is set, reviews use the default account.')
  })

  it('Claude Code off: the Claude card says nothing about reviews', async () => {
    useProviderAccountsStore.setState({ snapshot: snap(false, true), loaded: true })
    expect(await line('claude')).toBeNull()
    await render()
    expect(byTest('reviewer-line-claude')).toBeNull()
    expect(container.textContent).not.toContain('code reviews')
  })

  it('Codex off: nor does the Codex card', async () => {
    useProviderAccountsStore.setState({ snapshot: snap(true, false), loaded: true })
    expect(await line('codex')).toBeNull()
  })
})
