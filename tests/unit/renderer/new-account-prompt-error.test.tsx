// @vitest-environment jsdom
/**
 * Adversarial review pass 3, M2: when main refuses or rolls back a capture of
 * a detected /login (macOS multi-account), it answers `{ error }`. The prompt
 * must show it and stay open -- before, App closed the prompt as if the
 * account had been added.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: NewAccountPrompt } = await import('../../../src/renderer/components/NewAccountPrompt')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const addButton = () => [...container.querySelectorAll('button')].find((b) => /Add account/.test(b.textContent ?? '')) as HTMLButtonElement

describe('NewAccountPrompt', () => {
  it('M2: an error from onAdd is shown and the prompt stays open', async () => {
    const onDismiss = vi.fn()
    const onAdd = vi.fn(async () => 'The account could not be added: the original sign-in was not cleared because it changed while it was being copied. Nothing was changed; try again.')
    await act(async () => { root.render(<NewAccountPrompt email="b@example.com" onAdd={onAdd} onDismiss={onDismiss} />); await flush() })
    await act(async () => { addButton().click(); await flush() })
    expect(onAdd).toHaveBeenCalledTimes(1)
    const err = container.querySelector('[data-testid="new-account-error"]')
    expect(err?.getAttribute('role')).toBe('alert')
    expect(err?.textContent).toMatch(/could not be added/)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(addButton().disabled).toBe(false) // can try again
  })

  it('success (no error): nothing is shown', async () => {
    const onAdd = vi.fn(async () => null)
    await act(async () => { root.render(<NewAccountPrompt email="b@example.com" onAdd={onAdd} onDismiss={vi.fn()} />); await flush() })
    await act(async () => { addButton().click(); await flush() })
    expect(container.querySelector('[data-testid="new-account-error"]')).toBeNull()
  })
})
