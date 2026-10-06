// @vitest-environment jsdom
/**
 * Usage track MP6: the per-session strip reads the same as the rest of the
 * usage surfaces.
 *  - The weekly window reads "Weekly" on every path (never the legacy "7d").
 *  - D2: a window past its reset shows the static no-reading meter.
 *  - The waiting placeholder shows for any provider that reports usage, and
 *    never for a session nothing will report (D3) or an API-key account.
 *  - The cost tooltip per Q1.5: Claude Code unchanged; Codex with a ChatGPT
 *    sign-in "API-equivalent estimate"; Codex with an API key "Estimate at
 *    API list prices".
 *
 * Mocks as tests/unit/renderer/session-status-strip.test.ts; the registry
 * store is the real one, set directly. React.createElement keeps it a *.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, AccountView } from '../../../src/shared/providers'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const DEFAULT_STATUS_LINE = {
  showModel: true, showEffort: true, showAccount: true, showTokens: true, showContextBar: true, showCost: true,
  showLinesChanged: true, showDuration: true, showRateLimits: true, showResetTime: true, font: 'sans', fontSize: 12,
}

let sessionState: { activeSessionId: string | null; sessions: any[] } = { activeSessionId: null, sessions: [] }

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (selector: (s: typeof sessionState) => unknown) => selector(sessionState)
  useSessionStore.getState = () => sessionState
  return { useSessionStore }
})
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { statusLine: DEFAULT_STATUS_LINE, theme: 'dark' as const } }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { DEFAULT_STATUS_LINE, useSettingsStore }
})
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({ useCodexReviewUsage: () => null }))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: vi.fn(), recover: vi.fn() }) }))
;(globalThis as any).window.electronAPI = { pty: { write: vi.fn() } }

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')

const account = (id: string, over: Partial<AccountView> = {}): AccountView => ({
  id, providerId: 'codex', identityId: `identity-${id}`, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false,
  authMethod: 'browser', lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted',
  realmLifecycle: 'active', external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
  ...over,
})
const snapshot = (accounts: AccountView[]): AccountsSnapshot => ({
  revision: 1, registry: { mode: 'ready' } as AccountsSnapshot['registry'], providers: [], identities: [], groups: [], accounts,
  pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  useProviderAccountsStore.setState({ snapshot: snapshot([account('cx-chat', { isProviderDefault: true }), account('cx-key', { authMethod: 'apiKey' })]), loaded: true })
})
afterEach(() => {
  act(() => { root.unmount() }); container.remove()
  useProviderAccountsStore.setState({ snapshot: null, loaded: false })
})

async function show(session: Record<string, unknown>) {
  sessionState = { activeSessionId: session.id as string, sessions: [session] }
  await act(async () => { root.render(React.createElement(SessionStatusStrip, { sessionId: session.id as string })) ; await Promise.resolve() })
}
const past = () => new Date(Date.now() - 60_000).toISOString()
const future = () => new Date(Date.now() + 3_600_000).toISOString()
const costTitle = () => (Array.from(container.querySelectorAll('span')).find((s) => (s.textContent ?? '').startsWith('API eq')) as HTMLElement | undefined)?.title

describe('SessionStatusStrip, usage consistency (usage track MP6)', () => {
  it('a legacy weekly figure reads "Weekly", never "7d"', async () => {
    await show({ id: 'c1', provider: 'claude', status: 'idle', rateLimitCurrent: 30, rateLimitWeekly: 12, rateLimitWeeklyResets: future() })
    expect(container.textContent).toContain('Weekly:')
    expect(container.textContent).not.toContain('7d')
  })

  it('the waiting placeholder names the weekly window "Weekly" too', async () => {
    await show({ id: 'c2', provider: 'claude', status: 'idle' })
    const pending = container.querySelector('[data-testid="statusline-pending"]') as HTMLElement
    expect(pending.textContent).toContain('Weekly:')
    expect(pending.textContent).not.toContain('7d')
  })

  it('D2: a window past its reset shows the static no-reading meter, the rest keep their figures', async () => {
    await show({
      id: 'x1', provider: 'codex', status: 'idle', providerAccountId: 'cx-chat',
      usageBuckets: [
        { key: 'codex/300:', label: '5h', group: 'session', percent: 70, resetsAt: past(), severity: 'normal' },
        { key: 'codex/10080:', label: 'Weekly', group: 'weekly', percent: 40, resetsAt: future(), severity: 'normal' },
      ],
    })
    const still = container.querySelector('[data-testid="rate-limit-no-reading"]') as HTMLElement
    expect(still.textContent).toContain('5h:')
    expect(Array.from(container.querySelectorAll('[role="progressbar"][aria-valuenow]')).map((b) => b.getAttribute('aria-valuenow'))).toEqual(['40'])
  })

  it('D2 on the legacy path too', async () => {
    await show({ id: 'c3', provider: 'claude', status: 'idle', rateLimitCurrent: 30, rateLimitCurrentResets: past(), rateLimitWeekly: 12, rateLimitWeeklyResets: future() })
    expect(container.querySelector('[data-testid="rate-limit-no-reading"]')?.textContent).toContain('5h:')
    expect(Array.from(container.querySelectorAll('[role="progressbar"][aria-valuenow]')).map((b) => b.getAttribute('aria-valuenow'))).toEqual(['12'])
  })

  it('a Codex session waiting for its first reading shows the placeholder', async () => {
    await show({ id: 'x2', provider: 'codex', status: 'idle', providerAccountId: 'cx-chat' })
    expect(container.querySelector('[data-testid="statusline-pending"]')).not.toBeNull()
  })

  it('no placeholder for a session nothing will report (D3), or an API-key account', async () => {
    await show({ id: 'x3', provider: 'codex', status: 'idle', providerAccountId: 'cx-chat', usageUnavailable: 'no-reading' })
    expect(container.querySelector('[data-testid="statusline-pending"]')).toBeNull()
    await show({ id: 'x4', provider: 'codex', status: 'idle', providerAccountId: 'cx-key' })
    expect(container.querySelector('[data-testid="statusline-pending"]')).toBeNull()
  })

  it('the cost tooltip per Q1.5: Claude Code unchanged, Codex by how its account is billed', async () => {
    await show({ id: 'c4', provider: 'claude', status: 'idle', costUsd: 0.1 })
    expect(costTitle()).toBe('API equivalent cost (not billed on Max plan)')
    await show({ id: 'x5', provider: 'codex', status: 'idle', costUsd: 0.2, providerAccountId: 'cx-chat' })
    expect(costTitle()).toBe('API-equivalent estimate')
    await show({ id: 'x6', provider: 'codex', status: 'idle', costUsd: 0.2, providerAccountId: 'cx-key' })
    expect(costTitle()).toBe('Estimate at API list prices')
    // No account named: the provider default, whichever it is.
    await show({ id: 'x7', provider: 'codex', status: 'idle', costUsd: 0.2 })
    expect(costTitle()).toBe('API-equivalent estimate')
    useProviderAccountsStore.setState({ snapshot: snapshot([account('cx-chat'), account('cx-key', { authMethod: 'apiKey', isProviderDefault: true })]), loaded: true })
    await show({ id: 'x8', provider: 'codex', status: 'idle', costUsd: 0.2 })
    expect(costTitle()).toBe('Estimate at API list prices')
  })

  it('a window that resets while the strip is on screen turns to no reading on time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const soon = new Date(Date.now() + 60_000).toISOString()
      await show({ id: 'x9', provider: 'codex', status: 'idle', providerAccountId: 'cx-chat', usageBuckets: [{ key: 'codex/300:', label: '5h', group: 'session', percent: 70, resetsAt: soon, severity: 'normal' }] })
      expect(container.querySelector('[data-testid="rate-limit-no-reading"]')).toBeNull()
      await act(async () => { vi.advanceTimersByTime(61_000) })
      expect(container.querySelector('[data-testid="rate-limit-no-reading"]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
