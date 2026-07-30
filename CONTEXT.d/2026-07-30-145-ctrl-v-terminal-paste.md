## 2026-07-30 -- Ctrl+V now pastes into terminals (#145)

Decision recorded in architecture/decisions/2026-07-30-adr-008-terminal-clipboard-keybindings.md.

Reported as "Aqua Voice dictation can't paste into CCC -- I have to right-click every
time". Investigation found the bug is general, not tool-specific: **Ctrl+V did nothing
in a CCC terminal at all**, confirmed with the reporter.

- Root cause: there was NO app-level Ctrl+V handler for terminal text. Right-click
  paste (TerminalView `handleContextMenu`) reads the clipboard and calls
  `term.paste()` directly, never consulting focus -- which is exactly why it worked.
  Ctrl+V depended on the Electron Edit-menu `role: 'paste'` reaching Chromium's paste
  command, which targets the focused EDITABLE element = xterm's hidden helper
  textarea. No focus there -> keystroke dropped, silently, with no feedback. Any tool
  that steals focus and synthesizes a paste hits that every time.
- Fix: CCC owns the keybinding. Ctrl+V / Cmd+V / Shift+Insert (+ Ctrl+Shift+V) read
  the clipboard and `term.paste()` (keeps bracketed-paste correct, per #545), then
  preventDefault so the native command can't double-insert.
- `isActive` is a HARD guard: every session's TerminalView stays mounted (App.tsx
  renders them all with display:none, plus the optional partner terminal) and the
  listener is on `document`, so without it one Ctrl+V would paste into every open
  session at once. Read via a ref -- the installing effect keys on session identity,
  so a captured prop goes stale on tab switches.
- Ordinary editables (`input`/`textarea`/`select`/contenteditable) are left to the
  native path so CommandBar/settings/rename keep working. xterm's own helper textarea
  is explicitly NOT counted as ordinary -- it IS the terminal. Alt+V stays image paste.
- Also added: restore terminal focus when the WINDOW regains focus. Previously focus
  was re-grabbed only on session activation, overlay unmount, and mouseup in the
  terminal -- the sole `window.addEventListener('focus')` in the codebase was
  BottomBar's update check. This covers tools that synthesize typed CHARACTERS rather
  than a paste command. Skipped over modals and when focus is in a real input.
- Guard logic is pure + unit-tested (`isPasteChord`, `shouldHandleTerminalPaste`,
  `isOrdinaryEditable`) -- the guards are the interesting part, not the clipboard call.
- KNOWN, LEFT ALONE: the pre-existing Ctrl+Shift+C copy handler has the same missing
  `isActive` guard. Benign today (only one terminal holds a selection); noted in
  ADR-008 rather than fixed here, to keep this change scoped.
- ROUND 2 -- the first cut still failed against Aqua Voice in a dev build that DID
  contain it (source 00:28, build 08:47, fix branch checked out, no uncommitted
  changes). Cause: the handler fired but the READ failed, silently.
  `navigator.clipboard.readText()` requires the DOCUMENT to be focused and rejects
  otherwise -- the exact condition the handler exists to survive -- and the original
  catch swallowed it. Compounding it, Windows delayed-render means the first read
  after a focus change can come back empty anyway.
  Not speculation: `clipboard-image.ts` already documents this as the cause of the
  Alt+V image first-attempt miss and already fixes it with a retry. Text had the
  same flaw.
  So: added `src/main/clipboard-text.ts` (`readClipboardTextWithRetry`, 6 x 80ms,
  short-circuits) + `CLIPBOARD_READ_TEXT` IPC. The main-process clipboard has no
  focus requirement. Renderer API kept only as a fallback.
- Failure is now VISIBLE (paste hint) instead of silent. Silence is what let this
  bug live -- and it doubles as the diagnostic: if an external tool pastes nothing
  and NO hint appears, the handler never ran, so the tool isn't sending a paste
  chord and the mechanism is something else.
- Verification: typecheck clean; full suite 3147 passed / 4 skipped; 22 tests in
  tests/unit/renderer/terminal-input.test.ts + 7 in tests/unit/main/clipboard-text.test.ts
  (added `clipboard.readText` to the electron mock in tests/unit/setup.ts). Unit tests
  cannot prove the end-to-end path -- it needs a SYNTHESIZED Ctrl+V from an external
  process (clipboard write + SendKeys into the CCC window), which is what actually
  reproduces the focus-loss condition; hand-pressing the key does not.
