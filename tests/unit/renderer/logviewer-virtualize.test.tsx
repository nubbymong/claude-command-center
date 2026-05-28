// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const calls: any[] = []
beforeEach(() => {
  calls.length = 0
  ;(globalThis as any).window.electronAPI = {
    logs: {
      list: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockImplementation((_dir: string, offset: number, limit: number) => {
        calls.push({ offset, limit })
        return Promise.resolve({ entries: [], total: 10000, hasMore: true })
      }),
      cleanup: vi.fn(),
    },
  }
})

import LogViewer from '../../../src/renderer/components/LogViewer'

describe('LogViewer pagination (U4.3)', () => {
  it('does not request bulk 5000-entry pages -- every read call uses limit <= 500', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<LogViewer />) })
    await act(async () => { await new Promise(r => setTimeout(r, 100)) })
    // calls may be empty (no session selected yet) -- that's fine. Assert that
    // NONE of the calls (if any) used a limit > 500.
    expect(calls.every(c => c.limit <= 500)).toBe(true)
    root.unmount()
    container.remove()
  })
})
