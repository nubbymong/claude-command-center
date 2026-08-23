// @vitest-environment jsdom
/**
 * CommandBar: the one-row bar's session controls and chip look (ADR-018 D1, D3, D6).
 *
 *  1. The Claude Mode picker + Claude Model/Effort picker are GONE
 *     (BottomBar owns those now -- this bar is Claude-mode-agnostic).
 *  2. The Codex inline dropdowns STAY (BottomBar is Claude-only there).
 *  3. There is NO collapse toggle on the bar. "Hide the command bar" lives in
 *     the bar's right-click menu and the restore in Settings; when
 *     `barCollapsed` is set the bar renders nothing but a marker.
 *  4. A user chip is neutral -- the command's colour lives in its ICON (the
 *     monogram tile, or the chosen glyph), never on the chip surface.
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

// One custom Claude command so a chip renders. Mutable so a test can give it
// an icon before rendering.
let mockCommand: Record<string, unknown> = {}
const baseCommand = {
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
const mockSetBarCollapsed = vi.fn((v: boolean) => { mockBarCollapsed = v })

vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) =>
    sel({
      state: { collapsedSectionIds: [], barCollapsed: mockBarCollapsed },
      toggleSection: vi.fn(),
      setBarCollapsed: mockSetBarCollapsed,
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
const byTestId = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const chipNamed = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-chip"]')).find((b) => (b.textContent ?? '').includes(label))
const renderBar = (root: Root) => {
  act(() => {
    root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
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
  mockSetBarCollapsed.mockClear()
  mockBarCollapsed = false
  mockCommand = { ...baseCommand }
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

// --- Tests ---

describe('CommandBar session controls and chip look', () => {
  it('does NOT render the Claude Mode button or the Claude model-picker trigger', () => {
    mockSessions = [mkClaude()]
    mockActiveSessionId = 's-1'
    renderBar(root)
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
    renderBar(root)
    const text = container.textContent ?? ''
    // CodexModelDropdown exposes the gpt-5.x option list.
    expect(text).toContain('gpt-5.5')
    // PermissionsPresetDropdown exposes the preset list.
    const hasPreset = ['read-only', 'standard', 'auto', 'unrestricted'].some((p) => text.includes(p))
    expect(hasPreset).toBe(true)
  })

  it('has no collapse toggle; when barCollapsed is set the bar renders only a hidden marker', () => {
    mockSessions = [mkClaude()]
    mockActiveSessionId = 's-1'

    // Shown: the row and the chip are present, and nothing on the bar is a
    // disclosure toggle (the old "⌄ Commands N" control is gone).
    renderBar(root)
    expect(byTestId(container, 'command-row')).not.toBeNull()
    expect(chipNamed(container, 'Deploy')).toBeDefined()
    // The only disclosure on the row is the Notes tool's own popover; nothing
    // named for the command bar / "Commands" collapses the row any more.
    const disclosures = Array.from(container.querySelectorAll<HTMLElement>('[aria-expanded]'))
    expect(disclosures.filter((el) => el.getAttribute('data-testid') !== 'notes-tool')).toHaveLength(0)
    expect(disclosures.some((el) => /command/i.test(el.getAttribute('aria-label') ?? el.getAttribute('title') ?? ''))).toBe(false)
    expect(byTestId(container, 'command-bar-hidden')).toBeNull()

    // Hidden (the bar's right-click "Hide the command bar"; Settings restores):
    // no row, no chip, no Add -- only the marker the restore path keys on.
    mockBarCollapsed = true
    renderBar(root)
    expect(byTestId(container, 'command-bar-hidden')).not.toBeNull()
    expect(byTestId(container, 'command-row')).toBeNull()
    expect(chipNamed(container, 'Deploy')).toBeUndefined()
    expect(byTestId(container, 'command-add')).toBeNull()
  })

  it('keeps the chip surface neutral and puts the colour in the monogram tile', () => {
    mockSessions = [mkClaude()]
    mockActiveSessionId = 's-1'
    renderBar(root)
    const chip = chipNamed(container, 'Deploy')
    expect(chip).toBeDefined()

    // The chip is a neutral token-driven pill: background and border use the
    // semantic surface and border tokens, never the command colour.
    expect(chip!.style.background).toBe('var(--surface-raised)')
    expect(chip!.style.borderColor).toBe('var(--border-subtle)')
    expect(chip!.style.background).not.toContain('243')

    // No icon chosen -> the monogram tile: the label's first letter in the
    // command colour on a 15% tint of it. (#f38ba8 -> rgb(243, 139, 168).)
    const tile = chip!.querySelector<HTMLElement>('[data-testid="command-icon-monogram"]')
    expect(tile).not.toBeNull()
    expect(tile!.textContent).toBe('D')
    expect(tile!.style.color.replace(/\s/g, '')).toBe('rgb(243,139,168)')
    const tint = tile!.style.background.replace(/\s/g, '')
    expect(tint).toContain('color-mix(')
    expect(tint).toContain('rgb(243,139,168)15%')
    // No glyph when no icon key is stored.
    expect(chip!.querySelector('[data-testid="command-icon-glyph"]')).toBeNull()
  })

  it('draws the chosen glyph in the command colour instead of the monogram', () => {
    mockSessions = [mkClaude()]
    mockActiveSessionId = 's-1'
    mockCommand = { ...baseCommand, icon: 'rocket' }
    renderBar(root)
    const chip = chipNamed(container, 'Deploy')!
    const glyph = chip.querySelector<SVGElement>('[data-testid="command-icon-glyph"]')
    expect(glyph).not.toBeNull()
    expect(glyph!.getAttribute('data-icon')).toBe('rocket')
    expect(glyph!.getAttribute('stroke')).toBe('#f38ba8')
    expect(chip.querySelector('[data-testid="command-icon-monogram"]')).toBeNull()
    // The surface stays neutral either way.
    expect(chip.style.background).toBe('var(--surface-raised)')
  })
})
