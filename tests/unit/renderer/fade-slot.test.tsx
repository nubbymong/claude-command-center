// @vitest-environment jsdom
/**
 * FadeSlot (RC8): the presence chips (moon + working pill) enter and exit with
 * a fade instead of popping. The rules this file holds shut:
 *  - show=true renders the child; show=false keeps it MOUNTED in the 'out'
 *    phase for the fade, then unmounts after FADE_OUT_MS.
 *  - The exiting chip keeps the LAST-rendered child even when the caller's
 *    children have already collapsed to null (the store value backing the chip
 *    clears the same frame the flag does).
 *  - Flipping show back on during the exit cancels the unmount.
 *  - Initial show=false renders nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { FadeSlot, FADE_OUT_MS } = await import('../../../src/renderer/components/sidebar/Badges')

describe('FadeSlot — presence-chip fade lifecycle', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.useRealTimers()
  })

  const slot = () => container.querySelector('[data-testid="fade-slot"]')
  const render = (show: boolean, child: React.ReactNode = createElement('i', { 'data-testid': 'chip' }, 'chip')) =>
    act(() => { root.render(createElement(FadeSlot, { show }, child)) })

  it('renders the child in the "in" phase while shown', () => {
    render(true)
    expect(slot()?.getAttribute('data-phase')).toBe('in')
    expect(container.querySelector('[data-testid="chip"]')).not.toBeNull()
  })

  it('initial show=false renders nothing', () => {
    render(false)
    expect(slot()).toBeNull()
  })

  it('keeps the chip mounted in the "out" phase for the fade, then unmounts', () => {
    render(true)
    render(false)
    expect(slot()?.getAttribute('data-phase')).toBe('out')
    expect(container.querySelector('[data-testid="chip"]')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(FADE_OUT_MS + 10) })
    expect(slot()).toBeNull()
  })

  it('the exiting slot keeps the LAST child even when children collapse to null', () => {
    render(true)
    render(false, null) // the flag and its backing value clear together
    expect(container.querySelector('[data-testid="chip"]')).not.toBeNull()
  })

  it('re-showing during the exit cancels the unmount', () => {
    render(true)
    render(false)
    act(() => { vi.advanceTimersByTime(FADE_OUT_MS / 2) })
    render(true)
    act(() => { vi.advanceTimersByTime(FADE_OUT_MS * 2) })
    expect(slot()?.getAttribute('data-phase')).toBe('in')
    expect(container.querySelector('[data-testid="chip"]')).not.toBeNull()
  })
})
