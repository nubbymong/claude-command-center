// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountFilter } from '../../../src/renderer/components/tokenomics/AccountFilter'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('AccountFilter', () => {
  let container: HTMLDivElement, root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders "All accounts" + observed emails + (Mixed) + (Unknown)', () => {
    const emails = ['a@x.com', 'b@x.com']
    act(() => {
      root.render(createElement(AccountFilter, { emails, value: 'all', onChange: () => {} }))
    })
    const opts = Array.from(container.querySelectorAll('option')).map(o => o.value)
    expect(opts).toEqual(['all', 'a@x.com', 'b@x.com', '__mixed__', '__unknown__'])
  })

  it('calls onChange with the selected value', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(createElement(AccountFilter, { emails: ['a@x.com'], value: 'all', onChange }))
    })
    const select = container.querySelector('select')!
    act(() => {
      select.value = 'a@x.com'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('a@x.com')
  })
})
