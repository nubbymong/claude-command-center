// tests/unit/tmux-wheel-scroll.test.ts
//
// #85 — the renderer half of wheel scrollback for SSH/tmux sessions. In a
// tmux-wrapped SSH session xterm sits on the alternate screen with no
// scrollback, and @xterm/xterm 6.0.0's wheel listener answers that case by
// emitting a cursor Up/Down to the PTY: every notch typed an arrow key at the
// remote app. This controller claims the wheel before that fallback and drives
// tmux's own copy-mode instead.
//
// The tmux-side behaviour (key parsing, scroll distance, copy-mode entry) was
// verified end-to-end against tmux 3.4 on 2026-09-20; these tests pin the
// renderer's state machine, which is where the traps are: the first notch has
// to enter copy-mode AND scroll, a scroll-down at the live bottom must send
// nothing, and a keystroke must leave copy-mode or it is eaten by the
// scrollback viewer instead of reaching claude.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTmuxWheelScroll, WHEEL_NOTCH_PX, PACE_MS, type TmuxWheelScroll } from '../../src/renderer/components/terminal/tmuxWheelScroll'
import { TMUX_WHEEL_UP_KEY, TMUX_WHEEL_DOWN_KEY, TMUX_WHEEL_EXIT_KEY } from '../../src/shared/tmux-wheel'

let written: string[]
let wheel: TmuxWheelScroll

/** Minimal WheelEvent stand-in — the controller reads three fields. */
function ev(deltaY: number, opts: { deltaMode?: number; ctrlKey?: boolean } = {}): WheelEvent {
  return { deltaY, deltaMode: opts.deltaMode ?? 0, ctrlKey: opts.ctrlKey ?? false } as WheelEvent
}

/**
 * Everything the controller has written SO FAR. Keys are paced one per
 * `PACE_MS` -- tmux resolves at most two escape sequences out of a single read
 * (measured against 3.4, `escape-time` 500) -- so a test that wants the whole
 * gesture drains the pacer first with `drain()`.
 */
const sent = (): string => written.join('')

/** Run the pacer to completion. */
function drain(): void {
  vi.advanceTimersByTime(PACE_MS * 64)
}

beforeEach(() => {
  vi.useFakeTimers()
  written = []
  wheel = createTmuxWheelScroll((data) => written.push(data))
  wheel.setEnabled(true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createTmuxWheelScroll (#85)', () => {
  it('is inert until enabled, so local and untmuxed sessions keep xterm\'s own scrolling', () => {
    const local = createTmuxWheelScroll((data) => written.push(data))
    expect(local.handleWheel(ev(-WHEEL_NOTCH_PX))).toBe(false)
    drain()
    expect(written).toEqual([])
    expect(local.exitPrefixForInput()).toBe('')
  })

  it('sends the up-key TWICE on the first notch: once to enter copy-mode, once to scroll', () => {
    // The root-table binding is a single `copy-mode -e` (a multi-command tmux
    // binding cannot survive the launch line's quoting), so entry does not
    // scroll on its own.
    expect(wheel.handleWheel(ev(-WHEEL_NOTCH_PX))).toBe(true)
    drain()
    expect(sent()).toBe(TMUX_WHEEL_UP_KEY + TMUX_WHEEL_UP_KEY)
  })

  it('sends one up-key per notch once copy-mode is open', () => {
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX))
    drain()
    written = []
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX * 3))
    drain()
    expect(sent()).toBe(TMUX_WHEEL_UP_KEY.repeat(3))
  })

  it('sends nothing when scrolling down at the live bottom, but still claims the event', () => {
    // Claiming it is the point: letting xterm see the event is what emitted an
    // arrow key. There is simply nothing to scroll towards.
    expect(wheel.handleWheel(ev(WHEEL_NOTCH_PX * 2))).toBe(true)
    drain()
    expect(written).toEqual([])
  })

  it('scrolls back down only while copy-mode is open', () => {
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX * 2))
    drain()
    written = []
    wheel.handleWheel(ev(WHEEL_NOTCH_PX * 2))
    drain()
    expect(sent()).toBe(TMUX_WHEEL_DOWN_KEY.repeat(2))
  })

  it('leaves copy-mode in front of a keystroke, exactly once', () => {
    // tmux copy-mode EATS keystrokes: without this the user scrolls up, types,
    // and the text drives the scrollback viewer instead of reaching claude.
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX))
    drain()
    expect(wheel.exitPrefixForInput()).toBe(TMUX_WHEEL_EXIT_KEY)
    expect(wheel.exitPrefixForInput()).toBe('')
  })

  it('needs a fresh entry key after a keystroke closed copy-mode', () => {
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX))
    drain()
    wheel.exitPrefixForInput()
    written = []
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX))
    drain()
    expect(sent()).toBe(TMUX_WHEEL_UP_KEY + TMUX_WHEEL_UP_KEY)
  })

  it('accumulates sub-notch trackpad deltas instead of rounding them away', () => {
    for (let i = 0; i < 4; i++) expect(wheel.handleWheel(ev(-WHEEL_NOTCH_PX / 4))).toBe(true)
    drain()
    expect(sent()).toBe(TMUX_WHEEL_UP_KEY + TMUX_WHEEL_UP_KEY)
  })

  it('drops the banked remainder when the scroll direction reverses', () => {
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX * 1.5)) // 1 notch up, 0.5 banked
    drain()
    written = []
    // Without the reset the banked half-notch would swallow the first notch back.
    wheel.handleWheel(ev(WHEEL_NOTCH_PX))
    drain()
    expect(sent()).toBe(TMUX_WHEEL_DOWN_KEY)
  })

  it('converts line- and page-mode deltas (Firefox, some Linux configs)', () => {
    wheel.handleWheel(ev(-3, { deltaMode: 1 })) // 3 lines = 1 notch
    drain()
    expect(sent()).toBe(TMUX_WHEEL_UP_KEY + TMUX_WHEEL_UP_KEY)
    written = []
    wheel.handleWheel(ev(-1, { deltaMode: 2 })) // 1 page = 8 notches
    drain()
    expect(sent()).toBe(TMUX_WHEEL_UP_KEY.repeat(8))
  })

  it('writes ONE key per write, PACE_MS apart -- tmux drops the rest of a burst', () => {
    // Measured against tmux 3.4 (escape-time 500): six up-keys in one write
    // scrolled 6 lines instead of 18; the same six spaced 20ms apart scrolled
    // all 18. Mutation to prove this can fail: write the whole gesture at once.
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX * 3)) // enter + 3 scrolls = 4 keys
    expect(written).toEqual([TMUX_WHEEL_UP_KEY])
    vi.advanceTimersByTime(PACE_MS)
    expect(written).toHaveLength(2)
    vi.advanceTimersByTime(PACE_MS * 2)
    expect(written).toHaveLength(4)
    expect(written.every((k) => k === TMUX_WHEEL_UP_KEY)).toBe(true)
  })

  it('a second gesture mid-flight extends the running pacer instead of starting a rival one', () => {
    // Two pacers would put two keys in the same read, which is the burst that
    // loses keys in the first place.
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX))
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX * 2))
    expect(written).toHaveLength(1)
    drain()
    expect(sent()).toBe(TMUX_WHEEL_UP_KEY.repeat(4)) // 1 enter + 3 scrolls
  })

  it('drops queued scroll keys when the user types, so at most one shares the leave key read', () => {
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX * 6))
    expect(written).toHaveLength(1)
    expect(wheel.exitPrefixForInput()).toBe(TMUX_WHEEL_EXIT_KEY)
    drain()
    expect(written).toHaveLength(1) // nothing further escaped the queue
  })

  it('leaves ctrl+wheel alone — that is the zoom gesture, not scrollback', () => {
    expect(wheel.handleWheel(ev(-WHEEL_NOTCH_PX, { ctrlKey: true }))).toBe(false)
    expect(written).toEqual([])
  })

  it('drops the copy-mode belief on reset and on a disable, so no stale key is sent', () => {
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX))
    drain()
    wheel.reset()
    expect(wheel.exitPrefixForInput()).toBe('')
    wheel.handleWheel(ev(-WHEEL_NOTCH_PX))
    drain()
    wheel.setEnabled(false)
    wheel.setEnabled(true)
    expect(wheel.exitPrefixForInput()).toBe('')
  })
})
