// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { theme: 'dark' as const } }
  const useSettingsStore: any = (sel: (s: typeof STATE) => unknown) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')

const base = {
  id: 's1', label: 'web-frontend', model: 'sonnet', identityColorKey: 'mauve' as const,
  color: '', status: 'working' as const, createdAt: 0, provider: 'claude' as const,
  sessionType: 'local' as const, contextPercent: 40,
}
const props = {
  isActive: false, needsAttention: false, isRenaming: false, renameValue: '',
  renameRef: { current: null }, onRenameChange: () => {}, onRenameFinish: () => {},
  onRenameCancel: () => {}, onClick: () => {}, onContextMenu: () => {},
}

function render(root: Root, sessionOverrides: any, propOverrides: any = {}) {
  act(() => root.render(React.createElement(SessionRow, { ...(props as any), ...propOverrides, session: { ...base, ...sessionOverrides } })))
}

describe('SessionRow card', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('does NOT render a Claude provider badge for the default (claude) provider', () => {
    render(root, { provider: 'claude' })
    expect(container.querySelector('[title="Claude is working"]')).toBeNull()
    expect(container.querySelector('[title="Waiting for input"]')).toBeNull()
  })

  it('renders a Codex glyph for codex provider (non-default)', () => {
    render(root, { provider: 'codex' })
    expect(container.querySelector('[title="Codex is working"]')).toBeTruthy()
  })

  it('shows an identity chip only when selected (isActive)', () => {
    render(root, {}, { isActive: false })
    const before = container.querySelectorAll('[data-testid="identity-chip"]').length
    render(root, {}, { isActive: true })
    const after = container.querySelectorAll('[data-testid="identity-chip"]').length
    expect(before).toBe(0)
    expect(after).toBe(1)
  })

  it('applies the quiet dashed focus ring class when focused', () => {
    render(root, {}, { isFocused: true })
    expect(container.querySelector('.card-focus')).toBeTruthy()
  })

  it('selected card uses the identity colour for its 4px left rail (not teal var)', () => {
    render(root, {}, { isActive: true })
    const card = container.querySelector('.session-card') as HTMLElement
    expect(card.style.borderLeftWidth).toBe('4px')
    expect(card.getAttribute('style') || '').toContain('rgb(')
  })

  it('context meter turns danger above 85%', () => {
    render(root, { contextPercent: 90 })
    expect(container.querySelector('.meter-danger')).toBeTruthy()
    render(root, { contextPercent: 50 })
    expect(container.querySelector('.meter-neutral')).toBeTruthy()
  })

  it('rename input is NOT nested inside a <button> (a11y #398)', () => {
    render(root, {}, { isRenaming: true, renameValue: 'x' })
    const input = container.querySelector('input') as HTMLElement
    expect(input).toBeTruthy()
    expect(input.closest('button')).toBeNull()
  })
})
