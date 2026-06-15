// @vitest-environment jsdom
/**
 * Logs disabled-states regression tests.
 *
 * Verifies:
 *   - When loggingEnabled is false, SidebarNav keeps the Logs entry visible
 *     but non-interactive (onClick undefined / aria-disabled) with the tooltip
 *     "Enable session logging in Settings".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'

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
// Import component AFTER mocks.
import SidebarNav from '../../../src/renderer/components/sidebar/SidebarNav'

// ---------------------------------------------------------------------------
// Render helper

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
// Tests

describe('Logs disabled states — SidebarNav', () => {
  let unmount: (() => void) | undefined

  beforeEach(() => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, loggingEnabled: false },
    }))
  })

  afterEach(() => {
    unmount?.()
    unmount = undefined
    vi.clearAllMocks()
    // Restore loggingEnabled for other tests in the suite.
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, loggingEnabled: true },
    }))
  })

  it('SidebarNav keeps the Logs entry VISIBLE but non-interactive with the enable tooltip', async () => {
    const onViewChange = vi.fn()
    const { container, unmount: u } = renderComponent(
      <SidebarNav
        currentView="sessions"
        onViewChange={onViewChange}
        insightsStatus={null}
        insightsMessage={null}
        cloudAgentRunning={0}
      />
    )
    unmount = u

    // The Logs button carries an `aria-label` set to the tooltip text when
    // logging is disabled (the slow native `title` was removed; the accessible
    // name now comes from aria-label only).
    const TOOLTIP = 'Enable session logging in Settings'

    const logsBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.getAttribute('aria-label') === TOOLTIP ||
      b.getAttribute('title') === TOOLTIP
    ) as HTMLButtonElement | undefined

    expect(logsBtn).toBeTruthy() // visible in the DOM

    // aria-disabled must be set
    expect(logsBtn!.getAttribute('aria-disabled')).toBe('true')

    // Clicking must NOT invoke onViewChange with 'logs' (onClick is undefined
    // when disabled — the browser fires the event but no handler runs).
    await act(async () => { logsBtn!.click() })
    expect(onViewChange).not.toHaveBeenCalledWith('logs')
  })
})
