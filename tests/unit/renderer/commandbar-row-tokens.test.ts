// @vitest-environment jsdom
/**
 * Fix 3 -- command-strip rows must NOT carry bg-crust (UAT round 1).
 * The magic-buttons row (row 1) always renders. Rows 2/3 only render when
 * there are commands; this test keeps it simple and checks row 1 + the
 * overall DOM for bg-crust on divs that are command-strip containers.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({
      sessions: [{ id: 's-1', label: 't', workingDirectory: '/', color: '#89b4fa',
        sessionType: 'local', provider: 'claude', model: 'sonnet' }],
      activeSessionId: 's-1',
      updateSession: vi.fn(),
    }),
}))

vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    commands: [],
    sections: [],
    addCommand: vi.fn(),
    updateCommand: vi.fn(),
    removeCommand: vi.fn(),
    reorderCommands: vi.fn(),
    updateSection: vi.fn(),
    removeSection: vi.fn(),
    reorderSections: vi.fn(),
  }),
}))

vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) =>
    sel({ state: { collapsedSectionIds: [] }, toggleSection: vi.fn() }),
}))

vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: (sel: any) =>
    sel({ startActivation: vi.fn(() => 0), markAvailable: vi.fn(),
          markFailed: vi.fn(), bySessionId: {} }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ExcalidrawButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = { pty: { write: vi.fn() } }

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

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

describe('CommandBar row surface tokens (Fix 3)', () => {
  it('command-strip rows do not carry bg-crust class', () => {
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    // Strip rows are flex divs with border-t. Input fields also carry bg-crust but
    // those are <input> elements, not <div>. Assert no <div> has bg-crust.
    const crustedDivs = Array.from(container.querySelectorAll('div.bg-crust'))
    expect(crustedDivs).toHaveLength(0)
  })
})
