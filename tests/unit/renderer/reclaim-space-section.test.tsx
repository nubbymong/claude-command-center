// @vitest-environment jsdom
/**
 * ReclaimSpaceSection — the persistent post-import reclaim entry in Settings.
 * Previously the reclaim button existed ONLY inside the in-memory post-run
 * report: an app restart stranded a fully-armed reclaim with no UI door (the
 * user hit this after the real 16 GB import). This section renders from the
 * PERSISTED completion marker and uses a two-step confirm.
 */
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: ReclaimSpaceSection } = await import('../../../src/renderer/components/ReclaimSpaceSection')

const COMPLETION = { completedAt: 1780727619022, logsDir: 'C:/x/logs', totalSessions: 780, importedSessions: 780, skippedSessions: 0, importedEvents: 90249150, unparseableCount: 0 }

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}
const btn = (c: HTMLElement, label: string) => Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)

describe('ReclaimSpaceSection', () => {
  it('summarises the persisted import and offers the reclaim entry', () => {
    const { container, unmount } = render(
      <ReclaimSpaceSection sessionFolders={990} completion={COMPLETION} onReclaim={() => {}} />,
    )
    expect(container.textContent).toContain('780')
    expect(container.textContent).toContain('990')
    expect(btn(container, 'Reclaim disk space...')).toBeTruthy()
    unmount()
  })

  it('is two-step: first click arms, second click fires onReclaim', () => {
    const onReclaim = vi.fn()
    const { container, unmount } = render(
      <ReclaimSpaceSection sessionFolders={990} completion={COMPLETION} onReclaim={onReclaim} />,
    )
    act(() => { btn(container, 'Reclaim disk space...')!.click() })
    expect(onReclaim).not.toHaveBeenCalled()
    expect(container.textContent?.toLowerCase()).toContain('permanently')
    act(() => { btn(container, 'Permanently delete original files')!.click() })
    expect(onReclaim).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('Cancel disarms without firing', () => {
    const onReclaim = vi.fn()
    const { container, unmount } = render(
      <ReclaimSpaceSection sessionFolders={990} completion={COMPLETION} onReclaim={onReclaim} />,
    )
    act(() => { btn(container, 'Reclaim disk space...')!.click() })
    act(() => { btn(container, 'Cancel')!.click() })
    expect(onReclaim).not.toHaveBeenCalled()
    expect(btn(container, 'Reclaim disk space...')).toBeTruthy() // back to step one
    unmount()
  })
})
