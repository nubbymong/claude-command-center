// @vitest-environment jsdom
/**
 * Active-session context-bar sweep (owner call, 2026-08-27) — the inverse of
 * the sleep moon. The rules this file holds shut:
 *  - SOURCE is raw pty:data in the renderer: a chunk stamps the session; it is
 *    active while the last chunk is within ACTIVE_WINDOW_MS; the store only
 *    re-renders when the active SET changes, never per chunk.
 *  - Subscriptions reconcile against the live session list (new subscribed,
 *    gone unsubscribed + stamp cleared); setup is idempotent.
 *  - In SessionRow: Claude sessions only, and ATTENTION and SLEEP both suppress
 *    the sweep (precedence ATTENTION > ACTIVE > SLEEP > idle).
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

// pty.onData: capture the callbacks so tests can drive chunks.
const dataCallbacks = new Map<string, Set<(d: string) => void>>()
const onDataMock = vi.fn((sessionId: string, cb: (d: string) => void) => {
  let set = dataCallbacks.get(sessionId)
  if (!set) { set = new Set(); dataCallbacks.set(sessionId, set) }
  set.add(cb)
  return () => { set!.delete(cb) }
})

const { useActiveStore, setupActiveListeners, teardownActiveListeners, noteActivityGrace, ACTIVE_WINDOW_MS, ACTIVITY_GRACE_MS } =
  await import('../../../src/renderer/stores/activeStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')
const { useSleepStore } = await import('../../../src/renderer/stores/sleepStore')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function emit(sessionId: string, data = 'x'): void {
  for (const cb of dataCallbacks.get(sessionId) ?? []) cb(data)
}
function setSessions(ids: string[]): void {
  useSessionStore.setState({ sessions: ids.map((id) => ({ id })) as any })
}

describe('activeStore — derivation from pty:data', () => {
  beforeEach(() => {
    ;(window as any).electronAPI = { pty: { onData: onDataMock } }
    dataCallbacks.clear()
    onDataMock.mockClear()
    setSessions([])
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    teardownActiveListeners()
    vi.useRealTimers()
  })

  it('a chunk within the window marks the session active; it ages out after', () => {
    setSessions(['a'])
    setupActiveListeners()
    emit('a')                            // stamped at t=0
    vi.advanceTimersByTime(1000)         // tick @1000: 1000 < 2500 -> active
    expect(useActiveStore.getState().activeIds.has('a')).toBe(true)
    vi.advanceTimersByTime(2000)         // ticks @2000,@3000: 3000 > 2500 -> gone
    expect(useActiveStore.getState().activeIds.has('a')).toBe(false)
  })

  it('a steady stream keeps the session active across ticks', () => {
    setSessions(['a'])
    setupActiveListeners()
    for (let t = 0; t < 6; t++) {
      emit('a')
      vi.advanceTimersByTime(500)        // re-stamped well within the 2.5s window
    }
    expect(useActiveStore.getState().activeIds.has('a')).toBe(true)
  })

  it('only re-renders the store when the active SET changes', () => {
    setSessions(['a'])
    setupActiveListeners()
    let renders = 0
    const unsub = useActiveStore.subscribe(() => { renders++ })
    emit('a'); vi.advanceTimersByTime(1000)   // empty -> {a}: one change
    emit('a'); vi.advanceTimersByTime(1000)   // {a} -> {a}: no change
    expect(renders).toBe(1)
    unsub()
  })

  it('reconciles subscriptions: new session subscribed, removed session dropped', () => {
    setSessions(['a'])
    setupActiveListeners()
    expect(onDataMock).toHaveBeenCalledWith('a', expect.any(Function))
    setSessions(['a', 'b'])
    expect(onDataMock).toHaveBeenCalledWith('b', expect.any(Function))
    // remove 'a': a late chunk on its (torn-down) channel must not revive it
    setSessions(['b'])
    emit('a')
    vi.advanceTimersByTime(1000)
    expect(useActiveStore.getState().activeIds.has('a')).toBe(false)
  })

  it('setup is idempotent — a second call does not double-subscribe', () => {
    setSessions(['a'])
    setupActiveListeners()
    const first = onDataMock.mock.calls.length
    setupActiveListeners()
    expect(onDataMock.mock.calls.length).toBe(first)
  })

  it('chunks within the activation grace are ignored — a click-redraw never lights the pill (RC8)', () => {
    setSessions(['a'])
    setupActiveListeners()
    noteActivityGrace('a')               // focus-report/resize seen at t=0
    emit('a')                            // the TUI's redraw response, t=0: graced
    vi.advanceTimersByTime(2000)         // ticks at 1000/2000 observe no stamp
    expect(useActiveStore.getState().activeIds.has('a')).toBe(false)
    emit('a')                            // t=2000, past the grace: stamps
    vi.advanceTimersByTime(1000)
    expect(useActiveStore.getState().activeIds.has('a')).toBe(true)
  })

  it('the grace is per-session — another session\'s output still counts', () => {
    setSessions(['a', 'b'])
    setupActiveListeners()
    noteActivityGrace('a')
    emit('a')                            // graced
    emit('b')                            // not graced
    vi.advanceTimersByTime(1000)
    expect(useActiveStore.getState().activeIds.has('a')).toBe(false)
    expect(useActiveStore.getState().activeIds.has('b')).toBe(true)
  })

  it('a removed session drops its grace stamp with its subscription', () => {
    setSessions(['a'])
    setupActiveListeners()
    noteActivityGrace('a')
    setSessions([])                      // reconcile: sub + stamps dropped
    setSessions(['a'])                   // re-added: fresh subscription
    emit('a')                            // no stale grace: stamps immediately
    vi.advanceTimersByTime(1000)
    expect(useActiveStore.getState().activeIds.has('a')).toBe(true)
  })
})

describe('SessionRow — the sweep, precedence and Claude-only gate', () => {
  let container: HTMLDivElement
  let root: Root

  function makeSession(over: Partial<Session> = {}): Session {
    return {
      id: 's1', label: 'API Refactor', workingDirectory: '/x', model: 'opus',
      color: '#89b4fa', status: 'working', createdAt: 0, sessionType: 'local',
      contextPercent: 47, ...over,
    } as Session
  }
  const baseProps = {
    isActive: false, needsAttention: false, isRenaming: false, renameValue: '',
    renameRef: { current: null }, onRenameChange: () => {}, onRenameFinish: () => {},
    onRenameCancel: () => {}, onClick: () => {}, onContextMenu: () => {},
  }
  const fill = () => container.querySelector('[data-testid="context-meter-fill"]') as HTMLElement | null
  const wbadge = () => container.querySelector('[data-testid="working-badge"]')

  beforeEach(() => {
    useActiveStore.setState({ activeIds: new Set() })
    useSleepStore.setState({ silentSince: {}, attentionDismissedAt: {}, graceTick: 0 })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  const render = (session: Session, props: any = {}) =>
    act(() => { root.render(createElement(SessionRow, { session, ...baseProps, ...props })) })

  it('a moving Claude session gets the sweep AND the working pill', () => {
    useActiveStore.setState({ activeIds: new Set(['s1']) })
    render(makeSession())
    expect(fill()?.className).toContain('meter-active')
    expect(fill()?.getAttribute('data-active')).toBe('true')
    expect(wbadge()).not.toBeNull()
  })

  it('no sweep and no pill when the session is not moving', () => {
    render(makeSession())
    expect(fill()?.className).not.toContain('meter-active')
    expect(wbadge()).toBeNull()
  })

  it('ATTENTION suppresses the sweep and the pill', () => {
    useActiveStore.setState({ activeIds: new Set(['s1']) })
    render(makeSession(), { needsAttention: true })
    expect(fill()?.className).not.toContain('meter-active')
    expect(wbadge()).toBeNull()
  })

  it('SLEEP suppresses the sweep and the pill (mutual exclusion; moon shows instead)', () => {
    useActiveStore.setState({ activeIds: new Set(['s1']) })
    useSleepStore.setState({ silentSince: { s1: Date.now() - 130_000 } })
    render(makeSession())
    expect(fill()?.className).not.toContain('meter-active')
    expect(wbadge()).toBeNull()
    expect(container.querySelector('[data-testid="moon-badge"]')).not.toBeNull()
  })

  it('Claude only: a codex session never gets the sweep or the pill', () => {
    useActiveStore.setState({ activeIds: new Set(['s1']) })
    render(makeSession({ provider: 'codex' }))
    // codex still has a meter row, but never the active sweep or the working pill
    expect(fill()).not.toBeNull()
    expect(fill()?.className).not.toContain('meter-active')
    expect(wbadge()).toBeNull()
  })
})
