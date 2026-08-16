import { describe, it, expect } from 'vitest'
import {
  isControlReportOnly,
  decideContextMenuAction,
  blindPasteNeedsMenu,
  isPasteChord,
  isCopyChord,
  shouldHandleTerminalPaste,
  isOrdinaryEditable,
} from '../../../src/renderer/utils/terminalInput'

describe('isControlReportOnly', () => {
  it('treats focus in/out reports as control-only (not input)', () => {
    expect(isControlReportOnly('\x1b[I')).toBe(true)
    expect(isControlReportOnly('\x1b[O')).toBe(true)
  })
  it('treats cursor-position reports as control-only', () => {
    expect(isControlReportOnly('\x1b[12;40R')).toBe(true)
  })
  it('treats SGR mouse reports as control-only', () => {
    expect(isControlReportOnly('\x1b[<0;10;20M')).toBe(true)
    expect(isControlReportOnly('\x1b[<0;10;20m')).toBe(true)
  })
  it('treats genuine typed characters as input', () => {
    expect(isControlReportOnly('a')).toBe(false)
    expect(isControlReportOnly('\r')).toBe(false)
    expect(isControlReportOnly('ls -la')).toBe(false)
  })
  it('treats a control report followed by typed input as input', () => {
    expect(isControlReportOnly('\x1b[Ohello')).toBe(false)
  })
  it('empty string is not input', () => {
    expect(isControlReportOnly('')).toBe(true)
  })
})

describe('decideContextMenuAction', () => {
  const decide = (over: Partial<Parameters<typeof decideContextMenuAction>[0]> = {}) =>
    decideContextMenuAction({ hasSelection: false, classicMode: true, mouseTracking: false, ...over })

  it('copies whenever text is selected — in every mode', () => {
    // A visible selection is an unambiguous copy request. With mouse tracking
    // on it can only exist via Shift+drag, which is just as deliberate.
    expect(decide({ hasSelection: true })).toBe('copy')
    expect(decide({ hasSelection: true, mouseTracking: true })).toBe('copy')
    expect(decide({ hasSelection: true, classicMode: false })).toBe('copy')
    expect(decide({ hasSelection: true, classicMode: false, mouseTracking: true })).toBe('copy')
  })

  it('classic + no tracking + no selection → paste (the PuTTY behaviour the setting promises)', () => {
    expect(decide()).toBe('paste')
  })

  it('NEVER blind-pastes while mouse tracking is on — shows the menu instead', () => {
    // THE defect this replaces: with a TUI tracking the mouse, xterm disables
    // its selection service, so "no selection" is guaranteed and the old rule
    // pasted the clipboard into the PTY on every right-click. A right-click at
    // a mouse-mode claude's login screen pasted (and at a shell prompt would
    // execute) the clipboard the user was trying to COPY into.
    expect(decide({ mouseTracking: true })).toBe('menu')
    expect(decide({ mouseTracking: true, classicMode: false })).toBe('menu')
  })

  it('non-classic + no selection → menu, never the old unconditional paste', () => {
    // The old "always paste" assumed CC's copy-on-select had already copied.
    // Nothing in CCC handles OSC 52, so that premise was false — the menu
    // gives an explicit Paste one click away instead.
    expect(decide({ classicMode: false })).toBe('menu')
  })
})

describe('blindPasteNeedsMenu', () => {
  it('routes multi-line clipboard through the menu when bracketed paste is off', () => {
    // term.paste() converts \n to \r: at a raw prompt each line SUBMITS. One
    // right-click would execute the clipboard — that needs an explicit click.
    expect(blindPasteNeedsMenu('rm -rf /tmp/x\n', false)).toBe(true)
    expect(blindPasteNeedsMenu('line1\nline2', false)).toBe(true)
    expect(blindPasteNeedsMenu('line1\rline2', false)).toBe(true)
  })

  it('lets single-line text paste directly (no newline ⇒ nothing can submit)', () => {
    expect(blindPasteNeedsMenu('https://example.com/very/long/url', false)).toBe(false)
    expect(blindPasteNeedsMenu('npm run typecheck', false)).toBe(false)
  })

  it('lets multi-line text through when bracketed paste is active', () => {
    // Bracketed paste wraps the payload in \x1b[200~..\x1b[201~ — newlines are
    // literal there, and multi-line pastes into CC's input are routine.
    expect(blindPasteNeedsMenu('line1\nline2\n', true)).toBe(false)
  })
})

// #145: Ctrl+V did nothing in terminals because CCC had no handler and the native
// path only pastes into the focused editable element (xterm's hidden textarea).
const chord = (over: Partial<Parameters<typeof isPasteChord>[0]> = {}) => ({
  key: 'v',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
})

describe('isPasteChord', () => {
  it('matches Ctrl+V and Cmd+V, in either letter case', () => {
    expect(isPasteChord(chord({ ctrlKey: true }))).toBe(true)
    expect(isPasteChord(chord({ metaKey: true }))).toBe(true)
    // Chromium reports 'V' when shift is held.
    expect(isPasteChord(chord({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('matches Shift+Insert, the other terminal paste convention', () => {
    expect(isPasteChord(chord({ key: 'Insert', shiftKey: true }))).toBe(true)
  })

  it('ignores Alt+V — that is CCC image paste, never text', () => {
    // Alt+V routes clipboard IMAGES through saveImage; treating it as text paste
    // would double-handle the shortcut.
    expect(isPasteChord(chord({ altKey: true }))).toBe(false)
    expect(isPasteChord(chord({ ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('matches an INJECTED Ctrl+V that carries no code field', () => {
    // Measured from a real Aqua Voice dictation (#145 diagnostics): synthesized
    // keystrokes arrive as `key="v" mods=ctrl` with NO `code`, because there is no
    // physical scan code behind them. Human presses carry code=KeyV. Matching on
    // `key` alone is therefore load-bearing — requiring `code` would silently
    // exclude every injected paste, which is the entire bug.
    expect(isPasteChord({ key: 'v', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true)
  })

  it('ignores a bare v, and other modified keys', () => {
    expect(isPasteChord(chord())).toBe(false)
    expect(isPasteChord(chord({ key: 'c', ctrlKey: true }))).toBe(false)
    expect(isPasteChord(chord({ key: 'Insert' }))).toBe(false)
  })
})

describe('isCopyChord', () => {
  it('matches Ctrl+Shift+C in either letter case', () => {
    // With shift held Chromium reports 'C'; with caps lock ALSO on it reports 'c'.
    // The old inline check compared `e.key === 'C'` exactly, so copy silently
    // stopped working under caps lock (#153).
    expect(isCopyChord(chord({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isCopyChord(chord({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('does NOT match plain Ctrl+C — that is SIGINT and belongs to the shell', () => {
    expect(isCopyChord(chord({ key: 'c', ctrlKey: true }))).toBe(false)
  })

  it('ignores alt and meta variants', () => {
    expect(isCopyChord(chord({ key: 'c', ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false)
    expect(isCopyChord(chord({ key: 'c', ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false)
  })

  it('does not collide with the paste chords', () => {
    const pasteV = chord({ key: 'v', ctrlKey: true, shiftKey: true })
    expect(isPasteChord(pasteV)).toBe(true)
    expect(isCopyChord(pasteV)).toBe(false)
  })
})

describe('isOrdinaryEditable', () => {
  const el = (tagName: string, over: Record<string, unknown> = {}) => ({
    tagName,
    isContentEditable: false,
    classList: { contains: () => false },
    ...over,
  })

  it('treats real inputs as ordinary editables', () => {
    expect(isOrdinaryEditable(el('INPUT'))).toBe(true)
    expect(isOrdinaryEditable(el('TEXTAREA'))).toBe(true)
    expect(isOrdinaryEditable(el('SELECT'))).toBe(true)
    expect(isOrdinaryEditable(el('DIV', { isContentEditable: true }))).toBe(true)
  })

  it("does NOT treat xterm's own helper textarea as ordinary", () => {
    // The whole point: that textarea IS the terminal, so a paste chord landing on
    // it must be handled by us, not deferred to the native path.
    const helper = el('TEXTAREA', { classList: { contains: (c: string) => c === 'xterm-helper-textarea' } })
    expect(isOrdinaryEditable(helper)).toBe(false)
  })

  it('treats plain elements and null as not editable', () => {
    expect(isOrdinaryEditable(el('DIV'))).toBe(false)
    expect(isOrdinaryEditable(el('BODY'))).toBe(false)
    expect(isOrdinaryEditable(null)).toBe(false)
  })
})

describe('shouldHandleTerminalPaste', () => {
  const opts = (over: Partial<Parameters<typeof shouldHandleTerminalPaste>[0]> = {}) => ({
    isActive: true,
    hasModalOpen: false,
    targetIsOrdinaryEditable: false,
    ...over,
  })

  it('handles the paste for the active terminal', () => {
    expect(shouldHandleTerminalPaste(opts())).toBe(true)
  })

  it('NEVER handles it for an inactive terminal', () => {
    // Every session's TerminalView stays mounted and the listener is on `document`,
    // so without this guard one Ctrl+V pastes into every open session at once.
    expect(shouldHandleTerminalPaste(opts({ isActive: false }))).toBe(false)
  })

  it('defers while a modal is open', () => {
    expect(shouldHandleTerminalPaste(opts({ hasModalOpen: true }))).toBe(false)
  })

  it('defers to the native paste when focus is in an ordinary input', () => {
    // CommandBar / settings / rename fields must keep working normally.
    expect(shouldHandleTerminalPaste(opts({ targetIsOrdinaryEditable: true }))).toBe(false)
  })

  it('stays false when several guards apply at once', () => {
    expect(shouldHandleTerminalPaste({ isActive: false, hasModalOpen: true, targetIsOrdinaryEditable: true })).toBe(false)
  })
})
