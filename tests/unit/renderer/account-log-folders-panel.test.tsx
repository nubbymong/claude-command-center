// @vitest-environment jsdom
// [host] WP2 PR 4, P4.4 (row 56): each Codex account's own log folders beside
// "Open log folder" in Settings, General, Debug Logging. The panel asks main
// for the folders by account and KIND and opens one by the same key: no path
// passes through the renderer. Hidden while Codex is not in use, or with no
// account to show.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { AccountLogFoldersPanel, LOG_FOLDER_RESULT_TEXT } = await import('../../../src/renderer/components/settings/AccountLogFoldersPanel')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')

const account = (id: string, identityId: string, over: Record<string, unknown> = {}) => ({
  id, providerId: 'codex', identityId, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'browser',
  lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active', external: false,
  unverified: false, legacyLinked: false, ...over,
})
const SNAPSHOT = {
  revision: 3, registry: { mode: 'ready' }, groups: [], pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
  providers: [{ providerId: 'codex', displayName: 'Codex' }],
  identities: [{ id: 'i-work', friendlyName: 'Work', colourKey: 'blue' }],
  accounts: [account('acct-work', 'i-work'), account('acct-home', 'i-home', { external: true })],
}

describe('AccountLogFoldersPanel', () => {
  let container: HTMLDivElement
  let root: Root
  const base = useSettingsStore.getState().settings
  let list: ReturnType<typeof vi.fn>
  let openFolder: ReturnType<typeof vi.fn>
  let savedApi: unknown

  beforeEach(() => {
    savedApi = (window as any).electronAPI
    list = vi.fn(async () => [{ accountId: 'acct-work', folders: ['log', 'log-dir'] }, { accountId: 'acct-home', folders: ['log'] }])
    openFolder = vi.fn(async () => ({ ok: true }))
    ;(window as any).electronAPI = { ...(savedApi as object), debug: { accountLogFolders: list, openAccountLogFolder: openFolder } }
    useSettingsStore.setState({ settings: { ...base, codexEnabled: true } })
    useProviderAccountsStore.setState({ snapshot: SNAPSHOT as never, loaded: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    ;(window as any).electronAPI = savedApi
    useSettingsStore.setState({ settings: base })
    useProviderAccountsStore.setState({ snapshot: null })
  })
  const render = async () => { await act(async () => { root.render(React.createElement(AccountLogFoldersPanel)) }) }
  const button = (accountId: string, folder: string) => container.querySelector(`[data-account="${accountId}"] [data-folder="${folder}"]`) as HTMLButtonElement | null

  it('lists each account by name with the folders main names, and opens one by account and kind only', async () => {
    await render()
    expect(container.textContent).toContain('Codex log folders')
    expect(container.querySelector('[data-account="acct-work"]')!.textContent).toContain('Work')
    expect(container.querySelector('[data-account="acct-home"]')!.textContent).toContain("This computer's Codex")
    expect(button('acct-work', 'log')!.textContent).toBe('Open log folder')
    expect(button('acct-work', 'log-dir')!.textContent).toBe('Show log_dir folder')
    expect(button('acct-home', 'log-dir')).toBeNull()
    await act(async () => { button('acct-work', 'log-dir')!.click() })
    expect(openFolder).toHaveBeenCalledWith({ accountId: 'acct-work', folder: 'log-dir' })
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('says why a folder was not opened', async () => {
    await render()
    for (const code of ['not-found', 'refused', 'not-set', 'unknown-account'] as const) {
      openFolder.mockResolvedValueOnce({ ok: false, code })
      await act(async () => { button('acct-work', 'log')!.click() })
      expect(container.querySelector('[data-account="acct-work"] [role="status"]')!.textContent).toBe(LOG_FOLDER_RESULT_TEXT[code])
    }
    openFolder.mockRejectedValueOnce(new Error('ipc gone'))
    await act(async () => { button('acct-work', 'log')!.click() })
    expect(container.querySelector('[data-account="acct-work"] [role="status"]')!.textContent).toBe(LOG_FOLDER_RESULT_TEXT.refused)
  })

  it('every line it shows is plain ASCII', () => {
    for (const t of Object.values(LOG_FOLDER_RESULT_TEXT)) expect(t).toMatch(/^[\x20-\x7e]+$/)
  })

  it('hidden while Codex is not in use (nothing asked), and with no account to show', async () => {
    useSettingsStore.setState({ settings: { ...base, codexEnabled: false } })
    await render()
    expect(container.innerHTML).toBe('')
    expect(list).not.toHaveBeenCalled()
    useSettingsStore.setState({ settings: { ...base, codexEnabled: true } })
    list.mockResolvedValueOnce([])
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('turning Codex off hides what was shown', async () => {
    await render()
    expect(container.querySelector('[data-testid="account-log-folders"]')).toBeTruthy()
    await act(async () => { useSettingsStore.setState({ settings: { ...base, codexEnabled: false } }) })
    expect(container.innerHTML).toBe('')
  })

  it('an older main without the channel shows nothing and throws nothing', async () => {
    ;(window as any).electronAPI = { debug: {} }
    await render()
    expect(container.innerHTML).toBe('')
  })
})
