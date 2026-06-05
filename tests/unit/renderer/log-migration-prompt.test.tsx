// @vitest-environment jsdom
/**
 * LogMigrationPrompt unit tests.
 *
 * Verifies:
 *   - The prompt renders when legacy logs are present, not migrated, and not yet seen.
 *   - The prompt does NOT render once the surfacing flag has been seen.
 *   - The prompt does NOT render once migration is complete.
 *   - Clicking "Not now" marks legacyLogsSurfacingSeen=true via updateSettings (after 200ms defer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useMigrationStore } from '../../../src/renderer/stores/migrationStore'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Saved so tests that stub rAF (for fake-timer runs) can restore it and never
// leak the synchronous stub into other tests.
const ORIGINAL_RAF = globalThis.requestAnimationFrame

// ---------------------------------------------------------------------------
// Minimal electronAPI mock so both stores can function.
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  config: {
    save: vi.fn().mockResolvedValue(undefined),
  },
  logMigration: {
    detect: vi.fn().mockResolvedValue({ present: true, sessionFolders: 990, frozen: false }),
    run: vi.fn().mockResolvedValue({}),
    reclaim: vi.fn().mockResolvedValue({ reclaimedBytes: 0, failedFolders: [] }),
    onProgress: vi.fn(() => () => {}),
  },
}

// ---------------------------------------------------------------------------
// renderComponent helper (mirrors logging-consent.test.tsx house pattern)
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
const { default: LogMigrationPrompt } = await import('../../../src/renderer/components/LogMigrationPrompt')

// ---------------------------------------------------------------------------
// Helpers

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window.electronAPI.logMigration.detect = vi.fn().mockResolvedValue({ present: true, sessionFolders: 990, frozen: false })
  ;(globalThis as any).window.electronAPI.logMigration.run = vi.fn().mockResolvedValue({})
  ;(globalThis as any).window.electronAPI.logMigration.reclaim = vi.fn().mockResolvedValue({ reclaimedBytes: 0, failedFolders: [] })
  ;(globalThis as any).window.electronAPI.logMigration.onProgress = vi.fn(() => () => {})
  useMigrationStore.setState({ phase: 'idle', present: true, sessionFolders: 990, report: null })
})

function setFlags(seen: boolean, migrated = false) {
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, legacyLogsSurfacingSeen: seen, legacyLogsMigrated: migrated },
  }))
}

// ---------------------------------------------------------------------------
// Tests

describe('LogMigrationPrompt', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    unmount?.()
    unmount = undefined
    vi.clearAllMocks()
    vi.useRealTimers()
    globalThis.requestAnimationFrame = ORIGINAL_RAF
  })

  it('renders when present + not seen + not migrated', () => {
    setFlags(false)
    const { container, unmount: u } = renderComponent(React.createElement(LogMigrationPrompt))
    unmount = u
    expect(container.textContent).toMatch(/existing logs|import/i)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('does NOT render once seen', () => {
    setFlags(true)
    const { container, unmount: u } = renderComponent(React.createElement(LogMigrationPrompt))
    unmount = u
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.firstChild).toBeNull()
  })

  it('does NOT render once migrated', () => {
    setFlags(false, true)
    const { container, unmount: u } = renderComponent(React.createElement(LogMigrationPrompt))
    unmount = u
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.firstChild).toBeNull()
  })

  it('dismiss ("Not now") marks surfacingSeen via updateSettings after 200ms', async () => {
    // Stub rAF so the entering animation does not block under fake timers
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0 }

    vi.useFakeTimers()
    setFlags(false)

    const update = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ updateSettings: update as never })

    const { container, unmount: u } = renderComponent(React.createElement(LogMigrationPrompt))
    unmount = u

    // Find the "Not now" dismiss button
    const buttons = Array.from(container.querySelectorAll('button'))
    const dismissBtn = buttons.find((b) => /not now|dismiss|later/i.test(b.textContent ?? '')) as HTMLButtonElement
    expect(dismissBtn).toBeTruthy()

    // Click the button
    await act(async () => {
      dismissBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Before advancing: updateSettings should NOT have been called yet (deferred 200ms)
    expect(update).not.toHaveBeenCalled()

    // Advance fake timers past the 200ms defer
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ legacyLogsSurfacingSeen: true }))
  })

  it('dismiss ("Import now") marks seen AND starts the migration run', async () => {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0 }

    vi.useFakeTimers()
    setFlags(false)

    const update = vi.fn().mockResolvedValue(undefined)
    const runSpy = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ updateSettings: update as never })
    useMigrationStore.setState({ run: runSpy as never })

    const { container, unmount: u } = renderComponent(React.createElement(LogMigrationPrompt))
    unmount = u

    const buttons = Array.from(container.querySelectorAll('button'))
    const importBtn = buttons.find((b) => /import now/i.test(b.textContent ?? '')) as HTMLButtonElement
    expect(importBtn).toBeTruthy()

    await act(async () => {
      importBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Deferred until after the close animation.
    expect(runSpy).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ legacyLogsSurfacingSeen: true }))
    expect(runSpy).toHaveBeenCalledTimes(1)
  })
})
