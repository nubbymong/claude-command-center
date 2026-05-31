// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({
    sessions: [{ id: 's1', provider: 'claude', contextPercent: 10 }],
  }),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { statusLine: { font: 'sans', fontSize: 11 }, theme: 'dark' as const } }
  const useSettingsStore: any = (sel: any) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore, DEFAULT_STATUS_LINE: { font: 'sans', fontSize: 11 } }
})
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({
  useCodexReviewUsage: () => null,
}))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({
  useRestartSession: () => ({ restart: () => {} }),
}))

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = {
    pty: { write: vi.fn() },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('SessionStatusStrip surface tier (U1.2)', () => {
  it('uses --surface-raised, not --surface-chrome, for its background', () => {
    act(() => {
      root.render(createElement(SessionStatusStrip, { sessionId: 's1' }))
    })
    const strip = container.firstChild as HTMLElement
    expect(strip.style.background).toContain('var(--surface-raised)')
    expect(strip.style.background).not.toContain('var(--surface-chrome)')
  })
})
