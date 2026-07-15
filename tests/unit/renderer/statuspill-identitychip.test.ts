// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { StatusPill } = await import('../../../src/renderer/components/ui/StatusPill')
const { IdentityChip } = await import('../../../src/renderer/components/ui/IdentityChip')

describe('StatusPill', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('renders a label for running', () => {
    act(() => root.render(React.createElement(StatusPill, { state: 'running' })))
    expect(container.textContent).toContain('running')
  })
  it('renders "stopped" for error and "attention" for awaiting', () => {
    act(() => root.render(React.createElement(StatusPill, { state: 'error' })))
    expect(container.textContent).toContain('stopped')
    act(() => root.render(React.createElement(StatusPill, { state: 'awaiting' })))
    expect(container.textContent).toContain('attention')
  })
  it('renders nothing for idle (quiet)', () => {
    act(() => root.render(React.createElement(StatusPill, { state: 'idle' })))
    expect(container.textContent).toBe('')
  })
})

describe('IdentityChip', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('applies the colour and is not a CSS var', () => {
    act(() => root.render(React.createElement(IdentityChip, { color: '#9a8cf0' })))
    const el = container.querySelector('span') as HTMLElement
    expect(el.style.backgroundColor).toBe('rgb(154, 140, 240)')
    expect(el.getAttribute('style') || '').not.toContain('var(')
  })
})
