// @vitest-environment jsdom
/**
 * Hiding a Core tool (ADR-018 D9). Core tools are components, not data, so
 * the only thing a user can do to one is hide it: "In this session" (live,
 * keyed by the SESSION id -- never the pane's PTY id, so the Claude and
 * Partner bars of one session agree) or "Everywhere" (persisted). Snap and
 * Logs hide at once. Partner -- and Canvas / Browser while their pane is open
 * -- ask first, and the pane closes BEFORE the tool is hidden, so a button
 * never vanishes while its pane is still the thing on screen. Hiding Partner
 * hides the BUTTON only: a user button that runs in the partner shell still
 * opens it and types there. A hidden tool comes back from the bar's
 * right-click ("Show hidden tools") in the scope it was hidden in.
 * Part B pins the store rules the bar leans on: dedupe, show clears, the
 * dead-session sweep, and fail-open hydration of a damaged file.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useLogsStore } from '../../../src/renderer/stores/useLogsStore'
import { saveConfigNow } from '../../../src/renderer/utils/config-saver'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Tool = 'snap' | 'canvas' | 'logs' | 'browser' | 'partner' | 'notes'
type Hidden = { everywhere: Tool[]; bySession: Record<string, Tool[]> }
const emptyHidden = (): Hidden => ({ everywhere: [], bySession: {} })

// --- session store: one local Claude session that has a config ---
let SESSIONS: Array<Record<string, unknown>> = []
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: SESSIONS, activeSessionId: 's-1', updateSession: vi.fn() }),
}))

// --- command store, mocked wholesale: hiding a Core tool needs no user command
// (one test adds a partner-shell button to prove a hidden Partner still runs it) ---
let COMMANDS: Array<Record<string, unknown>> = []
const CMD_STORE = {
  get commands() { return COMMANDS },
  sections: [] as unknown[],
  addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(), reorderCommands: vi.fn(),
  moveCommand: vi.fn(), setCommandSection: vi.fn(), togglePinned: vi.fn(), clearReview: vi.fn(),
  updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
}
const addSection = vi.fn()
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: Object.assign(() => CMD_STORE, { getState: () => ({ ...CMD_STORE, addSection }) }),
}))

// --- command-bar UI store: mutable, and hideCoreTool really records the hide
// (a NEW hiddenCoreTools object, as the real store does -- the bar memoises
// on identity) so a re-render shows the tool gone and the bar menu lists it.
const BAR = {
  state: { collapsedSectionIds: [] as string[], barCollapsed: false, overflow: 'fold' as 'fold' | 'wrap2', hiddenCoreTools: emptyHidden() },
  toggleSection: vi.fn(), setOverflow: vi.fn(), setBarCollapsed: vi.fn(),
  hideCoreTool: vi.fn((tool: Tool, where: 'session' | 'everywhere', sid: string) => {
    const h = BAR.state.hiddenCoreTools
    const hiddenCoreTools: Hidden = where === 'everywhere'
      ? { ...h, everywhere: [...h.everywhere, tool] }
      : { ...h, bySession: { ...h.bySession, [sid]: [...(h.bySession[sid] ?? []), tool] } }
    BAR.state = { ...BAR.state, hiddenCoreTools }
  }),
  showCoreTool: vi.fn(),
}
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel(BAR),
}))

// --- the panes a hide may have to close first ---
const EXCAL: { bySessionId: Record<string, { isOpen: boolean }>; togglePane: ReturnType<typeof vi.fn> } = { bySessionId: {}, togglePane: vi.fn() }
vi.mock('../../../src/renderer/stores/excalidrawStore', () => ({
  useExcalidrawStore: Object.assign((sel: any) => sel(EXCAL), { getState: () => EXCAL }),
}))
const WEBVIEW: { bySessionId: Record<string, { isOpen: boolean }>; setOpen: ReturnType<typeof vi.fn>; [k: string]: unknown } = {
  bySessionId: {}, setOpen: vi.fn(), startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), navigate: vi.fn(),
}
vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: Object.assign((sel: any) => sel(WEBVIEW), { getState: () => WEBVIEW }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))

// Part B imports the REAL commandBarStore; its persistence goes through this mock.
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(), saveConfigDebounced: vi.fn() }))

vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => React.createElement('button', { 'data-testid': 'snap-mock' }, 'Snap') }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => React.createElement('button', { 'data-testid': 'canvas-mock' }, 'Canvas') }))
vi.mock('../../../src/renderer/components/LogsButton', () => ({ default: () => React.createElement('button', { 'data-testid': 'logs-mock' }, 'Logs') }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => React.createElement('button', { 'data-testid': 'browser-mock' }, 'Browser') }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/PasteHint', () => ({ default: () => null }))

;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: { write: vi.fn() },
  credentials: { save: vi.fn(), delete: vi.fn() },
  // The Notes tool in Core lists names on mount; a never-settling list keeps it quiet.
  notes: { list: vi.fn(() => new Promise(() => {})), save: vi.fn(), delete: vi.fn() },
}
const ptyWrite = () => (globalThis as any).window.electronAPI.pty.write as ReturnType<typeof vi.fn>

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')
// The real store for Part B, despite the wholesale mock above.
const realBar = await vi.importActual<typeof import('../../../src/renderer/stores/commandBarStore')>('../../../src/renderer/stores/commandBarStore')

let container: HTMLDivElement
let root: Root

const render = (props: Record<string, unknown> = {}) => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg', ...props } as never)) })
}
const byTestId = (id: string, within: ParentNode = container) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const must = (id: string, within: ParentNode = container): HTMLElement => {
  const el = byTestId(id, within)
  if (!el) throw new Error(`expected [data-testid="${id}"] on screen`)
  return el
}
const chipById = (id: string) => container.querySelector<HTMLElement>(`[data-testid="command-chip"][data-command-id="${id}"]`)
const rightClick = (el: Element) => {
  act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
}
const click = (el: Element) => { act(() => { (el as HTMLElement).click() }) }
/** Right-click a Core tool and open its "Hide this tool ▸" submenu. */
const openHideSubmenu = (tool: Tool) => {
  rightClick(must(`core-tool-${tool}`))
  click(must('menu-hide-tool', must('core-tool-menu')))
}
const PARTNER_PROPS = (onTogglePartner: () => void) => ({ partnerEnabled: true, isPartnerActive: true, onTogglePartner, partnerSessionId: 's-1-partner' })
/** hideCoreTool is the mock above; the mock's own call record is the assertion surface. */
const hideCalls = () => BAR.hideCoreTool.mock.calls

beforeEach(() => {
  SESSIONS = [{ id: 's-1', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet', configId: 'cfg' }]
  COMMANDS = []
  BAR.state = { collapsedSectionIds: [], barCollapsed: false, overflow: 'fold', hiddenCoreTools: emptyHidden() }
  BAR.hideCoreTool.mockClear()
  BAR.showCoreTool.mockClear()
  EXCAL.bySessionId = {}
  EXCAL.togglePane.mockClear()
  WEBVIEW.bySessionId = {}
  WEBVIEW.setOpen.mockClear()
  ptyWrite().mockClear()
  useLogsStore.setState({ bySessionId: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('Part A -- hiding a Core tool from the bar', () => {
  it('Logs: "Hide this tool ▸ In this session" hides at once, keyed by the session id, with no confirm and no pane touched', () => {
    render()
    expect(byTestId('core-tool-logs')).not.toBeNull()
    openHideSubmenu('logs')
    click(must('menu-hide-session'))
    expect(hideCalls()).toEqual([['logs', 'session', 's-1']])
    expect(byTestId('confirm-hide')).toBeNull()
    expect(byTestId('core-tool-menu')).toBeNull()
    // The pane was closed, so nothing toggled it (a toggle would create the entry).
    expect(useLogsStore.getState().bySessionId['s-1']).toBeUndefined()
    // The next render reads the hide back: the wrapper is gone, its siblings stay.
    render()
    expect(byTestId('core-tool-logs')).toBeNull()
    expect(byTestId('core-tool-canvas')).not.toBeNull()
    expect(byTestId('core-tool-browser')).not.toBeNull()
  })

  it('Logs: "Everywhere" hides with everywhere; an OPEN Logs pane closes BEFORE the hide, and still nothing asks', () => {
    useLogsStore.getState().setOpen('s-1', true)
    // Wrap the real togglePane so the ORDER against hideCoreTool can be read off invocationCallOrder.
    const realToggle = useLogsStore.getState().togglePane
    const togglePane = vi.fn((id: string) => realToggle(id))
    useLogsStore.setState({ togglePane })
    try {
      render()
      openHideSubmenu('logs')
      click(must('menu-hide-everywhere'))
      expect(byTestId('confirm-hide')).toBeNull()
      expect(hideCalls()).toEqual([['logs', 'everywhere', 's-1']])
      expect(togglePane).toHaveBeenCalledTimes(1)
      expect(togglePane).toHaveBeenCalledWith('s-1')
      expect(togglePane.mock.invocationCallOrder[0]).toBeLessThan(BAR.hideCoreTool.mock.invocationCallOrder[0])
      expect(useLogsStore.getState().bySessionId['s-1']?.isOpen).toBe(false)
    } finally {
      useLogsStore.setState({ togglePane: realToggle })
    }
  })

  it('Snap: "Hide this tool ▸ In this session" hides at once with no confirm, and the next render draws no Snap', () => {
    render()
    expect(byTestId('snap-mock', must('core-tool-snap'))).not.toBeNull()
    openHideSubmenu('snap')
    click(must('menu-hide-session'))
    expect(byTestId('confirm-hide')).toBeNull()
    expect(byTestId('core-tool-menu')).toBeNull()
    expect(hideCalls()).toEqual([['snap', 'session', 's-1']])
    render()
    expect(byTestId('core-tool-snap')).toBeNull()
    expect(byTestId('snap-mock')).toBeNull()
    // Its neighbours are untouched.
    expect(byTestId('core-tool-canvas')).not.toBeNull()
    expect(byTestId('core-tool-logs')).not.toBeNull()
  })

  it('a hide from a bar whose PTY is not the session (the Partner pane) is keyed by the SESSION id, and both bars of that session read it', () => {
    render({ sessionId: 'pty-1', parentSessionId: 's-1' })
    openHideSubmenu('logs')
    click(must('menu-hide-session'))
    expect(hideCalls()).toEqual([['logs', 'session', 's-1']])
    expect(BAR.state.hiddenCoreTools.bySession).toEqual({ 's-1': ['logs'] })
    // The same bar, re-rendered: gone.
    render({ sessionId: 'pty-1', parentSessionId: 's-1' })
    expect(byTestId('core-tool-logs')).toBeNull()
    // The session's main bar: gone too -- one session, one hide.
    render({ sessionId: 's-1', parentSessionId: 's-1' })
    expect(byTestId('core-tool-logs')).toBeNull()
    expect(byTestId('core-tool-canvas')).not.toBeNull()
  })

  it('Partner: asks first; "Hide in this session" closes the partner pane BEFORE hiding', () => {
    const onTogglePartner = vi.fn()
    render(PARTNER_PROPS(onTogglePartner))
    expect(byTestId('partner-toggle')).not.toBeNull()
    openHideSubmenu('partner')
    click(must('menu-hide-session'))
    const card = must('confirm-hide')
    expect(must('confirm-hide-title', card).textContent).toBe('Hide the Partner tool?')
    expect(must('confirm-hide-body', card).textContent).toContain('Buttons that run in the partner shell still open it when you click them.')
    // Nothing has happened yet: the menu is gone, the hide is pending.
    expect(byTestId('core-tool-menu')).toBeNull()
    expect(BAR.hideCoreTool).not.toHaveBeenCalled()
    expect(onTogglePartner).not.toHaveBeenCalled()
    click(must('confirm-hide-session'))
    expect(onTogglePartner).toHaveBeenCalledTimes(1)
    expect(hideCalls()).toEqual([['partner', 'session', 's-1']])
    expect(onTogglePartner.mock.invocationCallOrder[0]).toBeLessThan(BAR.hideCoreTool.mock.invocationCallOrder[0])
    expect(byTestId('confirm-hide')).toBeNull()
  })

  it('Partner: "Hide everywhere" on the confirm hides with everywhere (the pane still closes first)', () => {
    const onTogglePartner = vi.fn()
    render(PARTNER_PROPS(onTogglePartner))
    openHideSubmenu('partner')
    click(must('menu-hide-everywhere'))
    click(must('confirm-hide-everywhere', must('confirm-hide')))
    expect(hideCalls()).toEqual([['partner', 'everywhere', 's-1']])
    expect(onTogglePartner).toHaveBeenCalledTimes(1)
    expect(onTogglePartner.mock.invocationCallOrder[0]).toBeLessThan(BAR.hideCoreTool.mock.invocationCallOrder[0])
  })

  it('Partner: Cancel on the confirm hides nothing, toggles nothing, and the tool stays on the row', () => {
    const onTogglePartner = vi.fn()
    render(PARTNER_PROPS(onTogglePartner))
    openHideSubmenu('partner')
    click(must('menu-hide-session'))
    click(must('confirm-hide-cancel', must('confirm-hide')))
    expect(byTestId('confirm-hide')).toBeNull()
    expect(BAR.hideCoreTool).not.toHaveBeenCalled()
    expect(onTogglePartner).not.toHaveBeenCalled()
    expect(byTestId('partner-toggle')).not.toBeNull()
  })

  it('Partner: a closed partner pane is not toggled by the hide -- only an open one closes first', () => {
    const onTogglePartner = vi.fn()
    render({ ...PARTNER_PROPS(onTogglePartner), isPartnerActive: false })
    openHideSubmenu('partner')
    click(must('menu-hide-session'))
    click(must('confirm-hide-session', must('confirm-hide')))
    expect(hideCalls()).toEqual([['partner', 'session', 's-1']])
    expect(onTogglePartner).not.toHaveBeenCalled()
  })

  it('a Partner tool the user hid is only off the row: a button that runs in the partner shell still opens it and types there', () => {
    BAR.state = { ...BAR.state, hiddenCoreTools: { everywhere: [], bySession: { 's-1': ['partner'] } } }
    COMMANDS = [{ id: 'c1', label: 'Test', prompt: 'npm test', scope: 'config', configId: 'cfg', target: 'partner', order: 0 }]
    const onTogglePartner = vi.fn()
    render({ partnerEnabled: true, isPartnerActive: false, onTogglePartner, partnerSessionId: 's-1-partner' })
    expect(byTestId('core-tool-partner')).toBeNull()
    expect(byTestId('partner-toggle')).toBeNull()
    const chip = chipById('c1')
    expect(chip).not.toBeNull()
    // The write waits 100 ms for the partner pane to open; drive that clock by hand.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    click(chip!)
    expect(onTogglePartner).toHaveBeenCalledTimes(1)
    expect(ptyWrite()).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(100) })
    expect(ptyWrite()).toHaveBeenCalledTimes(1)
    expect(ptyWrite()).toHaveBeenCalledWith('s-1-partner', 'npm test\r')
  })

  it('Canvas with its pane OPEN: asks first ("Its pane closes first"), then togglePane(session) BEFORE hiding', () => {
    EXCAL.bySessionId = { 's-1': { isOpen: true } }
    render()
    openHideSubmenu('canvas')
    click(must('menu-hide-session'))
    const card = must('confirm-hide')
    expect(must('confirm-hide-title', card).textContent).toBe('Hide the Canvas tool?')
    expect(must('confirm-hide-body', card).textContent).toContain('Its pane closes first')
    expect(EXCAL.togglePane).not.toHaveBeenCalled()
    expect(BAR.hideCoreTool).not.toHaveBeenCalled()
    click(must('confirm-hide-session'))
    expect(EXCAL.togglePane).toHaveBeenCalledWith('s-1')
    expect(hideCalls()).toEqual([['canvas', 'session', 's-1']])
    expect(EXCAL.togglePane.mock.invocationCallOrder[0]).toBeLessThan(BAR.hideCoreTool.mock.invocationCallOrder[0])
  })

  it('Canvas with its pane CLOSED: hides at once, no confirm, the pane is not touched', () => {
    EXCAL.bySessionId = { 's-1': { isOpen: false } }
    render()
    openHideSubmenu('canvas')
    click(must('menu-hide-everywhere'))
    expect(byTestId('confirm-hide')).toBeNull()
    expect(hideCalls()).toEqual([['canvas', 'everywhere', 's-1']])
    expect(EXCAL.togglePane).not.toHaveBeenCalled()
  })

  it('Browser with its pane OPEN: asks first, then setOpen(key, false) BEFORE hiding', () => {
    WEBVIEW.bySessionId = { 's-1': { isOpen: true } }
    render()
    openHideSubmenu('browser')
    click(must('menu-hide-session'))
    const card = must('confirm-hide')
    expect(must('confirm-hide-title', card).textContent).toBe('Hide the Browser tool?')
    expect(must('confirm-hide-body', card).textContent).toContain('Its pane closes first')
    expect(WEBVIEW.setOpen).not.toHaveBeenCalled()
    expect(BAR.hideCoreTool).not.toHaveBeenCalled()
    click(must('confirm-hide-session'))
    expect(WEBVIEW.setOpen).toHaveBeenCalledWith('s-1', false)
    expect(hideCalls()).toEqual([['browser', 'session', 's-1']])
    expect(WEBVIEW.setOpen.mock.invocationCallOrder[0]).toBeLessThan(BAR.hideCoreTool.mock.invocationCallOrder[0])
  })

  it('after a session hide the tool is off the row and the bar menu "Show hidden tools" brings it back in THIS session', () => {
    const onTogglePartner = vi.fn()
    render(PARTNER_PROPS(onTogglePartner))
    openHideSubmenu('partner')
    click(must('menu-hide-session'))
    click(must('confirm-hide-session'))
    render(PARTNER_PROPS(onTogglePartner))
    expect(byTestId('partner-toggle')).toBeNull()
    expect(byTestId('core-tool-partner')).toBeNull()
    // Right-click the bar background (not a chip): Show hidden tools ▸ Show Partner.
    rightClick(must('command-bar'))
    const menu = must('bar-menu')
    const showHidden = must('bar-show-hidden', menu)
    expect(showHidden.getAttribute('aria-disabled')).toBeNull()
    click(showHidden)
    click(must('bar-show-partner', menu))
    expect(BAR.showCoreTool).toHaveBeenCalledTimes(1)
    expect(BAR.showCoreTool).toHaveBeenCalledWith('partner', 'session', 's-1')
  })

  it('after an everywhere hide, "Show hidden tools" restores it everywhere', () => {
    const onTogglePartner = vi.fn()
    render(PARTNER_PROPS(onTogglePartner))
    openHideSubmenu('partner')
    click(must('menu-hide-everywhere'))
    click(must('confirm-hide-everywhere'))
    render(PARTNER_PROPS(onTogglePartner))
    expect(byTestId('core-tool-partner')).toBeNull()
    rightClick(must('command-bar'))
    click(must('bar-show-hidden'))
    click(must('bar-show-partner'))
    expect(BAR.showCoreTool).toHaveBeenCalledWith('partner', 'everywhere', 's-1')
  })
})

describe('Part B -- the real commandBarStore rules the bar leans on', () => {
  const store = realBar.useCommandBarStore
  const fresh = () => ({ collapsedSectionIds: [], barCollapsed: false, overflow: 'fold' as const, hiddenCoreTools: emptyHidden(), upgradeReviewVersion: 0 })

  beforeEach(() => {
    store.setState({ state: fresh(), isLoaded: false })
    vi.mocked(saveConfigNow).mockClear()
  })

  it('hiding the same tool twice records it once, in either scope, and the WHOLE state is what gets written', () => {
    store.getState().hideCoreTool('logs', 'everywhere', 's-1')
    store.getState().hideCoreTool('logs', 'everywhere', 's-2')
    store.getState().hideCoreTool('canvas', 'session', 's-1')
    store.getState().hideCoreTool('canvas', 'session', 's-1')
    expect(store.getState().state.hiddenCoreTools).toEqual({ everywhere: ['logs'], bySession: { 's-1': ['canvas'] } })
    expect(saveConfigNow).toHaveBeenCalled()
    expect(saveConfigNow).toHaveBeenLastCalledWith('commandBarUi', store.getState().state)
  })

  it('showing a tool everywhere forgets every hide of it, per-session ones included, and drops emptied session keys', () => {
    store.setState({ state: { ...fresh(), hiddenCoreTools: { everywhere: ['logs', 'snap'], bySession: { 's-1': ['logs', 'canvas'], 's-2': ['logs'] } } } })
    store.getState().showCoreTool('logs', 'everywhere')
    expect(store.getState().state.hiddenCoreTools).toEqual({ everywhere: ['snap'], bySession: { 's-1': ['canvas'] } })
    expect(saveConfigNow).toHaveBeenCalledWith('commandBarUi', store.getState().state)
  })

  it('showing a tool in one session touches only that session and drops the key once it is empty', () => {
    store.setState({ state: { ...fresh(), hiddenCoreTools: { everywhere: ['logs'], bySession: { 's-1': ['logs'], 's-2': ['logs', 'browser'] } } } })
    store.getState().showCoreTool('logs', 'session', 's-1')
    expect(store.getState().state.hiddenCoreTools).toEqual({ everywhere: ['logs'], bySession: { 's-2': ['logs', 'browser'] } })
    store.getState().showCoreTool('logs', 'session', 's-2')
    expect(store.getState().state.hiddenCoreTools.bySession).toEqual({ 's-2': ['browser'] })
  })

  it('a tool counts as hidden here when it is hidden everywhere or in THIS session, and is listed once', () => {
    store.setState({ state: { ...fresh(), hiddenCoreTools: { everywhere: ['snap'], bySession: { 's-1': ['logs', 'snap'], 's-2': ['browser'] } } } })
    const s = store.getState()
    expect(s.isCoreToolHidden('snap', 's-9')).toBe(true)
    expect(s.isCoreToolHidden('logs', 's-1')).toBe(true)
    expect(s.isCoreToolHidden('logs', 's-9')).toBe(false)
    expect(s.isCoreToolHidden('browser', 's-1')).toBe(false)
    expect(s.hiddenToolsFor('s-1')).toEqual(['snap', 'logs'])
    expect(s.hiddenToolsFor('s-2')).toEqual(['snap', 'browser'])
    expect(s.hiddenToolsFor('s-9')).toEqual(['snap'])
  })

  it('the dead-session sweep forgets hides of sessions that are gone and writes once; with nothing to forget it writes nothing', () => {
    store.setState({ state: { ...fresh(), hiddenCoreTools: { everywhere: ['logs'], bySession: { 's-1': ['canvas'], 'dead': ['logs'] } } } })
    store.getState().reconcile(['s-1', 's-3'])
    expect(store.getState().state.hiddenCoreTools).toEqual({ everywhere: ['logs'], bySession: { 's-1': ['canvas'] } })
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
    expect(saveConfigNow).toHaveBeenCalledWith('commandBarUi', store.getState().state)
    vi.mocked(saveConfigNow).mockClear()
    const before = store.getState().state
    store.getState().reconcile(['s-1', 's-3'])
    expect(store.getState().state).toBe(before)
    expect(saveConfigNow).not.toHaveBeenCalled()
  })

  it('a damaged command-bar file loads as "everything shown": unknown tools go, malformed parts go, garbage is the defaults', () => {
    const { coerceCommandBarUi } = realBar
    // Unknown ids go; a non-array or emptied session entry goes with its key.
    expect(coerceCommandBarUi({
      hiddenCoreTools: { everywhere: ['logs', 'bogus', 3, null], bySession: { 's-1': ['canvas', 'nope'], 's-2': 'logs', 's-3': ['bogus'], 's-4': null } },
    }).hiddenCoreTools).toEqual({ everywhere: ['logs'], bySession: { 's-1': ['canvas'] } })
    // bySession that is not an object (an array, a string) → nothing hidden per session.
    expect(coerceCommandBarUi({ hiddenCoreTools: { everywhere: ['snap'], bySession: ['logs'] } }).hiddenCoreTools).toEqual({ everywhere: ['snap'], bySession: {} })
    // An ARRAY of lists must not leak in as the session key "0".
    const arrayBySession = coerceCommandBarUi({ hiddenCoreTools: { everywhere: ['snap'], bySession: [['snap']] } }).hiddenCoreTools
    expect(arrayBySession).toEqual({ everywhere: ['snap'], bySession: {} })
    expect(Object.keys(arrayBySession.bySession)).not.toContain('0')
    expect(coerceCommandBarUi({ hiddenCoreTools: { bySession: 'logs' } }).hiddenCoreTools).toEqual({ everywhere: [], bySession: {} })
    // Garbage at any level → everything shown, defaults everywhere.
    for (const bad of [null, undefined, {}, { hiddenCoreTools: 'x' }, { hiddenCoreTools: ['logs'] }, { hiddenCoreTools: 7 }]) {
      expect(coerceCommandBarUi(bad as never)).toEqual(fresh())
    }
    expect(coerceCommandBarUi({ overflow: 'sideways', collapsedSectionIds: 'a', barCollapsed: 'yes', upgradeReviewVersion: 'later' })).toEqual(fresh())
    // hydrate goes through the same door.
    store.getState().hydrate({ hiddenCoreTools: { everywhere: ['bogus', 'partner'], bySession: { 's-1': 'x' } } })
    expect(store.getState().state.hiddenCoreTools).toEqual({ everywhere: ['partner'], bySession: {} })
    expect(store.getState().isLoaded).toBe(true)
  })
})
