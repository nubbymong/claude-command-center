// @vitest-environment jsdom
/**
 * Ctrl+Alt+G (the #374 glyph-corruption diagnostic) must fire even while the
 * TERMINAL has focus — which is exactly where a user is when they see glyphs
 * go missing. xterm's own key handling stops keydown propagation at its
 * textarea, so the shortcut's original bubble-phase listener never heard the
 * chord in the one place it mattered (the beta.17 "Ctrl+Alt+G does nothing"
 * report). The handler now listens on the CAPTURE phase; this file simulates
 * xterm with a bubble-phase interceptor that stops propagation and proves the
 * capture listener still runs — and that the AltGr guard still holds.
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

  it('the AltGr guard holds: a real AltGraph chord passes through untouched', () => {
    const e = chord(true)
    act(() => { window.dispatchEvent(e) })
    expect(captureGlyphDiagnostic).not.toHaveBeenCalled()
    // Load-bearing now the listener runs BEFORE xterm: the event must reach
    // the terminal unprevented so AltGr text entry still types.
    expect(e.defaultPrevented).toBe(false)
  })
})
