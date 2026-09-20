/**
 * #85 — mouse-wheel scrollback for SSH sessions wrapped in tmux.
 *
 * THE BUG. In an SSH session CCC runs claude inside `tmux new-session` (#242),
 * and a tmux CLIENT always puts the outer terminal into the ALTERNATE screen.
 * xterm.js's alternate buffer has no scrollback, and `@xterm/xterm` 6.0.0's
 * wheel listener has a documented fallback for exactly that case: when the
 * wheel was not consumed as a mouse report and `!buffer.hasScrollback`, it
 * emits `ESC [ A` / `ESC [ B` (cursor Up/Down) to the PTY. So in an SSH session
 * every wheel notch TYPED AN ARROW KEY at the remote app instead of scrolling —
 * not merely a missing feature, but input the user never asked to send.
 *
 * WHY NOT JUST `tmux set mouse on`. With mouse reporting on, tmux DECSETs mouse
 * tracking to the client, xterm hands the mouse to the app, and classic
 * click-drag text selection dies — the regression #546 exists to prevent. CCC
 * therefore forces `mouse off` on its own tmux session and keeps doing so.
 *
 * THE FIX. Keep `mouse off`, intercept the wheel LOCALLY (xterm's
 * `attachCustomWheelEventHandler`, which runs BEFORE the arrow-key fallback)
 * and drive tmux's own copy-mode scrollback by writing a private key to the
 * PTY. tmux consumes the key from its client's input; it never reaches claude.
 *
 * THE KEYS. Three keys that no fleet keyboard produces by accident and that
 * every tmux 3.x parses from the standard xterm modifier form
 * `ESC [ <n> ; <mod> ~` (mod 7 = ctrl+alt):
 *
 *   C-M-F12  ESC [ 24 ; 7 ~   scroll up   (and, from the root table, ENTER copy-mode)
 *   C-M-F11  ESC [ 23 ; 7 ~   scroll down
 *   C-M-F10  ESC [ 21 ; 7 ~   leave copy-mode
 *
 * Every binding is a SINGLE tmux command. Multi-command bindings need a `\;`
 * that survives two levels of shell quoting on the way into the tmux launch
 * line, and the escaping is fragile enough that the first notch entering
 * copy-mode without scrolling is the better trade: the renderer simply sends
 * the up-key TWICE on the first notch (enter, then scroll).
 *
 * Bindings live in the `root` and `copy-mode` key tables (CCC also pins
 * `mode-keys emacs` on its own session so `copy-mode-vi` is never consulted).
 * The out-of-mode down/leave keys are bound to a silent no-op so that a stale
 * "we think we are in copy-mode" never leaks raw escape bytes into claude.
 *
 * Verified against tmux 3.4 (2026-09-20): up ×2 → copy-mode at scroll_position
 * 3, three more → 9, one down → 6, leave → out of mode, and the no-op keys are
 * inert outside copy-mode.
 *
 * Shared because BOTH sides must agree byte-for-byte: the main process binds
 * the tmux keys (ssh-tmux.ts) and the renderer writes them (tmuxWheelScroll.ts).
 */

/** Wheel-up / enter-copy-mode. tmux key name `C-M-F12`. */
export const TMUX_WHEEL_UP_KEY = '\x1b[24;7~'
/** Wheel-down. tmux key name `C-M-F11`. */
export const TMUX_WHEEL_DOWN_KEY = '\x1b[23;7~'
/** Leave copy-mode (jump back to the live bottom). tmux key name `C-M-F10`. */
export const TMUX_WHEEL_EXIT_KEY = '\x1b[21;7~'

/** The tmux key NAMES the bindings are registered under, in the same order. */
export const TMUX_WHEEL_UP_KEYNAME = 'C-M-F12'
export const TMUX_WHEEL_DOWN_KEYNAME = 'C-M-F11'
export const TMUX_WHEEL_EXIT_KEYNAME = 'C-M-F10'

/**
 * Lines of scrollback per wheel notch. 3 is the Windows/GNOME default
 * "lines per notch", so a notch moves the same distance it does in a local
 * session where xterm scrolls its own buffer.
 */
export const TMUX_WHEEL_LINES_PER_NOTCH = 3

/**
 * A silent tmux command for the root-table bindings of the down/leave keys.
 * It must exist (an UNBOUND key is forwarded to the pane, i.e. straight into
 * claude) and it must print nothing: CCC hides the tmux status line, so an
 * error message would have nowhere to go but the next redraw. Setting a
 * namespaced user option is the cheapest write tmux has.
 */
export const TMUX_WHEEL_NOOP_COMMAND = 'set -g @ccc-wnoop 1'
