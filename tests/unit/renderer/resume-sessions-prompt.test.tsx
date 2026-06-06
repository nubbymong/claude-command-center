// @vitest-environment jsdom
/**
 * ResumeSessionsPrompt unit tests — the startup gate that stops saved sessions
 * from force-resuming every boot ("Don't open" option).
 *
 * Props-driven (App owns the pending saved state): renders the saved-session
 * count, "Resume" fires onResume, "Don't open" fires onDontOpen. Mouse-only —
 * no autofocus, tabIndex=-1 — so it never steals focus from a terminal.
 */
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: ResumeSessionsPrompt } = await import('../../../src/renderer/components/ResumeSessionsPrompt')

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

const buttonByText = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)

describe('ResumeSessionsPrompt', () => {
  it('renders the saved-session count', () => {
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt count={3} onResume={() => {}} onDontOpen={() => {}} />,
    )
    expect(container.textContent).toContain('3')
    expect(buttonByText(container, 'Resume')).toBeTruthy()
    expect(buttonByText(container, "Don't open")).toBeTruthy()
    unmount()
  })

  it('Resume fires onResume (and not onDontOpen)', () => {
    const onResume = vi.fn()
    const onDontOpen = vi.fn()
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt count={1} onResume={onResume} onDontOpen={onDontOpen} />,
    )
    act(() => { buttonByText(container, 'Resume')!.click() })
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onDontOpen).not.toHaveBeenCalled()
    unmount()
  })

  it("Don't open fires onDontOpen (and not onResume)", () => {
    const onResume = vi.fn()
    const onDontOpen = vi.fn()
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt count={2} onResume={onResume} onDontOpen={onDontOpen} />,
    )
    act(() => { buttonByText(container, "Don't open")!.click() })
    expect(onDontOpen).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
    unmount()
  })

  it('never steals focus (no autofocus; dialog tabIndex=-1)', () => {
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt count={1} onResume={() => {}} onDontOpen={() => {}} />,
    )
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true)
    unmount()
  })
})
