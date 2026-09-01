// @vitest-environment jsdom
// tests/unit/renderer/use-statusline-subscription.test.tsx
//
// Covers the graceful-fail effort gate (effortLive) and the live Fast Mode flag
// (fastMode) that the statusline subscription writes onto the session. Uses the
// same local renderHook shim as use-effort-subscription.test.tsx (this repo does
// not depend on @testing-library/react).
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useStatuslineSubscription } from '../../../src/renderer/hooks/useStatuslineSubscription'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function renderHook<T>(hook: () => T) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const HookHost: React.FC = () => { hook(); return null }
  act(() => { root.render(<HookHost />) })
  return { unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

let cb: ((d: any) => void) | null = null
beforeEach(() => {
  cb = null
  ;(globalThis as any).window.electronAPI = { statusline: { onUpdate: (fn: any) => { cb = fn; return () => { cb = null } } } }
  useSessionStore.setState({
    sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'local' } as any],
    activeSessionId: 's1',
  })
})

describe('useStatuslineSubscription -- effort graceful-fail', () => {
  it('sets effortLevel AND effortLive on a live tick carrying effort', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', effortLevel: 'high' }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.effortLevel).toBe('high')
    expect(s.effortLive).toBe(true)
  })

  it('does not set effortLive when the tick carries no effort', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', contextUsedPercent: 20 }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.effortLive).toBeUndefined()
  })

  it('ignores ticks for other sessions', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's2', effortLevel: 'max' }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.effortLevel).toBeUndefined()
    expect(s.effortLive).toBeUndefined()
  })
})

describe('useStatuslineSubscription -- account identity (Phase 3 harmonise-remote)', () => {
  it('LOCAL sessions never take accountEmail/accountColour from a tick (v1.5.9 anti-clobber)', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', accountEmail: 'other@x.com', accountColour: 'mauve', contextUsedPercent: 10 }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBeUndefined()
    expect(s.accountColour).toBeUndefined()
    expect(s.contextPercent).toBe(10) // the rest of the tick still lands
  })

  it('SSH sessions DO take accountEmail/accountColour from their tunnel tick', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'ssh' } as any],
      activeSessionId: 's1',
    })
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', accountEmail: 'remote@x.com', accountColour: 'mauve' }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBe('remote@x.com')
    expect(s.accountColour).toBe('mauve')
  })

  it('an SSH tick without accountEmail leaves the stored identity untouched', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'ssh', accountEmail: 'kept@x.com' } as any],
      activeSessionId: 's1',
    })
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', contextUsedPercent: 30 }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBe('kept@x.com')
  })
})

describe('useStatuslineSubscription -- fast mode', () => {
  it('sets fastMode:true when the live tick reports fast_mode on', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', fastMode: true }) })
    expect(useSessionStore.getState().sessions[0].fastMode).toBe(true)
  })

  it('clears fastMode to false when toggled off (copies false, not just true)', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', fastMode: true }) })
    act(() => { cb!({ sessionId: 's1', fastMode: false }) })
    expect(useSessionStore.getState().sessions[0].fastMode).toBe(false)
  })

  it('leaves fastMode untouched when the tick omits fast_mode', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', fastMode: true }) })
    act(() => { cb!({ sessionId: 's1', contextUsedPercent: 50 }) })
    expect(useSessionStore.getState().sessions[0].fastMode).toBe(true)
  })
})
