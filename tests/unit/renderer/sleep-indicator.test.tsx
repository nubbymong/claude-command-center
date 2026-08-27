// @vitest-environment jsdom
/**
 * Sleeping-session moon (canvas "Session sleep indicator", 2026-08-27).
 *
 * The agreed rules this file holds shut:
 *  - Watchdog-only source: a session sleeps only while the Watchdog snapshot
 *    reports it silent; absent from the snapshot = not asleep.
 *  - Wake is Watchdog-observed activity only (a non-silent push clears it) —
 *    nothing in the renderer clears a moon.
 *  - ATTENTION always outranks the moon.
 *  - After an attention dismiss the moon waits at least 60 s (grace restarts
 *    at the dismiss), and the grace expiry re-derives without another push.
 *  - Claude sessions only (no moon on codex/shell cards).
 *  - Variant B: the moon is an ADDITIONAL chip; the type badge stays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const settingsState: any = { settings: { accountAliases: {}, accountColourOverrides: {} } }
const profilesState: any = { profiles: [] }

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel(profilesState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore }
})

const { isAsleep, useSleepStore, ATTENTION_DISMISS_GRACE_MS } = await import('../../../src/renderer/stores/sleepStore')
const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'API Refactor', workingDirectory: '/x', model: 'opus',
    color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local', ...over,
  } as Session
}

const baseProps = {
  isActive: false, needsAttention: false, isRenaming: false, renameValue: '',
  renameRef: { current: null }, onRenameChange: () => {}, onRenameFinish: () => {},
  onRenameCancel: () => {}, onClick: () => {}, onContextMenu: () => {},
}

function resetSleepStore() {
  useSleepStore.setState({ silentSince: {}, attentionDismissedAt: {}, graceTick: 0 })
}

describe('isAsleep — the eligibility rule', () => {
  const now = 1_000_000
  it('silent + no attention = asleep', () => {
    expect(isAsleep({ silentSince: now - 5_000, dismissedAt: undefined, needsAttention: false, now })).toBe(true)
  })
  it('not silent = never asleep', () => {
    expect(isAsleep({ silentSince: undefined, dismissedAt: undefined, needsAttention: false, now })).toBe(false)
  })
  it('ATTENTION outranks the moon', () => {
    expect(isAsleep({ silentSince: now - 5_000, dismissedAt: undefined, needsAttention: true, now })).toBe(false)
  })
  it('a fresh dismiss suppresses the moon for the grace window', () => {
    expect(isAsleep({ silentSince: now - 300_000, dismissedAt: now - 1_000, needsAttention: false, now })).toBe(false)
    expect(isAsleep({ silentSince: now - 300_000, dismissedAt: now - ATTENTION_DISMISS_GRACE_MS, needsAttention: false, now })).toBe(true)
  })
})

describe('sleep store — snapshot application', () => {
  beforeEach(resetSleepStore)

  it('records silent sessions with an idleMs-derived start, preserved across pushes', () => {
    const now = 500_000
    useSleepStore.getState().applyWatchdogSessions([{ sessionId: 'a', silent: true, idleMs: 130_000 }], now)
    expect(useSleepStore.getState().silentSince.a).toBe(now - 130_000)
    // A later push must keep the ORIGINAL start, not restart the clock.
    useSleepStore.getState().applyWatchdogSessions([{ sessionId: 'a', silent: true, idleMs: 190_000 }], now + 60_000)
    expect(useSleepStore.getState().silentSince.a).toBe(now - 130_000)
  })

  it('clears on a non-silent report and on absence from the snapshot (Watchdog-only source)', () => {
    const now = 500_000
    useSleepStore.getState().applyWatchdogSessions(
      [{ sessionId: 'a', silent: true, idleMs: 130_000 }, { sessionId: 'b', silent: true, idleMs: 140_000 }], now)
    useSleepStore.getState().applyWatchdogSessions([{ sessionId: 'a', silent: false, idleMs: 0 }], now + 5_000)
    expect(useSleepStore.getState().silentSince.a).toBeUndefined() // woke: Watchdog saw output
    expect(useSleepStore.getState().silentSince.b).toBeUndefined() // watcher gone: absent there is absent here
  })

  it('an identical snapshot does not churn store state', () => {
    const now = 500_000
    useSleepStore.getState().applyWatchdogSessions([{ sessionId: 'a', silent: true, idleMs: 130_000 }], now)
    const before = useSleepStore.getState().silentSince
    useSleepStore.getState().applyWatchdogSessions([{ sessionId: 'a', silent: true, idleMs: 135_000 }], now + 5_000)
    expect(useSleepStore.getState().silentSince).toBe(before)
  })

  it('a monitor session never records a silentSince, even when silent (RC8)', () => {
    const now = 500_000
    useSleepStore.getState().applyWatchdogSessions(
      [{ sessionId: 'a', silent: true, idleMs: 130_000, hasMonitors: true }], now)
    expect(useSleepStore.getState().silentSince.a).toBeUndefined()
  })

  it('monitors appearing on a tracked silent session clear its moon (RC8)', () => {
    const now = 500_000
    useSleepStore.getState().applyWatchdogSessions([{ sessionId: 'a', silent: true, idleMs: 130_000 }], now)
    expect(useSleepStore.getState().silentSince.a).toBeDefined()
    useSleepStore.getState().applyWatchdogSessions(
      [{ sessionId: 'a', silent: true, idleMs: 190_000, hasMonitors: true }], now + 60_000)
    expect(useSleepStore.getState().silentSince.a).toBeUndefined()
  })
})

describe('sleep store — dismiss grace timer', () => {
  beforeEach(() => {
    resetSleepStore()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('bumps graceTick once the grace window elapses, so cards re-derive without a push', () => {
    useSleepStore.getState().noteAttentionDismissed('a', 0)
    expect(useSleepStore.getState().graceTick).toBe(0)
    vi.advanceTimersByTime(ATTENTION_DISMISS_GRACE_MS)
    expect(useSleepStore.getState().graceTick).toBe(1)
  })

  it('a re-dismiss replaces the pending timer instead of stacking bumps', () => {
    useSleepStore.getState().noteAttentionDismissed('a', 0)
    vi.advanceTimersByTime(30_000)
    useSleepStore.getState().noteAttentionDismissed('a', 30_000)
    vi.advanceTimersByTime(ATTENTION_DISMISS_GRACE_MS)
    expect(useSleepStore.getState().graceTick).toBe(1)
  })
})

describe('SessionRow moon badge', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetSleepStore()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  const sleep = (id: string) =>
    useSleepStore.setState({ silentSince: { [id]: Date.now() - 130_000 } })

  it('renders the moon BESIDE the type badge while asleep (variant B), with dimmed meta', () => {
    sleep('s1')
    act(() => { root.render(createElement(SessionRow, { session: makeSession(), ...baseProps })) })
    expect(container.querySelector('[data-testid="moon-badge"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="type-badge-claude"]')).not.toBeNull() // spark stays
    const line2 = container.querySelector('[data-testid="card-line2"]') as HTMLElement
    expect(line2.style.opacity).toBe('0.7')
  })

  it('no moon while awake', () => {
    act(() => { root.render(createElement(SessionRow, { session: makeSession(), ...baseProps })) })
    expect(container.querySelector('[data-testid="moon-badge"]')).toBeNull()
  })

  it('ATTENTION outranks the moon on the card', () => {
    sleep('s1')
    act(() => { root.render(createElement(SessionRow, { session: makeSession(), ...baseProps, needsAttention: true })) })
    expect(container.querySelector('[data-testid="moon-badge"]')).toBeNull()
  })

  it('Claude sessions only: codex and shell cards never show a moon', () => {
    sleep('s1')
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ provider: 'codex' }), ...baseProps })) })
    expect(container.querySelector('[data-testid="moon-badge"]')).toBeNull()
    act(() => { root.render(createElement(SessionRow, { session: makeSession({ shellOnly: true }), ...baseProps })) })
    expect(container.querySelector('[data-testid="moon-badge"]')).toBeNull()
  })

  it('a fresh attention dismiss suppresses the moon; the grace expiry surfaces it', () => {
    vi.useFakeTimers()
    try {
      sleep('s1')
      useSleepStore.getState().noteAttentionDismissed('s1', Date.now())
      act(() => { root.render(createElement(SessionRow, { session: makeSession(), ...baseProps })) })
      expect(container.querySelector('[data-testid="moon-badge"]')).toBeNull()
      act(() => { vi.advanceTimersByTime(ATTENTION_DISMISS_GRACE_MS + 1_000) })
      expect(container.querySelector('[data-testid="moon-badge"]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
