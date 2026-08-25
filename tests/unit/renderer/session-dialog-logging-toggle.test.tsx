// @vitest-environment jsdom
/**
 * T16: SessionDialog "Index conversation logs" toggle.
 *
 * Tests:
 *  1. Toggle defaults ON (loggingEnabled undefined → checkbox checked).
 *  2. Toggle defaults ON when loggingEnabled: true.
 *  3. Toggling OFF persists loggingEnabled: false in claudeOptions on submit.
 *  4. Toggle is absent for shell-only sessions (loggingEnabled irrelevant).
 *  5. Spawn options carry the loggingEnabled value.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) =>
    sel({
      groups: [],
      addGroup: vi.fn(),
      sections: [],
      addSection: vi.fn(),
    }),
}))

if (typeof window !== 'undefined') {
  ;(window as any).electronAPI = {
    debug: { isEnabled: vi.fn().mockResolvedValue(false) },
    legacyVersion: {
      fetchVersions: vi.fn().mockResolvedValue([]),
      isInstalled: vi.fn().mockResolvedValue(false),
      install: vi.fn().mockResolvedValue({ ok: true }),
      onInstallProgress: vi.fn().mockReturnValue(() => {}),
    },
    dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  }
  ;(window as any).electronPlatform = 'win32'
}

import SessionDialog from '../../../src/renderer/components/SessionDialog'

function findCheckboxByLabel(container: HTMLElement, labelText: string): HTMLInputElement | null {
  const labels = container.querySelectorAll('label')
  for (const label of Array.from(labels)) {
    if (label.textContent?.includes(labelText)) {
      const cb = label.querySelector('input[type="checkbox"]')
      if (cb) return cb as HTMLInputElement
    }
  }
  // Also try aria / standalone checkbox with nearby text
  const inputs = container.querySelectorAll('input[type="checkbox"]')
  for (const input of Array.from(inputs)) {
    const parent = input.closest('label') ?? input.parentElement
    if (parent?.textContent?.includes(labelText)) return input as HTMLInputElement
  }
  return null
}

describe('SessionDialog indexing toggle', () => {
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

  it('renders the "Index conversation logs" toggle for Claude provider', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { provider: 'claude' },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    expect(container.textContent).toContain('Index conversation logs')
  })

  it('toggle defaults ON when loggingEnabled is undefined', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { provider: 'claude', claudeOptions: {} },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    const cb = findCheckboxByLabel(container, 'Index conversation logs')
    expect(cb).not.toBeNull()
    expect(cb?.checked).toBe(true)
  })

  it('toggle defaults ON when loggingEnabled is true', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: {
            provider: 'claude',
            claudeOptions: { loggingEnabled: true },
          },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    const cb = findCheckboxByLabel(container, 'Index conversation logs')
    expect(cb?.checked).toBe(true)
  })

  it('toggle reflects OFF when loggingEnabled is false', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: {
            provider: 'claude',
            claudeOptions: { loggingEnabled: false },
          },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    const cb = findCheckboxByLabel(container, 'Index conversation logs')
    expect(cb?.checked).toBe(false)
  })

  it('toggling OFF passes loggingEnabled: false in claudeOptions on submit', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          // workingDirectory required since the validation slot landed — an
          // empty directory blocks submit (the '.' fallback is gone).
          initial: { provider: 'claude', label: 'test', workingDirectory: 'C:\\proj' },
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })

    // Turn off the toggle
    const cb = findCheckboxByLabel(container, 'Index conversation logs')
    expect(cb).not.toBeNull()
    act(() => {
      cb!.click()
    })

    // Submit the form
    const form = container.querySelector('form')
    expect(form).not.toBeNull()
    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    expect(config.claudeOptions?.loggingEnabled).toBe(false)
  })

  it('toggling ON (default) does not write explicit true (default-on convention)', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { provider: 'claude', label: 'test', workingDirectory: 'C:\\proj' },
          onConfirm,
          onCancel: vi.fn(),
        }),
      )
    })

    // Submit without changing anything (toggle is already ON by default)
    const form = container.querySelector('form')
    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    // Default-on: when the user hasn't explicitly turned off, loggingEnabled is
    // either undefined or true; it must NOT be false.
    expect(config.claudeOptions?.loggingEnabled).not.toBe(false)
  })

  it('toggle is absent for shell-only sessions', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: { provider: 'claude', shellOnly: true },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    const cb = findCheckboxByLabel(container, 'Index conversation logs')
    expect(cb).toBeNull()
  })

  it('toggle is absent for Codex sessions', () => {
    act(() => {
      root.render(
        React.createElement(SessionDialog, {
          initial: {
            provider: 'codex',
            codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
          },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      )
    })
    const cb = findCheckboxByLabel(container, 'Index conversation logs')
    expect(cb).toBeNull()
  })
})

describe('SessionDialog edit-while-running note (relaunch revision 2026-08-24)', () => {
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

  const initial: any = { id: 'c1', label: 'App Dev', workingDirectory: '/x', color: '', sessionType: 'local', provider: 'claude' }

  it('shows when the edited config has live sessions, naming BOTH restart hazards', () => {
    act(() => {
      root.render(React.createElement(SessionDialog, { onConfirm: () => {}, onCancel: () => {}, initial, liveSessionCount: 2 } as any))
    })
    const note = container.querySelector('[data-testid="edit-while-running-note"]')!
    expect(note).toBeTruthy()
    expect(note.textContent).toContain('2 sessions')
    expect(note.textContent).toMatch(/from now on/)
    expect(note.textContent).toMatch(/SSH session .* will be refused/)
    // The silent half of the hazard must be named too (review follow-up B).
    expect(note.textContent).toMatch(/without its secret argument/)
  })

  it('absent with no live sessions, and absent on the create dialog regardless', () => {
    act(() => {
      root.render(React.createElement(SessionDialog, { onConfirm: () => {}, onCancel: () => {}, initial, liveSessionCount: 0 } as any))
    })
    expect(container.querySelector('[data-testid="edit-while-running-note"]')).toBeNull()
    act(() => {
      root.render(React.createElement(SessionDialog, { onConfirm: () => {}, onCancel: () => {}, liveSessionCount: 3 } as any))
    })
    expect(container.querySelector('[data-testid="edit-while-running-note"]')).toBeNull()
  })
})
