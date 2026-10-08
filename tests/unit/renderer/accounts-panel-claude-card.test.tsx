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
  config: { save: vi.fn(async () => true) },
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
    expect(byTest('provider-off-note-claude')!.textContent).toBe('Turn Claude Code on to manage its accounts.')
  })

  it('Claude Code off (P3.2, row 14): the accounts are listed, not managed, and nothing prompts a sign-in', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true }, isLoaded: true })
    const other: AccountProfile = { id: 'profile-work', name: 'Work', accountEmail: 'work@example.com', createdAt: 600_000 }
    useAccountProfilesStore.setState({ profiles: [primary, other] })
    ;(window as any).electronAPI.accountWeb.status.mockClear()
    await render()
    expect(byTest(`profile-row-${other.id}`)).not.toBeNull()
    // No menu, no editor, no claude.ai sign-in, no account notes: one muted line.
    expect(byTest(`profile-menu-btn-${other.id}`)).toBeNull()
    expect(byTest(`profile-chip-${other.id}`)!.tagName).toBe('SPAN')
    expect(container.querySelector('[data-testid^="account-web-session"]')).toBeNull()
    expect((window as any).electronAPI.accountWeb.status).not.toHaveBeenCalled()
    expect(byTest('accounts-claude-note')).toBeNull()
    expect(byTest('provider-off-note-claude')).not.toBeNull()
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

describe('the experimental macOS multi-account setting', () => {
  afterEach(() => { ;(globalThis as any).window.electronPlatform = 'win32' })

  it('macOS, setting off: the D2 note, no add button, and the toggle off', async () => {
    ;(globalThis as any).window.electronPlatform = 'darwin'
    useAccountProfilesStore.setState({ profiles: [primary] })
    await render()
    expect(byTest('accounts-mac-note')).not.toBeNull()
    expect(byTest('add-account-btn')).toBeNull()
    const sw = byTest('mac-multi-account-toggle')!.querySelector('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(byTest('mac-multi-account-toggle')!.textContent).toMatch(/Experimental/)
    // Honest about what was checked: the CLI mechanism by hand on a Mac; not
    // this app on a Mac, and not the version floor.
    const copy = byTest('mac-multi-account-toggle')!.textContent!
    expect(copy).toMatch(/Checked by hand with the Claude Code CLI on a Mac/)
    expect(copy).toMatch(/Not yet tested inside this app on a Mac/)
    expect(copy).toMatch(/not confirmed/)
  })

  it('macOS, setting on: the Claude reviewer copy no longer says only the normal sign-in can review', async () => {
    ;(globalThis as any).window.electronPlatform = 'darwin'
    const { reviewerNotice } = await import('../../../src/renderer/stores/providerAccountsStore')
    const snap = { reviewerNotices: [{ providerId: 'claude', message: 'cleared' }] } as any
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
    expect(reviewerNotice(snap, 'claude', 'darwin')).toMatch(/only the normal Claude sign-in/)
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, experimentalMacMultiAccount: true }, isLoaded: true })
    expect(reviewerNotice(snap, 'claude', 'darwin')).not.toMatch(/only the normal Claude sign-in/)
    expect(reviewerNotice(snap, 'claude', 'win32')).toBe(reviewerNotice(snap, 'claude', 'darwin'))
  })

  it('macOS, setting on: the add button replaces the note', async () => {
    ;(globalThis as any).window.electronPlatform = 'darwin'
    useAccountProfilesStore.setState({ profiles: [primary] })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, experimentalMacMultiAccount: true }, isLoaded: true })
    await render()
    expect(byTest('accounts-mac-note')).toBeNull()
    expect(byTest('add-account-btn')!.textContent!.trim()).toBe('Add another account')
    expect(byTest('mac-multi-account-toggle')!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  })

  it('flipping the toggle saves the one key main reads', async () => {
    ;(globalThis as any).window.electronPlatform = 'darwin'
    await render()
    const sw = byTest('mac-multi-account-toggle')!.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => { sw.click() })
    expect(useSettingsStore.getState().settings.experimentalMacMultiAccount).toBe(true)
    expect(byTest('accounts-mac-note')).toBeNull()
  })

  // Adversarial review pass 3, M4: main reads the SAVED file. A toggle whose
  // save failed must not look on (renderer ON / main OFF would offer accounts
  // main then refuses to launch).
  it('M4: a toggle whose save FAILED is put back, and says so', async () => {
    ;(globalThis as any).window.electronPlatform = 'darwin'
    const realUpdate = useSettingsStore.getState().updateSettings
    useSettingsStore.setState({
      updateSettings: async (u: Record<string, unknown>) => {
        useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...u } }))
        return false
      },
    } as never)
    try {
      await render()
      const sw = byTest('mac-multi-account-toggle')!.querySelector('[role="switch"]') as HTMLButtonElement
      await act(async () => { sw.click(); for (let i = 0; i < 6; i++) await Promise.resolve() })
      expect(useSettingsStore.getState().settings.experimentalMacMultiAccount).not.toBe(true)
      expect(byTest('mac-multi-account-toggle')!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
      expect(byTest('mac-multi-account-save-error')!.textContent).toMatch(/could not be saved/)
      expect(byTest('accounts-mac-note')).not.toBeNull()
    } finally {
      useSettingsStore.setState({ updateSettings: realUpdate } as never)
    }
  })

  // Re-attack R4: the failed payload (toggle ON) was kept for the BottomBar
  // Retry, which later wrote it -- main ON while the UI showed OFF.
  it('R4: after a failed toggle save, Retry writes the REVERTED setting, never the failed one', async () => {
    ;(globalThis as any).window.electronPlatform = 'darwin'
    const { retryFailedConfigSaves } = await import('../../../src/renderer/utils/config-saver')
    const save = (globalThis as any).window.electronAPI.config.save as ReturnType<typeof vi.fn>
    save.mockReset()
    save.mockResolvedValue(false)
    try {
      await render()
      const sw = byTest('mac-multi-account-toggle')!.querySelector('[role="switch"]') as HTMLButtonElement
      await act(async () => { sw.click(); for (let i = 0; i < 10; i++) await Promise.resolve() })
      expect(useSettingsStore.getState().settings.experimentalMacMultiAccount).not.toBe(true)
      save.mockReset()
      save.mockResolvedValue(true)
      await act(async () => { await retryFailedConfigSaves() })
      const settingsWrites = save.mock.calls.filter((c: unknown[]) => c[0] === 'settings')
      expect(settingsWrites.length).toBeGreaterThan(0)
      for (const c of settingsWrites) expect((c[1] as Record<string, unknown>).experimentalMacMultiAccount).not.toBe(true)
    } finally {
      save.mockReset()
      save.mockResolvedValue(true)
    }
  })

  it('Windows: no toggle, and the setting changes nothing', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, experimentalMacMultiAccount: true }, isLoaded: true })
    await render()
    expect(byTest('mac-multi-account-toggle')).toBeNull()
    expect(byTest('accounts-mac-note')).toBeNull()
    expect(byTest('add-account-btn')).not.toBeNull()
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
