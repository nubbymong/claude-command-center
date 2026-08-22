// @vitest-environment jsdom
/**
 * The per-band "N more" pill and its popover (ADR-018 D5, D8).
 *
 * D5: Global means "every session it can actually run in". Whether a button
 * can run HERE is computed at render time, never stored: one that cannot
 * leaves the row and sits greyed in its band's overflow with a one-line
 * reason -- nothing is deleted, rewritten, or hidden silently.
 * D8: one row by default; what does not fit folds into the pill -- Global
 * gives way FIRST (from its end, even when its own chips fit), Session last,
 * pinned never, and the hook keeps room for the pill itself; `wrap2` lets the
 * row take a second line first and folds only what lands on a third. The
 * popover groups by section, grows a filter once there is enough to filter,
 * runs a row on click or Enter (never a greyed one), right-click opens the
 * button's own menu, and "Manage all…" opens Settings → Custom Commands.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { foldForWidth, type FoldBand } from '../../../src/renderer/components/command-bar/useBandFolding'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mutable fixtures: a test sets them BEFORE rendering; the store mocks read
// them at call time rather than closing over a snapshot.
let COMMANDS: Array<Record<string, unknown>> = []
let SECTIONS: Array<Record<string, unknown>> = []
let SESSIONS: Array<Record<string, unknown>> = []
let BAR_STATE: Record<string, unknown> = {}

const localClaude = () => [{ id: 's-1', label: 'Box', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet', configId: 'cfg', shellOnly: false }]
const terminalOnly = () => [{ ...localClaude()[0], shellOnly: true }]
const freshBarState = () => ({ collapsedSectionIds: [], barCollapsed: false, overflow: 'fold', hiddenCoreTools: { everywhere: [], bySession: {} } })

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: SESSIONS, activeSessionId: 's-1', updateSession: vi.fn() }),
}))

const storeFns = {
  addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(), reorderCommands: vi.fn(),
  moveCommand: vi.fn(), setCommandSection: vi.fn(), togglePinned: vi.fn(), clearReview: vi.fn(),
  addSection: vi.fn(), updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
}
vi.mock('../../../src/renderer/stores/commandStore', () => {
  const state = () => ({ commands: COMMANDS, sections: SECTIONS, ...storeFns })
  return { useCommandStore: Object.assign(() => state(), { getState: state }) }
})

const barFns = { toggleSection: vi.fn(), setOverflow: vi.fn(), hideCoreTool: vi.fn(), showCoreTool: vi.fn(), setBarCollapsed: vi.fn() }
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: BAR_STATE, ...barFns }),
}))

const webviewState = { startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), navigate: vi.fn(), setOpen: vi.fn(), bySessionId: {} }
vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: Object.assign((sel: any) => sel(webviewState), { getState: () => webviewState }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))

// Keep the setup file's electronAPI (registry, config, …) and override only the
// two surfaces the bar writes to.
const ptyWrite = vi.fn()
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: { write: ptyWrite },
  credentials: { save: vi.fn(), delete: vi.fn() },
  // The Notes tool in Core lists names on mount; a never-settling list keeps it quiet.
  notes: { list: vi.fn(() => new Promise(() => {})), save: vi.fn(), delete: vi.fn() },
}

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

let container: HTMLDivElement
let root: Root
let layoutSpy: ReturnType<typeof vi.spyOn> | null = null

const render = (props: Record<string, unknown> = {}) => {
  act(() => {
    root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg', ...props } as never))
  })
}
const byTestId = (id: string, within: ParentNode = container) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const allByTestId = (id: string, within: ParentNode = container) => Array.from(within.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const chipIds = (within: ParentNode = container) => allByTestId('command-chip', within).map((b) => b.dataset.commandId)
const click = (el: Element | null | undefined) => { expect(el, 'element to click').toBeTruthy(); act(() => { (el as HTMLElement).click() }) }
const rightClick = (el: Element | null | undefined) => {
  expect(el, 'element to right-click').toBeTruthy()
  act(() => { el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })) })
}
const key = (el: Element | null | undefined, k: string, init: KeyboardEventInit = {}) => {
  expect(el, 'element to key').toBeTruthy()
  act(() => { el!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })) })
}
const openOverflow = (band: 'global' | 'config') => {
  click(byTestId(`command-more-${band}`))
  const dlg = byTestId('command-overflow')
  expect(dlg, 'overflow popover').not.toBeNull()
  return dlg!
}
const overflowIds = (dlg: HTMLElement) => allByTestId('command-overflow-item', dlg).map((i) => i.dataset.commandId)
const typeInto = (input: HTMLInputElement, text: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
/** Group headers inside the popover ("No section" / a section name). */
const groupHeaders = (dlg: HTMLElement) => allByTestId('command-overflow-group', dlg).map((d) => d.textContent?.trim())

/**
 * jsdom lays nothing out, and the folding hook treats a zero-width row as
 * "nothing to fold". This stub gives the row a width and sits the chips
 * left-to-right in DOM order, `step` px apart -- so when a chip folds (leaves
 * the DOM) the ones after it slide left, exactly as a flex row would.
 * `lineTop(i)` puts the i-th chip on a line (for `wrap2`); default: one line.
 */
interface LayoutOpts { rowWidth?: number; step?: number; chipWidth?: number; chipHeight?: number; lineTop?: (i: number) => number }
const installLayout = ({ rowWidth = 600, step = 120, chipWidth = 110, chipHeight = 22, lineTop = () => 0 }: LayoutOpts = {}) => {
  const zero = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
  layoutSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const testid = this.getAttribute('data-testid')
    if (testid === 'command-row') return { ...zero, right: rowWidth, width: rowWidth, bottom: chipHeight, height: chipHeight } as DOMRect
    if (testid === 'command-chip') {
      const row = this.closest('[data-testid="command-row"]')
      const i = row ? Array.from(row.querySelectorAll('[data-testid="command-chip"]')).indexOf(this) : -1
      if (i === -1) return zero as DOMRect
      const left = i * step
      const top = lineTop(i)
      return { ...zero, left, x: left, right: left + chipWidth, width: chipWidth, top, y: top, bottom: top + chipHeight, height: chipHeight } as DOMRect
    }
    return zero as DOMRect
  })
}

const secretGlobal = (n: number, label = `Secret ${n}`) => ({ id: `sec${n}`, label, prompt: `deploy ${n}`, scope: 'global', hasSecretArg: true })
const secretSession = (n: number, label = `Session secret ${n}`) => ({ id: `csec${n}`, label, prompt: `ship ${n}`, scope: 'config', configId: 'cfg', hasSecretArg: true })
/** n loose Global prompts g1..gn, 120 px apart under the stub. */
const globals = (n: number) => Array.from({ length: n }, (_, k) => k + 1).map((i) => ({ id: `g${i}`, label: `Global ${i}`, prompt: `say ${i}`, scope: 'global', order: i }))
const sessions = (n: number) => Array.from({ length: n }, (_, k) => k + 1).map((i) => ({ id: `c${i}`, label: `Session ${i}`, prompt: `run ${i}`, scope: 'config', configId: 'cfg', order: i }))

beforeEach(() => {
  COMMANDS = []
  SECTIONS = []
  SESSIONS = localClaude()
  BAR_STATE = freshBarState()
  ptyWrite.mockClear()
  for (const f of Object.values(storeFns)) f.mockClear()
  for (const f of Object.values(barFns)) f.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  layoutSpy?.mockRestore()
  layoutSpy = null
})

describe('a button that cannot run here leaves the row and the pill says so (D5)', () => {
  it('a Global legacy button carrying a secret (no kind, aimed at the main pane) is a shell line, so on an agent session it cannot run here', () => {
    // A secret only ever rode a shell line (ADR-009 pass on #386): the record
    // is read as one, and an agent's main pane is not a shell.
    COMMANDS = [secretGlobal(1, 'Deploy'), { id: 'ok', label: 'Plain', prompt: 'hello', scope: 'global' }]
    render()
    const global = byTestId('command-band-global')!
    expect(chipIds(global)).toEqual(['ok'])
    const pill = byTestId('command-more-global', global)
    expect(pill).not.toBeNull()
    expect(pill!.textContent).toContain('1 more')
    expect(pill!.title).toBe('1 more global command (1 cannot run here)')
    const dlg = openOverflow('global')
    const row = byTestId('command-overflow-item', dlg)!
    expect(row.dataset.commandId).toBe('sec1')
    expect(row.dataset.inapplicable).toBe('true')
    expect(row.title).toBe('Deploy — cannot run here: This shell line was made for a terminal-only session; here the main pane is an agent')
  })

  it('a Global prompt (no kind) on a terminal-only session: there is no agent to read it', () => {
    SESSIONS = terminalOnly()
    COMMANDS = [{ id: 'p1', label: 'Explain', prompt: 'explain this', scope: 'global' }]
    render()
    expect(chipIds(byTestId('command-band-global')!)).toEqual([])
    expect(byTestId('command-more-global')!.title).toContain('cannot run here')
    const dlg = openOverflow('global')
    expect(byTestId('command-overflow-item', dlg)!.title).toBe('Explain — cannot run here: No agent in this session to read a prompt')
  })

  it('a shell line aimed at the main pane, seen from an agent session: that line was made for a terminal-only session', () => {
    COMMANDS = [{ id: 'sh', label: 'List', prompt: 'ls -la', scope: 'global', kind: 'shell', target: 'claude' }]
    render()
    expect(chipIds(byTestId('command-band-global')!)).toEqual([])
    const dlg = openOverflow('global')
    expect(byTestId('command-overflow-item', dlg)!.title).toBe('List — cannot run here: This shell line was made for a terminal-only session; here the main pane is an agent')
  })

  it('the popover is a dialog named for its band; clicking a greyed row types nothing and leaves the popover open', () => {
    COMMANDS = [secretGlobal(1)]
    render()
    const dlg = openOverflow('global')
    expect(dlg.getAttribute('role')).toBe('dialog')
    expect(dlg.getAttribute('aria-label')).toBe('More Global commands')
    click(byTestId('command-overflow-item', dlg))
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(byTestId('command-overflow')).not.toBeNull()
  })

  it("the Session band's pill opens a popover named for it that lists only the Session band's entries", () => {
    COMMANDS = [secretGlobal(1, 'Global deploy'), secretSession(1, 'Session deploy')]
    render()
    expect(byTestId('command-more-global')!.textContent).toContain('1 more')
    expect(byTestId('command-more-config')!.textContent).toContain('1 more')
    const dlg = openOverflow('config')
    expect(dlg.getAttribute('aria-label')).toBe('More Session commands')
    const rows = allByTestId('command-overflow-item', dlg)
    expect(rows.map((r) => r.dataset.commandId)).toEqual(['csec1'])
    expect(rows[0].dataset.inapplicable).toBe('true')
    expect(rows[0].title).toBe('Session deploy — cannot run here: This shell line was made for a terminal-only session; here the main pane is an agent')
  })
})

describe('the popover groups by section (D8)', () => {
  it('a sectioned button sits under its section name, the loose one under "No section", section first', () => {
    SECTIONS = [{ id: 'sec-a', name: 'Release', scope: 'global', color: '#f9e2af' }]
    COMMANDS = [secretGlobal(1, 'Loose'), { ...secretGlobal(2, 'Ship'), sectionId: 'sec-a' }]
    render()
    const dlg = openOverflow('global')
    expect(groupHeaders(dlg)).toEqual(['Release', 'No section'])
    const items = allByTestId('command-overflow-item', dlg)
    expect(items.map((i) => i.dataset.commandId)).toEqual(['sec2', 'sec1'])
    // The section header precedes its item; the loose item comes after "No section".
    const headers = allByTestId('command-overflow-group', dlg)
    expect(headers[0].compareDocumentPosition(items[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(headers[1].compareDocumentPosition(items[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('draws no "No section" header when everything is loose (one group needs no label)', () => {
    COMMANDS = [secretGlobal(1), secretGlobal(2)]
    render()
    const dlg = openOverflow('global')
    expect(groupHeaders(dlg)).toEqual([])
    expect(dlg.textContent).not.toContain('No section')
  })
})

describe('the filter box (D8)', () => {
  it("appears once the list is long enough to need one (the bar's threshold: more than five entries)", () => {
    COMMANDS = [1, 2, 3, 4, 5].map((n) => secretGlobal(n))
    render()
    let dlg = openOverflow('global')
    expect(byTestId('command-overflow-filter', dlg)).toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    COMMANDS = [1, 2, 3, 4, 5, 6].map((n) => secretGlobal(n))
    render()
    dlg = openOverflow('global')
    expect(byTestId('command-overflow-filter', dlg)).not.toBeNull()
  })

  it('typing narrows the list, and an empty result says "Nothing matches."', () => {
    COMMANDS = [...[1, 2, 3, 4, 5].map((n) => secretGlobal(n)), secretGlobal(6, 'Zebra')]
    render()
    const dlg = openOverflow('global')
    expect(allByTestId('command-overflow-item', dlg)).toHaveLength(6)
    const input = byTestId('command-overflow-filter', dlg) as HTMLInputElement
    typeInto(input, 'zeb')
    expect(overflowIds(dlg)).toEqual(['sec6'])
    expect(dlg.textContent).not.toContain('Nothing matches.')
    typeInto(input, 'qqq')
    expect(allByTestId('command-overflow-item', dlg)).toHaveLength(0)
    expect(dlg.textContent).toContain('Nothing matches.')
  })

  it('Escape closes the popover', () => {
    COMMANDS = [1, 2, 3, 4, 5, 6].map((n) => secretGlobal(n))
    render()
    const dlg = openOverflow('global')
    key(byTestId('command-overflow-filter', dlg), 'Escape')
    expect(byTestId('command-overflow')).toBeNull()
  })
})

describe('"Manage all…" and the overflow mode', () => {
  it('"Manage all…" asks the app to open Settings on the Custom Commands tab and closes the popover', () => {
    COMMANDS = [secretGlobal(1)]
    render()
    const dlg = openOverflow('global')
    const seen: string[] = []
    const onOpen = (e: Event) => { seen.push((e as CustomEvent<{ tab: string }>).detail.tab) }
    window.addEventListener('app:openSettings', onOpen)
    try {
      click(byTestId('command-overflow-manage', dlg))
    } finally {
      window.removeEventListener('app:openSettings', onOpen)
    }
    expect(seen).toEqual(['commands'])
    expect(byTestId('command-overflow')).toBeNull()
  })

  it('the row is "fold" by default (one line, overflow hidden) and "wrap2" when the store says so (a second line may wrap)', () => {
    COMMANDS = [{ id: 'ok', label: 'Plain', prompt: 'hello', scope: 'global' }]
    render()
    let row = byTestId('command-row')!
    expect(row.dataset.overflow).toBe('fold')
    expect(row.classList.contains('overflow-hidden')).toBe(true)
    expect(row.classList.contains('flex-wrap')).toBe(false)
    expect(byTestId('command-band-global')!.classList.contains('flex-wrap')).toBe(false)
    act(() => { root.unmount() })
    root = createRoot(container)
    BAR_STATE = { ...freshBarState(), overflow: 'wrap2' }
    render()
    row = byTestId('command-row')!
    expect(row.dataset.overflow).toBe('wrap2')
    expect(row.classList.contains('flex-wrap')).toBe(true)
    expect(row.classList.contains('overflow-hidden')).toBe(false)
    expect(byTestId('command-band-global')!.classList.contains('flex-wrap')).toBe(true)
  })
})

describe('folding: what does not fit leaves the row for the pill (D8)', () => {
  // Six Global chips 120 px apart on a 600 px row: the sixth ends at 710 px,
  // past the 594 px edge; it folds, and so does the fifth once the pill's
  // 72 px of room is kept -- the fourth (right edge 470) stays.
  const six = () => globals(6)

  it('chips past the right edge fold from the end of the band; the pill counts them; the result holds across a re-render; a folded one still runs from the popover', () => {
    installLayout()
    COMMANDS = six()
    render()
    const first = chipIds(byTestId('command-band-global')!)
    expect(first).toEqual(['g1', 'g2', 'g3', 'g4'])
    // A second render of the same chip set re-measures and must change nothing.
    render()
    const global = byTestId('command-band-global')!
    expect(chipIds(global)).toEqual(first)
    const pill = byTestId('command-more-global', global)!
    expect(pill.textContent).toContain('2 more')
    expect(pill.title).toBe('2 more global commands')
    const dlg = openOverflow('global')
    const items = allByTestId('command-overflow-item', dlg)
    expect(items.map((i) => i.dataset.commandId)).toEqual(['g5', 'g6'])
    expect(items.every((i) => i.dataset.inapplicable === undefined)).toBe(true)
    click(items[0])
    expect(ptyWrite).toHaveBeenCalledWith('s-1', 'say 5\r')
    expect(byTestId('command-overflow')).toBeNull()
  })

  it('a pinned chip never folds, even when it sits past the edge', () => {
    installLayout()
    SECTIONS = [{ id: 'late', name: 'Late', scope: 'global' }]
    // The pinned chip is in a section, so it is drawn AFTER the six loose chips (index 6, right edge 830 px).
    COMMANDS = [...six(), { id: 'pin', label: 'Pinned', prompt: 'pinned', scope: 'global', order: 7, pinned: true, sectionId: 'late' }]
    render()
    const global = byTestId('command-band-global')!
    const ids = chipIds(global)
    expect(ids).toContain('pin')
    expect(ids).not.toContain('g5')
    expect(ids).not.toContain('g6')
    // The loose chips give way from their END, and the pinned one never does --
    // even though it is the chip actually past the edge. (The hook also keeps
    // room for the "N more" pill, so the exact count of loose chips that leave
    // is the row's business, not this test's.)
    const dlg = openOverflow('global')
    const folded = overflowIds(dlg)
    expect(folded).not.toContain('pin')
    expect(folded).toEqual(expect.arrayContaining(['g5', 'g6']))
    expect(folded.every((id) => id!.startsWith('g'))).toBe(true)
  })

  it('nothing folds while the row is wide enough', () => {
    installLayout({ rowWidth: 2000 })
    COMMANDS = six()
    render()
    expect(chipIds(byTestId('command-band-global')!)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6'])
    expect(byTestId('command-more-global')).toBeNull()
  })

  it('a changed chip set is measured from scratch: chips that folded before come back when they now fit', () => {
    installLayout()
    COMMANDS = six()
    render()
    expect(chipIds(byTestId('command-band-global')!)).toEqual(['g1', 'g2', 'g3', 'g4'])
    // Delete g2-g4 (a new signature): g5 and g6 now sit at 120 px and 240 px -- on the row again.
    COMMANDS = six().filter((c) => ['g1', 'g5', 'g6'].includes(c.id))
    render()
    expect(chipIds(byTestId('command-band-global')!)).toEqual(['g1', 'g5', 'g6'])
    expect(byTestId('command-more-global')).toBeNull()
  })

  it('Global gives way first: when the row overflows, the Session band keeps its chip and only Global shows a pill', () => {
    installLayout()
    // Seven chips on a 600 px row: the Session chip is the one past the edge
    // (index 6, right edge 830), but Global folds from ITS end until the row
    // fits -- g6, g5, then g4 once the pill's room is kept -- and the Session
    // chip slides back to 360..470 px.
    COMMANDS = [...six(), ...sessions(1)]
    render()
    const config = byTestId('command-band-config')!
    expect(chipIds(config)).toEqual(['c1'])
    expect(byTestId('command-more-config')).toBeNull()
    const global = byTestId('command-band-global')!
    expect(chipIds(global)).toEqual(['g1', 'g2', 'g3'])
    const pill = byTestId('command-more-global', global)
    expect(pill).not.toBeNull()
    expect(pill!.textContent).toContain('3 more')
    expect(overflowIds(openOverflow('global'))).toEqual(['g4', 'g5', 'g6'])
  })

  it('Session gives way only once Global has nothing left to fold: with every Global chip pinned, the Session band folds from its end', () => {
    installLayout()
    // Two pinned Global chips + five Session chips = seven on the row; c5 ends
    // at 830 px. Global has nothing it may fold, so Session gives c5, c4, c3.
    COMMANDS = [...globals(2).map((c) => ({ ...c, pinned: true })), ...sessions(5)]
    render()
    const global = byTestId('command-band-global')!
    expect(chipIds(global)).toEqual(['g1', 'g2'])
    expect(byTestId('command-more-global')).toBeNull()
    const config = byTestId('command-band-config')!
    expect(chipIds(config)).toEqual(['c1', 'c2'])
    const pill = byTestId('command-more-config', config)
    expect(pill).not.toBeNull()
    expect(pill!.textContent).toContain('3 more')
    const dlg = openOverflow('config')
    expect(dlg.getAttribute('aria-label')).toBe('More Session commands')
    expect(overflowIds(dlg)).toEqual(['c3', 'c4', 'c5'])
  })
})

describe('wrap2: the row may take a second line; only a third line folds (D8)', () => {
  // Five chips per line. The hook counts a chip as "on the third line" once its
  // top sits at least 2 × (chip height + 6) + 6 = 62 px below the row's top
  // (22 px chips), so line three is placed at 64 px here; line two at 32 px
  // stays well inside the allowance.
  const THREE_LINES = (i: number) => (i < 5 ? 0 : i < 10 ? 32 : 64)
  beforeEach(() => { BAR_STATE = { ...freshBarState(), overflow: 'wrap2' } })

  it('twelve chips: what lands on the third line folds into the pill and the first two lines stay', () => {
    installLayout({ lineTop: THREE_LINES })
    COMMANDS = globals(12)
    render()
    const global = byTestId('command-band-global')!
    // g11 and g12 are on line three. g10 leaves with them: the hook keeps
    // 72 px of room on line two for the pill that now appears there.
    expect(chipIds(global)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'])
    const pill = byTestId('command-more-global', global)
    expect(pill).not.toBeNull()
    expect(pill!.textContent).toContain('3 more')
    expect(overflowIds(openOverflow('global'))).toEqual(['g10', 'g11', 'g12'])
  })

  it('eight chips on two lines: nothing folds and there is no pill', () => {
    installLayout({ lineTop: THREE_LINES })
    COMMANDS = globals(8)
    render()
    expect(chipIds(byTestId('command-band-global')!)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'])
    expect(byTestId('command-more-global')).toBeNull()
  })

  it('a pinned chip on the third line never folds; the loose chips around it do', () => {
    installLayout({ lineTop: THREE_LINES })
    SECTIONS = [{ id: 'late', name: 'Late', scope: 'global' }]
    // Eleven loose chips, then the pinned one in a section (drawn last): g11
    // and 'pin' both start on line three.
    COMMANDS = [...globals(11), { id: 'pin', label: 'Pinned', prompt: 'pinned', scope: 'global', order: 12, pinned: true, sectionId: 'late' }]
    render()
    const ids = chipIds(byTestId('command-band-global')!)
    expect(ids).toContain('pin')
    expect(ids).not.toContain('g11')
    expect(ids.slice(0, 5)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5'])
    const folded = overflowIds(openOverflow('global'))
    expect(folded).not.toContain('pin')
    expect(folded).toContain('g11')
    expect(folded.every((id) => id!.startsWith('g'))).toBe(true)
  })
})

describe('foldForWidth: the pure fold rule the hook applies', () => {
  const bands = (pinnedGlobal: string[] = []): FoldBand[] => [
    { key: 'global', ids: ['g1', 'g2', 'g3', 'g4'], pinned: new Set(pinnedGlobal) },
    { key: 'config', ids: ['c1', 'c2'], pinned: new Set() },
  ]
  const w110 = () => 110
  const noPill = () => false
  const asLists = (r: Record<string, Set<string>>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v]]))

  it('takes from the END of the first band and keeps room for the pill: 100 px needed → g4, then g3 (110+4−72 = 42 < 100), then stop', () => {
    // remaining: 100 − 114 + 72 (pill) = 58 > 0 → g3 → −56 → stop.
    expect(asLists(foldForWidth(bands(), 100, w110, noPill))).toEqual({ global: ['g4', 'g3'], config: [] })
  })

  it('skips pinned chips: with g3 and g4 pinned it folds g2 then g1, never touching the Session band', () => {
    expect(asLists(foldForWidth(bands(['g3', 'g4']), 100, w110, noPill))).toEqual({ global: ['g2', 'g1'], config: [] })
  })

  it('touches the Session band only once Global has nothing left: with every Global chip pinned it folds c2, then c1', () => {
    expect(asLists(foldForWidth(bands(['g1', 'g2', 'g3', 'g4']), 100, w110, noPill))).toEqual({ global: [], config: ['c2', 'c1'] })
  })

  it('reserves no pill room for a band that already shows one: 100 px needed → g4 alone', () => {
    expect(asLists(foldForWidth(bands(), 100, w110, (k) => k === 'global'))).toEqual({ global: ['g4'], config: [] })
  })

  it('folds nothing when nothing is needed, and still answers for every band', () => {
    expect(asLists(foldForWidth(bands(), 0, w110, noPill))).toEqual({ global: [], config: [] })
    expect(asLists(foldForWidth(bands(), -40, w110, noPill))).toEqual({ global: [], config: [] })
  })
})

describe('running a row from the popover (D5, D8)', () => {
  const six = () => globals(6)

  it('Enter runs the highlighted row: ArrowDown then Enter types the second entry and closes the popover', () => {
    installLayout()
    COMMANDS = six()
    render()
    const dlg = openOverflow('global')
    expect(overflowIds(dlg)).toEqual(['g5', 'g6'])
    key(dlg, 'ArrowDown')
    key(dlg, 'Enter')
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(ptyWrite).toHaveBeenCalledWith('s-1', 'say 6\r')
    expect(byTestId('command-overflow')).toBeNull()
  })

  it('a greyed row\'s own menu cannot run it either: Run and Run with arguments are disabled with the reason, and nothing is typed (D5)', () => {
    // ADR-009 pass on #386: the popover refused the click, but the row's
    // right-click menu still offered Run. Fixture: a legacy Global secret
    // button (no kind, aimed at the main pane) on an AGENT session -- inapplicable.
    COMMANDS = [{ id: 'sec1', label: 'Deploy', prompt: 'deploy 1', scope: 'global', hasSecretArg: true, defaultArgs: ['-T', '{secret}'] }, { id: 'ok', label: 'Plain', prompt: 'hello', scope: 'global' }]
    render()
    const dlg = openOverflow('global')
    const row = byTestId('command-overflow-item', dlg)!
    expect(row.dataset.commandId).toBe('sec1')
    expect(row.dataset.inapplicable).toBe('true')
    rightClick(row)
    const menu = byTestId('command-menu')!
    const isDisabled = (el: HTMLElement | null) => !!el && (el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') === 'true'
    expect(isDisabled(byTestId('menu-run', menu)), 'Run disabled').toBe(true)
    expect(isDisabled(byTestId('menu-run-args', menu)), 'Run with arguments disabled').toBe(true)
    expect(menu.textContent).toContain('This shell line was made for a terminal-only session; here the main pane is an agent')
    // Even if something reaches the handler, nothing is typed.
    act(() => { byTestId('menu-run', menu)!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('Enter on a greyed row types nothing and leaves the popover open; the next runnable row still runs', () => {
    installLayout()
    COMMANDS = [...six(), secretGlobal(1)]
    render()
    const dlg = openOverflow('global')
    // Folded rows first, then the one that cannot run here.
    expect(overflowIds(dlg)).toEqual(['g5', 'g6', 'sec1'])
    key(dlg, 'ArrowDown')
    key(dlg, 'ArrowDown')
    key(dlg, 'Enter')
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(byTestId('command-overflow')).not.toBeNull()
    key(dlg, 'ArrowUp')
    key(dlg, 'Enter')
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(ptyWrite).toHaveBeenCalledWith('s-1', 'say 6\r')
    expect(byTestId('command-overflow')).toBeNull()
  })

  it("right-click on a row opens that button's own menu and closes the popover", () => {
    installLayout()
    COMMANDS = six()
    render()
    const dlg = openOverflow('global')
    rightClick(allByTestId('command-overflow-item', dlg)[0])
    expect(byTestId('command-overflow')).toBeNull()
    const menu = byTestId('command-menu')
    expect(menu).not.toBeNull()
    expect(byTestId('menu-title', menu!)!.textContent).toBe('Global 5')
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('each row carries the mark of where it runs, the same mark its chip would sit behind', () => {
    installLayout()
    COMMANDS = [...globals(5), { id: 'g6', label: 'Global 6', prompt: 'ls', scope: 'global', order: 6, target: 'partner' }]
    render()
    const dlg = openOverflow('global')
    const items = allByTestId('command-overflow-item', dlg)
    expect(items.map((i) => i.dataset.commandId)).toEqual(['g5', 'g6'])
    expect(byTestId('command-cluster-agent', items[0])).not.toBeNull()
    expect(byTestId('command-cluster-partner', items[0])).toBeNull()
    expect(byTestId('command-cluster-partner', items[1])).not.toBeNull()
    expect(byTestId('command-cluster-agent', items[1])).toBeNull()
  })

  it('dismissal is a backdrop MOUSEDOWN, never a click (Ctrl+C fires click events on backdrops -- house rule)', () => {
    installLayout()
    COMMANDS = globals(6)
    render()
    const dlg = openOverflow('global')
    const backdrop = byTestId('command-overflow-backdrop')!
    expect(backdrop.onclick, 'no click handler on the backdrop').toBeNull()
    click(backdrop)
    expect(byTestId('command-overflow'), 'still open after a click on the backdrop').not.toBeNull()
    act(() => { dlg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(byTestId('command-overflow'), 'still open after a mousedown inside').not.toBeNull()
    act(() => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(byTestId('command-overflow')).toBeNull()
    expect(ptyWrite).not.toHaveBeenCalled()
  })
})
