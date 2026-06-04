// @vitest-environment jsdom
// tests/unit/renderer/use-effort-subscription.test.tsx
//
// NOTE: this repo does not depend on @testing-library/react (only
// react-dom/client + react act, see e.g. auto-detect-banner-accept.test.tsx).
// We provide a tiny local `renderHook` shim with the same call shape the plan
// specified, so the test semantics match the spec exactly.
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useEffortSubscription } from '../../../src/renderer/hooks/useEffortSubscription'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function renderHook<T>(hook: () => T) {
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

let cb: ((d: { sessionId: string; effortLevel: string }) => void) | null = null
beforeEach(() => {
  cb = null
  // NOTE: assign only electronAPI (not the whole window) so jsdom's window
  // stays intact for react-dom's commit phase -- mirrors the repo pattern in
  // auto-detect-banner-accept.test.tsx. The plan's full-window replacement is
  // for @testing-library/react's renderHook, which this repo doesn't ship.
  ;(globalThis as any).window.electronAPI = { effort: { onUpdate: (fn: any) => { cb = fn; return () => { cb = null } } } }
  useSessionStore.setState({ sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'local' } as any], activeSessionId: 's1' })
})

describe('useEffortSubscription', () => {
  it('updates effortLevel and marks effortLive for the matching session', () => {
    renderHook(() => useEffortSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', effortLevel: 'xhigh' }) })
    expect(useSessionStore.getState().sessions[0].effortLevel).toBe('xhigh')
    // A live hooks tick must flip effortLive so the card may render the pill.
    expect(useSessionStore.getState().sessions[0].effortLive).toBe(true)
  })
  it('ignores updates for other sessions', () => {
    renderHook(() => useEffortSubscription('s1'))
    act(() => { cb!({ sessionId: 's2', effortLevel: 'xhigh' }) })
    expect(useSessionStore.getState().sessions[0].effortLevel).toBeUndefined()
  })
  it('ignores invalid levels (no effortLive flip)', () => {
    renderHook(() => useEffortSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', effortLevel: 'bogus' }) })
    expect(useSessionStore.getState().sessions[0].effortLevel).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].effortLive).toBeUndefined()
  })
})
