import { describe, it, expect, vi } from 'vitest'
import type { ILink } from '@xterm/xterm'
import { decorateTerminalLinks } from '../../../src/renderer/components/terminal/terminalLinks'

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

  it('turns the hover underline OFF (the flicker fix) but keeps the pointer cursor', () => {
    const [d] = decorateTerminalLinks([fakeLink('https://x.dev')], { open: () => {}, onHover: () => {}, onLeave: () => {} })!
    expect(d.decorations?.underline).toBe(false)
    expect(d.decorations?.pointerCursor).toBe(true)
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
