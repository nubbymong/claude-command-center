// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Mock LogReplay as a stub that exposes appendNew via useImperativeHandle and
// calls readEvents directly (so the live-tail assertion remains meaningful
// without depending on xterm terminal-init timing under fake timers).
// ---------------------------------------------------------------------------
vi.mock('../../../src/renderer/components/LogReplay', () => {
  const React = require('react')
  const { useImperativeHandle, forwardRef } = React
  const LogReplay = forwardRef(function LogReplay(
    { sessionId }: { sessionId: string; deleted?: boolean },
    ref: React.Ref<{ appendNew: () => Promise<void> }>,
  ) {
    useImperativeHandle(ref, () => ({
      appendNew: async () => {
        await (window as any).electronAPI.logsdb.readEvents(sessionId, 0)
      },
    }))
    return React.createElement('div', { 'data-testid': 'log-replay' })
  })
  return { default: LogReplay }
})

const reads: Array<{ offset: number }> = []
beforeEach(() => {
  reads.length = 0
  vi.useFakeTimers()
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  ;(globalThis as any).window.electronAPI = {
    logsdb: {
      readEvents: vi.fn().mockImplementation((_sid: string, offset: number) => {
        reads.push({ offset })
        return Promise.resolve([])
      }),
    },
  }
})

// Mock the session store so we can flip status working->exited.
// NOTE: SessionStatus uses 'working' (not 'running') for an active session.
let sessionStatus = 'working'
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({ sessions: [{ id: 's1', status: sessionStatus, label: 'APP' }] }),
}))

import LogsPane from '../../../src/renderer/components/LogsPane'

const mount = async (el: React.ReactElement) => {
  const container = document.createElement('div')
  Object.defineProperty(container, 'getBoundingClientRect', {
    value: () => ({ width: 600, height: 400 }),
  })
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(el)
  })
  return { container, cleanup: () => { root.unmount(); container.remove() } }
}

describe('LogsPane', () => {
  it('live-tails (polls readEvents) while the session status is working', async () => {
    sessionStatus = 'working'
    const { cleanup } = await mount(<LogsPane sessionId="s1" />)
    const before = reads.length
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    expect(reads.length).toBeGreaterThan(before)
    cleanup()
  })

  it('renders a find-in-session input with case and regex toggles', async () => {
    sessionStatus = 'complete'
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(container.querySelector('input[type="text"]')).toBeTruthy()
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels.some((t) => t?.includes('Aa'))).toBe(true)
    expect(labels.some((t) => t?.includes('.*'))).toBe(true)
    cleanup()
  })
})
