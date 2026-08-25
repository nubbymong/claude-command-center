// @vitest-environment jsdom
//
// TerminalContextMenu — the explicit Copy/Paste menu that replaces blind
// right-click paste wherever a blind decision would be unsafe (mouse-tracking
// TUIs, non-classic mode, multi-line clipboard at a raw prompt). The menu's
// entire contract is "nothing reaches the PTY without an explicit click", so
// the tests pin exactly that: disabled Copy cannot fire, Paste fires only on
// its own click, and every dismiss path closes without invoking an action.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import TerminalContextMenu from '../../../src/renderer/components/TerminalContextMenu'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}

const noop = () => {}

function renderMenu(over: Partial<React.ComponentProps<typeof TerminalContextMenu>> = {}) {
  const props = {
    x: 100,
    y: 100,
    hasSelection: false,
    onCopy: noop,
    onPaste: noop,
    onRepaint: noop,
    onClose: noop,
    ...over,
  }
  return render(<TerminalContextMenu {...props} />)
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  )
  if (!btn) throw new Error(`no ${text} button`)
  return btn
}

describe('TerminalContextMenu', () => {
  it('disables Copy and explains how to select when there is no selection', () => {
    const onCopy = vi.fn()
    const r = renderMenu({ hasSelection: false, onCopy })
    const copy = buttonByText(r.container, 'Copy')
    expect(copy.disabled).toBe(true)
    // The hint is the working-copy teaching path for mouse-tracking apps.
    expect(r.container.textContent).toContain('hold Shift')
    act(() => { copy.click() })
    expect(onCopy).not.toHaveBeenCalled()
    r.unmount()
  })

  it('enables Copy when a selection exists and fires onCopy on click', () => {
    const onCopy = vi.fn()
    const r = renderMenu({ hasSelection: true, onCopy })
    const copy = buttonByText(r.container, 'Copy')
    expect(copy.disabled).toBe(false)
    expect(r.container.textContent).not.toContain('hold Shift')
    act(() => { copy.click() })
    expect(onCopy).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('fires onPaste only from an explicit Paste click', () => {
    const onPaste = vi.fn()
    const r = renderMenu({ onPaste })
    expect(onPaste).not.toHaveBeenCalled() // rendering the menu never pastes
    act(() => { buttonByText(r.container, 'Paste').click() })
    expect(onPaste).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('fires onRepaint from the Repaint row, and only from it (#503)', () => {
    const onRepaint = vi.fn()
    const onCopy = vi.fn()
    const onPaste = vi.fn()
    const r = renderMenu({ hasSelection: true, onRepaint, onCopy, onPaste })
    const row = r.container.querySelector('[data-testid="terminal-ctx-repaint"]') as HTMLButtonElement
    expect(row).toBeTruthy()
    // Always enabled — the rescue must be reachable exactly when the pane is a mess.
    expect(row.disabled).toBe(false)
    act(() => { row.click() })
    expect(onRepaint).toHaveBeenCalledTimes(1)
    expect(onCopy).not.toHaveBeenCalled()
    expect(onPaste).not.toHaveBeenCalled()
    r.unmount()
  })

  it('closes on backdrop mousedown but NOT on mousedown inside the menu', () => {
    const onClose = vi.fn()
    const r = renderMenu({ onClose })
    const backdrop = r.container.querySelector('.fixed.inset-0') as HTMLElement
    const paste = buttonByText(r.container, 'Paste')
    act(() => { paste.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    const r = renderMenu({ onClose })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('closes on a further right-click outside instead of stacking menus', () => {
    const onClose = vi.fn()
    const r = renderMenu({ onClose })
    const backdrop = r.container.querySelector('.fixed.inset-0') as HTMLElement
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    r.unmount()
  })
})
