// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import ConductorServicesPanel from '../../../src/renderer/components/ConductorServicesPanel'
import type { DiagnosticsSnapshot } from '../../../src/shared/service-health'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const snap: DiagnosticsSnapshot = {
  capturedAt: 0, services: [], log: [],
  pty: {
    sessions: [{ sessionId: 'sess-abcdef', bytesFromPty: 2048, bytesReceived: 2048, bytesWritten: 2000,
      strippedBytes: 48, byteGap: 0, chunksFromPty: 12, appliedCols: 120, rendererCols: 120,
      resizeCount: 3, widthDesyncCount: 0 }],
    totals: { activeSessions: 1, bytesFromPty: 2048, resizes: 3, desyncs: 0 },
    recentEvents: [{ ts: 1, kind: 'resize', sessionId: 'sess-abcdef', detail: 'applied 120x30' }],
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = {
    serviceHealth: {
      get: () => Promise.resolve(snap),
      onUpdate: (_cb: unknown) => () => {},
      restart: () => Promise.resolve({ ok: true }),
    },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('ConductorServicesPanel PTY section', () => {
  it('renders the PTY integrity totals when snap.pty is present', async () => {
    await act(async () => {
      root.render(createElement(ConductorServicesPanel, { open: true, onClose: () => {} }))
    })
    // Let the async serviceHealth.get().then(setSnap) settle.
    await act(async () => { await Promise.resolve() })

    const text = container.textContent ?? ''
    expect(text).toMatch(/PTY integrity/i)
    expect(text).toMatch(/sess-abc/i)
  })
})
