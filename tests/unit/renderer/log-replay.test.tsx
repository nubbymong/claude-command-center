// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Make all elements report non-zero dimensions so the terminal init guard
// (`rect.width === 0`) does not spin forever in requestAnimationFrame.
Element.prototype.getBoundingClientRect = () =>
  ({ width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => {} } as DOMRect)

// ---------------------------------------------------------------------------
// Mock xterm and its FitAddon — they require a real browser canvas/DOM that
// jsdom cannot provide. The mocks capture write() calls so assertions remain
// meaningful, while keeping the test hermetic.
// ---------------------------------------------------------------------------
vi.mock('@xterm/xterm', () => {
  class Terminal {
    theme: unknown
    _writes: Uint8Array[] = []
    _disposed = false
    _addons: unknown[] = []
    loadAddon(addon: any) { this._addons.push(addon); if (addon._activate) addon._activate(this) }
    open(_el: unknown) { /* no-op in jsdom */ }
    write(data: Uint8Array | string) { this._writes.push(data as Uint8Array) }
    clear() { this._writes = [] }
    dispose() { this._disposed = true }
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    _activate(_term: unknown) {}
    fit() {}
    dispose() {}
  }
  return { FitAddon }
})

// ---------------------------------------------------------------------------
// Minimal logsdb mock — overridden per-test in beforeEach.
// ---------------------------------------------------------------------------
const reads: Array<{ sessionId: string; offset: number; limit: number }> = []
beforeEach(() => {
  reads.length = 0
  ;(globalThis as any).window.electronAPI = {
    logsdb: {
      readEvents: vi.fn().mockImplementation((sessionId: string, offset: number, limit: number) => {
        reads.push({ sessionId, offset, limit })
        return Promise.resolve([]) // empty session by default
      }),
    },
  }
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
})

import LogReplay from '../../../src/renderer/components/LogReplay'

const mount = async (el: React.ReactElement) => {
  const container = document.createElement('div')
  Object.defineProperty(container, 'getBoundingClientRect', {
    value: () => ({ width: 600, height: 400 }),
    configurable: true,
  })
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
  return { container, cleanup: () => { root.unmount(); container.remove() } }
}

describe('LogReplay', () => {
  it('pages readEvents for the given session with limit <= 1000', async () => {
    const { cleanup } = await mount(<LogReplay sessionId="s1" />)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((r) => r.sessionId === 's1')).toBe(true)
    expect(reads.every((r) => r.limit <= 1000)).toBe(true)
    cleanup()
  })

  it('shows an empty-state message when a session has no events', async () => {
    const { container, cleanup } = await mount(<LogReplay sessionId="empty" />)
    expect(container.textContent).toMatch(/No log output/i)
    cleanup()
  })

  it('shows the after-delete message when deleted is set', async () => {
    const { container, cleanup } = await mount(<LogReplay sessionId="x" deleted />)
    expect(container.textContent).toMatch(/These logs were deleted/i)
    cleanup()
  })

  it('does not double-read offset 0 when a constant tailNonce is present (no double-write)', async () => {
    ;(globalThis as any).window.electronAPI.logsdb.readEvents = vi.fn().mockImplementation(
      (sessionId: string, offset: number, limit: number) => {
        reads.push({ sessionId, offset, limit })
        // one event on the first page, nothing after
        return Promise.resolve(offset === 0 ? [{ id: 1, sessionId, seq: 0, ts: 1, type: 'data', raw: new Uint8Array([65]), text: 'A' }] : [])
      },
    )
    const { cleanup } = await mount(<LogReplay sessionId="s1" tailNonce={7} />)
    // The initial load reads offset 0 exactly once; the tail effect must NOT also read offset 0.
    expect(reads.filter((r) => r.offset === 0).length).toBe(1)
    cleanup()
  })
})
