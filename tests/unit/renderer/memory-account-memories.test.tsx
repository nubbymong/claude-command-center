// @vitest-environment jsdom
// [host] WP2 PR 4, P4.4 (row 55): each Codex account's own memories on the
// Memory page, labelled by account, with the "memories are off" state where
// an account has none; a file opens in the reading drawer read-only (no
// frontmatter edit; no Delete until its VM check, ACCOUNT_MEMORY_DELETE_SHOWN);
// search spans them; nothing of it while Codex is not in use.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountMemories, AccountMemoryFile } from '../../../src/shared/account-memories'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const file = (accountId: string, relPath: string, over: Partial<AccountMemoryFile> = {}): AccountMemoryFile => ({
  id: `${accountId}:${relPath}`, name: relPath.split('/').pop()!.replace(/\.md$/, ''), filename: relPath, project: '', projectDir: `account:${accountId}`,
  type: relPath === 'MEMORY.md' ? 'reference' : 'uncategorized', description: `about ${relPath}`, size: 120, modified: Date.now(), hasFrontmatter: false,
  path: `C:\\realms\\${accountId}\\memories\\${relPath.split('/').join('\\')}`, providerId: 'codex', accountId, relPath, ...over,
})
const ACCOUNTS: AccountMemories[] = [
  { providerId: 'codex', accountId: 'acct-work', external: false, state: 'present', truncated: false, files: [file('acct-work', 'MEMORY.md'), file('acct-work', 'extensions/ad_hoc/instructions.md')] },
  { providerId: 'codex', accountId: 'acct-home', external: true, state: 'none', truncated: false, files: [] },
  { providerId: 'codex', accountId: 'acct-odd', external: false, state: 'unreadable', truncated: false, files: [] },
  { providerId: 'codex', accountId: 'acct-empty', external: false, state: 'present', truncated: false, files: [] },
]

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const baseState = () => ({
  projects: [], memories: [], accountMemories: ACCOUNTS, totalSize: 0, scannedAt: 0, loading: false, error: null,
  selectedProject: null, selectedMemoryId: null as string | null, searchQuery: '', selectedContent: null as string | null,
  scopeFilter: 'all', typeFilter: null, sortBy: 'modified', sortDir: 'desc', recentSessions: {},
  scan: vi.fn(), selectProject: vi.fn(), selectMemory: vi.fn(), setSearch: vi.fn(), deleteMemory: vi.fn(), writeFrontmatter: vi.fn(),
  setScopeFilter: vi.fn(), setTypeFilter: vi.fn(), setSort: vi.fn(),
})
vi.mock('../../../src/renderer/stores/memoryStore', async (orig) => {
  const real = await orig<typeof import('../../../src/renderer/stores/memoryStore')>()
  return { ...real, useMemoryStore: (sel?: any) => (sel ? sel(state.value) : state.value) }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel?: any) => sel ? sel({ profiles: [] }) : { profiles: [] },
}))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel?: any) => sel ? sel({ sessions: [] }) : { sessions: [] },
}))

const { default: MemoryPage } = await import('../../../src/renderer/components/MemoryPage')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { ACCOUNT_MEMORY_DELETE_SHOWN } = await import('../../../src/shared/account-memories')

const account = (id: string, identityId: string, over: Record<string, unknown> = {}) => ({
  id, providerId: 'codex', identityId, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'browser',
  lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active', external: false,
  unverified: false, legacyLinked: false, ...over,
})
const SNAPSHOT = {
  revision: 1, registry: { mode: 'ready' }, groups: [], pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
  providers: [{ providerId: 'codex', displayName: 'Codex' }],
  identities: [{ id: 'i-work', friendlyName: 'Work', colourKey: 'blue' }, { id: 'i-odd', friendlyName: 'Odd one', colourKey: 'teal' }],
  accounts: [account('acct-work', 'i-work'), account('acct-home', 'i-home', { external: true }), account('acct-odd', 'i-odd')],
}

describe('MemoryPage: each Codex account\'s own memories', () => {
  let container: HTMLDivElement
  let root: Root
  const base = useSettingsStore.getState().settings

  beforeEach(() => {
    state.value = baseState()
    useSettingsStore.setState({ settings: { ...base, codexEnabled: true } })
    useProviderAccountsStore.setState({ snapshot: SNAPSHOT as never, loaded: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    useSettingsStore.setState({ settings: base })
    useProviderAccountsStore.setState({ snapshot: null })
  })
  const render = () => act(() => { root.render(React.createElement(MemoryPage)) })
  const card = (id: string) => container.querySelector(`[data-account-memories="${id}"]`) as HTMLElement | null

  it('lists each account under its own name, with its files, the off state and the unreadable state', () => {
    render()
    expect(container.querySelector('section[aria-label="Codex memories"]')).toBeTruthy()
    expect(card('acct-work')!.textContent).toContain('Work')
    expect(card('acct-work')!.textContent).toContain('extensions/ad_hoc/instructions.md')
    expect(card('acct-work')!.textContent).toContain('2 files')
    // This computer's own sign-in is named for what it is.
    expect(card('acct-home')!.textContent).toMatch(/This computer/i)
    expect(card('acct-home')!.querySelector('[data-memory-state="none"]')!.textContent).toBe(
      'No memories in this account. Codex keeps memories off by default; turn them on in Codex with /memories.',
    )
    // B-4: only what the app knows -- it could not read the folder (not why),
    // and a folder with no memory files (not whether memories are on).
    expect(card('acct-odd')!.querySelector('[data-memory-state="unreadable"]')!.textContent).toBe(
      "This account's memories folder could not be read.",
    )
    expect(card('acct-empty')!.querySelector('[data-memory-state="empty"]')!.textContent).toBe(
      "No memory files in this account's memories folder.",
    )
    expect(container.textContent).not.toMatch(/not a plain folder|Memories are on/)
    // B-7: Claude's empty store says whose it is, above them.
    expect(container.textContent).toContain('No Claude Code memories found')
    expect(container.textContent).not.toContain('No memory directories found')
  })

  it('opening a file selects it', () => {
    render()
    const row = container.querySelector('[data-memory-id="acct-work:MEMORY.md"]') as HTMLElement
    act(() => { row.click() })
    expect(state.value.selectMemory).toHaveBeenCalledWith('acct-work:MEMORY.md')
  })

  it('the reading drawer is read-only for an account memory: no Delete, no + Metadata, named by account', () => {
    expect(ACCOUNT_MEMORY_DELETE_SHOWN).toBe(false)
    state.value = { ...baseState(), selectedMemoryId: 'acct-work:MEMORY.md', selectedContent: '# Memory\n\nhello' }
    render()
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).not.toContain('Delete')
    expect(buttons).not.toContain('+ Metadata')
    const grid = container.textContent ?? ''
    expect(grid).toContain('Account')
    expect(grid).toContain('Work')
    expect(grid).toContain('hello')
  })

  it("Claude's memories keep their Delete and + Metadata", () => {
    const claudeMem = { id: 'c1', name: 'note', filename: 'note.md', project: 'proj', projectDir: 'F--PROJ', type: 'feedback', description: 'd', size: 3, modified: Date.now(), hasFrontmatter: false, path: '/x/note.md' }
    state.value = { ...baseState(), memories: [claudeMem], projects: [{ name: 'proj', projectDir: 'F--PROJ', fileCount: 1, totalSize: 3, lastModified: Date.now(), types: { feedback: 1 } }], selectedMemoryId: 'c1', selectedContent: 'x' }
    render()
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toContain('Delete')
    expect(buttons).toContain('+ Metadata')
  })

  it('search spans the accounts\' files, each named by its account', () => {
    state.value = { ...baseState(), searchQuery: 'instructions' }
    render()
    expect(container.textContent).toContain('1 result')
    expect(container.textContent).toContain('Local / Work / extensions/ad_hoc/instructions.md')
  })

  it('nothing of it while Codex is not in use', () => {
    useSettingsStore.setState({ settings: { ...base, codexEnabled: false } })
    render()
    expect(container.querySelector('section[aria-label="Codex memories"]')).toBeNull()
    expect(container.textContent).not.toMatch(/codex/i)
  })
})
