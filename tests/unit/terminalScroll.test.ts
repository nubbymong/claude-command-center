import { describe, it, expect } from 'vitest'
import { decideFollow } from '../../src/renderer/utils/terminalScroll'

describe('decideFollow (issue #73 sticky-bottom)', () => {
  it('follows when the viewport is exactly at the bottom', () => {
    expect(decideFollow({ viewportY: 100, baseY: 100 })).toEqual({
      scrollToBottom: true,
      scrolledUp: false,
    })
  })

  it('follows a fresh, empty buffer (both zero)', () => {
    expect(decideFollow({ viewportY: 0, baseY: 0 })).toEqual({
      scrollToBottom: true,
      scrolledUp: false,
    })
  })

  it('stops following and flags scrolled-up when the user is above the bottom', () => {
    // The core bug: a scrollbar-thumb drag leaves viewportY < baseY. Previously
    // the wheel-only latch stayed false here and the next chunk yanked down.
    expect(decideFollow({ viewportY: 40, baseY: 100 })).toEqual({
      scrollToBottom: false,
      scrolledUp: true,
    })
  })

  it('treats a viewport past the base (transient over-scroll) as at the bottom', () => {
    expect(decideFollow({ viewportY: 101, baseY: 100 })).toEqual({
      scrollToBottom: true,
      scrolledUp: false,
    })
  })

  it('resumes following the moment the user returns to the bottom', () => {
    // scrolled up ...
    expect(decideFollow({ viewportY: 40, baseY: 100 }).scrolledUp).toBe(true)
    // ... then dragged/paged back down to the bottom.
    expect(decideFollow({ viewportY: 100, baseY: 100 })).toEqual({
      scrollToBottom: true,
      scrolledUp: false,
    })
  })

  it('keeps honoring a scrolled-up viewport as scrollback grows (baseY climbs)', () => {
    // Output keeps arriving while the user reads history: viewportY stays put,
    // baseY climbs. Must remain scrolled-up on every chunk, never snap down.
    expect(decideFollow({ viewportY: 40, baseY: 200 }).scrolledUp).toBe(true)
    expect(decideFollow({ viewportY: 40, baseY: 500 }).scrolledUp).toBe(true)
  })
})
