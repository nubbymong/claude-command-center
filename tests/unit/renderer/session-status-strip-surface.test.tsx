// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mutable mock state so individual tests can vary session/settings/profiles.
const sessionState: any = { sessions: [{ id: 's1', provider: 'claude', contextPercent: 10 }] }
const settingsState: any = { settings: { statusLine: { font: 'sans', fontSize: 11 }, theme: 'dark', accountAliases: {}, accountColourOverrides: {} } }
const profilesState: any = { profiles: [] }
const restartState = vi.hoisted(() => ({ restart: vi.fn() }))

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel(sessionState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore, DEFAULT_STATUS_LINE: { font: 'sans', fontSize: 11 } }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel(profilesState),
}))
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({ useCodexReviewUsage: () => null }))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: restartState.restart }) }))
vi.mock('../../../src/renderer/hooks/useSwitchAccount', () => ({ useSwitchAccount: () => () => {} }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = { pty: { write: vi.fn() } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Reset to defaults each test.
  sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10 }]
  settingsState.settings = { statusLine: { font: 'sans', fontSize: 11 }, theme: 'dark', accountAliases: {}, accountColourOverrides: {} }
  profilesState.profiles = []
  restartState.restart.mockClear()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('SessionStatusStrip surface tier (U1.2)', () => {
  it('uses --surface-raised, not --surface-chrome, for its background', () => {
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    const strip = container.firstChild as HTMLElement
    expect(strip.style.background).toContain('var(--surface-raised)')
    expect(strip.style.background).not.toContain('var(--surface-chrome)')
  })
})

describe('SessionStatusStrip -- meters awaiting the first statusline payload', () => {
  const pending = () => container.querySelectorAll('[data-testid="rate-limit-pending"]')

  /** A live local Claude session with the rate-limit meters switched on. */
  const liveClaude = (extra: Record<string, unknown> = {}) => {
    sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10, status: 'working', ...extra }]
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showRateLimits: true }
  }

  it('shows waiting meters instead of nothing before the first payload', () => {
    // The statusline comes from a detached child process and can trail the
    // terminal by seconds. Rendering nothing there reads as "broken".
    liveClaude()
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    expect(pending().length).toBe(2) // 5h + 7d
    // Never a value: no colour ramp, no percentage.
    for (const p of pending()) expect(p.textContent ?? '').not.toMatch(/\d+%/)
  })

  it('stops shimmering once a real payload arrives', () => {
    liveClaude({ rateLimitCurrent: 42, rateLimitWeekly: 8 })
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    expect(pending().length).toBe(0)
    expect(container.querySelectorAll('[role="progressbar"]').length).toBeGreaterThan(0)
  })

  it('does NOT shimmer where a payload will never come', () => {
    // Each of these would otherwise shimmer forever, which is a worse lie than
    // the blank it replaces.
    liveClaude()
    settingsState.settings.statusLineEnabled = false
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    expect(pending().length).toBe(0)

    settingsState.settings.statusLineEnabled = true
    liveClaude({ shellOnly: true })
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    expect(pending().length).toBe(0)

    liveClaude({ status: 'disconnected' })
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    expect(pending().length).toBe(0)
  })
})

describe('SessionStatusStrip account/model de-duplication (Bug 6)', () => {
  it('multi-account: shows the account ONCE (interactive switch pill), not also as a read-only chip', () => {
    sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10, accountEmail: 'a@x.com', profileId: 'p1', modelName: 'Opus 4.8' }]
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showAccount: true, showModel: true }
    profilesState.profiles = [
      { id: 'p1', name: '', accountEmail: 'a@x.com', createdAt: 1 },
      { id: 'p2', name: '', accountEmail: 'b@x.com', createdAt: 2 },
    ]

    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
    const strip = container.firstChild as HTMLElement

    // The read-only telemetry account chip must NOT render (the switch pill covers it).
    expect(container.querySelector('[data-testid="account-chip"]')).toBeNull()
    // The interactive account-switch pill IS present.
    expect(container.querySelector('[title^="Switch account"]')).not.toBeNull()
    // The account email appears exactly once in visible text (no doubling).
    const occurrences = (strip.textContent ?? '').split('a@x.com').length - 1
    expect(occurrences).toBe(1)
  })

  it('single-account: still shows the read-only account chip (no switch pill to cover it)', () => {
    sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10, accountEmail: 'a@x.com', profileId: 'p1', modelName: 'Opus 4.8' }]
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showAccount: true, showModel: true }
    profilesState.profiles = [{ id: 'p1', name: '', accountEmail: 'a@x.com', createdAt: 1 }] // <2 -> no switch pill

    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })

    expect(container.querySelector('[data-testid="account-chip"]')).not.toBeNull()
    expect(container.querySelector('[title^="Switch account"]')).toBeNull()
  })
})

describe('SessionStatusStrip master switch (onboarding p4)', () => {
  it('absent statusLineEnabled (pre-upgrade config) keeps the telemetry band', () => {
    sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10 }]
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showContextBar: true }

    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })

    expect(container.textContent).toContain('10%')
  })

  it('statusLineEnabled=false hides the telemetry band but keeps the Claude controls', () => {
    sessionState.sessions = [{ id: 's1', provider: 'claude', contextPercent: 10 }]
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showContextBar: true }
    settingsState.settings.statusLineEnabled = false

    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })

    expect(container.textContent).not.toContain('10%')
    expect(container.querySelector('[title="Restart session"]')).not.toBeNull()
  })

  it('statusLineEnabled=false collapses a Codex strip entirely (telemetry-only, nothing left)', () => {
    sessionState.sessions = [{ id: 's1', provider: 'codex', contextPercent: 10 }]
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showContextBar: true }
    settingsState.settings.statusLineEnabled = false

    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })

    expect(container.firstChild).toBeNull()
  })
})

describe('SessionStatusStrip terminal-only (shell) sessions', () => {
  it('shows a Restart control, but none of the Claude telemetry or Model/account controls', () => {
    sessionState.sessions = [{ id: 's1', shellOnly: true, contextPercent: 10, accountEmail: 'a@x.com', profileId: 'p1' }]
    settingsState.settings.statusLine = { font: 'sans', fontSize: 11, showContextBar: true, showAccount: true, showModel: true }
    profilesState.profiles = [
      { id: 'p1', name: '', accountEmail: 'a@x.com', createdAt: 1 },
      { id: 'p2', name: '', accountEmail: 'b@x.com', createdAt: 2 },
    ]

    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })

    // The Restart pill is present (same title/affordance as a Claude session).
    expect(container.querySelector('[title="Restart session"]')).not.toBeNull()
    // No telemetry (context %) and no Claude-only controls leak onto a raw shell.
    expect(container.textContent).not.toContain('10%')
    expect(container.querySelector('[title^="Switch account"]')).toBeNull()
    expect(container.textContent).not.toContain('a@x.com')
  })

  it('clicking Restart calls restart()', () => {
    sessionState.sessions = [{ id: 's1', shellOnly: true }]
    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })

    const btn = container.querySelector('[title="Restart session"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    act(() => { btn.click() })
    expect(restartState.restart).toHaveBeenCalledTimes(1)
  })

  it('shows Restart even when the status line is turned off', () => {
    // The shell Restart is gated before the status-line collapse, unlike the
    // telemetry band — turning the status line off must not remove it.
    sessionState.sessions = [{ id: 's1', shellOnly: true }]
    settingsState.settings.statusLineEnabled = false

    act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })

    expect(container.querySelector('[title="Restart session"]')).not.toBeNull()
  })
})
