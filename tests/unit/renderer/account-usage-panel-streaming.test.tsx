// @vitest-environment jsdom
//
// Plan P3: the account-usage page shows a skeleton per account up front and fills
// each row as its usage STREAMS in, instead of one all-or-nothing "Loading…" gate.
// These mount the real panel with the streaming IPC mocked and assert: skeletons
// render before any usage lands, each resolves independently as its result
// arrives, and a manual Refresh returns rows to skeletons and re-streams.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountUsage } from '../../../src/shared/usage-types'
import type { AccountProfile } from '../../../src/shared/account-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useReauthAccount', () => ({ useReauthAccount: () => vi.fn() }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark', useThemeController: () => {} }))
vi.mock('../../../src/renderer/components/PageFrame', () => ({
  default: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) =>
    <div data-testid="page-frame"><div data-testid="pf-actions">{actions}</div>{children}</div>,
}))

const list = vi.fn<[], Promise<AccountProfile[]>>()
const authInfo = vi.fn(async () => [] as unknown[])
/** Controllable stream: emit a result, or finish. */
let stream: { emit: (u: AccountUsage) => void; done: () => void } | null = null
const fetchAllStream = vi.fn((onResult: (u: AccountUsage) => void) => new Promise<void>((resolve) => {
  stream = { emit: (u) => act(() => onResult(u)), done: () => resolve() }
}))
const fetchOne = vi.fn()

Object.defineProperty(window, 'electronAPI', {
  writable: true, configurable: true,
  value: { accountProfiles: { list, authInfo }, accountUsage: { fetchAllStream, fetchOne } },
})

const { default: AccountUsagePanel } = await import('../../../src/renderer/components/AccountUsagePanel')

const profile = (id: string): AccountProfile => ({ id, name: id, accountEmail: `${id}@x.com`, createdAt: 0 })
const usage = (profileId: string, percent: number): AccountUsage => ({
  profileId, email: `${profileId}@x.com`, name: profileId, isPrimary: false, active: true,
  status: 'ok', buckets: [{ key: 'session:', label: '5h', group: 'session', percent, resetsAt: '', severity: 'normal' }], fetchedAt: Date.now(),
})

let container: HTMLDivElement
let root: Root
const skeletons = () => container.querySelectorAll('[data-testid="account-usage-skeleton"]')
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

beforeEach(() => {
  list.mockReset(); authInfo.mockReset(); fetchAllStream.mockClear(); stream = null
  authInfo.mockResolvedValue([])
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function mount() {
  await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} />) })
  await flush()
}

describe('AccountUsagePanel — streaming skeletons (plan P3)', () => {
  it('shows a skeleton per account before any usage lands, then resolves each as it streams in', async () => {
    list.mockResolvedValue([profile('a'), profile('b'), profile('c')])
    await mount()

    // Before any result: three skeletons, no account cards.
    expect(skeletons().length).toBe(3)
    expect(container.textContent).not.toContain('a@x.com')

    // Stream the first account -> its row resolves, the other two stay skeletons.
    stream!.emit(usage('a', 41))
    await flush()
    expect(skeletons().length).toBe(2)
    expect(container.textContent).toContain('a@x.com')
    expect(container.textContent).toContain('41%')

    // Stream the rest.
    stream!.emit(usage('b', 12)); stream!.emit(usage('c', 7))
    await flush()
    expect(skeletons().length).toBe(0)
    expect(container.textContent).toContain('b@x.com')
    expect(container.textContent).toContain('c@x.com')
    stream!.done()
  })

  it('renders placeholder skeletons while the account list itself is still resolving', async () => {
    let resolveList!: (p: AccountProfile[]) => void
    list.mockReturnValue(new Promise<AccountProfile[]>((r) => { resolveList = r }))
    await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} />) })
    // List not resolved yet: placeholder skeletons, no "No accounts found".
    expect(skeletons().length).toBeGreaterThan(0)
    expect(container.textContent).not.toMatch(/No accounts found/)
    resolveList([profile('a')])
    await flush()
    expect(skeletons().length).toBe(1) // now one per real account
    stream!.done()
  })

  it('shows "No accounts found" only once the list resolves empty', async () => {
    list.mockResolvedValue([])
    await mount()
    expect(container.textContent).toMatch(/No accounts found/)
    expect(skeletons().length).toBe(0)
  })

  it('a manual Refresh returns rows to skeletons and re-streams', async () => {
    list.mockResolvedValue([profile('a')])
    await mount()
    stream!.emit(usage('a', 20)); await flush()
    expect(container.textContent).toContain('20%')
    expect(skeletons().length).toBe(0)

    // Click Refresh (rendered into the mocked PageFrame actions slot).
    const refresh = container.querySelector('[data-testid="pf-actions"] button') as HTMLElement
    await act(async () => { refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    // Back to a skeleton until the new stream lands.
    expect(skeletons().length).toBe(1)
    expect(fetchAllStream).toHaveBeenCalledTimes(2)
    stream!.emit(usage('a', 55)); await flush()
    expect(container.textContent).toContain('55%')
    stream!.done()
  })
})
