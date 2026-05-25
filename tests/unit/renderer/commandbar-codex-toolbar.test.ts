// @vitest-environment jsdom
/**
 * P5.5: CommandBar Codex toolbar -- model + permissions preset.
 * Asserts that Codex sessions see model/preset dropdowns. The Claude Mode
 * picker was removed from the CommandBar in P4b (it lives in the app-level
 * BottomBar now), so neither provider renders a "Mode" button here.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// --- store mocks (must precede component import) ---

let mockSessions: Array<any> = []
let mockActiveSessionId: string | null = null
const mockUpdate = vi.fn()

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({
      sessions: mockSessions,
      activeSessionId: mockActiveSessionId,
      updateSession: mockUpdate,
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
    sel({
      state: { collapsedSectionIds: [] },
      toggleSection: vi.fn(),
    }),
}))

vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: (sel: any) =>
    sel({
      startActivation: vi.fn(() => 0),
      markAvailable: vi.fn(),
      markFailed: vi.fn(),
      bySessionId: {},
    }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('../../../src/renderer/stores/tipsStore', () => ({
  trackUsage: vi.fn(),
}))

vi.mock('../../../src/renderer/utils/id', () => ({
  generateId: () => 'test-id',
}))

// Stub child components that would need full Electron context
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({
  default: () => null,
}))
vi.mock('../../../src/renderer/components/ExcalidrawButton', () => ({
  default: () => null,
}))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({
  default: () => null,
}))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({
  default: () => null,
}))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({
  default: () => null,
}))

// Mock window.electronAPI
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  pty: { write: vi.fn() },
}

// Import component AFTER all mocks
const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

// --- Session factories ---

const mkClaude = () => ({
  id: 's-1',
  label: 't',
  workingDirectory: '/',
  color: '#89b4fa',
  sessionType: 'local' as const,
  provider: 'claude' as const,
  model: 'claude-opus-4-5',
})

const mkCodex = () => ({
  id: 's-1',
  label: 't',
  workingDirectory: '/',
  color: '#89b4fa',
  sessionType: 'local' as const,
  provider: 'codex' as const,
  model: 'codex',
  codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' as const },
})

// --- Test setup ---

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockUpdate.mockClear()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

// --- Tests ---

describe('CommandBar Codex toolbar (P5.5)', () => {
  it('Codex sessions: Mode dropdown is HIDDEN', () => {
    mockSessions = [mkCodex()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    // "Mode" is the literal button label; Codex branch does not render it
    expect(container.textContent ?? '').not.toContain('Mode')
  })

  it('Codex sessions: model dropdown shows GPT-5.x options', () => {
    mockSessions = [mkCodex()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    expect(container.textContent ?? '').toContain('gpt-5.5')
  })

  it('Codex sessions: permissions-preset selector visible', () => {
    mockSessions = [mkCodex()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    const text = container.textContent ?? ''
    const hasPreset = ['read-only', 'standard', 'auto', 'unrestricted'].some((p) =>
      text.includes(p),
    )
    expect(hasPreset).toBe(true)
  })

  it('Claude sessions: Mode dropdown is HIDDEN (moved to BottomBar in P4b)', () => {
    mockSessions = [mkClaude()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    // P4b removed the transitional Claude Mode picker from the CommandBar --
    // the app-level BottomBar owns Mode/Model now. No button labelled "Mode".
    const modeBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Mode',
    )
    expect(modeBtn).toBeUndefined()
  })
})
