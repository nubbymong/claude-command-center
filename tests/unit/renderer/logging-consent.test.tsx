// @vitest-environment jsdom
/**
 * LoggingConsentPrompt unit tests.
 *
 * Verifies:
 *   - The prompt renders when loggingConsentSeen is falsy.
 *   - The prompt does NOT render when loggingConsentSeen is true.
 *   - Clicking "Skip indexing" calls updateSettings with { loggingEnabled: false, loggingConsentSeen: true }.
 *   - Clicking "Keep indexing" calls updateSettings with { loggingConsentSeen: true } and does NOT set loggingEnabled false.
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
const { loggingConsentDue, LOGGING_CONSENT_VERSION } = await import('../../../src/renderer/utils/logging-consent')
import appSource from '../../../src/renderer/App.tsx?raw'
import transparencySource from '../../../src/renderer/onboarding/TransparencyStep.tsx?raw'

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
    expect(container.textContent).toContain('Conversation indexing is on')
    expect(container.querySelector('button')).toBeTruthy()
    // P3.12: what is indexed, and where each assistant keeps it either way.
    expect(container.textContent).toContain("Claude Code's and Codex's own conversation transcripts")
    expect(container.textContent).toContain('sessions folder')
  })

  it('renders the prompt when loggingConsentSeen is undefined', () => {
    seedSettings({ loggingConsentSeen: undefined })
    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u
    expect(container.textContent).toContain('Conversation indexing is on')
  })

  it('does NOT render the prompt when loggingConsentSeen is true', () => {
    seedSettings({ loggingConsentSeen: true })
    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u
    // Nothing visible -- the component returns null immediately
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('clicking "Skip indexing" calls updateSettings with { loggingEnabled: false, loggingConsentSeen: true }', async () => {
    seedSettings({ loggingConsentSeen: false })
    // Intercept the updateSettings action on the store directly.
    const updateSpy = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState((s) => ({ ...s, updateSettings: updateSpy }))

    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u

    const skipBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Skip indexing'
    ) as HTMLButtonElement
    expect(skipBtn).toBeTruthy()

    await act(async () => { skipBtn.click() })
    // The component delays updateSettings by CLOSE_ANIM_MS (200ms) for the exit animation.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250))
    })

    expect(updateSpy).toHaveBeenCalledOnce()
    const callArg = updateSpy.mock.calls[0][0]
    expect(callArg).toMatchObject({ loggingEnabled: false, loggingConsentSeen: true })
  })

  it('clicking "Keep indexing" calls updateSettings with { loggingConsentSeen: true } and does NOT set loggingEnabled false', async () => {
    seedSettings({ loggingConsentSeen: false })
    const updateSpy = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState((s) => ({ ...s, updateSettings: updateSpy }))

    const { container, unmount: u } = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = u

    const keepBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Keep indexing'
    ) as HTMLButtonElement
    expect(keepBtn).toBeTruthy()

    await act(async () => { keepBtn.click() })
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

// ---------------------------------------------------------------------------
// P3.12 round 1 (B5): the notice an upgrading user saw named Claude Code's
// transcripts only, and Codex's are indexed by default too. A user with Codex
// in use whose seen notice predates that (no notice version, or version 1) is
// shown it once more; a Claude-only user, a user who turned indexing off, and
// one who saw the current notice are not.
// ---------------------------------------------------------------------------

describe('LoggingConsentPrompt: once more for Codex (P3.12 round 1, B5)', () => {
  let unmount: (() => void) | undefined
  afterEach(() => { unmount?.(); unmount = undefined; vi.clearAllMocks() })

  it('loggingConsentDue: never seen, or seen before Codex was named while Codex is in use and indexing is on', () => {
    expect(LOGGING_CONSENT_VERSION).toBe(2)
    expect(loggingConsentDue({})).toBe(true)
    expect(loggingConsentDue({ loggingConsentSeen: false, codexEnabled: true })).toBe(true)
    // Claude-only (Codex off or never answered): nothing new.
    expect(loggingConsentDue({ loggingConsentSeen: true })).toBe(false)
    expect(loggingConsentDue({ loggingConsentSeen: true, codexEnabled: false })).toBe(false)
    // Codex in use, the earlier notice.
    expect(loggingConsentDue({ loggingConsentSeen: true, codexEnabled: true })).toBe(true)
    expect(loggingConsentDue({ loggingConsentSeen: true, codexEnabled: true, loggingConsentVersion: 1 })).toBe(true)
    // Codex in use, the current notice seen.
    expect(loggingConsentDue({ loggingConsentSeen: true, codexEnabled: true, loggingConsentVersion: 2 })).toBe(false)
    // Indexing turned off: the notice (which says it is on) is not shown again.
    expect(loggingConsentDue({ loggingConsentSeen: true, codexEnabled: true, loggingEnabled: false })).toBe(false)
  })

  it('an upgrading Codex user sees the notice once more; a Claude-only user does not', () => {
    seedSettings({ loggingConsentSeen: true, codexEnabled: true, loggingConsentVersion: undefined })
    let r = renderComponent(React.createElement(LoggingConsentPrompt))
    expect(r.container.textContent).toContain('Conversation indexing is on')
    r.unmount()
    seedSettings({ loggingConsentSeen: true, codexEnabled: undefined, loggingConsentVersion: undefined })
    r = renderComponent(React.createElement(LoggingConsentPrompt))
    unmount = r.unmount
    expect(r.container.textContent).toBe('')
  })

  it('both answers record the current notice version', async () => {
    for (const label of ['Keep indexing', 'Skip indexing']) {
      seedSettings({ loggingConsentSeen: true, codexEnabled: true, loggingConsentVersion: undefined })
      const updateSpy = vi.fn().mockResolvedValue(undefined)
      useSettingsStore.setState((st) => ({ ...st, updateSettings: updateSpy }))
      const r = renderComponent(React.createElement(LoggingConsentPrompt))
      const btn = Array.from(r.container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement
      await act(async () => { btn.click() })
      await act(async () => { await new Promise((res) => setTimeout(res, 250)) })
      expect(updateSpy.mock.calls[0][0], label).toMatchObject({ loggingConsentSeen: true, loggingConsentVersion: LOGGING_CONSENT_VERSION })
      r.unmount()
    }
  })

  it('the boot gate and the onboarding page use the same rule and record the same version', () => {
    expect(appSource).toMatch(/loggingConsentDue\(s\.settings\)/)
    expect(appSource).toMatch(/loggingConsentSeen: !loggingConsentDueNow/)
    expect(transparencySource).toMatch(/save\(\{ loggingConsentSeen: true, loggingConsentVersion: LOGGING_CONSENT_VERSION \}\)/)
  })
})
