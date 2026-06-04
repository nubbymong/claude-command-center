// @vitest-environment jsdom
/**
 * MigrationReport unit tests.
 *
 * Verifies:
 *   - Shows imported/total/events and lists every unparseable file.
 *   - Requires a two-step confirm before invoking onReclaim.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// renderComponent helper (house pattern, mirrors logging-consent.test.tsx)
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
// Import component AFTER environment setup.
const { MigrationReport } = await import('../../../src/renderer/components/MigrationReport')

// ---------------------------------------------------------------------------
// Shared fixture
const report = {
  totalSessions: 990, importedSessions: 980, skippedSessions: 8, importedEvents: 123456,
  unparseable: [
    { path: 'C:/logs/APP/s5/session.jsonl', reason: 'skipped malformed line(s)', skippedLines: 3 },
    { path: 'C:/logs/APP/s9', reason: 'no parseable events', skippedLines: 0 },
  ],
  foldedPartnerDirs: 1,
  detectedFolders: 990,
  dbBytesBefore: 1_000_000, dbBytesAfter: 4_000_000,
}

// ---------------------------------------------------------------------------
describe('MigrationReport', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    unmount?.()
    unmount = undefined
  })

  it('shows imported/total/events and lists every unparseable file', () => {
    const { container, unmount: u } = renderComponent(
      React.createElement(MigrationReport, {
        report,
        onReclaim: () => {},
        onDismiss: () => {},
        reclaiming: false,
      })
    )
    unmount = u

    const text = container.textContent ?? ''
    // Shows imported session count
    expect(text).toContain('980')
    // Shows events with toLocaleString formatting
    expect(text).toContain('123,456')
    // Lists both unparseable paths
    expect(text).toContain('s5/session.jsonl')
    expect(text).toContain('no parseable events')
  })

  it('renders the reconciliation line with the detected count and merged partner count', () => {
    const { container, unmount: u } = renderComponent(
      React.createElement(MigrationReport, {
        report,
        onReclaim: () => {},
        onDismiss: () => {},
        reclaiming: false,
      })
    )
    unmount = u

    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    // Detected folder count + the reconciliation phrasing.
    expect(text).toContain('Detected 990 session folder(s)')
    // The merged-partner term accounts for the folded partner dir.
    expect(text).toContain('1 partner terminal(s) merged into their base session')
    // No-readable-event folders are surfaced (one such unparseable entry in the fixture).
    expect(text).toContain('1 with no readable events')
  })

  it('requires a two-step confirm before invoking onReclaim', async () => {
    const onReclaim = vi.fn()
    const { container, unmount: u } = renderComponent(
      React.createElement(MigrationReport, {
        report,
        onReclaim,
        onDismiss: () => {},
        reclaiming: false,
      })
    )
    unmount = u

    // Find the initial "Reclaim space" button
    const buttons = () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    const reclaimBtn = buttons().find((b) => /reclaim/i.test(b.textContent ?? ''))
    expect(reclaimBtn).toBeTruthy()

    // First click: should NOT call onReclaim, but should show the confirmation warning
    await act(async () => {
      reclaimBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onReclaim).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/permanent|cannot be undone/i)

    // Second click: find the confirm/delete button and click it
    const confirmBtn = buttons().find((b) => /delete .*permanently|confirm/i.test(b.textContent ?? ''))
    expect(confirmBtn).toBeTruthy()

    await act(async () => {
      confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onReclaim).toHaveBeenCalledOnce()
  })
})
