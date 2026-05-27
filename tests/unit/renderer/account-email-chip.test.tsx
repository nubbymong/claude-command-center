// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({
  useResolvedTheme: () => 'dark',
}))

const { default: AccountEmailChip } = await import('../../../src/renderer/components/AccountEmailChip')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true } as any)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(props: any) {
  act(() => { root.render(createElement(AccountEmailChip, props)) })
}

describe('AccountEmailChip', () => {
  it('renders nothing without an email', () => {
    render({ email: undefined, statuslineColour: undefined })
    expect(container.querySelector('[data-testid="account-chip"]')).toBeNull()
  })

  it('renders the email text and a coloured dot', () => {
    render({ email: 'me@example.com', statuslineColour: 'violet' })
    expect(container.textContent).toContain('me@example.com')
    const dot = container.querySelector('[data-testid="account-chip-dot"]') as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.style.background).not.toBe('')
  })

  it('uses the full email as the title even when truncated', () => {
    const long = 'nicholas.moger@a-very-long-company-domain-name.com'
    render({ email: long, statuslineColour: 'violet' })
    const chip = container.querySelector('[data-testid="account-chip"]') as HTMLElement
    expect(chip.getAttribute('title')).toBe(long)
    // long email should be visually shortened
    expect(chip.textContent!.length).toBeLessThan(long.length)
  })
})
