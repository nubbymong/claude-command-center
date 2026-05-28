// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { FilterBar } = await import('../../../src/renderer/components/TokenomicsPage')

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

describe('Tokenomics group-by pivot control (U2.2)', () => {
  it('renders three pivot buttons and calls onGroupBy when clicked', () => {
    const onGroupBy = vi.fn()

    act(() => {
      root.render(
        createElement(FilterBar, {
          dateFilter: 'all',
          spendFilter: 'all',
          providerFilter: 'all',
          onDateFilter: () => {},
          onSpendFilter: () => {},
          onProviderFilter: () => {},
          selectedDate: null,
          projects: [],
          projectFilter: 'all',
          onProjectFilter: () => {},
          accountEmails: [],
          accountFilter: 'all',
          onAccountFilter: () => {},
          groupBy: 'project',
          onGroupBy,
        } as any)
      )
    })

    // Buttons use capitalize CSS class, so text content matches the raw lowercase value
    const buttons = Array.from(container.querySelectorAll('button'))
    const projectBtn = buttons.find(b => b.textContent?.toLowerCase() === 'project')
    const accountBtn = buttons.find(b => b.textContent?.toLowerCase() === 'account')
    const modelBtn = buttons.find(b => b.textContent?.toLowerCase() === 'model')

    expect(projectBtn).toBeTruthy()
    expect(accountBtn).toBeTruthy()
    expect(modelBtn).toBeTruthy()

    act(() => {
      accountBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onGroupBy).toHaveBeenCalledWith('account')
  })
})
