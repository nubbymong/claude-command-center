// @vitest-environment jsdom
/**
 * Drag and keyboard moves on the one-row command bar (ADR-018 D7, D8).
 *
 * The bar never reorders the array itself: every drop turns into ONE store
 * call -- `moveCommand(movedId, beforeId, band, configId)` for a position,
 * `setCommandSection(id, sectionId)` for membership, `reorderSections` for a
 * section label dragged onto another of its own band. Crossing a band is a
 * scope change: nothing is written until the user confirms, and that holds for
 * a chip, for a whole section, and for the keyboard (Alt+Shift+arrow is the
 * cross-band drop). Core is a no-drop zone and nothing in it can be picked up.
 * While a chip is in the air the row keeps its shape: the fold is not
 * re-measured until the drag ends, so the bar never re-fits the terminal under
 * the pointer. These tests pin the exact arguments of each call and the exact
 * wording of each card.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---- fixtures (mutable so a test can change them BEFORE rendering) ----------
const G1 = { id: 'g1', label: 'Global one', prompt: 'one', scope: 'global' as const, order: 0 }
const G2 = { id: 'g2', label: 'Global two', prompt: 'two', scope: 'global' as const, order: 1 }
const G3 = { id: 'g3', label: 'Global three', prompt: 'three', scope: 'global' as const, order: 2, sectionId: 'sec-g' }
const C1 = { id: 'c1', label: 'Session one', prompt: 's-one', scope: 'config' as const, configId: 'cfg', order: 0 }
const C2 = { id: 'c2', label: 'Session two', prompt: 's-two', scope: 'config' as const, configId: 'cfg', order: 1, sectionId: 'sec-c' }
const SEC_G = { id: 'sec-g', name: 'Glob sec', scope: 'global' as const }
const SEC_C = { id: 'sec-c', name: 'Sess sec', scope: 'config' as const, configId: 'cfg' }
/** Six loose Global chips, for the folding tests (120 px apart on a 600 px row: the last two fold). */
const six = () => [1, 2, 3, 4, 5, 6].map((n) => ({ id: `g${n}`, label: `Global ${n}`, prompt: `say ${n}`, scope: 'global' as const, order: n }))

let COMMANDS: Array<Record<string, unknown>> = []
let SECTIONS: Array<Record<string, unknown>> = []

// Stable spies so the component's `store.moveCommand(...)` hits the same fn we assert on.
const moveCommand = vi.fn()
const setCommandSection = vi.fn()
const reorderSections = vi.fn()
const togglePinned = vi.fn()
const clearReview = vi.fn()
const addCommand = vi.fn()
const updateCommand = vi.fn()
const removeCommand = vi.fn()
const updateSection = vi.fn()
const removeSection = vi.fn()
const addSection = vi.fn()

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({
      sessions: [{ id: 's-1', label: 'My config', workingDirectory: '/', color: '#89b4fa',
        sessionType: 'local', provider: 'claude', model: 'sonnet', configId: 'cfg' }],
      activeSessionId: 's-1',
      updateSession: vi.fn(),
    }),
}))

vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: Object.assign(
    () => ({
      commands: COMMANDS,
      sections: SECTIONS,
      addCommand, updateCommand, removeCommand,
      reorderCommands: vi.fn(),
      moveCommand, setCommandSection, togglePinned, clearReview,
      updateSection, removeSection, reorderSections,
    }),
    { getState: () => ({ addSection }) },
  ),
}))

vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) =>
    sel({
      state: { collapsedSectionIds: [], barCollapsed: false, overflow: 'fold', hiddenCoreTools: { everywhere: [], bySession: {} } },
      toggleSection: vi.fn(), setOverflow: vi.fn(), hideCoreTool: vi.fn(), showCoreTool: vi.fn(), setBarCollapsed: vi.fn(),
    }),
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
vi.mock('../../../src/renderer/components/LogsButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/PasteHint', () => ({ default: () => null }))

const ptyWrite = vi.fn()
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: { write: ptyWrite },
  credentials: { save: vi.fn(), delete: vi.fn() },
  // The Notes tool (Core, D10) lists notes on mount; a promise that never
  // settles keeps that state update out of the tests (no act() noise).
  notes: { list: vi.fn(() => new Promise(() => {})), save: vi.fn(), delete: vi.fn() },
}

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

// ---- harness ------------------------------------------------------------------
let container: HTMLDivElement
let root: Root
let layoutSpy: ReturnType<typeof vi.spyOn> | null = null
/** Read at call time by the layout stub, so a test can narrow the row mid-drag. */
const layout = { rowWidth: 600, step: 120, chipWidth: 110 }

beforeEach(() => {
  COMMANDS = [G1, G2, G3, C1, C2]
  SECTIONS = [SEC_G, SEC_C]
  layout.rowWidth = 600
  vi.clearAllMocks()
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

const render = (props: Record<string, unknown> = {}) => {
  act(() => {
    root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg', partnerEnabled: true, partnerSessionId: 's-1-partner', ...props } as never))
  })
}

const byTestId = (id: string, within: ParentNode = container) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const mustGet = (id: string, within: ParentNode = container): HTMLElement => {
  const el = byTestId(id, within)
  if (!el) throw new Error(`expected [data-testid="${id}"] on the page`)
  return el
}
const chip = (id: string) => container.querySelector<HTMLElement>(`[data-testid="command-chip"][data-command-id="${id}"]`)!
const sectionLabel = (id: string) => container.querySelector<HTMLElement>(`[data-testid="command-section-label"][data-section-id="${id}"]`)!
const click = (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click')
  act(() => { el.click() })
}
/** The chips still on the Global row, in order (a folded chip has left the DOM). */
const globalIds = () => Array.from(mustGet('command-band-global').querySelectorAll<HTMLElement>('[data-testid="command-chip"]')).map((b) => b.dataset.commandId)

// jsdom has no DragEvent constructor: a plain Event with a dataTransfer object
// stapled on. React's synthetic event reads dataTransfer off the native event.
type DT = { setData: ReturnType<typeof vi.fn>; getData: ReturnType<typeof vi.fn>; effectAllowed: string; dropEffect: string }
const makeDT = (): DT => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' })
const fire = (el: Element, type: 'dragstart' | 'dragover' | 'drop' | 'dragend', dt: DT = makeDT()): DT => {
  const evt = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(evt, 'dataTransfer', { value: dt })
  act(() => { el.dispatchEvent(evt) })
  return dt
}
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })) })
}

/**
 * jsdom lays nothing out, and the folding hook treats a zero-width row as
 * "nothing to fold". This stub gives the row a width and sits the chips
 * left-to-right in DOM order, `step` px apart -- so when a chip folds (leaves
 * the DOM) the ones after it slide left, exactly as a flex row would. The row
 * width is read from `layout` at call time so a test can narrow it mid-drag.
 */
const installLayout = () => {
  const zero = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
  layoutSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const testid = this.getAttribute('data-testid')
    if (testid === 'command-row') return { ...zero, right: layout.rowWidth, width: layout.rowWidth, bottom: 22, height: 22 } as DOMRect
    if (testid === 'command-chip') {
      const row = this.closest('[data-testid="command-row"]')
      const i = row ? Array.from(row.querySelectorAll('[data-testid="command-chip"]')).indexOf(this) : -1
      if (i === -1) return zero as DOMRect
      const left = i * layout.step
      return { ...zero, left, x: left, right: left + layout.chipWidth, width: layout.chipWidth, bottom: 22, height: 22 } as DOMRect
    }
    return zero as DOMRect
  })
}

// ---- tests ----------------------------------------------------------------------

describe('a drop inside a band is a reorder, and nothing more', () => {
  it('a chip dropped on a neighbour in its own band goes before it -- one store call, no card', () => {
    render()
    const dt = fire(chip('g1'), 'dragstart')
    expect(dt.effectAllowed).toBe('move')
    expect(dt.setData).toHaveBeenCalledWith('application/x-command', 'g1')
    fire(chip('g2'), 'dragover')
    fire(chip('g2'), 'drop')
    expect(moveCommand).toHaveBeenCalledTimes(1)
    expect(moveCommand).toHaveBeenCalledWith('g1', 'g2', 'global', 'cfg')
    expect(setCommandSection).not.toHaveBeenCalled()
    expect(byTestId('confirm-scope')).toBeNull()
  })

  it('while a chip is in the air each band grows an end slot; dropping there puts the chip last (beforeId null)', () => {
    render()
    // No drag yet: no slots (the bar's width must not change under the pointer).
    expect(byTestId('command-end-slot-global')).toBeNull()
    expect(byTestId('command-end-slot-config')).toBeNull()
    fire(chip('g1'), 'dragstart')
    expect(byTestId('command-end-slot-global')).not.toBeNull()
    expect(byTestId('command-end-slot-config')).not.toBeNull()
    fire(mustGet('command-end-slot-global'), 'dragover')
    fire(mustGet('command-end-slot-global'), 'drop')
    expect(moveCommand).toHaveBeenCalledTimes(1)
    expect(moveCommand).toHaveBeenCalledWith('g1', null, 'global', 'cfg')
    expect(byTestId('confirm-scope')).toBeNull()
    // The drop ended the drag: the slots are gone again.
    expect(byTestId('command-end-slot-global')).toBeNull()
  })

  it('a drag that ends without a drop leaves everything as it was, and the end slots go away', () => {
    render()
    fire(chip('c1'), 'dragstart')
    expect(byTestId('command-end-slot-config')).not.toBeNull()
    fire(chip('c1'), 'dragend')
    expect(byTestId('command-end-slot-global')).toBeNull()
    expect(byTestId('command-end-slot-config')).toBeNull()
    expect(moveCommand).not.toHaveBeenCalled()
    expect(setCommandSection).not.toHaveBeenCalled()
  })
})

describe('crossing a band is a scope change and is confirmed first (D7)', () => {
  it('Session → Global: nothing moves until "Show … in every config?" is confirmed; OK puts it before the drop target in Global', () => {
    render()
    fire(chip('c1'), 'dragstart')
    fire(chip('g1'), 'dragover')
    fire(chip('g1'), 'drop')
    expect(moveCommand).not.toHaveBeenCalled()
    const card = mustGet('confirm-scope')
    expect(mustGet('confirm-scope-title', card).textContent).toBe('Show "Session one" in every config?')
    expect(mustGet('confirm-scope-body', card).textContent).toContain('It becomes Global: it appears in every config')
    expect(mustGet('confirm-scope-ok', card).textContent).toBe('Make Global')
    click(byTestId('confirm-scope-ok', card))
    expect(moveCommand).toHaveBeenCalledTimes(1)
    expect(moveCommand).toHaveBeenCalledWith('c1', 'g1', 'global', 'cfg')
    expect(byTestId('confirm-scope')).toBeNull()
  })

  it('Session → Global: Cancel leaves everything as it was', () => {
    render()
    fire(chip('c1'), 'dragstart')
    fire(chip('g1'), 'drop')
    const card = mustGet('confirm-scope')
    click(byTestId('confirm-scope-cancel', card))
    expect(byTestId('confirm-scope')).toBeNull()
    expect(moveCommand).not.toHaveBeenCalled()
    expect(setCommandSection).not.toHaveBeenCalled()
  })

  it('Global → Session: nothing moves until "Keep … only in this config?" is confirmed; OK ("Keep it here only") puts it before the drop target in Session', () => {
    render()
    fire(chip('g1'), 'dragstart')
    fire(chip('c1'), 'dragover')
    fire(chip('c1'), 'drop')
    expect(moveCommand).not.toHaveBeenCalled()
    const card = mustGet('confirm-scope')
    expect(mustGet('confirm-scope-title', card).textContent).toBe('Keep "Global one" only in this config?')
    expect(mustGet('confirm-scope-body', card).textContent).toContain('It becomes Session-only')
    const ok = mustGet('confirm-scope-ok', card)
    expect(ok.textContent).toBe('Keep it here only')
    click(ok)
    expect(moveCommand).toHaveBeenCalledTimes(1)
    expect(moveCommand).toHaveBeenCalledWith('g1', 'c1', 'config', 'cfg')
  })
})

describe('the Global → Session card says how many configs the button leaves (D7)', () => {
  const keepHereBody = (props: Record<string, unknown>) => {
    render(props)
    fire(chip('g1'), 'dragstart')
    fire(chip('c1'), 'drop')
    return mustGet('confirm-scope-body', mustGet('confirm-scope')).textContent ?? ''
  }

  it('with three saved configs it says "leaves your other 2 configs"', () => {
    expect(keepHereBody({ configCount: 3 })).toContain('leaves your other 2 configs')
  })

  it('with two saved configs it says "leaves your other 1 config" -- singular', () => {
    const body = keepHereBody({ configCount: 2 })
    expect(body).toContain('leaves your other 1 config')
    expect(body).not.toContain('1 configs')
  })

  it('when the bar is not told the count it says "leaves your other configs", and still names this config', () => {
    const body = keepHereBody({})
    expect(body).toContain('leaves your other configs')
    expect(body).toContain('shows only here (My config)')
  })
})

describe('a drop onto a section label is the only path that writes sectionId', () => {
  it('a chip dropped on a section label of its own band is filed there -- the label lit up on dragover; no move, no card', () => {
    render()
    fire(chip('g1'), 'dragstart')
    fire(sectionLabel('sec-g'), 'dragover')
    expect(sectionLabel('sec-g').className).toContain('ring-1')
    fire(sectionLabel('sec-g'), 'drop')
    expect(setCommandSection).toHaveBeenCalledTimes(1)
    expect(setCommandSection).toHaveBeenCalledWith('g1', 'sec-g')
    expect(moveCommand).not.toHaveBeenCalled()
    expect(byTestId('confirm-scope')).toBeNull()
  })

  it('a chip dropped on a section label of the OTHER band writes nothing until the scope change is confirmed; OK re-scopes it AND files it there', () => {
    render()
    fire(chip('c1'), 'dragstart')
    fire(sectionLabel('sec-g'), 'dragover')
    fire(sectionLabel('sec-g'), 'drop')
    const card = mustGet('confirm-scope')
    expect(mustGet('confirm-scope-title', card).textContent).toBe('Show "Session one" in every config?')
    // Confirm FIRST (D7): the chip is still where it was, in no new section.
    expect(setCommandSection).not.toHaveBeenCalled()
    expect(moveCommand).not.toHaveBeenCalled()
    click(byTestId('confirm-scope-ok', card))
    expect(moveCommand).toHaveBeenCalledWith('c1', null, 'global', 'cfg')
    expect(setCommandSection).toHaveBeenCalledWith('c1', 'sec-g')
    expect(byTestId('confirm-scope')).toBeNull()
  })

  it('a chip dropped on a section label of the other band, then Cancel: it stays in its band and is filed nowhere', () => {
    render()
    fire(chip('c1'), 'dragstart')
    fire(sectionLabel('sec-g'), 'drop')
    click(byTestId('confirm-scope-cancel', mustGet('confirm-scope')))
    expect(byTestId('confirm-scope')).toBeNull()
    expect(setCommandSection).not.toHaveBeenCalled()
    expect(moveCommand).not.toHaveBeenCalled()
  })
})

describe('Core is a no-drop zone and nothing in it can be picked up', () => {
  it('a chip dragged over Core is refused (dropEffect "none") and a drop there writes nothing', () => {
    render()
    fire(chip('g1'), 'dragstart')
    const core = mustGet('command-band-core')
    const dt = fire(core, 'dragover')
    expect(dt.dropEffect).toBe('none')
    fire(core, 'drop')
    expect(moveCommand).not.toHaveBeenCalled()
    expect(setCommandSection).not.toHaveBeenCalled()
    expect(reorderSections).not.toHaveBeenCalled()
  })

  it('no Core tool is draggable -- only user chips and section labels are', () => {
    render()
    expect(mustGet('command-band-core').querySelector('[draggable="true"]')).toBeNull()
    // The selector is live: a user chip IS draggable.
    expect(chip('g1').getAttribute('draggable')).toBe('true')
    expect(sectionLabel('sec-g').getAttribute('draggable')).toBe('true')
  })
})

describe('keyboard parity inside a band', () => {
  it('Alt+→ moves the focused chip one place right; the last chip stays put', () => {
    render()
    // Global row order: g1, g2, g3. One place right of g1 means "before g3".
    chip('g1').focus()
    key(chip('g1'), 'ArrowRight', { altKey: true })
    expect(moveCommand).toHaveBeenCalledWith('g1', 'g3', 'global', 'cfg')
    // One place right of g2 lands it last: beforeId null.
    key(chip('g2'), 'ArrowRight', { altKey: true })
    expect(moveCommand).toHaveBeenLastCalledWith('g2', null, 'global', 'cfg')
    // The last chip cannot go further right: no call.
    moveCommand.mockClear()
    key(chip('g3'), 'ArrowRight', { altKey: true })
    expect(moveCommand).not.toHaveBeenCalled()
    expect(byTestId('confirm-scope')).toBeNull()
  })

  it('Alt+← moves the focused chip one place left; the first chip stays put', () => {
    render()
    key(chip('g2'), 'ArrowLeft', { altKey: true })
    expect(moveCommand).toHaveBeenCalledWith('g2', 'g1', 'global', 'cfg')
    moveCommand.mockClear()
    key(chip('g1'), 'ArrowLeft', { altKey: true })
    expect(moveCommand).not.toHaveBeenCalled()
  })

  it('a plain arrow only moves focus along the band -- nothing is reordered; only the first chip is in the tab order', () => {
    render()
    chip('g1').focus()
    expect(document.activeElement).toBe(chip('g1'))
    key(chip('g1'), 'ArrowRight')
    expect(document.activeElement).toBe(chip('g2'))
    expect(moveCommand).not.toHaveBeenCalled()
    // Only the first chip of a band is in the tab order (roving tabindex).
    expect(chip('g1').tabIndex).toBe(0)
    expect(chip('g2').tabIndex).toBe(-1)
  })
})

describe('keyboard parity across bands: Alt+Shift+arrow is the cross-band drop, same confirm (D7)', () => {
  it('Alt+Shift+← on a Session chip asks "Show … in every config?" and moves nothing; OK puts it last in Global', () => {
    render()
    key(chip('c1'), 'ArrowLeft', { altKey: true, shiftKey: true })
    expect(moveCommand).not.toHaveBeenCalled()
    const card = mustGet('confirm-scope')
    expect(mustGet('confirm-scope-title', card).textContent).toBe('Show "Session one" in every config?')
    click(byTestId('confirm-scope-ok', card))
    expect(moveCommand).toHaveBeenCalledTimes(1)
    expect(moveCommand).toHaveBeenCalledWith('c1', null, 'global', 'cfg')
    expect(byTestId('confirm-scope')).toBeNull()
  })

  it('Alt+Shift+→ on a Global chip asks "Keep … only in this config?" and moves nothing; OK puts it last in Session', () => {
    render()
    key(chip('g1'), 'ArrowRight', { altKey: true, shiftKey: true })
    expect(moveCommand).not.toHaveBeenCalled()
    const card = mustGet('confirm-scope')
    expect(mustGet('confirm-scope-title', card).textContent).toBe('Keep "Global one" only in this config?')
    click(byTestId('confirm-scope-ok', card))
    expect(moveCommand).toHaveBeenCalledTimes(1)
    expect(moveCommand).toHaveBeenCalledWith('g1', null, 'config', 'cfg')
    expect(byTestId('confirm-scope')).toBeNull()
  })

  it('Alt+Shift+arrow then Cancel: the chip stays in its band, in its place', () => {
    render()
    key(chip('g2'), 'ArrowLeft', { altKey: true, shiftKey: true })
    click(byTestId('confirm-scope-cancel', mustGet('confirm-scope')))
    expect(byTestId('confirm-scope')).toBeNull()
    expect(moveCommand).not.toHaveBeenCalled()
  })

  it('on a bar with no saved config Alt+Shift on a Global chip does nothing: no card, no move, no within-band shuffle', () => {
    render({ configId: undefined })
    expect(byTestId('command-band-config')).toBeNull()
    key(chip('g1'), 'ArrowRight', { altKey: true, shiftKey: true })
    key(chip('g2'), 'ArrowLeft', { altKey: true, shiftKey: true })
    expect(byTestId('confirm-scope')).toBeNull()
    expect(moveCommand).not.toHaveBeenCalled()
  })
})

describe('dragging a section label: reorder inside a band, a confirmed scope change across bands (D7, D9)', () => {
  it('a section label dropped on another of its own band reorders the sections -- no card, no member moves', () => {
    const SEC_G2 = { id: 'sec-g2', name: 'Glob two', scope: 'global' as const }
    const G4 = { id: 'g4', label: 'Global four', prompt: 'four', scope: 'global' as const, order: 3, sectionId: 'sec-g2' }
    SECTIONS = [SEC_G, SEC_G2, SEC_C]
    COMMANDS = [G1, G2, G3, G4, C1, C2]
    render()
    const dt = fire(sectionLabel('sec-g'), 'dragstart')
    expect(dt.setData).toHaveBeenCalledWith('application/x-section', 'sec-g')
    // A section drag is not a chip drag: no end slots, and a chip drop target is not armed.
    expect(byTestId('command-end-slot-global')).toBeNull()
    fire(sectionLabel('sec-g2'), 'dragover')
    fire(sectionLabel('sec-g2'), 'drop')
    expect(reorderSections).toHaveBeenCalledTimes(1)
    const next = reorderSections.mock.calls[0][0] as Array<{ id: string }>
    expect(next.map((s) => s.id)).toEqual(['sec-g2', 'sec-g', 'sec-c'])
    expect(byTestId('confirm-section-band')).toBeNull()
    expect(updateSection).not.toHaveBeenCalled()
    expect(moveCommand).not.toHaveBeenCalled()
    expect(setCommandSection).not.toHaveBeenCalled()
  })

  it('a Session section label dropped on a Global one asks "Move … and its N buttons to Global?" and reorders nothing; OK re-scopes the section and moves every member', () => {
    render()
    fire(sectionLabel('sec-c'), 'dragstart')
    fire(sectionLabel('sec-g'), 'dragover')
    expect(sectionLabel('sec-g').className).toContain('ring-1')
    fire(sectionLabel('sec-g'), 'drop')
    expect(reorderSections).not.toHaveBeenCalled()
    expect(updateSection).not.toHaveBeenCalled()
    expect(moveCommand).not.toHaveBeenCalled()
    const card = mustGet('confirm-section-band')
    expect(mustGet('confirm-section-band-title', card).textContent).toBe('Move "Sess sec" and its 1 button to Global?')
    expect(mustGet('confirm-section-band-body', card).textContent).toContain('They will show in every config.')
    click(byTestId('confirm-section-band-ok', card))
    expect(updateSection).toHaveBeenCalledTimes(1)
    const [secId, patch] = updateSection.mock.calls[0] as [string, Record<string, unknown>]
    expect(secId).toBe('sec-c')
    // configId is CLEARED, not left behind: a Global section belongs to no config.
    expect(patch).toStrictEqual({ scope: 'global', configId: undefined })
    expect(moveCommand).toHaveBeenCalledTimes(1)
    expect(moveCommand).toHaveBeenCalledWith('c2', null, 'global', 'cfg')
    expect(byTestId('confirm-section-band')).toBeNull()
    expect(reorderSections).not.toHaveBeenCalled()
  })

  it('a Global section label dropped on a Session one asks "… to Session?"; OK binds the section to this config and moves every member', () => {
    render()
    fire(sectionLabel('sec-g'), 'dragstart')
    fire(sectionLabel('sec-c'), 'drop')
    const card = mustGet('confirm-section-band')
    expect(mustGet('confirm-section-band-title', card).textContent).toBe('Move "Glob sec" and its 1 button to Session?')
    expect(mustGet('confirm-section-band-body', card).textContent).toContain('They will show only in this config (My config).')
    click(byTestId('confirm-section-band-ok', card))
    expect(updateSection).toHaveBeenCalledWith('sec-g', { scope: 'config', configId: 'cfg' })
    expect(moveCommand).toHaveBeenCalledTimes(1)
    expect(moveCommand).toHaveBeenCalledWith('g3', null, 'config', 'cfg')
    expect(reorderSections).not.toHaveBeenCalled()
  })

  it('a section label dropped across bands, then Cancel: nothing is written and the sections keep their order', () => {
    render()
    fire(sectionLabel('sec-c'), 'dragstart')
    fire(sectionLabel('sec-g'), 'drop')
    click(byTestId('confirm-section-band-cancel', mustGet('confirm-section-band')))
    expect(byTestId('confirm-section-band')).toBeNull()
    expect(updateSection).not.toHaveBeenCalled()
    expect(moveCommand).not.toHaveBeenCalled()
    expect(reorderSections).not.toHaveBeenCalled()
    expect(setCommandSection).not.toHaveBeenCalled()
  })
})

describe('the row keeps its shape while a chip is in the air (D8)', () => {
  it('a row that narrows mid-drag folds nothing more until the drag ends; dragend re-measures and folds what no longer fits', () => {
    installLayout()
    COMMANDS = six()
    SECTIONS = []
    render()
    expect(globalIds()).toEqual(['g1', 'g2', 'g3', 'g4'])
    expect(mustGet('command-more-global').textContent).toContain('2 more')
    fire(chip('g1'), 'dragstart')
    // The window narrows under the pointer; the bar re-renders (drag-over state)
    // but must NOT re-measure: same four chips, same pill.
    layout.rowWidth = 300
    fire(chip('g3'), 'dragover')
    render()
    expect(globalIds()).toEqual(['g1', 'g2', 'g3', 'g4'])
    expect(mustGet('command-more-global').textContent).toContain('2 more')
    // Let go: the fold catches up with the narrower row.
    fire(chip('g1'), 'dragend')
    expect(globalIds()).toEqual(['g1', 'g2'])
    expect(mustGet('command-more-global').textContent).toContain('4 more')
  })

  // The "new chip set -> unfold and measure again" reset is deferred while a
  // chip is in the air (D7/D8: the bar keeps its shape during a drag) and
  // applied on the first render after dragend.
  it('a chip set that changes mid-drag does not unfold the row until the drag ends', () => {
    installLayout()
    COMMANDS = six()
    SECTIONS = []
    render()
    expect(globalIds()).toEqual(['g1', 'g2', 'g3', 'g4'])
    fire(chip('g1'), 'dragstart')
    // g2-g4 vanish from the store (another bar, a sync): a fresh measure would
    // bring g5 and g6 back onto the row -- but not while a chip is in the air.
    COMMANDS = six().filter((c) => ['g1', 'g5', 'g6'].includes(c.id))
    render()
    expect(globalIds()).toEqual(['g1'])
    expect(mustGet('command-more-global').textContent).toContain('2 more')
    fire(chip('g1'), 'dragend')
    expect(globalIds()).toEqual(['g1', 'g5', 'g6'])
    expect(byTestId('command-more-global')).toBeNull()
  })
})
