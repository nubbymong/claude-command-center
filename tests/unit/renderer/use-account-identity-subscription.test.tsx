// @vitest-environment jsdom
// tests/unit/renderer/use-account-identity-subscription.test.tsx
//
// MIRRORS use-effort-subscription.test.tsx: a tiny local `renderHook` shim
// (this repo does not depend on @testing-library/react) and partial
// electronAPI assignment (NOT full-window replacement) so jsdom's window
// survives react-dom's commit phase.
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useAccountIdentitySubscription } from '../../../src/renderer/hooks/useAccountIdentitySubscription'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import type { IdentityColorKey } from '../../../src/shared/identity-colors'

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

let cb: ((d: { sessionId: string; email: string; colourKey: string }) => void) | null = null
let pullResult: { email: string; colourKey: string } | null = null
beforeEach(() => {
  cb = null
  pullResult = null
  ;(globalThis as any).window.electronAPI = {
    accountIdentity: {
      get: vi.fn(async () => pullResult),
      onUpdate: (fn: any) => { cb = fn; return () => { cb = null } },
    },
  }
  useSessionStore.setState({ sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'local' } as any], activeSessionId: 's1' })
})

describe('useAccountIdentitySubscription', () => {
  it('updates accountEmail/accountColour for the matching session via push', () => {
    renderHook(() => useAccountIdentitySubscription('s1'))
    act(() => { cb!({ sessionId: 's1', email: 'a@me.com', colourKey: 'mauve' as IdentityColorKey }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBe('a@me.com')
    expect(s.accountColour).toBe('mauve')
  })
  it('ignores push updates for other sessions', () => {
    renderHook(() => useAccountIdentitySubscription('s1'))
    act(() => { cb!({ sessionId: 's2', email: 'b@live.co.uk', colourKey: 'rose' as IdentityColorKey }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBeUndefined()
    expect(s.accountColour).toBeUndefined()
  })
  it('populates from the pull-on-mount get()', async () => {
    pullResult = { email: 'pulled@me.com', colourKey: 'indigo' }
    renderHook(() => useAccountIdentitySubscription('s1'))
    // Flush the get() promise + its .then() state write.
    await act(async () => { await Promise.resolve() })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBe('pulled@me.com')
    expect(s.accountColour).toBe('indigo')
  })
})
