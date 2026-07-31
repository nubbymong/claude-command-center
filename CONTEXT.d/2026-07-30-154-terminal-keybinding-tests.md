## 2026-07-30 -- Terminal keybindings extracted so event-phase ordering is testable (#154, #153)

The #145 bug was a keydown handler registered on `document` in the BUBBLE phase.
xterm's own listener sits on the helper textarea and runs in the TARGET phase, so it
had already converted Ctrl+V to the raw control byte \x16 and written it to the PTY
before the handler ran. It typechecked, passed every predicate test, and was dead
code on the only path that mattered -- it took three attempts plus custom
instrumentation to find, and nothing in the suite could have caught a repeat.

- New `src/renderer/components/terminal/terminalKeybindings.ts` --
  `installTerminalKeybindings(opts)` owns BOTH clipboard chords behind ONE
  capture-phase `document` listener and returns a disposer. Every DOM/Electron
  dependency is injected (`doc`, `hasModalOpen`, `getActiveElement`, `readText`,
  `writeText`, `term`), so tests drive the real wiring rather than a copy of it.
- TerminalView now just calls it; the two inline handlers and their manual
  add/removeEventListener bookkeeping are gone. `isActive` is passed as a THUNK --
  the installing effect keys on session identity, so a captured boolean goes stale on
  tab switches, and the listener is shared by every mounted TerminalView.
- Fixes #153 in the same change, because the extraction rewrites exactly that
  registration: the copy chord gained the `isActive` / modal / ordinary-editable gate
  it never had (it previously ran once per mounted terminal and fired with focus in a
  text input). Also `isCopyChord` matches case-insensitively -- the old check was
  `e.key === 'C'` exactly, so copy silently stopped working under caps lock.
- CRITICAL validation, the point of the whole ticket: flipping the capture flag to
  `false` makes exactly three tests fail -- "xterm NEVER sees a paste chord", the copy
  equivalent, and the disposal test (an unmatched capture flag on
  removeEventListener silently removes nothing). A test that cannot fail would have
  been worthless here, so this was verified by mutation, not assumed.
- Tests use a real textarea carrying `xterm-helper-textarea` with its own keydown
  listener standing in for xterm. 19 cases: phase ordering for both chords, ordinary
  keys (incl. Ctrl+C = SIGINT) passing through untouched, defaultPrevented, disposal,
  inactive/modal/ordinary-editable guards, isActive read fresh per keystroke, empty
  and rejected clipboard reads, Shift+Insert and Cmd+V, an INJECTED chord with no
  `code` field, and the copy paths incl. caps lock and a rejected write.
- Verification: typecheck clean; full suite 3182 passed / 4 skipped (19 new
  keybinding tests + 4 isCopyChord predicate tests).
