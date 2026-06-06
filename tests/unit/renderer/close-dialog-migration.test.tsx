// @vitest-environment jsdom
/**
 * CloseDialog migration guard — closing the app while a log import runs must
 * warn (user-approved quit-confirm) instead of silently abandoning the run.
 */
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: CloseDialog } = await import('../../../src/renderer/components/CloseDialog')

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}
const btn = (c: HTMLElement, label: string) => Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)

const base = { mode: 'close' as const, onSaveAndClose: vi.fn(), onCloseWithoutSaving: vi.fn(), onCancel: vi.fn() }

describe('CloseDialog migration guard', () => {
  it('no migration: classic copy, no import warning', () => {
    const { container, unmount } = render(<CloseDialog {...base} sessionCount={2} />)
    expect(container.textContent).toContain('2 active sessions')
    expect(container.textContent?.toLowerCase()).not.toContain('import')
    unmount()
  })

  it('migration running + sessions: warning line appears alongside session copy', () => {
    const { container, unmount } = render(<CloseDialog {...base} sessionCount={2} migrationRunning />)
    expect(container.textContent?.toLowerCase()).toContain('log import')
    expect(container.textContent?.toLowerCase()).toContain('continue')
    expect(btn(container, 'Save Sessions')).toBeTruthy()
    unmount()
  })

  it('migration running + ZERO sessions: import-focused dialog with Quit anyway / Cancel only', () => {
    const onCloseWithoutSaving = vi.fn()
    const onCancel = vi.fn()
    const { container, unmount } = render(
      <CloseDialog {...base} onCloseWithoutSaving={onCloseWithoutSaving} onCancel={onCancel} sessionCount={0} migrationRunning />,
    )
    expect(container.textContent?.toLowerCase()).toContain('log import')
    expect(btn(container, 'Save Sessions')).toBeUndefined()
    act(() => { btn(container, 'Quit anyway')!.click() })
    expect(onCloseWithoutSaving).toHaveBeenCalledTimes(1)
    expect(btn(container, 'Cancel')).toBeTruthy()
    unmount()
  })
})
