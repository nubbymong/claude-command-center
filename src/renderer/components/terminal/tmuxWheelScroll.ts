/**
 * tmuxWheelScroll.ts — #85, the renderer half of mouse-wheel scrollback for
 * SSH sessions wrapped in tmux. The main half (the tmux key bindings) is
 * buildTmuxWheelBindings in src/main/ssh-tmux.ts; the bytes both sides agree
 * on, and the whole rationale, live in src/shared/tmux-wheel.ts.
 *
 * Three jobs:
 *
 *  1. TURN A WHEEL NOTCH INTO A tmux SCROLL. Installed via xterm's
 *     `attachCustomWheelEventHandler`, which `@xterm/xterm` 6.0.0 consults
 *     BEFORE its `!buffer.hasScrollback` fallback — the branch that was
 *     emitting cursor Up/Down at the remote app. Handling the event here means
 *     that fallback never runs, which is half the bug on its own.
 *
 *  2. PACE THE KEYS. tmux resolves at most TWO escape sequences out of one
 *     read: at the default `escape-time` of 500ms its key parser holds an
 *     ambiguous ESC and drops the rest of the burst. Measured against tmux 3.4
 *     on 2026-09-20 — six up-keys in ONE write scrolled 6 lines instead of 18,
 *     and the same six spaced 20ms apart scrolled all 18. So keys go out ONE
 *     at a time, `PACE_MS` apart, which is also what makes a flick look like
 *     scrolling rather than a jump. Lowering the remote's `escape-time` would
 *     fix it in one command and is not done here: it is a server option, so it
 *     would be reaching into the user's other tmux sessions to change a
 *     setting they tuned, for our convenience.
 *
 *  3. LEAVE COPY-MODE THE MOMENT THE USER TYPES. tmux copy-mode swallows
 *     keystrokes: scroll up, type, and the text goes to the scrollback viewer
 *     instead of claude. Every real keystroke therefore gets the leave-key
 *     written in front of it, and any still-queued scroll keys are dropped —
 *     the user has stopped scrolling. At most one scroll key can then share a
 *     read with the leave key, and two per read is exactly what tmux resolves.
 *     Sending the leave key when tmux has ALREADY left (the `-e` auto-exit at
 *     the bottom, which the renderer cannot observe) is inert — that is what
 *     the root-table no-op binding is for.
 *
 * Deliberately not a React hook and free of xterm imports: a plain object with
 * injected `write`, so the state machine is unit-testable without a DOM.
 */

import {
  TMUX_WHEEL_UP_KEY,
  TMUX_WHEEL_DOWN_KEY,
  TMUX_WHEEL_EXIT_KEY,
} from '../../../shared/tmux-wheel'

/**
 * Pixels of `deltaY` per wheel notch. Chrome reports 100 per notch on Windows
 * and Linux at default settings; a trackpad reports a stream of small deltas
 * that accumulate into notches instead, so a flick scrolls smoothly rather
 * than being rounded away to nothing.
 */
export const WHEEL_NOTCH_PX = 100

/**
 * Milliseconds between queued keys. 20 was enough for tmux 3.4 to resolve every
 * key in a six-key burst; 25 is that with margin, and still 40 notches/second —
 * faster than a wheel produces them.
 */
export const PACE_MS = 25

/** Notches per `DOM_DELTA_LINE` unit — 3 lines per notch, so one line ≈ ⅓. */
const LINES_PER_NOTCH = 3

/** Notches per `DOM_DELTA_PAGE` unit. Rare (some Linux configs); a page ≈ 8. */
const NOTCHES_PER_PAGE = 8

export interface TmuxWheelScroll {
  /**
   * Handle a wheel event. `true` means the event was consumed and xterm must
   * NOT process it (the caller returns `false` from xterm's custom wheel
   * handler); `false` means the session is local/untmuxed and xterm's own
   * scrolling should run untouched.
   */
  handleWheel(event: WheelEvent): boolean
  /**
   * Bytes to write to the PTY immediately BEFORE the user's own input, or ''
   * when nothing is needed. Consumes the "we are in copy-mode" belief and
   * drops any keys still queued.
   */
  exitPrefixForInput(): string
  /** SSH + tmux-wrapped sessions only; everything else stays on xterm's path. */
  setEnabled(enabled: boolean): void
  /** Drop the copy-mode belief and the queue (respawn, reconnect, dispose). */
  reset(): void
}

export function createTmuxWheelScroll(write: (data: string) => void): TmuxWheelScroll {
  let enabled = false
  let inCopyMode = false
  /** Sub-notch remainder, so a trackpad's small deltas accumulate. */
  let accum = 0
  /** Keys not yet written, one per `PACE_MS`. */
  let queue: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const stopPacer = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    queue = []
  }

  /** Write the head of the queue now, then keep going on a timer. */
  const pump = (): void => {
    const key = queue.shift()
    if (key === undefined) {
      timer = null
      return
    }
    write(key)
    timer = setTimeout(pump, PACE_MS)
  }

  const enqueue = (keys: string[]): void => {
    queue.push(...keys)
    // A pacer already running will pick these up on its next tick; starting a
    // second one would put two keys in the same read and lose one of them.
    if (timer === null) pump()
  }

  /** Signed notch count for one event; sub-notch movement is carried over. */
  const notchesFor = (event: WheelEvent): number => {
    let px: number
    if (event.deltaMode === 1 /* DOM_DELTA_LINE */) px = (event.deltaY / LINES_PER_NOTCH) * WHEEL_NOTCH_PX
    else if (event.deltaMode === 2 /* DOM_DELTA_PAGE */) px = event.deltaY * NOTCHES_PER_PAGE * WHEEL_NOTCH_PX
    else px = event.deltaY
    // A direction change starts a fresh accumulator: carrying a half-notch of
    // "up" into a "down" flick would swallow the first notch back the other way.
    if (px !== 0 && Math.sign(px) !== Math.sign(accum)) accum = 0
    accum += px
    const notches = Math.trunc(accum / WHEEL_NOTCH_PX)
    accum -= notches * WHEEL_NOTCH_PX
    return notches
  }

  return {
    handleWheel(event: WheelEvent): boolean {
      if (!enabled) return false
      // Ctrl+wheel is the zoom gesture and belongs to whoever owns zoom, never
      // to scrollback. Left entirely alone, exactly as xterm would see it.
      if (event.ctrlKey) return false
      const notches = notchesFor(event)
      // Consumed even at zero notches: the event is OURS for this session, and
      // letting xterm see a sub-notch trackpad delta is what emitted an arrow
      // key. Sub-notch movement is banked in `accum` for the next event.
      if (notches === 0) return true
      if (notches < 0) {
        // Scroll up. The first key only ENTERS copy-mode (the root binding is a
        // single `copy-mode -e`), so one extra is queued ahead of the scrolls.
        const enter = inCopyMode ? [] : [TMUX_WHEEL_UP_KEY]
        inCopyMode = true
        enqueue([...enter, ...Array<string>(-notches).fill(TMUX_WHEEL_UP_KEY)])
      } else if (inCopyMode) {
        enqueue(Array<string>(notches).fill(TMUX_WHEEL_DOWN_KEY))
      }
      // Scrolling down while NOT in copy-mode is already at the live bottom:
      // nothing to send, and nothing for xterm to do either.
      return true
    },
    exitPrefixForInput(): string {
      if (!enabled || !inCopyMode) return ''
      inCopyMode = false
      accum = 0
      stopPacer()
      return TMUX_WHEEL_EXIT_KEY
    },
    setEnabled(next: boolean): void {
      if (next === enabled) return
      enabled = next
      inCopyMode = false
      accum = 0
      stopPacer()
    },
    reset(): void {
      inCopyMode = false
      accum = 0
      stopPacer()
    },
  }
}
