// @vitest-environment jsdom
/**
 * 2.1.0-beta.5: "Starting effort" control. Before this, per-config effort was
 * plumbed end-to-end (--effort at spawn) but UNREACHABLE: the dialog had no
 * control and its save path rebuilt claudeOptions without an effortLevel key,
 * wiping any stored value on every edit. These tests pin both halves:
 *   1. Picking an effort persists claudeOptions.effortLevel on submit.
 *   2. An edit that doesn't touch effort keeps the stored value (no wipe).
 *   3. "Default" persists as undefined (no --effort flag at spawn).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({
    groups: [],
    addGroup: vi.fn(),
    sections: [],
    addSection: vi.fn(),
  }),
}))

if (typeof window !== 'undefined') {
  ;(window as any).electronAPI = {
    debug: { isEnabled: vi.fn().mockResolvedValue(false) },
    dialog: { openFolder: vi.fn().mockResolvedValue(null) },
    credentials: { save: vi.fn(), delete: vi.fn() },
  }
  ;(window as any).electronPlatform = 'win32'
}

import SessionDialog from '../../../src/renderer/components/SessionDialog'

const CLAUDE_LOCAL = { provider: 'claude' as const, label: 'test', workingDirectory: 'C:\\proj' }

function submit(container: HTMLElement) {
  const form = container.querySelector('form')
  expect(form).not.toBeNull()
  act(() => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function effortChip(container: HTMLElement, label: string): HTMLButtonElement | null {
  const group = container.querySelector('[role="radiogroup"][aria-label="Starting effort"]')
  if (!group) return null
  for (const btn of Array.from(group.querySelectorAll('button'))) {
    if (btn.textContent?.trim() === label) return btn as HTMLButtonElement
  }
  return null
}

describe('SessionDialog starting effort', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders the effort control with a Default chip for Claude configs', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: CLAUDE_LOCAL,
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    expect(container.textContent).toContain('Starting effort')
    expect(effortChip(container, 'Default')).not.toBeNull()
  })

  it('picking an effort persists claudeOptions.effortLevel on submit', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: CLAUDE_LOCAL,
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })
    const group = container.querySelector('[role="radiogroup"][aria-label="Starting effort"]')
    expect(group).not.toBeNull()
    // First registry chip after "Default" — value comes from the live registry,
    // so the test doesn't hardcode a level name.
    const chips = Array.from(group!.querySelectorAll('button'))
    expect(chips.length).toBeGreaterThan(1)
    act(() => { (chips[1] as HTMLButtonElement).click() })
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    expect(typeof config.claudeOptions?.effortLevel).toBe('string')
    expect(config.claudeOptions?.effortLevel!.length).toBeGreaterThan(0)
  })

  it('an untouched edit keeps the stored effortLevel (regression: the wipe bug)', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { ...CLAUDE_LOCAL, claudeOptions: { effortLevel: 'xhigh' } },
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.effortLevel).toBe('xhigh')
  })

  it('Default persists as undefined so the spawn emits no --effort flag', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { ...CLAUDE_LOCAL, claudeOptions: { effortLevel: 'max' } },
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })
    const def = effortChip(container, 'Default')
    expect(def).not.toBeNull()
    act(() => { def!.click() })
    submit(container)
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.effortLevel).toBeUndefined()
  })

  it('an untouched edit keeps a stored "Default" model as Default (no silent opus upgrade)', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { ...CLAUDE_LOCAL, claudeOptions: {} },
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })
    submit(container)
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.model).toBeUndefined()
  })
})
