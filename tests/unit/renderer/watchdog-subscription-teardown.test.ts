// @vitest-environment jsdom
// #605 (ADR-009 round 1, MINOR): tearing a watcher down pushes a state with
// armed:false. The subscription must CLEAR the session's watchdog rather than
// store it, otherwise the header paints an "off" Watchdog pill and the session
// menu offers three toggles that can never tick -- on every running session the
// moment the feature is unticked in Settings.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useWatchdogSubscription } = await import('../../../src/renderer/hooks/useWatchdogSubscription')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

type Push = (state: unknown) => void
let push: Push = () => {}

function Probe({ id }: { id: string }) {
  useWatchdogSubscription(id)
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSessionStore.setState({
    sessions: [{
      id: 's1', label: 'x', workingDirectory: '/w', model: 'sonnet',
      color: '#fff', status: 'idle', createdAt: 0, sessionType: 'local',
    }],
  } as never)
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.electronAPI = {
    watchdog: {
      onUpdate: (cb: Push) => { push = cb; return () => {} },
      getStates: async () => [],
    },
  }
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const mount = (id = 's1') => act(() => { root.render(React.createElement(Probe, { id })) })
const watchdogOf = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)?.watchdog

const armed = {
  sessionId: 's1', status: 'monitoring', armed: true, waitUntil: null, gaveUp: false,
  checks: { rateLimit: true, overload: true, safeguard: true },
}

describe('#605 watchdog subscription and teardown', () => {
  it('stores an armed push', () => {
    mount()
    act(() => { push(armed) })
    expect(watchdogOf('s1')?.checks).toEqual({ rateLimit: true, overload: true, safeguard: true })
  })

  it('CLEARS the session on a teardown push (armed:false), leaving no pill behind', () => {
    mount()
    act(() => { push(armed) })
    expect(watchdogOf('s1')).toBeTruthy()
    act(() => {
      push({
        sessionId: 's1', status: 'monitoring', armed: false, waitUntil: null, gaveUp: false,
        checks: { rateLimit: false, overload: false, safeguard: false },
        lastAction: 'watchdog stopped',
      })
    })
    expect(watchdogOf('s1'), 'a stopped watcher must leave nothing for the pill to paint').toBeUndefined()
  })

  it('ignores a push aimed at a different session', () => {
    mount()
    act(() => { push({ ...armed, sessionId: 'other' }) })
    expect(watchdogOf('s1')).toBeUndefined()
  })
})
