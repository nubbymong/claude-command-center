// tests/unit/tmux-wheel-keys.test.ts
//
// #85 — the byte <-> tmux-keyname contract.
//
// `src/shared/tmux-wheel.ts` exists for ONE reason: the main process binds a
// tmux key NAME and the renderer writes the BYTES, and if the two ever stop
// describing the same keypress the wheel goes quiet (or, worse, the bytes are
// forwarded to the pane and typed at claude). Nothing else pins that: both the
// main and renderer test files import these constants and interpolate them into
// their own expectations, so they pass just as happily with the up-key set to
// the down-key's bytes (adversarial review, 2026-09-20 — four constant mutants
// survived the whole suite).
//
// The encoding is not a matter of taste. It is the standard xterm modified
// function key, `ESC [ <code> ; <modifier> ~`, where the code is the key's own
// (F10 = 21, F11 = 23, F12 = 24 — note 22 is skipped, a real quirk of the
// sequence) and the modifier is 1 + shift(1) + alt(2) + ctrl(4), so ctrl+alt
// is 7. tmux parses exactly that form into `C-M-F<n>`, verified against tmux
// 3.4 by driving these byte strings through a real pty client.
import { describe, it, expect } from 'vitest'
import {
  TMUX_WHEEL_UP_KEY,
  TMUX_WHEEL_DOWN_KEY,
  TMUX_WHEEL_EXIT_KEY,
  TMUX_WHEEL_UP_KEYNAME,
  TMUX_WHEEL_DOWN_KEYNAME,
  TMUX_WHEEL_EXIT_KEYNAME,
  TMUX_WHEEL_LINES_PER_NOTCH,
  TMUX_WHEEL_NOOP_COMMAND,
} from '../../src/shared/tmux-wheel'

/** The xterm function-key codes, which are NOT contiguous across F10-F12. */
const FN_CODE: Record<string, number> = { F10: 21, F11: 23, F12: 24 }

const KEYS: Array<{ role: string; bytes: string; name: string }> = [
  { role: 'up', bytes: TMUX_WHEEL_UP_KEY, name: TMUX_WHEEL_UP_KEYNAME },
  { role: 'down', bytes: TMUX_WHEEL_DOWN_KEY, name: TMUX_WHEEL_DOWN_KEYNAME },
  { role: 'exit', bytes: TMUX_WHEEL_EXIT_KEY, name: TMUX_WHEEL_EXIT_KEYNAME },
]

describe('tmux wheel key contract (#85)', () => {
  it('pins the exact bytes, so the renderer half cannot drift from the tmux half', () => {
    expect(TMUX_WHEEL_UP_KEY).toBe('\x1b[24;7~')
    expect(TMUX_WHEEL_DOWN_KEY).toBe('\x1b[23;7~')
    expect(TMUX_WHEEL_EXIT_KEY).toBe('\x1b[21;7~')
  })

  it('pins the exact tmux key names the bindings are registered under', () => {
    expect(TMUX_WHEEL_UP_KEYNAME).toBe('C-M-F12')
    expect(TMUX_WHEEL_DOWN_KEYNAME).toBe('C-M-F11')
    expect(TMUX_WHEEL_EXIT_KEYNAME).toBe('C-M-F10')
  })

  it.each(KEYS)('$role: the bytes decode to exactly the key name tmux is told to bind', ({ bytes, name }) => {
    const match = /^\x1b\[(\d+);(\d+)~$/.exec(bytes)
    expect(match).not.toBeNull()
    const [, code, modifier] = match!
    const fn = /^C-M-(F\d+)$/.exec(name)
    expect(fn).not.toBeNull()
    expect(Number(code)).toBe(FN_CODE[fn![1]])
    // 1 + alt(2) + ctrl(4). Any other modifier is a DIFFERENT keypress, which
    // tmux would forward to the pane instead of acting on.
    expect(Number(modifier)).toBe(7)
  })

  it('keeps the three keys distinct — two roles on one key would bind over each other', () => {
    expect(new Set([TMUX_WHEEL_UP_KEY, TMUX_WHEEL_DOWN_KEY, TMUX_WHEEL_EXIT_KEY]).size).toBe(3)
    expect(new Set([TMUX_WHEEL_UP_KEYNAME, TMUX_WHEEL_DOWN_KEYNAME, TMUX_WHEEL_EXIT_KEYNAME]).size).toBe(3)
  })

  it('scrolls 3 lines a notch — the platform default, so a remote notch moves like a local one', () => {
    expect(TMUX_WHEEL_LINES_PER_NOTCH).toBe(3)
  })

  it('keeps the no-op command silent and namespaced', () => {
    // It must WRITE something (an unbound key is forwarded to the pane) and
    // must PRINT nothing: CCC hides the tmux status line, so a message would
    // have nowhere to go but the next redraw. A user option is the cheapest
    // silent write tmux has; anything that displays or runs a shell is not.
    expect(TMUX_WHEEL_NOOP_COMMAND).toMatch(/^set -g @ccc-\w+ \w+$/)
    expect(TMUX_WHEEL_NOOP_COMMAND).not.toMatch(/display|run-shell|send|copy-mode/)
  })
})
