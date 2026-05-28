// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: any) => any) =>
    selector({ settings: { updateChannel: 'stable' } }),
}))

vi.mock('../../../src/renderer/components/ThemeToggle', () => ({
  default: () => createElement('div', { 'data-testid': 'theme-toggle' }),
}))

const { default: TitleBar } = await import('../../../src/renderer/components/TitleBar')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = {
    window: {
      isMaximized: vi.fn().mockResolvedValue(false),
      onMaximizedChanged: vi.fn().mockReturnValue(() => {}),
      minimize: vi.fn(),
      maximize: vi.fn(),
      close: vi.fn(),
    },
    serviceStatus: {
      get: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn().mockReturnValue(() => {}),
    },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('TitleBar surface tier (U1 shell chrome)', () => {
  it('uses --surface-raised, not --surface-chrome, for its background', () => {
    act(() => {
      root.render(createElement(TitleBar, { sidebarOpen: true, onToggleSidebar: () => {} }))
    })
    const bar = container.firstChild as HTMLElement
    expect(bar.style.background).toContain('var(--surface-raised)')
    expect(bar.style.background).not.toContain('var(--surface-chrome)')
  })
})
