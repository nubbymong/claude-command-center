// @vitest-environment jsdom
/**
 * Bug #418 -- ThemeToggle 2-state flip.
 * The old 3-state cycle could produce invisible transitions (system->dark when
 * OS is already dark). The new component reads the RESOLVED theme and always
 * flips to the opposite explicit mode, so every click produces a visible change.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// -- mutable state controlled by each test --
let mockTheme: 'dark' | 'light' | 'system' = 'dark'
let mockResolvedTheme: 'dark' | 'light' = 'dark'
const mockUpdateSettings = vi.fn()

vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: (selector: any) =>
    selector({
      settings: { theme: mockTheme },
      updateSettings: mockUpdateSettings,
    }),
}))

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({
  useResolvedTheme: () => mockResolvedTheme,
}))

// Import AFTER mocks are in place
import ThemeToggle from '../../../src/renderer/components/ThemeToggle'

describe('ThemeToggle (2-state flip)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mockUpdateSettings.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders exactly one button', () => {
    mockResolvedTheme = 'dark'
    act(() => { root.render(React.createElement(ThemeToggle)) })
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(1)
  })

  it('button has an accessible name (title or aria-label)', () => {
    mockResolvedTheme = 'dark'
    act(() => { root.render(React.createElement(ThemeToggle)) })
    const btn = container.querySelector('button')!
    const name = btn.getAttribute('aria-label') || btn.getAttribute('title') || ''
    expect(name.length).toBeGreaterThan(0)
  })

  it('clicking when resolved is dark calls updateSettings({ theme: "light" })', () => {
    mockResolvedTheme = 'dark'
    act(() => { root.render(React.createElement(ThemeToggle)) })
    act(() => { container.querySelector('button')!.click() })
    expect(mockUpdateSettings).toHaveBeenCalledWith({ theme: 'light' })
  })

  it('clicking when resolved is light calls updateSettings({ theme: "dark" })', () => {
    mockResolvedTheme = 'light'
    act(() => { root.render(React.createElement(ThemeToggle)) })
    act(() => { container.querySelector('button')!.click() })
    expect(mockUpdateSettings).toHaveBeenCalledWith({ theme: 'dark' })
  })
})
