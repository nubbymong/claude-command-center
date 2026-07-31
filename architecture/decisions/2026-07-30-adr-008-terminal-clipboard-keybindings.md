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

## The measured root cause (supersedes two earlier theories)

Two attempted fixes failed because the mechanism was reasoned about rather than
measured. Opt-in input diagnostics (`CCC_INPUT_DEBUG=1`) settled it:

```
keydown key="v" mods=ctrl trusted=true target=textarea.xterm-helper-textarea   <- injected, NO code field
pty:write shell  len=1 "\x16"
pty:write claude len=1 "\x16"
```

- The external tool **does** send a real synthesized Ctrl+V. Injected keystrokes
  arrive with `key="v"` and **no `code`** (no physical scan code); human presses
  carry `code=KeyV`. Both were present in one trace, which is how they were told
  apart.
- What reached the PTY was `\x16` — **SYN, the raw Ctrl+V control byte** — in
  BOTH session types. So CCC was never pasting at all.
- It appeared to work in a shell only because **PSReadLine binds Ctrl+V to Paste**,
  so PowerShell pasted from the Windows clipboard itself. `claude.exe` has no
  binding for `\x16`, so nothing happened. That difference is what made this look
  like a `claude.exe` bug; it was not.
- The paste handler never ran because it was registered on `document` in the
  **bubble** phase. xterm's own keydown listener is on the helper textarea, so it
  runs in the target phase — **before** any document bubble listener — converting
  the chord to `\x16` and writing it. `preventDefault()` there is already too late.

So the defect was event-phase ordering in CCC, not focus, not the clipboard API,
not the injecting tool, and not Claude Code.

## Decision

**Terminal clipboard keybindings are CCC's, handled explicitly and
focus-independently. The Electron menu roles are a fallback for ordinary input
fields, never the mechanism for terminals.**

- The keydown listener is registered in the **CAPTURE** phase on `document` and
  calls `stopPropagation()` before `preventDefault()`. Capture on `document` runs
  ahead of any listener on a descendant, so xterm never sees the chord and never
  emits `\x16`. This is not a stylistic detail — in the bubble phase the handler is
  dead code, which is exactly how the first attempt shipped looking correct.
  `stopPropagation`, not `stopImmediatePropagation`, so the diagnostics listener on
  the same node still records the event.
- `isPasteChord` matches on `key` alone and must never require `code`: injected
  keystrokes have no `code`, so requiring it would exclude precisely the case this
  exists to serve.

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
- **Resolved in #154/#153:** the wiring now lives in
  `components/terminal/terminalKeybindings.ts` (`installTerminalKeybindings`), which
  owns BOTH chords behind one capture-phase listener and returns a disposer. Copy
  gained the same `isActive` / modal / ordinary-editable gate it never had. The
  extraction exists so the REGISTRATION is testable, not just the predicates — the
  original bug was dead code that passed every predicate test, and a test that
  mirrors the registration would pass regardless. The suite drives the installer
  with a stand-in for xterm's textarea listener and asserts xterm never sees the
  chord; flipping the capture flag to `false` fails exactly those tests, which is
  the check that the coverage is real.
- Verified by simulating the real failure mode — clipboard write plus a synthesized
  Ctrl+V from an external process (`SendKeys`) into the CCC window — not only by
  pressing the key by hand, since hand-pressing does not reproduce the
  focus-loss condition that external tools create.
