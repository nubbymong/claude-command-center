import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ILink } from '@xterm/xterm'
import { decorateTerminalLinks, createLinkHoverControl, LINK_HOVER_CLASS } from '../../../src/renderer/components/terminal/terminalLinks'

// The decorator ignores the event arg (handlers key off the URI), so a plain
// cast avoids needing a DOM environment for MouseEvent.
const EV = {} as MouseEvent

function fakeLink(text: string): ILink {
  return {
    range: { start: { x: 1, y: 1 }, end: { x: text.length, y: 1 } },
    text,
    activate: () => { throw new Error('original activate should be replaced') },
  }
}

describe('decorateTerminalLinks (#21)', () => {
  it('returns undefined when given no links', () => {
    expect(decorateTerminalLinks(undefined, { open: () => {}, onHover: () => {}, onLeave: () => {} })).toBeUndefined()
  })

  it('turns BOTH hover decorations OFF (underline: #562 selection flicker; pointerCursor: 2026-09-02 hover flicker)', () => {
    // xterm clears + re-asks the hovered link on every viewport re-render, so
    // any decoration it owns strobes at render cadence in a busy session. The
    // hand cursor is managed by createLinkHoverControl instead.
    const [d] = decorateTerminalLinks([fakeLink('https://x.dev')], { open: () => {}, onHover: () => {}, onLeave: () => {} })!
    expect(d.decorations?.underline).toBe(false)
    expect(d.decorations?.pointerCursor).toBe(false)
  })

  it('routes activate through open() with the matched URI (both http and https)', () => {
    const open = vi.fn()
    const links = decorateTerminalLinks(
      [fakeLink('https://a.dev'), fakeLink('http://b.local')],
      { open, onHover: () => {}, onLeave: () => {} },
    )!
    links[0].activate(EV, 'https://a.dev')
    links[1].activate(EV, 'http://b.local')
    expect(open).toHaveBeenNthCalledWith(1, 'https://a.dev')
    expect(open).toHaveBeenNthCalledWith(2, 'http://b.local')
  })

  it('records the hovered URI and clears it on leave (for the Copy-link menu item)', () => {
    const onHover = vi.fn()
    const onLeave = vi.fn()
    const [d] = decorateTerminalLinks([fakeLink('https://x.dev')], { open: () => {}, onHover, onLeave })!
    d.hover!(EV, 'https://x.dev')
    d.leave!(EV, 'https://x.dev')
    expect(onHover).toHaveBeenCalledWith('https://x.dev')
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('passes range and text through unchanged', () => {
    const src = fakeLink('https://x.dev/path')
    const [d] = decorateTerminalLinks([src], { open: () => {}, onHover: () => {}, onLeave: () => {} })!
    expect(d.text).toBe('https://x.dev/path')
    expect(d.range).toEqual(src.range)
  })
})

describe('createLinkHoverControl (2026-09-02 hover-flicker fix)', () => {
  afterEach(() => { vi.useRealTimers() })

  function fakeEl() {
    const classes = new Set<string>()
    return {
      el: {
        classList: {
          add: (c: string) => { classes.add(c) },
          remove: (c: string) => { classes.delete(c) },
        },
      } as unknown as HTMLElement,
      has: () => classes.has(LINK_HOVER_CLASS),
    }
  }

  it('the hover class stays OUT of the claude-session cursor-nuke net (never contains "xterm-cursor")', () => {
    // terminalTheme.ts hides any element matching [class*="xterm-cursor"]
    // inside a Claude session (display:none !important) — reusing xterm's own
    // xterm-cursor-pointer here display:noned the ENTIRE terminal on hover
    // (review blocker, 2026-09-02), and xterm strobing that class per render
    // is what made the original flicker so visible. App-owned name only.
    expect(LINK_HOVER_CLASS).not.toMatch(/xterm-cursor/)
    // ...and the injected stylesheet actually pairs a cursor rule with it.
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const theme = fs.readFileSync(
      path.resolve(__dirname, '../../../src/renderer/components/terminal/terminalTheme.ts'),
      'utf-8',
    )
    expect(theme).toContain('LINK_HOVER_CLASS}')
    expect(theme).toContain('cursor: pointer !important')
  })

  it('hover applies the hand cursor and records the URI immediately', () => {
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el)
    c.hover('https://x.dev')
    expect(f.has()).toBe(true)
    expect(c.current()).toBe('https://x.dev')
  })

  it("xterm's re-render churn (leave then immediate re-hover) never drops the cursor or the URI", () => {
    // The bug: xterm clears + re-asks the hovered link on every viewport
    // re-render, so leave/hover fired at render cadence and the hand cursor
    // strobed. The debounced leave makes the gap invisible.
    vi.useFakeTimers()
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el, 150)
    c.hover('https://x.dev')
    for (let i = 0; i < 10; i++) {
      c.leave()
      vi.advanceTimersByTime(20) // re-provide lands well inside the debounce
      c.hover('https://x.dev')
      expect(f.has()).toBe(true)
      expect(c.current()).toBe('https://x.dev')
    }
    // ...and a right-click inside a churn gap still sees the URI (latent race).
    c.leave()
    vi.advanceTimersByTime(100)
    expect(c.current()).toBe('https://x.dev')
    // Run the debounce out (Copilot nit: no pending fake timer left behind) —
    // which also pins the other half: an UNCANCELLED leave does clear.
    vi.advanceTimersByTime(51)
    expect(c.current()).toBeNull()
    expect(f.has()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a real departure clears the cursor and the URI after the delay', () => {
    vi.useFakeTimers()
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el, 150)
    c.hover('https://x.dev')
    c.leave()
    vi.advanceTimersByTime(151)
    expect(f.has()).toBe(false)
    expect(c.current()).toBeNull()
  })

  it('moving between two links keeps the cursor and swaps the URI', () => {
    vi.useFakeTimers()
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el, 150)
    c.hover('https://a.dev')
    c.leave()
    c.hover('https://b.dev')
    vi.advanceTimersByTime(500)
    expect(f.has()).toBe(true)
    expect(c.current()).toBe('https://b.dev')
  })

  it('dispose cancels a pending leave and clears state at once', () => {
    vi.useFakeTimers()
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el, 150)
    c.hover('https://x.dev')
    c.leave()
    c.dispose()
    expect(f.has()).toBe(false)
    expect(c.current()).toBeNull()
    vi.advanceTimersByTime(500) // the cancelled timer must not fire anything
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tolerates a missing element (terminal not yet opened / already disposed)', () => {
    const c = createLinkHoverControl(() => null)
    c.hover('https://x.dev')
    expect(c.current()).toBe('https://x.dev')
    c.dispose()
    expect(c.current()).toBeNull()
  })
})
