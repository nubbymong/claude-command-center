// @vitest-environment jsdom
/**
 * The one predicate the bar's backdrops use to tell "dismiss" from "this is a
 * context-menu gesture": the right button everywhere, and Ctrl+left on macOS
 * (Blink delivers that mousedown as button 0 + ctrlKey and opens the context
 * menu after it -- a backdrop that closed on that mousedown would let the
 * contextmenu fall through to the terminal, which pastes).
 */
import { describe, it, expect } from 'vitest'
import { isContextMenuGesture } from '../../../src/renderer/lib/pointer'

describe('isContextMenuGesture', () => {
  it('the right button is a context-menu gesture on every platform', () => {
    for (const p of ['win32', 'darwin', 'linux', undefined]) expect(isContextMenuGesture({ button: 2, ctrlKey: false }, p), String(p)).toBe(true)
  })
  it('Ctrl + left button is a context-menu gesture ONLY on macOS', () => {
    expect(isContextMenuGesture({ button: 0, ctrlKey: true }, 'darwin')).toBe(true)
    expect(isContextMenuGesture({ button: 0, ctrlKey: true }, 'win32')).toBe(false)
    expect(isContextMenuGesture({ button: 0, ctrlKey: true }, 'linux')).toBe(false)
    expect(isContextMenuGesture({ button: 0, ctrlKey: true }, undefined)).toBe(false)
  })
  it('a plain left or middle button is a dismiss everywhere', () => {
    for (const p of ['win32', 'darwin', 'linux']) {
      expect(isContextMenuGesture({ button: 0, ctrlKey: false }, p)).toBe(false)
      expect(isContextMenuGesture({ button: 1, ctrlKey: false }, p)).toBe(false)
      expect(isContextMenuGesture({ button: 1, ctrlKey: true }, p)).toBe(false)
    }
  })
  it('reads window.electronPlatform when no platform is passed', () => {
    const w = window as unknown as { electronPlatform?: string }
    const before = w.electronPlatform
    try {
      w.electronPlatform = 'darwin'
      expect(isContextMenuGesture({ button: 0, ctrlKey: true })).toBe(true)
      w.electronPlatform = 'win32'
      expect(isContextMenuGesture({ button: 0, ctrlKey: true })).toBe(false)
    } finally { w.electronPlatform = before }
  })
})
