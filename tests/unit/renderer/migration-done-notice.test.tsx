// @vitest-environment jsdom
/**
 * MigrationDoneNotice — corner notice when a log import finishes (or fails)
 * while the user is anywhere in the app. Gated on migrationStore.reportAcked so
 * it surfaces once per run; "View report" deep-links to Settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useMigrationStore } from '../../../src/renderer/stores/migrationStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  logMigration: { detect: vi.fn(), run: vi.fn(), reclaim: vi.fn(), onProgress: vi.fn(() => () => {}) },
  config: { save: vi.fn().mockResolvedValue(undefined) },
}

const { default: MigrationDoneNotice } = await import('../../../src/renderer/components/MigrationDoneNotice')

const REPORT = { totalSessions: 780, importedSessions: 780, skippedSessions: 0, failedSessions: 0, importedEvents: 9, unparseable: [], foldedPartnerDirs: 210, noEventDirs: 0, detectedFolders: 990, dbBytesBefore: 0, dbBytesAfter: 1 }

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}
const btn = (c: HTMLElement, label: string) => Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)

describe('MigrationDoneNotice', () => {
  beforeEach(() => {
    useMigrationStore.setState({ phase: 'idle', report: null, reportAcked: true, errorMessage: undefined, errorKind: undefined })
  })

  it('hidden while idle/running or already acked', () => {
    const a = render(<MigrationDoneNotice onViewReport={() => {}} />)
    expect(a.container.querySelector('[role="status"]')).toBeNull()
    a.unmount()
    useMigrationStore.setState({ phase: 'running', reportAcked: false })
    const b = render(<MigrationDoneNotice onViewReport={() => {}} />)
    expect(b.container.querySelector('[role="status"]')).toBeNull()
    b.unmount()
  })

  it('surfaces on done with the imported count; View report deep-links + acks', () => {
    const onViewReport = vi.fn()
    useMigrationStore.setState({ phase: 'done', report: REPORT, reportAcked: false })
    const { container, unmount } = render(<MigrationDoneNotice onViewReport={onViewReport} />)
    expect(container.textContent).toContain('780')
    act(() => { btn(container, 'View report')!.click() })
    expect(onViewReport).toHaveBeenCalledTimes(1)
    expect(useMigrationStore.getState().reportAcked).toBe(true)
    unmount()
  })

  it('Dismiss acks without navigating', () => {
    const onViewReport = vi.fn()
    useMigrationStore.setState({ phase: 'done', report: REPORT, reportAcked: false })
    const { container, unmount } = render(<MigrationDoneNotice onViewReport={onViewReport} />)
    act(() => { btn(container, 'Dismiss')!.click() })
    expect(onViewReport).not.toHaveBeenCalled()
    expect(useMigrationStore.getState().reportAcked).toBe(true)
    unmount()
  })

  it('warns when sessions failed (incomplete run)', () => {
    useMigrationStore.setState({ phase: 'done', report: { ...REPORT, failedSessions: 3 }, reportAcked: false })
    const { container, unmount } = render(<MigrationDoneNotice onViewReport={() => {}} />)
    expect(container.textContent?.toLowerCase()).toContain('fail')
    unmount()
  })

  it('surfaces a RUN error variant (reclaim errors are not its business)', () => {
    useMigrationStore.setState({ phase: 'error', errorKind: 'run', errorMessage: 'worker down', reportAcked: false })
    const a = render(<MigrationDoneNotice onViewReport={() => {}} />)
    expect(a.container.textContent).toContain('worker down')
    a.unmount()
    useMigrationStore.setState({ phase: 'error', errorKind: 'reclaim', errorMessage: 'locked', reportAcked: false })
    const b = render(<MigrationDoneNotice onViewReport={() => {}} />)
    expect(b.container.querySelector('[role="status"]')).toBeNull()
    b.unmount()
  })
})
