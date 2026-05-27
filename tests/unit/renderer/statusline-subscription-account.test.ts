// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Capture the onUpdate callback the hook registers so the test can drive it.
let pushed: ((data: any) => void) | null = null

;(globalThis as any).window = (globalThis as any).window ?? {}
;(window as any).electronAPI = {
  statusline: {
    onUpdate: (cb: (data: any) => void) => {
      pushed = cb
      return () => { pushed = null }
    },
  },
}

// Dynamic import AFTER mocks so the hook sees the mocked window.electronAPI
const { useStatuslineSubscription } = await import('../../../src/renderer/hooks/useStatuslineSubscription')

function HookHarness({ sessionId }: { sessionId: string }) {
  useStatuslineSubscription(sessionId)
  return null
}

describe('useStatuslineSubscription account fields', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    pushed = null
    ;(window as any).electronAPI = {
      statusline: {
        onUpdate: (cb: (data: any) => void) => {
          pushed = cb
          return () => { pushed = null }
        },
      },
    }
    useSessionStore.setState({
      sessions: [{
        id: 's1', label: 'S1', workingDirectory: '/x', model: 'sonnet', color: 'mauve',
        status: 'idle', createdAt: 0, sessionType: 'local',
      } as any],
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('copies accountEmail + accountColour into the session', () => {
    act(() => { root.render(React.createElement(HookHarness, { sessionId: 's1' })) })
    act(() => { pushed!({ sessionId: 's1', accountEmail: 'me@example.com', accountColour: 'violet' }) })
    const s = useSessionStore.getState().sessions.find((x) => x.id === 's1')!
    expect(s.accountEmail).toBe('me@example.com')
    expect(s.accountColour).toBe('violet')
  })

  it('leaves account fields untouched when payload omits them', () => {
    act(() => { root.render(React.createElement(HookHarness, { sessionId: 's1' })) })
    act(() => { pushed!({ sessionId: 's1', model: 'opus' }) })
    const s = useSessionStore.getState().sessions.find((x) => x.id === 's1')!
    expect(s.accountEmail).toBeUndefined()
    expect(s.modelName).toBe('opus')
  })
})
