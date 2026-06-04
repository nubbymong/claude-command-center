// @vitest-environment jsdom
/**
 * LoggingConsentPrompt unit tests.
 *
 * Verifies:
 *   - The prompt renders when loggingConsentSeen is falsy.
 *   - The prompt does NOT render when loggingConsentSeen is true.
 *   - Clicking "Turn off" calls updateSettings with { loggingEnabled: false, loggingConsentSeen: true }.
 *   - Clicking "Keep on" calls updateSettings with { loggingConsentSeen: true } and does NOT set loggingEnabled false.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'
import type { AppSettings } from '../../../src/renderer/stores/settingsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Minimal electronAPI mock so the settings store can persist.
const configSaveMock = vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue(undefined)
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  config: {
    save: configSaveMock,
  },
}

// ---------------------------------------------------------------------------
// renderComponent helper (same pattern as accounts-panel.test.tsx)
function renderComponent(ui: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

// ---------------------------------------------------------------------------
// Import component AFTER mocks.
const { default: LoggingConsentPrompt } = await import('../../../src/renderer/components/LoggingConsentPrompt')

// ---------------------------------------------------------------------------
// Helpers

const baseSettings: Partial<AppSettings> = {
  loggingEnabled: true,
  loggingConsentSeen: false,
}

function seedSettings(overrides: Partial<AppSettings> = {}) {
  useSettingsStore.setState((s) => ({
    ...s,
    settings: { ...s.settings, ...baseSettings, ...overrides },
    isLoaded: true,
  }))
}

// ---------------------------------------------------------------------------
// Tests

describe('LoggingConsentPrompt', () => {
  let unmount: (() => void) | undefined

  beforeEach(() => {
    configSaveMock.mockClear()
  })

  afterEach(() => {
    unmount?.()
    unmount = undefined
    vi.clearAllMocks()
  })

  it('renders the prompt when loggingConsentSeen is falsy', () => {
    seedSettings({ loggingConsentSeen: false })
    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u
    expect(container.textContent).toContain('Session logging is on')
    expect(container.querySelector('button')).toBeTruthy()
  })

  it('renders the prompt when loggingConsentSeen is undefined', () => {
    seedSettings({ loggingConsentSeen: undefined })
    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u
    expect(container.textContent).toContain('Session logging is on')
  })

  it('does NOT render the prompt when loggingConsentSeen is true', () => {
    seedSettings({ loggingConsentSeen: true })
    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u
    // Nothing visible -- the component returns null immediately
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('clicking "Turn off" calls updateSettings with { loggingEnabled: false, loggingConsentSeen: true }', async () => {
    seedSettings({ loggingConsentSeen: false })
    // Intercept the updateSettings action on the store directly.
    const updateSpy = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState((s) => ({ ...s, updateSettings: updateSpy }))

    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u

    const turnOffBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Turn off'
    ) as HTMLButtonElement
    expect(turnOffBtn).toBeTruthy()

    await act(async () => { turnOffBtn.click() })
    // The component delays updateSettings by CLOSE_ANIM_MS (200ms) for the exit animation.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250))
    })

    expect(updateSpy).toHaveBeenCalledOnce()
    const callArg = updateSpy.mock.calls[0][0]
    expect(callArg).toMatchObject({ loggingEnabled: false, loggingConsentSeen: true })
  })

  it('clicking "Keep on" calls updateSettings with { loggingConsentSeen: true } and does NOT set loggingEnabled false', async () => {
    seedSettings({ loggingConsentSeen: false })
    const updateSpy = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState((s) => ({ ...s, updateSettings: updateSpy }))

    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u

    const keepOnBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Keep on'
    ) as HTMLButtonElement
    expect(keepOnBtn).toBeTruthy()

    await act(async () => { keepOnBtn.click() })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250))
    })

    expect(updateSpy).toHaveBeenCalledOnce()
    const callArg = updateSpy.mock.calls[0][0]
    expect(callArg).toMatchObject({ loggingConsentSeen: true })
    // Must NOT explicitly disable logging
    expect((callArg as Record<string, unknown>).loggingEnabled).not.toBe(false)
  })
})
