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

// The effort control is native radios styled as chips: each option is a
// <label> wrapping <input type="radio">. Return the input so .click() drives it.
function effortChip(container: HTMLElement, label: string): HTMLInputElement | null {
  const group = container.querySelector('[role="radiogroup"][aria-label="Starting effort"]')
  if (!group) return null
  for (const lab of Array.from(group.querySelectorAll('label'))) {
    if (lab.textContent?.trim() === label) return lab.querySelector('input[type="radio"]') as HTMLInputElement
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
    expect(effortChip(container, 'Default')!.checked).toBe(true)
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
    const chips = Array.from(group!.querySelectorAll('input[type="radio"]'))
    expect(chips.length).toBeGreaterThan(1)
    act(() => { (chips[1] as HTMLInputElement).click() })
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

  it('provider, transport and effort are native radios grouped by name (a11y — #188 Copilot)', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: CLAUDE_LOCAL,
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    // Native <input type="radio"> get the ARIA radiogroup keyboard pattern
    // (roving tabindex, arrow-key nav, skip-disabled) from the browser — the
    // hand-rolled role="radio" buttons did not.
    const named = (n: string) => container.querySelectorAll(`input[type="radio"][name="${n}"]`).length
    expect(named('ccc-provider')).toBe(3)   // Claude Code / Codex / Terminal only
    expect(named('ccc-transport')).toBe(2)  // Local / SSH
    expect(named('ccc-effort')).toBeGreaterThan(1)  // Default + registry levels
    // No leftover fake-radio buttons claiming radio semantics.
    expect(container.querySelectorAll('button[role="radio"]').length).toBe(0)
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

// The model <select> is controlled; set .value through the native setter so
// React's value-tracker sees the change and the 'change' event drives onChange
// (the standard controlled-input testing idiom).
function selectModel(container: HTMLElement, value: string) {
  const sel = Array.from(container.querySelectorAll('select')).find((s) =>
    Array.from(s.options).some((o) => o.value === value),
  )
  expect(sel, `no <select> offers model ${value}`).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    setter.call(sel, value)
    sel!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

// #385 Finding #1: effortLevel was not reset when the model changed, so a chip
// greyed out by the new model still submitted its value (--effort xhigh --model
// claude-opus-4-6). These pin that switching to a model that disallows the
// current effort clears it, and that the disallowed value can never reach
// onConfirm. claude-opus-4-6's registry effort list is ["low","medium","high",
// "max"] — it disallows "xhigh" and "ultracode".
describe('SessionDialog effort resets when the model stops supporting it', () => {
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

  it('switching to a model that disallows the current effort clears the chip', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: CLAUDE_LOCAL,
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    // Default model ('') supports every level, so "Extra high" (xhigh) is live.
    const xhigh = effortChip(container, 'Extra high')
    expect(xhigh).not.toBeNull()
    expect(xhigh!.disabled).toBe(false)
    act(() => { xhigh!.click() })
    expect(effortChip(container, 'Extra high')!.checked).toBe(true)

    // Switch to a model that does not offer xhigh.
    selectModel(container, 'claude-opus-4-6')

    // The chip is now disabled AND deselected; Default is selected instead.
    expect(effortChip(container, 'Extra high')!.disabled).toBe(true)
    expect(effortChip(container, 'Extra high')!.checked).toBe(false)
    expect(effortChip(container, 'Default')!.checked).toBe(true)
  })

  it('onConfirm cannot submit an --effort the newly-picked model disallows', () => {
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
    act(() => { effortChip(container, 'Extra high')!.click() })
    selectModel(container, 'claude-opus-4-6')
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.model).toBe('claude-opus-4-6')
    // The unsupported effort was cleared, so no --effort xhigh rides along.
    expect(config.claudeOptions?.effortLevel).toBeUndefined()
  })

  // ADR-009 MINOR on #404. handleModelChange only fires when the user TOUCHES
  // the model select, so a config saved before claude-opus-4-6 dropped "xhigh"
  // reopened with that chip still selected and re-submitted --effort xhigh on
  // Save without the model ever being touched. Clamped on load AND on submit.
  it('a saved effort the saved model no longer supports is clamped on LOAD', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { ...CLAUDE_LOCAL, claudeOptions: { model: 'claude-opus-4-6', effortLevel: 'xhigh' } },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    expect(effortChip(container, 'Extra high')!.disabled).toBe(true)
    expect(effortChip(container, 'Extra high')!.checked).toBe(false)
    expect(effortChip(container, 'Default')!.checked).toBe(true)
  })

  it('and cannot be re-submitted by a Save that touches nothing', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { ...CLAUDE_LOCAL, claudeOptions: { model: 'claude-opus-4-6', effortLevel: 'xhigh' } },
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.model).toBe('claude-opus-4-6')
    expect(config.claudeOptions?.effortLevel).toBeUndefined()
  })

  it('a saved effort the saved model DOES support is left alone', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { ...CLAUDE_LOCAL, claudeOptions: { model: 'claude-opus-4-6', effortLevel: 'high' } },
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })
    expect(effortChip(container, 'High')!.checked).toBe(true)
    submit(container)
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.effortLevel).toBe('high')
  })

  it('a still-supported effort survives a model switch (no over-reset)', () => {
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
    // "High" is supported by claude-opus-4-6, so switching must keep it.
    act(() => { effortChip(container, 'High')!.click() })
    selectModel(container, 'claude-opus-4-6')
    expect(effortChip(container, 'High')!.checked).toBe(true)
    submit(container)
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.effortLevel).toBe('high')
  })
})
