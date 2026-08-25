// @vitest-environment jsdom
/**
 * Ctrl+Alt+G (the #374 glyph-corruption diagnostic) must fire even while the
 * TERMINAL has focus — which is exactly where a user is when they see glyphs
 * go missing. xterm's own key handling stops keydown propagation at its
 * textarea, so the shortcut's original bubble-phase listener never heard the
 * chord in the one place it mattered (the beta.17 "Ctrl+Alt+G does nothing"
* report). The handler now listens on the CAPTURE phase; this file simulates
 * xterm faithfully (a capture-phase interceptor on the textarea that cancels
 * the chord) and proves the window capture listener still runs — plus the
 * AltGr guard, and the yield to the Settings shortcut recorder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/onboarding/gate', () => ({ deriveOnboarding: () => ({ due: false, steps: [] }) }))
vi.mock('../../../src/renderer/utils/imageTransfer', () => ({ sendImageToSession: vi.fn() }))
const captureGlyphDiagnostic = vi.fn(async () => ({ ok: true }))
vi.mock('../../../src/renderer/utils/glyphDiagnostic', () => ({
  captureGlyphDiagnostic: (...args: unknown[]) => captureGlyphDiagnostic(...args),
}))
const requestResync = vi.fn(() => true)
vi.mock('../../../src/renderer/components/terminal/repaintRegistry', () => ({
  requestResync: (...args: unknown[]) => requestResync(...args),
}))

const { useKeyboardShortcuts } = await import('../../../src/renderer/hooks/useKeyboardShortcuts')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
const { DEFAULT_SHORTCUTS } = await import('../../../src/renderer/utils/shortcuts')

function Host() {
  useKeyboardShortcuts('s1', () => {}, () => {}, 'sessions', [], () => {})
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  captureGlyphDiagnostic.mockClear()
  requestResync.mockClear()
  useSessionStore.setState({ sessions: [], activeSessionId: 's1', renamingSessionId: null } as any)
  useSettingsStore.setState({ settings: { keyboardShortcuts: DEFAULT_SHORTCUTS } as any })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(<Host />) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** A keydown for Ctrl+Alt+G, optionally with AltGr really down. */
function chord(altGraph = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })
  Object.defineProperty(e, 'getModifierState', { value: (m: string) => (m === 'AltGraph' ? altGraph : false) })
  return e
}

describe('Ctrl+Alt+G glyph capture survives xterm (#374, beta.17 silence)', () => {
  it('fires even when xterm-style handling stops propagation at its textarea', () => {
    // Simulate xterm's textarea: its real listener is capture-phase on the
    // textarea and cancels handled chords (preventDefault + stopPropagation)
    // — the shape that silenced the shortcut for a focused terminal.
    const term = document.createElement('textarea')
    container.appendChild(term)
    term.addEventListener('keydown', (e) => { e.stopPropagation(); e.preventDefault() }, true)
    act(() => { term.dispatchEvent(chord()) })
    expect(captureGlyphDiagnostic).toHaveBeenCalledTimes(1)
    expect(captureGlyphDiagnostic).toHaveBeenCalledWith('s1')
  })

  it('still fires on a plain window keydown (no terminal focused)', () => {
    // Regression guard, not a phase discriminator: a window-dispatched event
    // reaches window listeners in either phase. Test 1 is the one that fails
    // on a bubble-only binding.
    act(() => { window.dispatchEvent(chord()) })
    expect(captureGlyphDiagnostic).toHaveBeenCalledTimes(1)
  })

  it('yields to the Settings shortcut recorder / Test box', () => {
    // Those boxes carry data-shortcut-capture and must WIN, or the chord can
    // never be re-recorded or tested — pressing it in the Test box would fire
    // a real capture (disk write + Explorer reveal) instead of matching.
    const box = document.createElement('div')
    box.setAttribute('data-shortcut-capture', '')
    container.appendChild(box)
    act(() => { box.dispatchEvent(chord()) })
    expect(captureGlyphDiagnostic).not.toHaveBeenCalled()
  })

  it('SettingsPage actually emits the attribute the yield keys on (both boxes)', () => {
    // The other half of the contract: the handler honours data-shortcut-capture
    // (test above), and the recorder + Test box must CARRY it — deleting the
    // attribute from SettingsPage silently resurrects the regression.
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components/SettingsPage.tsx'), 'utf8')
    const tagged = src.match(/data-shortcut-capture/g) ?? []
    expect(tagged.length).toBeGreaterThanOrEqual(2)
  })

  it('the AltGr guard holds: a real AltGraph chord passes through untouched', () => {
    const e = chord(true)
    act(() => { window.dispatchEvent(e) })
    expect(captureGlyphDiagnostic).not.toHaveBeenCalled()
    // Load-bearing now the listener runs BEFORE xterm: the event must reach
    // the terminal unprevented so AltGr text entry still types.
    expect(e.defaultPrevented).toBe(false)
  })
})

/** A keydown for Ctrl+Alt+R (#503), with the same knobs plus key-repeat. */
function chordR(opts: { altGraph?: boolean; repeat?: boolean } = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'r', ctrlKey: true, altKey: true, repeat: opts.repeat ?? false, bubbles: true, cancelable: true,
  })
  Object.defineProperty(e, 'getModifierState', { value: (m: string) => (m === 'AltGraph' ? (opts.altGraph ?? false) : false) })
  return e
}

describe('Ctrl+Alt+R repaint + re-sync (#503)', () => {
  it('fires even when xterm-style handling stops propagation at its textarea', () => {
    const term = document.createElement('textarea')
    container.appendChild(term)
    term.addEventListener('keydown', (e) => { e.stopPropagation(); e.preventDefault() }, true)
    act(() => { term.dispatchEvent(chordR()) })
    expect(requestResync).toHaveBeenCalledTimes(1)
  })

  it('repairs the terminal the chord was pressed IN, resolved by DOM ancestry', () => {
    // The partner shell registers under `${id}-partner` and stays mounted while
    // hidden — the active session id alone would nudge the hidden main pty.
    const pane = document.createElement('div')
    pane.setAttribute('data-terminal-session', 's1-partner')
    const term = document.createElement('textarea')
    pane.appendChild(term)
    container.appendChild(pane)
    act(() => { term.dispatchEvent(chordR()) })
    expect(requestResync).toHaveBeenCalledWith('s1-partner')
  })

  it('falls back to the active session when focus is outside any terminal', () => {
    act(() => { window.dispatchEvent(chordR()) })
    expect(requestResync).toHaveBeenCalledWith('s1')
  })

  it('ignores key-repeat — a held chord must not storm the pty with resizes', () => {
    act(() => { window.dispatchEvent(chordR({ repeat: true })) })
    expect(requestResync).not.toHaveBeenCalled()
  })

  it('the AltGr guard holds here too', () => {
    const e = chordR({ altGraph: true })
    act(() => { window.dispatchEvent(e) })
    expect(requestResync).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('yields to the Settings shortcut recorder / Test box', () => {
    const box = document.createElement('div')
    box.setAttribute('data-shortcut-capture', '')
    container.appendChild(box)
    act(() => { box.dispatchEvent(chordR()) })
    expect(requestResync).not.toHaveBeenCalled()
  })

  it('still fires for a user whose persisted shortcut map predates the chord', () => {
    // The hydration shape that killed new chords: a saved keyboardShortcuts
    // object from an older release has no repaintTerminal key, and a plain
    // `|| DEFAULT_SHORTCUTS` substitution never fires because the object
    // EXISTS. The handler must merge over the defaults instead.
    useSettingsStore.setState({ settings: { keyboardShortcuts: { closeSession: 'Ctrl+W' } } as any })
    act(() => { window.dispatchEvent(chordR()) })
    expect(requestResync).toHaveBeenCalledTimes(1)
  })
})
