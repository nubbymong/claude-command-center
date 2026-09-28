// @vitest-environment jsdom
// P3.6 (row 20): a Codex session carries its account chip on the session strip
// and on its sidebar card, as a Claude session does, named and coloured from
// the account's identity (the footer's label rule: a Codex identity shows its
// name; this computer's own sign-in is named for what it is). The account is
// the one the session runs under, else the provider default, the rule the
// footer and the strip's billing line already read.
//
// Mocks as tests/unit/renderer/strip-usage-consistency.test.ts; the registry
// store is the real one, set directly. React.createElement keeps it a *.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const STATUS_LINE = {
  showModel: true, showEffort: true, showAccount: true, showTokens: true, showContextBar: true, showCost: true,
  showLinesChanged: true, showDuration: true, showRateLimits: true, showResetTime: true, font: 'sans', fontSize: 12,
}
let sessionState: { activeSessionId: string | null; sessions: any[] } = { activeSessionId: null, sessions: [] }
const settingsState: any = { settings: { statusLine: STATUS_LINE, theme: 'dark', accountAliases: {}, accountColourOverrides: {} } }

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (selector: (s: typeof sessionState) => unknown) => selector(sessionState)
  useSessionStore.getState = () => sessionState
  return { useSessionStore }
})
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (selector: (s: any) => unknown) => selector(settingsState)
  useSettingsStore.getState = () => settingsState
  return { DEFAULT_STATUS_LINE: STATUS_LINE, useSettingsStore }
})
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({ useCodexReviewUsage: () => null }))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: vi.fn(), recover: vi.fn() }) }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
;(globalThis as any).window.electronAPI = { pty: { write: vi.fn() } }

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')
const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')
const { useProviderAccountsStore, accountDisplayName } = await import('../../../src/renderer/stores/providerAccountsStore')
const { resolveIdentityColor } = await import('../../../src/shared/identity-colors')
const { snapshot, work, personal, local } = await import('./accounts-snapshot-harness')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
  settingsState.settings = { statusLine: STATUS_LINE, theme: 'dark', accountAliases: {}, accountColourOverrides: {} }
})
afterEach(() => {
  act(() => { root.unmount() }); container.remove()
  useProviderAccountsStore.setState({ snapshot: null, loaded: false })
})

const css = (key: string) => { const el = document.createElement('span'); el.style.backgroundColor = resolveIdentityColor(key as never, 'dark'); return el.style.backgroundColor }
async function strip(session: Record<string, unknown>) {
  sessionState = { activeSessionId: session.id as string, sessions: [session] }
  await act(async () => { root.render(React.createElement(SessionStatusStrip, { sessionId: session.id as string })); await Promise.resolve() })
}
const chip = () => container.querySelector('[data-testid="account-chip"]') as HTMLElement | null
const chipDot = () => (chip()!.querySelector('span') as HTMLElement).style.backgroundColor

describe('the session strip shows a Codex session\'s account (P3.6, row 20)', () => {
  it('the account it runs under: the identity\'s name and colour, at the far left', async () => {
    await strip({ id: 'x1', provider: 'codex', status: 'idle', providerAccountId: personal.id })
    expect(chip()).not.toBeNull()
    expect(chip()!.textContent).toBe('Personal')
    expect(chipDot()).toBe(css('pink'))
    // The first item of the strip, as Claude's.
    expect(container.firstElementChild!.firstElementChild).toBe(chip())
    expect(chip()!.title).toBe('alex@home.example')
  })

  it('no account named: the provider default\'s', async () => {
    await strip({ id: 'x2', provider: 'codex', status: 'idle' })
    expect(chip()!.textContent).toBe('Work')
    expect(chipDot()).toBe(css('indigo'))
  })

  it('this computer\'s own sign-in is named for what it is', async () => {
    await strip({ id: 'x3', provider: 'codex', status: 'idle', providerAccountId: local.id })
    expect(chip()!.textContent).toBe(accountDisplayName(snapshot(), local))
  })

  it('hidden by the Account item of the Status Line settings, as Claude\'s; and with no account list, nothing', async () => {
    settingsState.settings = { ...settingsState.settings, statusLine: { ...STATUS_LINE, showAccount: false } }
    await strip({ id: 'x4', provider: 'codex', status: 'idle', providerAccountId: work.id })
    expect(chip()).toBeNull()
    settingsState.settings = { ...settingsState.settings, statusLine: STATUS_LINE }
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    await strip({ id: 'x5', provider: 'codex', status: 'idle', providerAccountId: work.id })
    expect(chip()).toBeNull()
  })

  it('with the status line master switch off the account item stays, as Claude\'s does, and the band goes when nothing is left', async () => {
    settingsState.settings = { ...settingsState.settings, statusLineEnabled: false }
    await strip({ id: 'x4b', provider: 'codex', status: 'idle', providerAccountId: work.id, costUsd: 0.5 })
    expect(chip()!.textContent).toBe('Work')
    expect(container.textContent).not.toContain('API eq')
    settingsState.settings = { ...settingsState.settings, statusLine: { ...STATUS_LINE, showAccount: false } }
    await strip({ id: 'x4c', provider: 'codex', status: 'idle', providerAccountId: work.id })
    expect(container.innerHTML).toBe('')
  })

  it('an account that is not the session provider\'s is never shown for it', async () => {
    await strip({ id: 'x6', provider: 'codex', status: 'idle', providerAccountId: 'acc-claude-main' })
    expect(chip()).toBeNull()
  })
})

describe('the sidebar card shows it too (P3.6, row 20)', () => {
  const props = {
    isActive: false, needsAttention: false, isRenaming: false, renameValue: '', renameRef: { current: null },
    onRenameChange: () => {}, onRenameFinish: () => {}, onRenameCancel: () => {}, onClick: () => {}, onContextMenu: () => {},
  }
  const card = (session: Record<string, unknown>) => act(() => root.render(React.createElement(SessionRow, { ...(props as any), session: { label: 'api', identityColorKey: 'mauve', color: '', createdAt: 0, sessionType: 'local', ...session } })))

  it('line 3 names the Codex account and wears its identity colour', () => {
    card({ id: 'x7', provider: 'codex', status: 'idle', providerAccountId: personal.id })
    expect(container.querySelector('[data-testid="account-name"]')!.textContent).toBe('Personal')
    expect((container.querySelector('[data-testid="account-dot"]') as HTMLElement).style.backgroundColor).toBe(css('pink'))
    expect((container.querySelector('[data-testid="account-dot"]') as HTMLElement).getAttribute('aria-label')).toBe('Account: Personal')
  })

  it('with no account list the card stays two lines, as an accountless card does', () => {
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    card({ id: 'x8', provider: 'codex', status: 'idle', providerAccountId: personal.id })
    expect(container.querySelector('[data-testid="card-line3"]')).toBeNull()
  })

  it('a terminal-only tab carries no account line', () => {
    card({ id: 'x9', provider: 'codex', shellOnly: true, status: 'idle', providerAccountId: personal.id })
    expect(container.querySelector('[data-testid="card-line3"]')).toBeNull()
  })
})
