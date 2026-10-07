// @vitest-environment jsdom
/**
 * [host] P4.11 review (P411-6): the Usage page's age tick (useRenderEvery)
 * re-renders while mounted and leaves no timer behind: unmounting, or a new
 * period, clears the interval it set.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useRenderEvery } from '../../../src/renderer/hooks/useRenderEvery'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let renders = 0
function Probe({ ms }: { ms: number }) {
  useRenderEvery(ms)
  renders++
  return null
}

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

describe('useRenderEvery', () => {
  it('[host] re-renders every period while mounted, and unmounting clears its timer', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    renders = 0
    act(() => root!.render(<Probe ms={30_000} />))
    const first = renders
    expect(vi.getTimerCount()).toBe(1)
    // One tick per period (each its own act, as two ticks in one act batch).
    act(() => { vi.advanceTimersByTime(30_000) })
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(renders).toBe(first + 2)
    act(() => root!.unmount())
    root = null
    expect(vi.getTimerCount()).toBe(0)
  })

  it('[host] a new period replaces the timer rather than adding one', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(<Probe ms={30_000} />))
    act(() => root!.render(<Probe ms={10_000} />))
    expect(vi.getTimerCount()).toBe(1)
  })
})
