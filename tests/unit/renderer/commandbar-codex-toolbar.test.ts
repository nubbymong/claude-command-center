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

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = () => ({ sessions: mockSessions, activeSessionId: mockActiveSessionId, updateSession: mockUpdate })
  return { useSessionStore: Object.assign((sel: any) => sel(state()), { getState: state }) }
})

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
const { registerScreenReader } = await import('../../../src/renderer/components/terminal/screenRegistry')
const { markSpawned, clearSpawned } = await import('../../../src/renderer/ptyTracker')

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

// P3.8 round 1 (L1): the model select is for a session with no live run (it
// applies at the next start); a live session's pill opens Codex's own picker.
const mkStopped = () => ({ ...mkCodex(), ptyExited: true })

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
    mockSessions = [mkStopped()]
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
    mockSessions = [{ ...mkStopped(), codexOptions: { model: 'gpt-5.3-codex-spark', permissionsPreset: 'standard' as const } }]
    mockActiveSessionId = 's-1'
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    expect(modelSelect()!.value).toBe('gpt-5.3-codex-spark')
    act(() => { root.unmount() })
    root = createRoot(container)
    mockSessions = [{ ...mkStopped(), codexOptions: { permissionsPreset: 'standard' as const } }]
    act(() => {
      root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' }))
    })
    expect(modelSelect()!.value).toBe('')
  })

  it('Codex sessions: choosing Default clears the model (no flag at the next start), and a model sets it', () => {
    mockSessions = [mkStopped()]
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
    mockSessions = [{ ...mkStopped(), codexOptions: { model: 'gpt-6-astra', reasoningEffort: 'ultra' as const, permissionsPreset: 'standard' as const } }]
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

// P3.8 round 1 (L1, row 41; the default pending the owner's decision): Codex
// has no one-line command for a model or an effort (the VM probe: `/model
// <slug>` is sent as a message, there is no /effort), so on a live session the
// model pill opens Codex's own picker (a bare /model, typed only at its ready
// prompt, lib/codexComposer.ts), and the strip then follows what Codex
// reports. (J4) A pill's "Restart session to apply" goes with the Restart.
describe('the Codex model pill on a live session (P3.8 round 1)', () => {
  let off: (() => void) | null = null
  let screen: unknown = null
  afterEach(() => { off?.(); off = null; clearSpawned('s-1'); vi.useRealTimers() })
  const pill = () => container.querySelector('[data-testid="codex-model-pill"]') as HTMLButtonElement | null
  const liveCodex = (over: Record<string, unknown> = {}) => ({ ...mkCodex(), createdAt: 1000, modelName: 'gpt-6-astra', reasoningEffort: 'low', ...over })
  const show = () => act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1' })) })

  it("shows the running model, and a press opens Codex's own picker: /model, then Enter", async () => {
    vi.useFakeTimers()
    const S = await import('./codex-composer-screens')
    screen = S.READY
    off = registerScreenReader('s-1', () => screen as never)
    markSpawned('s-1')
    const write = vi.fn((_id: string, d: string) => { if (d === '/model') screen = [...S.READY.slice(0, 10), { text: '\u203a /model', typed: '\u203a /model' }, { text: '', typed: '' }, { text: '  /model  choose', typed: '  /model  choose' }] })
    ;(globalThis as any).window.electronAPI = { pty: { write } }
    mockSessions = [liveCodex()]
    show()
    expect(pill()!.textContent).toContain('gpt-6-astra')
    expect(container.querySelectorAll('select option[value="gpt-5.2"]')).toHaveLength(0)
    act(() => { pill()!.click() })
    expect(write.mock.calls.map((c) => c[1])).toEqual(['/model'])
    act(() => { vi.advanceTimersByTime(300) })
    expect(write.mock.calls.map((c) => c[1])).toEqual(['/model', '\r'])
  })

  it('types nothing when Codex is not at its prompt, and says why', async () => {
    vi.useFakeTimers()
    const S = await import('./codex-composer-screens')
    screen = S.TRUST
    off = registerScreenReader('s-1', () => screen as never)
    markSpawned('s-1')
    const write = vi.fn()
    ;(globalThis as any).window.electronAPI = { pty: { write } }
    mockSessions = [liveCodex()]
    show()
    act(() => { pill()!.click() })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(write).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="codex-model-note"]')!.textContent).toMatch(/not at its prompt/)
  })

  it("a press's pending Enter is dropped when the bar is re-pointed at another tab or goes away", async () => {
    vi.useFakeTimers()
    const S = await import('./codex-composer-screens')
    for (const leave of ['re-point', 'unmount'] as const) {
      screen = S.READY
      off?.()
      off = registerScreenReader('s-1', () => screen as never)
      markSpawned('s-1')
      const write = vi.fn((_id: string, d: string) => { if (d === '/model') screen = [...S.READY.slice(0, 10), { text: '\u203a /model', typed: '\u203a /model' }, { text: '', typed: '' }, { text: '  /model  choose', typed: '  /model  choose' }] })
      ;(globalThis as any).window.electronAPI = { pty: { write } }
      mockSessions = [liveCodex(), liveCodex({ id: 's-2' })]
      show()
      act(() => { pill()!.click() })
      if (leave === 're-point') act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-2', parentSessionId: 's-2' })) })
      else { act(() => { root.unmount() }); root = createRoot(container) }
      act(() => { vi.advanceTimersByTime(300) })
      expect(write.mock.calls.map((c) => [c[0], c[1]])).toEqual([['s-1', '/model']])
    }
  })

  it('a stopped session keeps the select, applied at the next start; its hint goes with the Restart (J4)', () => {
    mockSessions = [{ ...mkStopped(), createdAt: 1000 }]
    show()
    expect(pill()).toBeNull()
    const sel = Array.from(container.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === 'gpt-5.2')) as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    act(() => { setter.call(sel, 'gpt-6-astra'); sel.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('Restart session to apply')
    mockSessions = [{ ...mkStopped(), createdAt: 2000 }]
    show()
    expect(container.textContent).not.toContain('Restart session to apply')
  })

  it("the permissions pill's hint goes with the Restart too (J4), and it offers Plan mode", () => {
    mockSessions = [liveCodex()]
    show()
    const sel = Array.from(container.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === 'unrestricted')) as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['read-only', 'standard', 'plan', 'auto', 'unrestricted'])
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    act(() => { setter.call(sel, 'auto'); sel.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('Restart session to apply')
    mockSessions = [liveCodex({ createdAt: 2000 })]
    show()
    expect(container.textContent).not.toContain('Restart session to apply')
  })

  // P3.8 round 2 (PM1): the pill says what is true. A live Plan mode session
  // runs read-only; it reads "plan" only while Codex's own footer shows its
  // Plan mode. A stopped session's choice reads "plan" (applied at its start).
  it("a live Plan mode session's pill reads read-only until Codex's footer shows Plan mode", async () => {
    vi.useFakeTimers()
    const S = await import('./codex-composer-screens')
    screen = S.READY
    off = registerScreenReader('s-1', () => screen as never)
    markSpawned('s-1')
    const planOption = () => {
      const sel = Array.from(container.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === 'unrestricted')) as HTMLSelectElement
      return Array.from(sel.options).find((o) => o.value === 'plan')!.textContent
    }
    mockSessions = [liveCodex({ codexOptions: { model: 'gpt-5.5', permissionsPreset: 'plan' } })]
    show()
    expect(planOption()).toMatch(/read-only/)
    screen = S.READY_PLAN
    act(() => { vi.advanceTimersByTime(1000) })
    expect(planOption()).toBe('plan')
    screen = S.TYPED_PLAN // a popup is up: no footer to go by, the last reading holds
    act(() => { vi.advanceTimersByTime(1000) })
    expect(planOption()).toBe('plan')
    screen = S.READY // Codex left Plan mode (the plan accepted): read-only still
    act(() => { vi.advanceTimersByTime(1000) })
    expect(planOption()).toMatch(/read-only/)
    mockSessions = [{ ...mkStopped(), codexOptions: { model: 'gpt-5.5', permissionsPreset: 'plan' } }]
    show()
    expect(planOption()).toBe('plan')
  })
})
