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
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({
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

  // P3.8 (row 39): the pill's list is the registry's Codex catalogue, as the
  // session dialog's is (src/renderer/codex-models.ts).
  const modelSelect = () => Array.from(container.querySelectorAll('select')).find((s) =>
    Array.from(s.options).some((o) => o.value === 'gpt-5.2')) as HTMLSelectElement | undefined

  it("Codex sessions: model dropdown offers the registry's Codex models, the session's selected", () => {
    mockSessions = [mkCodex()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    const sel = modelSelect()!
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'])
    expect(sel.value).toBe('gpt-5.5')
    expect(Array.from(sel.options).map((o) => o.value)).not.toContain('gpt-5.3-codex')
  })

  it("Codex sessions: a session on a model the list no longer offers shows it; one with none shows Default", () => {
    mockSessions = [{ ...mkCodex(), codexOptions: { model: 'gpt-5.3-codex-spark', permissionsPreset: 'standard' as const } }]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    expect(modelSelect()!.value).toBe('gpt-5.3-codex-spark')
    act(() => { root.unmount() })
    root = createRoot(container)
    mockSessions = [{ ...mkCodex(), codexOptions: { permissionsPreset: 'standard' as const } }]
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    expect(modelSelect()!.value).toBe('')
  })

  it('Codex sessions: choosing Default clears the model (no flag at the next start), and a model sets it', () => {
    mockSessions = [mkCodex()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    const choose = (v: string) => {
      const sel = modelSelect()!
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      act(() => { setter.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })) })
    }
    choose('')
    expect(mockUpdate).toHaveBeenLastCalledWith('s-1', { codexOptions: { model: undefined, permissionsPreset: 'standard' } })
    choose('gpt-6-astra')
    expect(mockUpdate).toHaveBeenLastCalledWith('s-1', { codexOptions: { model: 'gpt-6-astra', permissionsPreset: 'standard' } })
  })

  it('Codex sessions: a model the session effort does not run drops that effort to Default; one it runs keeps it', () => {
    mockSessions = [{ ...mkCodex(), codexOptions: { model: 'gpt-6-astra', reasoningEffort: 'ultra' as const, permissionsPreset: 'standard' as const } }]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    const choose = (v: string) => {
      const sel = modelSelect()!
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      act(() => { setter.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })) })
    }
    choose('gpt-5.6-terra')
    expect(mockUpdate).toHaveBeenLastCalledWith('s-1', { codexOptions: { model: 'gpt-5.6-terra', reasoningEffort: 'ultra', permissionsPreset: 'standard' } })
    choose('gpt-5.5')
    expect(mockUpdate).toHaveBeenLastCalledWith('s-1', { codexOptions: { model: 'gpt-5.5', reasoningEffort: undefined, permissionsPreset: 'standard' } })
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
