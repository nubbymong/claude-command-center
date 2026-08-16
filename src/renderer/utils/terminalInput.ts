// Detects xterm onData payloads that are terminal CONTROL REPORTS only (focus
// in/out, cursor-position report, mouse report) -- NOT genuine user input.
// Fixes #406: the attention-ack must not reset when the user merely focuses or
// blurs a session (xterm emits focus reports through onData), only when they
// actually type. If anything other than control reports remains, it's input.
const CONTROL_REPORT = /\x1b\[(?:I|O|\d*(?:;\d*)*R|M[\s\S]{0,3}|<\d+;\d+;\d+[Mm])/g

export function isControlReportOnly(data: string): boolean {
  if (!data) return true
  const stripped = data.replace(CONTROL_REPORT, '')
  return stripped.length === 0
}

// Decides what a right-click contextmenu event should do in a terminal.
//
// The old two-way version of this ('copy' | 'paste') was built on a premise
// that is FALSE inside CCC: "when there is no selection, a copy already
// happened on mouse-up (CC's copy-on-select)". A TUI can only reach the system
// clipboard through OSC 52, and CCC's xterm registers no OSC 52 handler and
// loads no ClipboardAddon — so nothing a TUI does ever copies. Worse, while a
// program has MOUSE TRACKING on (CC with classic off, vim, htop, a hand-run
// claude), xterm disables its selection service entirely, so hasSelection is
// always false and "no selection ⇒ paste" fired on every right-click — feeding
// the clipboard straight into the PTY, where a newline at a shell prompt
// EXECUTES it.
//
// The rules, in order:
//   - a visible selection is an unambiguous copy request → COPY. (While mouse
//     tracking is on, a selection can only exist via Shift+drag — xterm's
//     deliberate override — so it is still unambiguous.)
//   - no selection + mouse tracking on → MENU. Never blind-paste at a TUI:
//     the user cannot see what a paste would do, and the click was probably an
//     attempted copy that xterm's disabled selection turned into "no selection".
//   - no selection + no tracking + classicMode → PASTE, the PuTTY behaviour the
//     setting promises (classicTerminalCopyPaste, default on).
//   - no selection + no tracking + non-classic → MENU. The old "always paste"
//     rested entirely on the false copy-on-select premise; an explicit menu
//     pastes one click later and can never execute something unasked.
//
// 'menu' = show the terminal context menu with explicit Copy / Paste items.
export function decideContextMenuAction(opts: {
  hasSelection: boolean
  classicMode: boolean
  mouseTracking: boolean
}): 'copy' | 'paste' | 'menu' {
  if (opts.hasSelection) return 'copy'
  if (opts.mouseTracking) return 'menu'
  return opts.classicMode ? 'paste' : 'menu'
}

// Should a BLIND paste (classic right-click with nothing selected — the only
// paste the user did not explicitly pick from a menu) be routed through the
// context menu for confirmation instead?
//
// The hazard is precise: term.paste() normalises \n to \r, so clipboard text
// containing any newline submits line-by-line at a raw shell prompt — one
// right-click executes the clipboard. When the foreground program has turned
// bracketed paste on (CC's input, modern shells' line editors), the paste
// arrives wrapped in \x1b[200~ ... \x1b[201~ and newlines are literal, so
// multi-line pastes there are routine and safe — no confirmation.
export function blindPasteNeedsMenu(text: string, bracketedPasteActive: boolean): boolean {
  if (bracketedPasteActive) return false
  return /[\r\n]/.test(text)
}

// Is this keystroke a terminal paste request? Ctrl+V (Win/Linux), Cmd+V (macOS),
// and Shift+Insert (the other long-standing terminal convention).
//
// Ctrl+Shift+V is deliberately included: some terminals use it as "paste as plain
// text", and users coming from them press it out of habit.
export function isPasteChord(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  if (e.altKey) return false // Alt+V is CCC's image paste — never text.
  const key = e.key.toLowerCase()
  if (key === 'v' && (e.ctrlKey || e.metaKey)) return true
  if (e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.metaKey) return true
  return false
}

// Is this keystroke a terminal COPY request? Ctrl+Shift+C — the conventional
// terminal copy chord, kept distinct from Ctrl+C so it cannot swallow SIGINT.
//
// Matched case-insensitively: with shift held Chromium reports 'C', but with caps
// lock also on it reports 'c'. The old inline check compared `e.key === 'C'`
// exactly, so copy silently stopped working under caps lock.
export function isCopyChord(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  if (e.altKey || e.metaKey) return false
  return e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c'
}

// Should THIS TerminalView handle a paste chord itself, rather than leaving it to
// Chromium's native paste?
//
// Why CCC has to own the keybinding at all (#145): the native path pastes into the
// focused *editable element* — xterm's hidden helper textarea — so it silently does
// nothing whenever that textarea has lost DOM focus. An external tool that takes
// focus and synthesizes Ctrl+V (dictation, snippet expanders) hits that every time.
// Right-click paste always worked precisely because it reads the clipboard directly
// and never consults focus, so this makes Ctrl+V take the same route.
//
// The guards, in order, and why each one matters:
//   - `isActive`: EVERY session's TerminalView stays mounted (App.tsx renders them
//     with display:none), and the listener is on `document`. Without this, one
//     Ctrl+V pastes into every open session at once.
//   - `hasModalOpen`: a dialog is up; pasting into the terminal behind it is wrong.
//     Mirrors the existing focus-restore guard.
//   - `targetIsOrdinaryEditable`: focus is in a real input (CommandBar, settings,
//     rename) — leave Chromium's native paste alone so those keep working. xterm's
//     OWN textarea must not count as ordinary, or we'd never handle the common case.
export function shouldHandleTerminalPaste(opts: {
  isActive: boolean
  hasModalOpen: boolean
  targetIsOrdinaryEditable: boolean
}): boolean {
  if (!opts.isActive) return false
  if (opts.hasModalOpen) return false
  if (opts.targetIsOrdinaryEditable) return false
  return true
}

// Classifies the current focus target for shouldHandleTerminalPaste. An element is
// an "ordinary editable" if it accepts typed text AND is not the xterm helper
// textarea (xterm marks its own with class `xterm-helper-textarea`).
export function isOrdinaryEditable(el: {
  tagName?: string
  isContentEditable?: boolean
  classList?: { contains: (c: string) => boolean }
} | null): boolean {
  if (!el) return false
  if (el.classList?.contains('xterm-helper-textarea')) return false
  const tag = (el.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return !!el.isContentEditable
}
