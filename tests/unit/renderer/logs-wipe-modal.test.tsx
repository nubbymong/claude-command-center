// @vitest-environment jsdom
/**
 * LogsWipeModal — first-run BLOCKING confirm for the Logs v2 reset (Task 7/17).
 *
 * The old migration UI (LogMigrationPrompt / MigrationDoneNotice / reclaim /
 * report) is gone; the new build never reads the old log stores, so the single
 * confirm proceeds straight to deletion. This file covers the modal's behaviour:
 *   - it renders the wipe copy + the detected byte figure,
 *   - confirm → logsWipe.confirm() IPC → onComplete fires (modal closes),
 *   - a failing confirm IPC still closes (boot is never blocked).
 *
 * App.tsx gates this on the logsWipe.detect() result (logsWipeBytes > 0); that
 * gate predicate is exercised here directly so we don't have to render the whole
 * App tree (which wires dozens of stores/IPC surfaces).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Saved so the fake-timer runs can restore rAF and never leak the synchronous
// stub into other tests.
const ORIGINAL_RAF = globalThis.requestAnimationFrame

// ---------------------------------------------------------------------------
// Minimal electronAPI mock — the modal only touches logsWipe.confirm().
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  logsWipe: {
    detect: vi.fn().mockResolvedValue({ present: true, totalBytes: 21 * 1024 * 1024 * 1024, paths: [], settingsKeys: [] }),
    confirm: vi.fn().mockResolvedValue({ deletedPaths: [], clearedKeys: [], freedBytes: 0 }),
  },
}

// Import component AFTER the mock is installed.
const { default: LogsWipeModal } = await import('../../../src/renderer/components/LogsWipeModal')

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}

const wipeBtn = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => /delete old logs|deleting/i.test(b.textContent ?? ''))

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window.electronAPI.logsWipe.confirm = vi.fn().mockResolvedValue({ deletedPaths: [], clearedKeys: [], freedBytes: 0 })
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.requestAnimationFrame = ORIGINAL_RAF
})

describe('LogsWipeModal', () => {
  it('renders the wipe copy + the detected byte figure', () => {
    const { container, unmount } = render(<LogsWipeModal totalBytes={21 * 1024 * 1024 * 1024} onComplete={() => {}} />)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.textContent?.toLowerCase()).toContain('deleted')
    // 21 GiB formatted figure
    expect(container.textContent).toMatch(/21\.0 GB/)
    expect(wipeBtn(container)).toBeTruthy()
    unmount()
  })

  it('confirm → logsWipe.confirm() IPC → onComplete (modal closes)', async () => {
    // Stub rAF so the entering animation does not stall under fake timers.
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0 }
    vi.useFakeTimers()

    const onComplete = vi.fn()
    const confirmSpy = (globalThis as any).window.electronAPI.logsWipe.confirm

    const { container, unmount } = render(<LogsWipeModal totalBytes={1234} onComplete={onComplete} />)

    await act(async () => {
      wipeBtn(container)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // IPC fired immediately on click.
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // onComplete is deferred by the 200ms close animation.
    expect(onComplete).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(onComplete).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('still closes when the confirm IPC rejects (boot never blocked)', async () => {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0 }
    vi.useFakeTimers()

    ;(globalThis as any).window.electronAPI.logsWipe.confirm = vi.fn().mockRejectedValue(new Error('locked'))
    const onComplete = vi.fn()

    const { container, unmount } = render(<LogsWipeModal totalBytes={1234} onComplete={onComplete} />)

    await act(async () => {
      wipeBtn(container)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(onComplete).toHaveBeenCalledTimes(1)
    unmount()
  })
})
