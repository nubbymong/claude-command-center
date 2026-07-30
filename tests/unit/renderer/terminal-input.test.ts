import { describe, it, expect } from 'vitest'
import {
  isControlReportOnly,
  decideContextMenuAction,
  isPasteChord,
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
  describe('classic mode (classicTerminalCopyPaste: true)', () => {
    it('returns copy when text is selected', () => {
      expect(decideContextMenuAction(true, true)).toBe('copy')
    })
    it('returns paste when nothing is selected', () => {
      expect(decideContextMenuAction(false, true)).toBe('paste')
    })
  })

  describe('non-classic mode (CC mouse on / copy-on-select active)', () => {
    // CC already copies on mouse-up; right-click must always paste regardless
    // of selection state so it never overwrites the intended paste target.
    it('returns paste when nothing is selected', () => {
      expect(decideContextMenuAction(false, false)).toBe('paste')
    })
    it('returns paste even when text is selected', () => {
      expect(decideContextMenuAction(true, false)).toBe('paste')
    })
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
