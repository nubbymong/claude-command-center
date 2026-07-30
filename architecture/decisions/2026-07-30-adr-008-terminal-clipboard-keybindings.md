# ADR-008: CCC owns terminal clipboard keybindings; never rely on the native paste path

- **Status:** Accepted (2026-07-30)
- **Deciders:** @nubbymong (owner)
- **Related:** CONTEXT.d/2026-07-30-145-ctrl-v-terminal-paste.md, #145,
  src/renderer/utils/terminalInput.ts,
  src/renderer/components/TerminalView.tsx, src/main/clipboard-text.ts,
  src/main/clipboard-image.ts (the image precedent), src/main/index.ts (Edit menu roles)

## Context

Ctrl+V did nothing in a CCC terminal. Right-click paste worked, so the clipboard
was reachable only by mouse — and any external tool that delivers text by putting
it on the clipboard and synthesizing a paste (dictation such as Aqua Voice,
snippet expanders, macro tools) was unusable.

The two paths were asymmetric:

- **Right-click** read `navigator.clipboard.readText()` and called `term.paste()`
  directly. It never consulted DOM focus, which is why it always worked.
- **Ctrl+V** had **no handler at all**. It depended on the Electron Edit menu's
  `role: 'paste'` (added "so Ctrl+C/V/X/A work in frameless window") reaching
  Chromium's paste command, which targets the focused **editable element** —
  xterm.js's hidden helper textarea. Whenever that textarea does not hold DOM
  focus, the keystroke lands on a non-editable element and is dropped silently.

The native path is therefore only ever as reliable as one hidden element's focus
state. An external app that takes focus and hands it back is the worst case, and
nothing in CCC restored terminal focus on window focus (focus was re-grabbed only
on session activation, overlay unmount, and mouseup inside the terminal).

## Decision

**Terminal clipboard keybindings are CCC's, handled explicitly and
focus-independently. The Electron menu roles are a fallback for ordinary input
fields, never the mechanism for terminals.**

- Ctrl+V / Cmd+V / Shift+Insert (and Ctrl+Shift+V, which some terminals use) read
  the clipboard and call `term.paste()` — the same route right-click already
  proved — then `preventDefault()` so the native command cannot double-insert.
  `term.paste()` also keeps bracketed-paste mode correct, as #545 established for
  right-click.
- The decision logic is pure and unit-tested (`isPasteChord`,
  `shouldHandleTerminalPaste`, `isOrdinaryEditable`), because the interesting part
  is the guards, not the clipboard call.
- **`isActive` is a hard guard.** Every session's `TerminalView` stays mounted
  (`App.tsx` renders them all with `display:none`, plus an optional partner
  terminal) and the listener is on `document`, so without it a single Ctrl+V
  pastes into every open session simultaneously. It is read through a ref, not the
  captured prop, because the installing effect keys on session identity and would
  otherwise go stale on tab switches.
- **Ordinary editables are left to the native path.** When focus is in a real
  `<input>`/`<textarea>`/`<select>`/`[contenteditable]`, CCC does not intercept, so
  CommandBar, settings and rename fields keep behaving normally. xterm's own helper
  textarea is explicitly *excluded* from that classification — it IS the terminal.
- Alt+V stays image paste and is never treated as text.
- **The clipboard is read in the MAIN process** (`readClipboardTextWithRetry`), not
  via `navigator.clipboard.readText()`. Two independent reasons, both fatal to the
  renderer API here:
  1. The async clipboard API **requires the document to be focused** and rejects
     with "Document is not focused" otherwise — exactly the condition this handler
     exists to survive. Depending on document focus would reintroduce the bug in a
     new place.
  2. **Windows delayed-render**: the first read after the window gains focus can
     return empty because the source app materialises the format lazily. This is
     not speculation — it is the documented cause of the Alt+V *image*
     first-attempt miss (`clipboard-image.ts`), fixed there with the same retry.
     Text has no reason to behave differently, so it gets the same treatment
     (6 tries x 80ms, short-circuiting on the first hit).
  The renderer API remains as a fallback if the IPC call fails.
- **Failure is visible, never silent.** An empty or unreadable clipboard shows a
  paste hint. Silence is what let this bug live: Ctrl+V appeared to do nothing,
  with no way to tell whether the chord was even received. The hint is also the
  cheapest available diagnostic — if an external tool pastes nothing and NO hint
  appears, the handler never ran, which means the tool is not sending a paste
  chord at all and the mechanism is something else.
- Separately, terminal focus is now restored when the window regains focus, for
  tools that synthesize *typed characters* rather than a paste command. Skipped
  over modals and when focus sits in a real input, so it cannot steal focus from
  the user.

Rejected alternatives: **relying on the Edit-menu role** (the status quo — fails
exactly when an external tool is involved, and fails *silently*, which is why this
went unnoticed); **`attachCustomKeyEventHandler`** (xterm-scoped, so it only fires
when xterm already has focus — the case that is already working); **restoring
focus on window focus alone** (necessary for the typing case but not sufficient:
it would leave paste dependent on a focus race).

## Consequences

- Ctrl+V works in terminals regardless of which element holds DOM focus, so
  clipboard-plus-synthesized-paste tools work. This is the fix for #145.
- CCC now owns a keybinding Chromium would otherwise handle. If a future change
  needs Ctrl+V to reach some new in-terminal editable surface, it must be added to
  `isOrdinaryEditable`, not worked around in the handler.
- `preventDefault()` fires **before** the async clipboard read, so a denied read
  (insecure context, window not focused) is a no-op rather than a double paste.
  The terminal is left unchanged and nothing is reported — consistent with the
  existing right-click behaviour.
- The pre-existing Ctrl+Shift+C copy handler still lacks the `isActive` guard. It
  is benign today (only one terminal holds a selection) and is intentionally left
  alone here to keep this change scoped; it should get the same treatment.
- Verified by simulating the real failure mode — clipboard write plus a synthesized
  Ctrl+V from an external process (`SendKeys`) into the CCC window — not only by
  pressing the key by hand, since hand-pressing does not reproduce the
  focus-loss condition that external tools create.
