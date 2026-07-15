// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import ToggleSwitch from '../../../src/renderer/components/github/config/ToggleSwitch'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}

describe('ToggleSwitch', () => {
  it('renders a switch role with checked state', () => {
    const r = render(<ToggleSwitch state="on" onToggle={() => {}} label="CI" />)
    const sw = r.container.querySelector('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(sw.getAttribute('aria-label')).toBe('CI')
    r.unmount()
  })
  it('mixed state exposes aria-checked="mixed"', () => {
    const r = render(<ToggleSwitch state="mixed" onToggle={() => {}} label="x" />)
    expect(r.container.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('mixed')
    r.unmount()
  })
  it('click fires onToggle once', () => {
    const onToggle = vi.fn()
    const r = render(<ToggleSwitch state="off" onToggle={onToggle} label="x" />)
    act(() => {
      r.container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onToggle).toHaveBeenCalledTimes(1)
    r.unmount()
  })
  it('disabled blocks onToggle and sets the native disabled attribute', () => {
    const onToggle = vi.fn()
    const r = render(<ToggleSwitch state="off" onToggle={onToggle} label="x" disabled />)
    const btn = r.container.querySelector('button')!
    // jsdom's dispatchEvent bypasses native disabled-button click suppression,
    // so the dispatch below exercises the handler guard; the attribute
    // assertion covers the native path real browsers and keyboards rely on.
    expect(btn.hasAttribute('disabled')).toBe(true)
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onToggle).not.toHaveBeenCalled()
    r.unmount()
  })
  it('keeps a visible keyboard focus ring (codebase convention)', () => {
    const r = render(<ToggleSwitch state="on" onToggle={() => {}} label="x" />)
    expect(r.container.querySelector('button')!.className).toContain('focus-visible:ring-1')
    r.unmount()
  })
})
