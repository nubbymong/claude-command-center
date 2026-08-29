// @vitest-environment jsdom
//
// The terminal half of the canvas ⇄ terminal fade (W23).
//
// The canvas pane is created and destroyed by the swap, so a static class on
// its root is its whole animation. The terminal container is the opposite: it
// stays mounted and is merely hidden, because re-keying it would remount xterm
// and take the user's scrollback with it. So the fade has to be armed by the
// COVER coming off, and — this is the part that bites — disarmed by something
// other than `animationend`, which never fires at all under reduced motion.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { PaneFade } from '../../../src/renderer/components/PaneFade'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function draw(covered: boolean): void {
  act(() => {
    root.render(
      <PaneFade covered={covered} className="flex-1" data-testid="terminal-panes">
        <span>terminal</span>
      </PaneFade>,
    )
  })
}
function pane(): HTMLElement {
  return container.querySelector('[data-testid="terminal-panes"]') as HTMLElement
}

describe('PaneFade', () => {
  it('says nothing on a first render, however it starts', () => {
    draw(false)
    expect(pane().className).not.toContain('pane-fade-in')
    draw(false)
    expect(pane().className).not.toContain('pane-fade-in')
  })

  it('fades in when the canvas closes over it, and not when it opens', () => {
    draw(false)
    draw(true)
    // Going UNDER the canvas animates nothing — the container is hidden.
    expect(pane().className).not.toContain('pane-fade-in')
    draw(false)
    expect(pane().className).toContain('pane-fade-in')
  })

  it('drops the class when the animation ends', () => {
    draw(true)
    draw(false)
    expect(pane().className).toContain('pane-fade-in')
    act(() => {
      pane().dispatchEvent(new Event('animationend', { bubbles: true }))
    })
    expect(pane().className).not.toContain('pane-fade-in')
  })

  it('drops it on a timer too, because reduced motion fires no animationend', () => {
    vi.useFakeTimers()
    draw(true)
    draw(false)
    expect(pane().className).toContain('pane-fade-in')
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(pane().className).not.toContain('pane-fade-in')
  })

  it('keeps the container it replaced — same classes, same children, no re-creation', () => {
    draw(false)
    const first = pane()
    const child = first.firstElementChild
    draw(true)
    draw(false)
    expect(pane()).toBe(first)
    expect(pane().firstElementChild).toBe(child)
    expect(pane().className).toContain('flex-1')
  })
})
