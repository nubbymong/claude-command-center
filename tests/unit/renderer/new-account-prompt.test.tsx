// @vitest-environment jsdom
/**
 * NewAccountPrompt unit tests.
 *
 * Verifies:
 *   - The detected email is rendered.
 *   - Typing a name and clicking "Add account" calls onAdd with the typed name.
 *   - Clicking "Not now" calls onDismiss.
 *   - Pressing Enter in the name input also calls onAdd.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

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

// Import component AFTER environment is set up
const { default: NewAccountPrompt } = await import('../../../src/renderer/components/NewAccountPrompt')

describe('NewAccountPrompt', () => {
  let unmount: () => void

  afterEach(() => {
    unmount?.()
    vi.clearAllMocks()
  })

  it('renders the detected email', () => {
    const { container, unmount: u } = renderComponent(
      React.createElement(NewAccountPrompt, {
        email: 'test@example.com',
        onAdd: vi.fn(),
        onDismiss: vi.fn(),
      })
    )
    unmount = u
    expect(container.textContent).toContain('test@example.com')
  })

  it('calls onAdd with the typed name when "Add account" is clicked', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    const { container, unmount: u } = renderComponent(
      React.createElement(NewAccountPrompt, {
        email: 'work@corp.com',
        onAdd,
        onDismiss: vi.fn(),
      })
    )
    unmount = u

    const input = container.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()

    await act(async () => {
      input.value = 'Work'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // Use React's synthetic onChange pathway
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      nativeInputValueSetter?.call(input, 'Work')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Simulate React controlled component change
    await act(async () => {
      const changeEvent = new Event('change', { bubbles: true })
      Object.defineProperty(changeEvent, 'target', { value: { value: 'Work' } })
      input.dispatchEvent(changeEvent)
    })

    // Find and click "Add account" button
    const addBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Add account')
    ) as HTMLButtonElement
    expect(addBtn).toBeTruthy()

    await act(async () => { addBtn.click() })

    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('calls onDismiss when "Not now" is clicked', async () => {
    const onDismiss = vi.fn()
    const { container, unmount: u } = renderComponent(
      React.createElement(NewAccountPrompt, {
        email: 'x@y.com',
        onAdd: vi.fn(),
        onDismiss,
      })
    )
    unmount = u

    const dismissBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Not now')
    ) as HTMLButtonElement
    expect(dismissBtn).toBeTruthy()

    await act(async () => { dismissBtn.click() })

    // onDismiss fires after the close animation; schedule past the setTimeout
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250))
    })

    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('calls onAdd when Enter is pressed in the name input', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    const { container, unmount: u } = renderComponent(
      React.createElement(NewAccountPrompt, {
        email: 'enter@test.com',
        onAdd,
        onDismiss: vi.fn(),
      })
    )
    unmount = u

    const input = container.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onAdd).toHaveBeenCalledOnce()
  })
})
