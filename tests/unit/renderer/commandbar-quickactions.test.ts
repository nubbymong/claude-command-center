// @vitest-environment jsdom
/**
 * P4b: CommandBar collapsible quick-actions strip + neutral chips.
 *
 * Verifies the Phase-4 cleanup of the transitional CommandBar:
 *  1. The Claude Mode picker + Claude Model/Effort picker are GONE
 *     (BottomBar owns those now -- this strip is Claude-mode-agnostic).
 *  2. The Codex inline dropdowns STAY (BottomBar is Claude-only there).
 *  3. A collapse toggle exists and hides the command rows when collapsed.
 *  4. Command chips are neutral -- colour is a dot, not a button tint.
 *
 * React.createElement (not JSX) so the file stays *.test.ts under the
 * vitest include glob -- matches the sibling commandbar-codex-toolbar test.
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

// One custom Claude command so a chip renders.
const mockCommand = {
  id: 'cmd-1',
  label: 'Deploy',
  prompt: '/deploy',
  color: '#f38ba8',
  scope: 'global' as const,
  target: 'claude' as const,
}

vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: Object.assign(
    () => ({
      commands: [mockCommand],
      sections: [],
      addCommand: vi.fn(),
      updateCommand: vi.fn(),
      removeCommand: vi.fn(),
      reorderCommands: vi.fn(),
      updateSection: vi.fn(),
      removeSection: vi.fn(),
      reorderSections: vi.fn(),
    }),
    { getState: () => ({ addSection: vi.fn() }) },
  ),
}))

// Mutable bar-collapse state so a test can flip it between renders.
let mockBarCollapsed = false
const mockToggleBar = vi.fn(() => { mockBarCollapsed = !mockBarCollapsed })

vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) =>
    sel({
      state: { collapsedSectionIds: [], barCollapsed: mockBarCollapsed },
      toggleSection: vi.fn(),
      toggleBar: mockToggleBar,
      setBarCollapsed: vi.fn(),
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
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))

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
  modelName: 'claude-opus-4-5',
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

// --- helpers ---

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
}
function buttonByAccessibleName(container: HTMLElement, needle: string): HTMLButtonElement | undefined {
  const n = needle.toLowerCase()
  return buttons(container).find((b) => {
    const title = (b.getAttribute('title') ?? '').toLowerCase()
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
    return title.includes(n) || aria.includes(n)
  })
}

// --- Test setup ---

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockUpdate.mockClear()
  mockToggleBar.mockClear()
  mockBarCollapsed = false
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

// --- Tests ---

describe('CommandBar quick-actions strip (P4b)', () => {
  it('does NOT render the Claude Mode button or the Claude model-picker trigger', () => {
    mockSessions = [mkClaude()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    // No button whose trimmed text is exactly "Mode".
    const modeBtn = buttons(container).find((b) => (b.textContent ?? '').trim() === 'Mode')
    expect(modeBtn).toBeUndefined()
    // The Claude model picker trigger displayed the short model name + a caret.
    // shortModelName('claude-opus-4-5') -> "Opus"; assert that trigger is gone.
    const modelTrigger = buttons(container).find((b) => (b.textContent ?? '').includes('Opus'))
    expect(modelTrigger).toBeUndefined()
  })

  it('keeps the Codex inline dropdowns for a codex session', () => {
    mockSessions = [mkCodex()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    const text = container.textContent ?? ''
    // CodexModelDropdown exposes the gpt-5.x option list.
    expect(text).toContain('gpt-5.5')
    // PermissionsPresetDropdown exposes the preset list.
    const hasPreset = ['read-only', 'standard', 'auto', 'unrestricted'].some((p) => text.includes(p))
    expect(hasPreset).toBe(true)
  })

  it('has a collapse toggle that hides the command rows when barCollapsed flips', () => {
    mockSessions = [mkClaude()]
    mockActiveSessionId = 's-1'

    // Expanded: the command chip is present.
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    const expandedHasChip = buttons(container).some((b) => (b.textContent ?? '').includes('Deploy'))
    expect(expandedHasChip).toBe(true)

    // The toggle has an accessible name mentioning "command".
    const toggle = buttonByAccessibleName(container, 'command')
    expect(toggle).toBeDefined()
    expect(toggle!.getAttribute('aria-expanded')).toBe('true')

    // Collapse and re-render: the command chip is gone.
    mockBarCollapsed = true
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    const collapsedHasChip = buttons(container).some((b) => (b.textContent ?? '').includes('Deploy'))
    expect(collapsedHasChip).toBe(false)
    // Toggle still present and now reports collapsed.
    const toggle2 = buttonByAccessibleName(container, 'command')
    expect(toggle2).toBeDefined()
    expect(toggle2!.getAttribute('aria-expanded')).toBe('false')
  })

  it('renders the command colour as a dot, not as a chip background/border tint', () => {
    mockSessions = [mkClaude()]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    const chip = buttons(container).find((b) => (b.textContent ?? '').includes('Deploy'))
    expect(chip).toBeDefined()

    // UAT R2: the chip is a neutral token-driven pill. Its background/border
    // must NOT be tinted with the command colour -- they use semantic surface
    // and border tokens instead, so the colour reads only as a leading dot.
    expect(chip!.style.background).toBe('var(--surface-raised)')
    expect(chip!.style.borderColor).toBe('var(--border-subtle)')
    expect(chip!.style.background).not.toContain('243')

    // A descendant dot carries the colour as inline backgroundColor.
    const dot = Array.from(chip!.querySelectorAll<HTMLElement>('span')).find(
      (s) => s.style.backgroundColor !== '',
    )
    expect(dot).toBeDefined()
    // #f38ba8 -> rgb(243, 139, 168)
    expect(dot!.style.backgroundColor.replace(/\s/g, '')).toBe('rgb(243,139,168)')
  })
})
