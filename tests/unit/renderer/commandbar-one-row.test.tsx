// @vitest-environment jsdom
/**
 * THE ROW of the one-row command bar (ADR-018 D1, D3, D4, D9, D10).
 *
 * Why these tests: the bar's shape used to change with the session (rows
 * appeared and vanished) and its labels lied about the session (a Codex
 * session said "Claude", an SSH session never said the partner shell is on
 * this PC). These pin the fixed order Add · Core · Global · Session, the one
 * tab stop per band, sections drawn INSIDE their scope band -- and ONLY in
 * it: a Global section or another config's section never leaks into the
 * Session band or a Session chip's "Move to section" list -- the Core-tool
 * matrix (Snap gone on terminal-only, Notes drawn last, hidden tools not
 * drawn, Logs kept on the row but dimmed WITH the reason instead of
 * vanishing), and the words every mark and chip derive from
 * `sessionCapabilities`.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---- mutable fixtures: tests set these BEFORE rendering; the store mocks read
// them at call time rather than closing over a snapshot.
const BASE_SESSION = {
  id: 's-1', label: 'My config', workingDirectory: '/', color: '#89b4fa',
  sessionType: 'local', provider: 'claude', model: 'sonnet', configId: 'cfg',
}
let SESSIONS: Array<Record<string, unknown>> = [BASE_SESSION]

const ALL_COMMANDS = [
  { id: 'g1', label: 'Explain', prompt: 'explain this', scope: 'global' as const, order: 0 },
  { id: 'g2', label: 'Review', prompt: 'review this', scope: 'global' as const, order: 1, sectionId: 'sec-g' },
  { id: 'g3', label: 'Lint', prompt: 'lint this', scope: 'global' as const, order: 2 },
  { id: 'c1', label: 'Test', prompt: 'npm test', scope: 'config' as const, configId: 'cfg', target: 'partner' as const, order: 0 },
  { id: 'c2', label: 'Build', prompt: 'npm run build', scope: 'config' as const, configId: 'cfg', target: 'partner' as const, order: 1, sectionId: 'sec-c' },
  { id: 'c3', label: 'Ask', prompt: 'ask the agent', scope: 'config' as const, configId: 'cfg', target: 'claude' as const, order: 2 },
]
const ALL_SECTIONS = [
  { id: 'sec-g', name: 'Reviews', scope: 'global' as const, color: '#f9e2af' },
  { id: 'sec-c', name: 'Builds', scope: 'config' as const, configId: 'cfg', color: '#a6e3a1' },
]
// Another config's section and its button: saved in the same store, never on THIS bar.
const OTHER_SECTION = { id: 'sec-o', name: 'Other builds', scope: 'config' as const, configId: 'other-cfg', color: '#f38ba8' }
const OTHER_COMMAND = { id: 'o1', label: 'Deploy', prompt: 'deploy it', scope: 'config' as const, configId: 'other-cfg', target: 'partner' as const, order: 0, sectionId: 'sec-o' }
let COMMANDS: Array<Record<string, unknown>> = ALL_COMMANDS
let SECTIONS: Array<Record<string, unknown>> = ALL_SECTIONS

let BAR_STATE: Record<string, unknown> = {
  collapsedSectionIds: [], barCollapsed: false, overflow: 'fold',
  hiddenCoreTools: { everywhere: [], bySession: {} },
}
const barFns = {
  toggleSection: vi.fn(), setOverflow: vi.fn(), hideCoreTool: vi.fn(), showCoreTool: vi.fn(), setBarCollapsed: vi.fn(),
}

// Every store function the bar can call is a vi.fn() so a test can assert calls.
const storeFns = {
  addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(), reorderCommands: vi.fn(),
  moveCommand: vi.fn(), setCommandSection: vi.fn(), togglePinned: vi.fn(), clearReview: vi.fn(),
  addSection: vi.fn(), updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
}

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: SESSIONS, activeSessionId: 's-1', updateSession: vi.fn() }),
}))

vi.mock('../../../src/renderer/stores/commandStore', () => {
  const state = () => ({ commands: COMMANDS, sections: SECTIONS, ...storeFns })
  const useCommandStore = (sel?: any) => (sel ? sel(state()) : state())
  useCommandStore.getState = state
  return { useCommandStore }
})

vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: BAR_STATE, ...barFns }),
}))

vi.mock('../../../src/renderer/stores/webviewStore', () => {
  const state = { startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), navigate: vi.fn(), setOpen: vi.fn(), bySessionId: {} }
  const useWebviewStore = (sel: any) => sel(state)
  useWebviewStore.getState = () => state
  return {
    useWebviewStore,
    pollUrlForContent: vi.fn(() => Promise.resolve(false)),
    probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
  }
})

vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
// Snap renders a MARKER so a test can tell "not drawn" from "drawn but empty".
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => React.createElement('div', { 'data-testid': 'snap-mock' }) }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
// The dialog is a marker that echoes the scope the bar preset for it.
vi.mock('../../../src/renderer/components/CommandDialog', () => ({
  default: (p: { presetScope?: string }) => React.createElement('div', { 'data-testid': 'dialog-mock', 'data-scope': p.presetScope }),
}))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))

// The Notes tool is REAL (it is the Core tool under test); its index is empty.
const notesApi = {
  list: vi.fn(async () => []),
  load: vi.fn(async () => ''),
  save: vi.fn(async () => true),
  delete: vi.fn(async () => true),
  reorder: vi.fn(async () => true),
}
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: { write: vi.fn() },
  credentials: { save: vi.fn(), delete: vi.fn() },
  notes: notesApi,
}

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

let container: HTMLDivElement
let root: Root

// The Notes tool reads its index (`notes.list`) on mount and resolves on
// microtasks; a macrotask tick inside act drains them so no state lands after
// the test looked.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const render = async (props: Record<string, unknown> = {}) => {
  await act(async () => {
    root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg', ...props } as never))
  })
  await flush()
}
/** Unmount and render again on a fresh root (a new session, a changed fixture). */
const remount = async (props: Record<string, unknown> = {}) => {
  act(() => { root.unmount() })
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await render(props)
}

const byTestId = (id: string, within: ParentNode = container) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const allByTestId = (id: string, within: ParentNode = container) => Array.from(within.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const chipById = (id: string, within: ParentNode = container) => within.querySelector<HTMLElement>(`[data-testid="command-chip"][data-command-id="${id}"]`)
const click = (el: Element | null | undefined) => { expect(el).not.toBeNull(); act(() => { (el as HTMLElement).click() }) }
const rightClick = (el: Element | null | undefined) => {
  expect(el).not.toBeNull()
  act(() => { el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 })) })
}
/** True when `a` is drawn before `b` in document order. */
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
/** The Logs button inside its Core wrapper, and whether it is dimmed. */
const logsButton = () => byTestId('core-tool-logs')!.querySelector<HTMLElement>('[data-testid="logs-toggle"]')
const dimmedLogs = () => byTestId('core-tool-logs')!.querySelector<HTMLElement>('[data-dimmed="true"]')

const PARTNER = () => ({ partnerEnabled: true, onTogglePartner: vi.fn(), partnerSessionId: 's-1-partner' })

beforeEach(() => {
  SESSIONS = [BASE_SESSION]
  COMMANDS = ALL_COMMANDS
  SECTIONS = ALL_SECTIONS
  BAR_STATE = { collapsedSectionIds: [], barCollapsed: false, overflow: 'fold', hiddenCoreTools: { everywhere: [], bySession: {} } }
  for (const fn of [...Object.values(storeFns), ...Object.values(barFns)]) fn.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the row: Add · Core · Global · Session, in that order (D1)', () => {
  it('draws Add first, then the Core tools, then the Global band, then the Session band', async () => {
    await render(PARTNER())
    const row = byTestId('command-row')!
    expect(row.firstElementChild).toBe(byTestId('command-add'))
    const wanted = new Set(['command-add', 'command-band-core', 'command-band-global', 'command-band-config'])
    const order = Array.from(row.querySelectorAll<HTMLElement>('[data-testid]')).map((e) => e.dataset.testid!).filter((id) => wanted.has(id))
    expect(order).toEqual(['command-add', 'command-band-core', 'command-band-global', 'command-band-config'])
  })

  it('each band is a toolbar named for its scope with ONE tab stop: the first chip is tabbable, the rest are not', async () => {
    await render()
    const global = byTestId('command-band-global')!
    const session = byTestId('command-band-config')!
    expect(global.getAttribute('role')).toBe('toolbar')
    expect(global.getAttribute('aria-label')).toBe('Global commands')
    expect(session.getAttribute('role')).toBe('toolbar')
    expect(session.getAttribute('aria-label')).toBe('Session commands')
    const globalChips = allByTestId('command-chip', global)
    expect(globalChips.length).toBe(3)
    expect(globalChips.map((c) => c.tabIndex)).toEqual([0, -1, -1])
    const sessionChips = allByTestId('command-chip', session)
    expect(sessionChips.length).toBe(3)
    expect(sessionChips.map((c) => c.tabIndex)).toEqual([0, -1, -1])
  })
})

describe('Add is a split chip', () => {
  it('the Add button opens the dialog preset to the Session scope when the session has a config, Global when it has not', async () => {
    await render()
    click(byTestId('command-add-button'))
    expect(byTestId('dialog-mock')?.getAttribute('data-scope')).toBe('config')
    SESSIONS = [{ ...BASE_SESSION, configId: undefined }]
    await remount({ configId: undefined })
    click(byTestId('command-add-button'))
    expect(byTestId('dialog-mock')?.getAttribute('data-scope')).toBe('global')
  })

  it('the caret opens the Add menu instead of the dialog', async () => {
    await render()
    click(byTestId('command-add-caret'))
    expect(byTestId('add-menu')).not.toBeNull()
    expect(byTestId('dialog-mock')).toBeNull()
  })
})

describe('sections live INSIDE their scope band (D9)', () => {
  it('draws a section label before its chips, a Global section only in the Global band and a config section only in the Session band', async () => {
    await render()
    const global = byTestId('command-band-global')!
    const session = byTestId('command-band-config')!
    const reviews = global.querySelector<HTMLElement>('[data-testid="command-section-label"][data-section-id="sec-g"]')
    const builds = session.querySelector<HTMLElement>('[data-testid="command-section-label"][data-section-id="sec-c"]')
    expect(reviews?.textContent).toBe('Reviews')
    expect(builds?.textContent).toBe('Builds')
    expect(session.querySelector('[data-section-id="sec-g"]')).toBeNull()
    expect(global.querySelector('[data-section-id="sec-c"]')).toBeNull()
    // The label opens the group: it is drawn before the section's chip.
    expect(before(reviews!, chipById('g2', global)!)).toBe(true)
    expect(before(builds!, chipById('c2', session)!)).toBe(true)
    // Loose chips come first; the section group follows them.
    expect(before(chipById('g1', global)!, reviews!)).toBe(true)
  })

  it('the Session band shows THIS config\'s sections only: a Global section and another config\'s section never appear in it, nor in a Session chip\'s "Move to section" list', async () => {
    SECTIONS = [...ALL_SECTIONS, OTHER_SECTION]
    COMMANDS = [...ALL_COMMANDS, OTHER_COMMAND]
    await render()
    const global = byTestId('command-band-global')!
    const session = byTestId('command-band-config')!
    // The other config's button and section are nowhere on this bar.
    expect(chipById('o1')).toBeNull()
    expect(container.querySelector('[data-section-id="sec-o"]')).toBeNull()
    // The Session band: its own section, not the Global one.
    expect(session.querySelector('[data-section-id="sec-c"]')).not.toBeNull()
    expect(session.querySelector('[data-section-id="sec-g"]')).toBeNull()
    expect(global.querySelector('[data-section-id="sec-g"]')).not.toBeNull()
    expect(global.querySelector('[data-section-id="sec-c"]')).toBeNull()

    // A Session chip's Move to section ▸ offers this config's sections only --
    // and picking one files the chip there.
    rightClick(chipById('c1'))
    let menu = byTestId('command-menu')!
    click(byTestId('menu-move-section', menu))
    expect(byTestId('menu-section-none', menu)).not.toBeNull()
    expect(byTestId('menu-section-sec-c', menu)).not.toBeNull()
    expect(byTestId('menu-section-sec-g', menu)).toBeNull()
    expect(byTestId('menu-section-sec-o', menu)).toBeNull()
    click(byTestId('menu-section-sec-c', menu))
    expect(storeFns.setCommandSection).toHaveBeenCalledWith('c1', 'sec-c')
    expect(byTestId('command-menu')).toBeNull()

    // Mirror: a Global chip sees the Global sections only.
    rightClick(chipById('g1'))
    menu = byTestId('command-menu')!
    click(byTestId('menu-move-section', menu))
    expect(byTestId('menu-section-sec-g', menu)).not.toBeNull()
    expect(byTestId('menu-section-sec-c', menu)).toBeNull()
    expect(byTestId('menu-section-sec-o', menu)).toBeNull()
  })

  it('a section in collapsedSectionIds is one chip carrying the count; its buttons leave the row; clicking it asks the store to expand', async () => {
    BAR_STATE = { ...BAR_STATE, collapsedSectionIds: ['sec-g'] }
    await render()
    const global = byTestId('command-band-global')!
    const collapsed = byTestId('command-section-collapsed', global)
    expect(collapsed).not.toBeNull()
    expect(collapsed!.textContent).toContain('Reviews')
    // The count is its own node, exactly the section's button count.
    expect(collapsed!.lastElementChild?.textContent).toBe('1')
    expect(collapsed!.title).toBe('Reviews — 1 button, collapsed. Click to expand.')
    expect(chipById('g2')).toBeNull()
    expect(chipById('g1')).not.toBeNull()
    // The Session band's section is untouched.
    expect(allByTestId('command-section-collapsed', byTestId('command-band-config')!)).toHaveLength(0)
    click(collapsed)
    expect(barFns.toggleSection).toHaveBeenCalledWith('sec-g')
  })
})

describe('Core tools follow the capabilities matrix and the hide list (D3, D9, D10)', () => {
  it('draws Partner only when the feature is on AND the bar can toggle it', async () => {
    await render({ partnerEnabled: true, onTogglePartner: vi.fn() })
    expect(byTestId('partner-toggle')).not.toBeNull()
    expect(byTestId('core-tool-partner')).not.toBeNull()
    await remount({ partnerEnabled: true })
    expect(byTestId('partner-toggle')).toBeNull()
    expect(byTestId('core-tool-partner')).toBeNull()
  })

  it('does not draw a tool hidden everywhere or hidden for THIS session, but keeps one hidden for another session', async () => {
    BAR_STATE = { ...BAR_STATE, hiddenCoreTools: { everywhere: ['logs'], bySession: { 's-1': ['canvas'], 's-other': ['browser'] } } }
    await render()
    expect(byTestId('core-tool-logs')).toBeNull()
    expect(byTestId('core-tool-canvas')).toBeNull()
    expect(byTestId('core-tool-browser')).not.toBeNull()
    // Control: on a live session every wrapper is there.
    BAR_STATE = { ...BAR_STATE, hiddenCoreTools: { everywhere: [], bySession: {} } }
    await remount()
    expect(byTestId('core-tool-snap')).not.toBeNull()
    expect(byTestId('core-tool-logs')).not.toBeNull()
    expect(byTestId('core-tool-canvas')).not.toBeNull()
    expect(byTestId('core-tool-browser')).not.toBeNull()
    expect(byTestId('core-tool-notes')).not.toBeNull()
    expect(byTestId('snap-mock', byTestId('core-tool-snap')!)).not.toBeNull()
  })

  it('on a local Claude session Snap is a wrapped Core tool and Logs is live: not dimmed, no reason in its tooltip', async () => {
    await render()
    const snap = byTestId('core-tool-snap')
    expect(snap).not.toBeNull()
    expect(byTestId('snap-mock', snap!)).not.toBeNull()
    expect(logsButton()).not.toBeNull()
    expect(byTestId('core-tool-logs')!.querySelector('[data-dimmed]')).toBeNull()
    expect(logsButton()!.title).toBe('Open session logs')
  })

  it('the Notes tool is drawn LAST in Core; hidden, it leaves the row and the Add menu loses "Add note…"', async () => {
    await render(PARTNER())
    const core = byTestId('command-band-core')!
    const notes = byTestId('notes-tool', core)
    expect(notes).not.toBeNull()
    expect(notes!.closest('[data-testid^="core-tool-"]')?.getAttribute('data-testid')).toBe('core-tool-notes')
    expect(core.lastElementChild).toBe(byTestId('core-tool-notes', core))
    for (const id of ['core-tool-snap', 'core-tool-canvas', 'core-tool-logs', 'core-tool-browser', 'core-tool-partner']) {
      expect(before(byTestId(id, core)!, byTestId('core-tool-notes', core)!)).toBe(true)
    }
    click(byTestId('command-add-caret'))
    expect(byTestId('add-note', byTestId('add-menu')!)).not.toBeNull()

    BAR_STATE = { ...BAR_STATE, hiddenCoreTools: { everywhere: [], bySession: { 's-1': ['notes'] } } }
    await remount(PARTNER())
    expect(byTestId('core-tool-notes')).toBeNull()
    expect(byTestId('notes-tool')).toBeNull()
    // The hide is per tool: its neighbour is still there, and still last now.
    expect(byTestId('command-band-core')!.lastElementChild).toBe(byTestId('core-tool-partner'))
    click(byTestId('command-add-caret'))
    expect(byTestId('add-menu')).not.toBeNull()
    expect(byTestId('add-note')).toBeNull()
  })

  it('terminal-only: Snap is not drawn, Logs stays dimmed with "a shell has no transcript", Canvas/Browser are there; a Global prompt leaves the row while the config\'s own shell line stays', async () => {
    SESSIONS = [{ ...BASE_SESSION, shellOnly: true }]
    COMMANDS = [
      { id: 'g1', label: 'Explain', prompt: 'explain this', scope: 'global', order: 0 },           // a prompt, no kind, target claude
      { id: 'c3', label: 'Status', prompt: 'git status', scope: 'config', configId: 'cfg', target: 'claude', order: 0 }, // this shell's own line
    ]
    SECTIONS = []
    await render()
    expect(byTestId('core-tool-snap')).toBeNull()
    expect(byTestId('snap-mock')).toBeNull()
    expect(byTestId('core-tool-canvas')).not.toBeNull()
    expect(byTestId('core-tool-browser')).not.toBeNull()
    // Logs does not vanish with the session type (the bar keeps its shape): it
    // stays, dimmed, and its tooltip says why there is nothing to show.
    expect(byTestId('core-tool-logs')).not.toBeNull()
    const logs = dimmedLogs()
    expect(logs).not.toBeNull()
    expect(logs!.getAttribute('title')).toContain('a shell has no transcript')
    // No agent here to read a prompt: the Global prompt is inapplicable and
    // sits in the band's overflow pill, never silently gone.
    expect(chipById('g1')).toBeNull()
    const more = byTestId('command-more-global')
    expect(more).not.toBeNull()
    expect(more!.title).toContain('cannot run here')
    // The Session shell line of this config IS on the row, as a shell line.
    const session = byTestId('command-band-config')!
    const status = chipById('c3', session)
    expect(status).not.toBeNull()
    expect(status!.dataset.kind).toBe('shell')
    expect(byTestId('command-cluster-main-shell', session)?.getAttribute('title')).toBe('These run in this shell')
    expect(byTestId('command-more-config')).toBeNull()
  })
})

describe('the words come from the session, not from a hard-coded "Claude" (D2, D4)', () => {
  it('a Codex session keeps its two select pills, says Codex on the agent mark and the chip, and dims Logs because Codex transcripts are not indexed', async () => {
    SESSIONS = [{ ...BASE_SESSION, provider: 'codex', codexOptions: { permissionsPreset: 'standard', model: 'gpt-5.5' } }]
    await render()
    const row = byTestId('command-row')!
    expect(row.querySelectorAll('select')).toHaveLength(2)
    const agentMarks = allByTestId('command-cluster-agent')
    expect(agentMarks.length).toBeGreaterThan(0)
    for (const m of agentMarks) {
      expect(m.getAttribute('title')).toBe('These run in Codex')
      expect(m.getAttribute('title')).not.toContain('Claude')
    }
    expect(chipById('g1')?.title).toContain('runs in the Codex terminal')
    expect(chipById('g1')?.title).not.toContain('Claude')
    const logs = dimmedLogs()
    expect(logs).not.toBeNull()
    expect(logs!.getAttribute('title')).toContain("Codex transcripts aren't indexed")
  })

  it('an SSH session badges the partner shell and the Partner tool "this PC", names the host on the agent mark, and dims Logs because the transcript lives on the host', async () => {
    SESSIONS = [{ ...BASE_SESSION, sessionType: 'ssh', sshConfig: { host: 'box' } }]
    await render({ sessionType: 'ssh', ...PARTNER() })
    const session = byTestId('command-band-config')!
    const partnerMark = byTestId('command-cluster-partner', session)
    expect(partnerMark).not.toBeNull()
    expect(byTestId('command-machine-badge', partnerMark!)?.textContent).toBe('this PC')
    expect(partnerMark!.getAttribute('title')).toBe('These run in the partner shell — on this PC, not the host')
    expect(byTestId('command-cluster-agent', session)?.getAttribute('title')).toBe('These run in Claude on box')
    const partner = byTestId('partner-toggle')!
    expect(byTestId('command-machine-badge', partner)?.textContent).toBe('this PC')
    expect(chipById('c1')?.title).toContain('runs in the partner shell (this PC)')
    const logs = dimmedLogs()
    expect(logs).not.toBeNull()
    // The reason names the host (ADR-018 D3 / canvas: "lives on build-box").
    expect(logs!.getAttribute('title')).toContain('the transcript lives on box')
  })
})

describe('review marks and pins (D8, D13)', () => {
  it('a command tagged needsReview carries the review mark; a pinned one leads its band', async () => {
    COMMANDS = [
      { id: 'g1', label: 'Explain', prompt: 'explain this', scope: 'global', order: 0 },
      { id: 'g2', label: 'Review', prompt: 'review this', scope: 'global', order: 1, needsReview: ['secret-like-arg'] },
      { id: 'g3', label: 'Lint', prompt: 'lint this', scope: 'global', order: 2, pinned: true },
    ]
    SECTIONS = []
    await render()
    expect(byTestId('command-review-mark', chipById('g2')!)).not.toBeNull()
    expect(byTestId('command-review-mark', chipById('g1')!)).toBeNull()
    const global = byTestId('command-band-global')!
    expect(allByTestId('command-chip', global).map((c) => c.dataset.commandId)).toEqual(['g3', 'g1', 'g2'])
  })
})
