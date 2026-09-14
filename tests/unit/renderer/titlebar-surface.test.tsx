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
    serviceHealth: {
      get: vi.fn().mockResolvedValue(null),
      restart: vi.fn(),
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
  it('uses --surface-panel (aligned to the side panel/rails), not the near-black --surface-chrome', () => {
    act(() => {
      root.render(createElement(TitleBar, { sidebarOpen: true, onToggleSidebar: () => {} }))
    })
    const bar = container.firstChild as HTMLElement
    // Aligned to --surface-panel so the top chrome matches the panel/rail depth
    // instead of floating at the lighter --surface-raised card tier.
    expect(bar.style.background).toContain('var(--surface-panel)')
    expect(bar.style.background).not.toContain('var(--surface-chrome)')
  })
})

describe('TitleBar degraded-status tint (#275)', () => {
  // The tint composes a status token into the bar's own gradient. It broke in
  // June when the colours became var() tokens but the template still appended a
  // hex-alpha suffix (`var(--status-warning)18`), which is not valid CSS: the
  // whole background declaration was dropped and the bar went TRANSPARENT for
  // every non-green status. That is what "the colour shifts when a chip leaves
  // green" was — the panel fill vanishing, not amber bleeding in.
  it('produces a background that stays a valid CSS value when the worst status is degraded', () => {
    ;(globalThis as any).window.electronAPI.serviceStatus.get = vi.fn().mockResolvedValue({
      worst: 'degraded_performance',
      api: { status: 'degraded_performance' },
      updatedAt: new Date().toISOString(),
    })
    act(() => {
      root.render(createElement(TitleBar, { sidebarOpen: true, onToggleSidebar: () => {} }))
    })
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      const bar = container.firstChild as HTMLElement
      const bg = bar.style.background
      // The panel fill must still be there...
      expect(bg).toContain('var(--surface-panel)')
      // ...and the tint must be a real colour function, never a token with a
      // hex-alpha suffix glued on. jsdom does not evaluate color-mix, but it
      // does reject a declaration it cannot parse — so an empty style here is
      // the same failure a real browser shows.
      expect(bg.length).toBeGreaterThan(0)
      expect(bg).not.toMatch(/var\([^)]*\)[0-9a-f]{2}\b/i)
      expect(bg).toContain('color-mix')
    })
  })
})
