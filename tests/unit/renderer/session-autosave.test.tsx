// @vitest-environment jsdom
// Local renderHook shim (this repo doesn't depend on @testing-library/react —
// see use-effort-subscription.test.tsx for the same pattern).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useSessionAutosave } from '../../../src/renderer/hooks/useSessionAutosave'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import type { Session } from '../../../src/renderer/stores/sessionStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderHook<T>(hook: () => T): { unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const HookHost: React.FC = () => {
    hook()
    return null
  }
  act(() => {
    root.render(<HookHost />)
  })
  return {
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

function makeSession(id: string): Session {
  // Minimal shape; buildSessionState only reads a subset and tolerates undefined.
  return { id, label: id, sessionType: 'local' } as unknown as Session
}

describe('useSessionAutosave', () => {
  let save: ReturnType<typeof vi.fn>
  let handle: { unmount: () => void } | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    save = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { session: { save } }
    // Reset BEFORE mounting so the reset doesn't trip the (not-yet-active) subscription.
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    handle = renderHook(() => useSessionAutosave())
  })

  afterEach(() => {
    handle?.unmount()
    handle = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('debounce-flushes the live session set when sessions are opened', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    useSessionStore.getState().addSession(makeSession('b'))
    expect(save).not.toHaveBeenCalled() // coalesced by the debounce
    vi.advanceTimersByTime(1000)

    expect(save).toHaveBeenCalledTimes(1)
    const state = save.mock.calls.at(-1)![0]
    expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'b'])
  })

  it('persists an EMPTY set when all sessions are closed (the resume-phantom fix)', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    useSessionStore.getState().addSession(makeSession('b'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    useSessionStore.getState().removeSession('a')
    useSessionStore.getState().removeSession('b')
    vi.advanceTimersByTime(1000)

    expect(save).toHaveBeenCalledTimes(1)
    const state = save.mock.calls.at(-1)![0]
    expect(state.sessions).toEqual([]) // -> next launch offers nothing to resume
  })

  it('does not flush on session metadata churn (same sessions array)', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    useSessionStore.getState().setActiveSession('a') // replaces activeSessionId only
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('does NOT flush on a per-session telemetry tick (structural key unchanged)', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    // A statusline tick replaces the sessions array but not the session SET.
    // The hook keys on session ids, so this must not (re)arm the autosave timer.
    useSessionStore.getState().updateSession('a', { contextPercent: 77 })
    useSessionStore.getState().updateSession('a', { contextPercent: 78 })
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('does not let sustained telemetry ticks starve a real add/remove flush', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    // A real structural change arms the timer...
    useSessionStore.getState().addSession(makeSession('b'))
    // ...and telemetry churn that follows must NOT keep resetting it.
    for (let i = 0; i < 5; i++) {
      useSessionStore.getState().updateSession('a', { contextPercent: i })
      vi.advanceTimersByTime(300)
    }
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
    const state = save.mock.calls.at(-1)![0]
    expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'b'])
  })
})
