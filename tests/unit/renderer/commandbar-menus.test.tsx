// @vitest-environment jsdom
/**
 * Every menu the one-row command bar opens (ADR-018 D4, D7, D9, D10), driven
 * from the bar the way a user drives it: right-click a chip, a section label, a
 * Core tool, a band or the bar background; click the Add caret. Each surface is
 * its own data-testid so ONE right-click opens exactly ONE menu, and every item
 * either calls the store action the design names, opens the input it must, or
 * raises the confirm card it must. The command store is mocked wholesale: these
 * tests assert the CALL the bar makes, never what the store does with it.
 *
 * WHY these exact checks: the bar is the only place a user can create a section
 * in a BAND (D9), rename or recolour one, move a button with the menu instead of
 * a drag, or reach a Core tool's own action -- none of that has a second UI, so
 * each path is walked here from the right-click to the store call.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { commandSecretKey } from '../../../src/shared/command-secret'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Rec = Record<string, unknown>

// Mutable fixtures: a test sets them BEFORE rendering; every mock reads them at
// call time rather than closing over a snapshot.
let COMMANDS: Rec[] = []
let SECTIONS: Rec[] = []
let SESSIONS: Rec[] = []
let BAR_STATE: Rec = {}

const G1 = { id: 'g1', label: 'Prompt one', prompt: 'do a thing', scope: 'global' }
const G2 = { id: 'g2', label: 'Prompt two', prompt: 'explain', scope: 'global', defaultArgs: ['--all'], sectionId: 'sg' }
const G3 = { id: 'g3', label: 'Prompt three', prompt: 'summarise', scope: 'global' }
const G4 = { id: 'g4', label: 'Prompt four', prompt: 'refactor', scope: 'global' }
const C1 = { id: 'c1', label: 'Shell one', prompt: 'npm test', scope: 'config', configId: 'cfg', target: 'partner' }
const C2 = { id: 'c2', label: 'Shell two', prompt: 'npm run build', scope: 'config', configId: 'cfg', target: 'partner', sectionId: 'sc' }
const ALL: Rec[] = [G1, G2, C1, C2]
/** Three loose Global chips in store order g1, g2, g3 -- the Move ▸ arithmetic reads cleanly on them. */
const LOOSE_TRIO: Rec[] = [G1, { ...G2, sectionId: undefined }, G3]
const SG = { id: 'sg', name: 'Tools', scope: 'global', color: '#A6E3A1' }
const SC = { id: 'sc', name: 'Build', scope: 'config', configId: 'cfg' }
const LOCAL_CLAUDE = { id: 's-1', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet', configId: 'cfg' }
const freshBarState = (): Rec => ({ collapsedSectionIds: [], barCollapsed: false, overflow: 'fold', hiddenCoreTools: { everywhere: [], bySession: {} } })

// Every store function the bar can call, as one stable vi.fn each so a test can
// assert the exact call.
const store = {
  addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(), reorderCommands: vi.fn(),
  moveCommand: vi.fn(), setCommandSection: vi.fn(), togglePinned: vi.fn(), clearReview: vi.fn(),
  addSection: vi.fn(), updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
}
const bar = { toggleSection: vi.fn(), setOverflow: vi.fn(), hideCoreTool: vi.fn(), showCoreTool: vi.fn(), setBarCollapsed: vi.fn() }

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: SESSIONS, activeSessionId: 's-1', updateSession: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/commandStore', () => {
  const snapshot = () => ({ commands: COMMANDS, sections: SECTIONS, ...store })
  const useCommandStore = Object.assign(() => snapshot(), { getState: snapshot })
  return { useCommandStore }
})
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: BAR_STATE, ...bar }),
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
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))
// The dialog is a marker: which command it edits, which scope/section it was opened for.
vi.mock('../../../src/renderer/components/CommandDialog', () => ({
  default: (p: { initial?: { id: string }; presetScope?: string; presetSectionId?: string }) =>
    React.createElement('div', { 'data-testid': 'dialog-mock', 'data-initial': p.initial?.id ?? '', 'data-scope': p.presetScope ?? '', 'data-section': p.presetSectionId ?? '' }),
}))

const ptyWrite = vi.fn()
const credDelete = vi.fn(() => Promise.resolve(true))
const credSave = vi.fn(() => Promise.resolve(true))
// The Notes tool lists names on mount; an empty index keeps it quiet.
const notesApi = { list: vi.fn(() => Promise.resolve([])), load: vi.fn(() => Promise.resolve('')), save: vi.fn(() => Promise.resolve(true)), delete: vi.fn(() => Promise.resolve(true)) }
// Augment the setup's electronAPI -- replacing it wholesale would drop the
// registry/config/sentinel mocks other components on the bar read.
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: { write: ptyWrite },
  credentials: { save: credSave, delete: credDelete },
  notes: notesApi,
}

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

let container: HTMLDivElement
let root: Root

/** Mount and let the Notes tool's index load settle, so no update lands outside act. */
const mount = async (props: Rec = {}) => {
  await act(async () => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg', partnerEnabled: true, partnerSessionId: 's-1-partner', onTogglePartner: () => {}, ...props } as never)) })
}
const remount = async (props: Rec = {}) => {
  act(() => { root.unmount() })
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await mount(props)
}
/** Drain a microtask-deferred update (a `notes.list` round-trip) inside act. */
const flush = () => act(async () => { await Promise.resolve() })

const byTestId = (id: string, within: ParentNode = container) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const mustGet = (id: string, within: ParentNode = container): HTMLElement => {
  const el = byTestId(id, within)
  if (!el) throw new Error(`expected [data-testid="${id}"] on the page`)
  return el
}
const chip = (id: string) => container.querySelector<HTMLElement>(`[data-testid="command-chip"][data-command-id="${id}"]`)
const sectionLabel = (id: string) => container.querySelector<HTMLElement>(`[data-testid="command-section-label"][data-section-id="${id}"]`)
const menus = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid$="-menu"]'))
const menuItemsOf = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
const rightClick = (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to right-click')
  act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 })) })
}
const click = (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click')
  act(() => { el.click() })
}
const key = (el: Element | null, k: string, init: KeyboardEventInit = {}) => {
  if (!el) throw new Error('nothing focused to send a key to')
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })) })
}
/** Type into a React-controlled input: the native setter so React's value tracker sees the change. */
const typeInto = (input: HTMLElement | null, value: string) => {
  if (!(input instanceof HTMLInputElement)) throw new Error('no input to type into')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const isDisabled = (el: HTMLElement | null) => !!el && (el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') === 'true'
/** A Menu's header: its title line and its sub line, by their own test ids. */
const headerOf = (menu: HTMLElement) => ({ title: byTestId('menu-title', menu)?.textContent ?? '', sub: byTestId('menu-sub', menu)?.textContent ?? '' })
/** The right-edge hint of a menu item (the mono span), so a count is read exactly. */
const hintOf = (item: HTMLElement | null) => item?.querySelector<HTMLElement>('span.font-mono')?.textContent ?? null
const settingsOpens = () => {
  const opened: string[] = []
  const onOpen = (e: Event) => { opened.push((e as CustomEvent<{ tab: string }>).detail.tab) }
  window.addEventListener('app:openSettings', onOpen)
  return { opened, stop: () => window.removeEventListener('app:openSettings', onOpen) }
}

beforeEach(() => {
  COMMANDS = ALL
  SECTIONS = [SG, SC]
  SESSIONS = [LOCAL_CLAUDE]
  BAR_STATE = freshBarState()
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('right-click a chip: the button menu', () => {
  it('opens exactly one menu, headed by the chip, with its tooltip minus its own name as the sub-line, and every item in place', async () => {
    await mount()
    rightClick(chip('g1'))
    const open = menus()
    expect(open).toHaveLength(1)
    expect(open[0].dataset.testid).toBe('command-menu')
    // The bar's own right-click handler sits underneath: it must NOT also fire.
    expect(byTestId('bar-menu')).toBeNull()
    expect(headerOf(open[0])).toEqual({ title: 'Prompt one', sub: 'Prompt · runs in the Claude terminal · Global — every config' })
    for (const id of ['menu-run', 'menu-run-args', 'menu-edit', 'menu-duplicate', 'menu-icon-colour', 'menu-pin', 'menu-show-in', 'menu-move-section', 'menu-move', 'menu-delete']) {
      expect(byTestId(id), id).not.toBeNull()
    }
    expect(byTestId('menu-review')).toBeNull()
    expect(isDisabled(byTestId('menu-run-args'))).toBe(true)            // no args to run with
    expect(byTestId('menu-pin')?.textContent).toBe('Pin to bar')
    expect(hintOf(byTestId('menu-delete'))).toBe('from every config')    // a Global chip
  })

  it('the chip tooltip and the menu header are ONE string: "<title> — <sub>" (D4), for a loose chip and a sectioned chip with args alike', async () => {
    await mount()
    for (const id of ['g1', 'g2', 'c1']) {
      const c = chip(id)!
      rightClick(c)
      const { title, sub } = headerOf(mustGet('command-menu'))
      expect(title, id).not.toBe('')
      expect(sub, id).not.toBe('')
      expect(c.title, id).toBe(`${title} — ${sub}`)
      key(document.activeElement, 'Escape')
    }
  })

  it('a pinned Session chip with arguments: Run with arguments is live, Pin reads Unpin, Delete carries no "every config" hint', async () => {
    COMMANDS = ALL.map((c) => (c.id === 'c1' ? { ...c, pinned: true, defaultArgs: ['--watch'] } : c))
    await mount()
    rightClick(chip('c1'))
    const menu = mustGet('command-menu')
    expect(headerOf(menu).title).toBe('Shell one')
    expect(headerOf(menu).sub).toContain('Shell line · runs in the partner shell · Session — this config only')
    expect(headerOf(menu).sub).not.toMatch(/^Shell one/)
    expect(isDisabled(byTestId('menu-run-args'))).toBe(false)
    expect(byTestId('menu-pin')?.textContent).toBe('Unpin from bar')
    expect(hintOf(byTestId('menu-delete'))).toBeNull()
  })

  it('a chip the upgrade review tagged puts "Review this button…" FIRST with the count, and it opens the editor on that command', async () => {
    COMMANDS = ALL.map((c) => (c.id === 'g1' ? { ...c, needsReview: ['secret-like-arg', 'section-dissolved'] } : c))
    await mount()
    expect(byTestId('command-review-mark', chip('g1')!)).not.toBeNull()
    rightClick(chip('g1'))
    const first = menuItemsOf(mustGet('command-menu'))[0]
    expect(first?.dataset.testid).toBe('menu-review')
    expect(first?.textContent).toContain('(2)')
    click(first)
    expect(menus()).toHaveLength(0)
    expect(byTestId('dialog-mock')?.getAttribute('data-initial')).toBe('g1')
  })
})

describe('button menu actions', () => {
  it('Run types the prompt plus a carriage return into the session PTY and closes the menu', async () => {
    await mount()
    rightClick(chip('g1'))
    click(byTestId('menu-run'))
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(ptyWrite).toHaveBeenCalledWith('s-1', 'do a thing\r')
    expect(menus()).toHaveLength(0)
  })

  it('Edit… opens the editor on that command and closes the menu', async () => {
    await mount()
    rightClick(chip('g1'))
    click(byTestId('menu-edit'))
    expect(menus()).toHaveLength(0)
    expect(byTestId('dialog-mock')?.getAttribute('data-initial')).toBe('g1')
  })

  it('Duplicate adds "<label> copy" under a fresh id and drops order, pinned, needsReview, the secret flag and last-used args', async () => {
    COMMANDS = ALL.map((c) => (c.id === 'c1'
      ? { ...c, order: 3, pinned: true, needsReview: ['ssh-partner-is-local'], hasSecretArg: true, lastCustomArgs: ['x'], defaultArgs: ['--a'], color: '#A6E3A1', icon: 'rocket' }
      : c))
    await mount()
    rightClick(chip('c1'))
    click(byTestId('menu-duplicate'))
    expect(store.addCommand).toHaveBeenCalledTimes(1)
    const added = store.addCommand.mock.calls[0][0] as Rec
    expect(added).toMatchObject({ id: 'test-id', label: 'Shell one copy', prompt: 'npm test', scope: 'config', configId: 'cfg', target: 'partner', defaultArgs: ['--a'], color: '#A6E3A1', icon: 'rocket' })
    for (const k of ['order', 'pinned', 'needsReview', 'hasSecretArg', 'lastCustomArgs']) expect(added, k).not.toHaveProperty(k)
    expect(menus()).toHaveLength(0)
  })

  it('Pin to bar toggles the pin on that command', async () => {
    await mount()
    rightClick(chip('g1'))
    click(byTestId('menu-pin'))
    expect(store.togglePinned).toHaveBeenCalledWith('g1')
    expect(menus()).toHaveLength(0)
  })

  it('Delete asks first -- the card says Global for a Global chip -- and OK removes the command AND its keychain secret', async () => {
    await mount()
    rightClick(chip('g1'))
    click(byTestId('menu-delete'))
    const card = mustGet('confirm-delete')
    expect(byTestId('confirm-delete-title', card)?.textContent).toBe('Delete "Prompt one"?')
    expect(byTestId('confirm-delete-body', card)?.textContent).toContain('Global')
    expect(store.removeCommand).not.toHaveBeenCalled()
    click(byTestId('confirm-delete-ok'))
    expect(store.removeCommand).toHaveBeenCalledWith('g1')
    expect(credDelete).toHaveBeenCalledWith(commandSecretKey('g1'))
    expect(byTestId('confirm-delete')).toBeNull()
  })
})

describe('button menu submenus', () => {
  it('Show in: a Global chip can only go to Session, and picking it asks before narrowing the scope', async () => {
    await mount()
    rightClick(chip('g1'))
    click(byTestId('menu-show-in'))
    expect(isDisabled(byTestId('menu-show-global'))).toBe(true)
    expect(isDisabled(byTestId('menu-show-session'))).toBe(false)
    expect(mustGet('command-menu').textContent).not.toContain('This session has no saved config.')
    click(byTestId('menu-show-session'))
    const card = mustGet('confirm-scope')
    expect(byTestId('confirm-scope-title', card)?.textContent).toBe('Keep "Prompt one" only in this config?')
    expect(store.moveCommand).not.toHaveBeenCalled()
    click(byTestId('confirm-scope-ok'))
    expect(store.moveCommand).toHaveBeenCalledWith('g1', null, 'config', 'cfg')
    expect(byTestId('confirm-scope')).toBeNull()
  })

  it('Move to section lists only THIS band\'s sections; picking one files the chip there; the current one is marked and disabled', async () => {
    await mount()
    rightClick(chip('g1'))
    click(byTestId('menu-move-section'))
    expect(isDisabled(byTestId('menu-section-none'))).toBe(true)   // g1 is unsectioned
    expect(byTestId('menu-section-sg')).not.toBeNull()
    expect(byTestId('menu-section-sc')).toBeNull()                  // a Session-band section never shows for a Global chip
    click(byTestId('menu-section-sg'))
    expect(store.setCommandSection).toHaveBeenCalledWith('g1', 'sg')
    expect(menus()).toHaveLength(0)
    // g2 already lives in Tools: "No section" is the live choice, Tools is current.
    rightClick(chip('g2'))
    click(byTestId('menu-move-section'))
    expect(isDisabled(byTestId('menu-section-none'))).toBe(false)
    expect(isDisabled(byTestId('menu-section-sg'))).toBe(true)
    expect(byTestId('menu-section-sg')?.textContent).toContain('current')
    click(byTestId('menu-section-none'))
    expect(store.setCommandSection).toHaveBeenCalledWith('g2', undefined)
  })

  it('Icon and colour opens the quick picker; a glyph, the monogram and a swatch each update the command', async () => {
    await mount()
    rightClick(chip('g1'))
    click(byTestId('menu-icon-colour'))
    const picker = mustGet('icon-colour-picker')
    click(byTestId('icon-pick-rocket', picker))
    expect(store.updateCommand).toHaveBeenLastCalledWith('g1', { icon: 'rocket' })
    click(byTestId('icon-pick-monogram', picker))
    const [id, patch] = store.updateCommand.mock.calls.at(-1) as [string, Rec]
    expect(id).toBe('g1')
    expect('icon' in patch && patch.icon === undefined).toBe(true)
    click(picker.querySelector<HTMLElement>('[aria-label="Colour #A6E3A1"]'))
    expect(store.updateCommand).toHaveBeenLastCalledWith('g1', { color: '#A6E3A1' })
  })
})

describe('button menu Move ▸: one store call with the right neighbour named', () => {
  const moveVia = (id: string, item: 'menu-move-left' | 'menu-move-right' | 'menu-move-start' | 'menu-move-end') => {
    rightClick(chip(id))
    click(byTestId('menu-move'))
    click(byTestId(item))
    expect(menus()).toHaveLength(0)
  }

  it('Left puts the chip before its left neighbour; the first chip stays put', async () => {
    COMMANDS = [...LOOSE_TRIO, C1, C2]
    await mount()
    moveVia('g2', 'menu-move-left')
    expect(store.moveCommand).toHaveBeenCalledTimes(1)
    expect(store.moveCommand).toHaveBeenCalledWith('g2', 'g1', 'global', 'cfg')
    store.moveCommand.mockClear()
    moveVia('g1', 'menu-move-left')
    expect(store.moveCommand).not.toHaveBeenCalled()
  })

  it('Right puts the chip before the one AFTER its right neighbour, or last (null) when that is the end', async () => {
    COMMANDS = [...LOOSE_TRIO, C1, C2]
    await mount()
    moveVia('g1', 'menu-move-right')
    expect(store.moveCommand).toHaveBeenCalledWith('g1', 'g3', 'global', 'cfg')
    moveVia('g2', 'menu-move-right')
    expect(store.moveCommand).toHaveBeenLastCalledWith('g2', null, 'global', 'cfg')
  })

  it('To the start names the first chip; To the end names nothing (null)', async () => {
    COMMANDS = [...LOOSE_TRIO, C1, C2]
    await mount()
    moveVia('g3', 'menu-move-start')
    expect(store.moveCommand).toHaveBeenCalledWith('g3', 'g1', 'global', 'cfg')
    moveVia('g1', 'menu-move-end')
    expect(store.moveCommand).toHaveBeenLastCalledWith('g1', null, 'global', 'cfg')
  })

  it('a pinned chip is never the anchor: moving an unpinned chip right skips over the pinned run', async () => {
    // g3 pinned: the only right-hand neighbour of g1 that counts is g2, so g1 lands last.
    COMMANDS = [G1, { ...G2, sectionId: undefined }, { ...G3, pinned: true }, C1, C2]
    await mount()
    moveVia('g1', 'menu-move-right')
    expect(store.moveCommand).toHaveBeenCalledTimes(1)
    expect(store.moveCommand).toHaveBeenCalledWith('g1', null, 'global', 'cfg')
    // g2 pinned in the middle of four: g1 right lands before g4, not before the pinned g3-less slot.
    COMMANDS = [G1, { ...G2, sectionId: undefined, pinned: true }, G3, G4, C1, C2]
    store.moveCommand.mockClear()
    await remount()
    moveVia('g1', 'menu-move-right')
    expect(store.moveCommand).toHaveBeenCalledWith('g1', 'g4', 'global', 'cfg')
  })

  it('a Session chip moves inside the Session band with the config named', async () => {
    await mount()
    moveVia('c2', 'menu-move-left')
    expect(store.moveCommand).toHaveBeenCalledWith('c2', 'c1', 'config', 'cfg')
  })
})

describe('button menu keyboard', () => {
  it('opens with the first item focused, ArrowDown moves to the next, Escape closes and returns focus to the chip', async () => {
    await mount()
    const g2 = chip('g2')!
    rightClick(g2)
    expect((document.activeElement as HTMLElement | null)?.dataset.testid).toBe('menu-run')
    key(document.activeElement, 'ArrowDown')
    expect((document.activeElement as HTMLElement | null)?.dataset.testid).toBe('menu-run-args') // g2 has args, so it is live
    key(document.activeElement, 'Escape')
    expect(menus()).toHaveLength(0)
    expect(document.activeElement).toBe(g2)
  })
})

describe('a session with no saved config', () => {
  it('Show in ▸ Session and a section\'s Move ▸ To the Session band are disabled, with the foot saying why', async () => {
    SESSIONS = [{ ...LOCAL_CLAUDE, configId: undefined }]
    await mount({ configId: undefined })
    rightClick(chip('g1'))
    click(byTestId('menu-show-in'))
    expect(isDisabled(byTestId('menu-show-session'))).toBe(true)
    expect(mustGet('command-menu').textContent).toContain('This session has no saved config.')
    key(document.activeElement, 'Escape')
    rightClick(sectionLabel('sg'))
    click(byTestId('menu-section-move'))
    expect(isDisabled(byTestId('menu-section-to-global'))).toBe(true)
    expect(isDisabled(byTestId('menu-section-to-session'))).toBe(true)
  })
})

describe('right-click a section label: the section menu', () => {
  it('offers Rename, Colour, Collapse to a chip, Move, Add command to this section, Delete (keeps its N); collapse and delete call the store', async () => {
    await mount()
    rightClick(sectionLabel('sg'))
    expect(menus()).toHaveLength(1)
    const menu = mustGet('section-menu')
    expect(headerOf(menu)).toEqual({ title: 'Tools', sub: 'section · Global · 1 button' })
    expect(byTestId('menu-section-rename')?.textContent).toBe('Rename…')
    expect(byTestId('menu-section-colour')?.textContent).toContain('Colour')
    expect(byTestId('menu-section-collapse')?.textContent).toBe('Collapse to a chip')
    expect(byTestId('menu-section-move')).not.toBeNull()
    expect(byTestId('menu-section-add')?.textContent).toBe('Add command to this section…')
    expect(hintOf(byTestId('menu-section-delete'))).toBe('keeps its 1')
    click(byTestId('menu-section-collapse'))
    expect(bar.toggleSection).toHaveBeenCalledWith('sg')
    expect(menus()).toHaveLength(0)
    rightClick(sectionLabel('sg'))
    click(byTestId('menu-section-add'))
    expect(byTestId('dialog-mock')?.getAttribute('data-scope')).toBe('global')
    expect(byTestId('dialog-mock')?.getAttribute('data-section')).toBe('sg')
    rightClick(sectionLabel('sg'))
    click(byTestId('menu-section-delete'))
    expect(store.removeSection).toHaveBeenCalledWith('sg')
  })

  it('Rename… opens the name box pre-filled; Enter saves the new name WITH the section\'s colour; Escape saves nothing', async () => {
    await mount()
    rightClick(sectionLabel('sg'))
    click(byTestId('menu-section-rename'))
    expect(menus()).toHaveLength(0)
    const input = mustGet('section-name-input') as HTMLInputElement
    expect(input.value).toBe('Tools')
    expect(input.closest('[role="dialog"]')?.getAttribute('aria-label')).toBe('Rename section')
    typeInto(input, 'Toolbox')
    key(input, 'Enter')
    expect(store.updateSection).toHaveBeenCalledTimes(1)
    expect(store.updateSection).toHaveBeenCalledWith('sg', { name: 'Toolbox', color: '#A6E3A1' })
    expect(byTestId('section-name-input')).toBeNull()
    // Escape: the box closes and nothing is written.
    store.updateSection.mockClear()
    rightClick(sectionLabel('sg'))
    click(byTestId('menu-section-rename'))
    typeInto(byTestId('section-name-input'), 'Dropped')
    key(byTestId('section-name-input'), 'Escape')
    expect(byTestId('section-name-input')).toBeNull()
    expect(store.updateSection).not.toHaveBeenCalled()
  })

  it('Colour ▸: a swatch recolours the section; Default clears the colour', async () => {
    await mount()
    rightClick(sectionLabel('sg'))
    click(byTestId('menu-section-colour'))
    const menu = mustGet('section-menu')
    click(menu.querySelector<HTMLElement>('[aria-label="Colour #F9E2AF"]'))
    expect(store.updateSection).toHaveBeenLastCalledWith('sg', { color: '#F9E2AF' })
    click(menu.querySelector<HTMLElement>('[aria-label="Default colour"]'))
    const [id, patch] = store.updateSection.mock.calls.at(-1) as [string, Rec]
    expect(id).toBe('sg')
    expect('color' in patch && patch.color === undefined).toBe(true)
  })

  it('a collapsed section\'s chip right-clicks to the same menu, now offering Expand', async () => {
    BAR_STATE = { ...freshBarState(), collapsedSectionIds: ['sg'] }
    await mount()
    expect(sectionLabel('sg')).not.toBeNull()
    rightClick(mustGet('command-section-collapsed'))
    expect(mustGet('section-menu')).not.toBeNull()
    expect(byTestId('menu-section-collapse')?.textContent).toBe('Expand')
  })

  it('Move ▸: a Global section cannot go to Global; To the Session band asks, naming the section and its count, then re-scopes it and moves every member', async () => {
    await mount()
    rightClick(sectionLabel('sg'))
    click(byTestId('menu-section-move'))
    expect(isDisabled(byTestId('menu-section-to-global'))).toBe(true)
    expect(isDisabled(byTestId('menu-section-to-session'))).toBe(false)
    click(byTestId('menu-section-to-session'))
    const card = mustGet('confirm-section-band')
    expect(byTestId('confirm-section-band-title', card)?.textContent).toBe('Move "Tools" and its 1 button to Session?')
    expect(store.updateSection).not.toHaveBeenCalled()
    click(byTestId('confirm-section-band-ok'))
    expect(store.updateSection).toHaveBeenCalledWith('sg', { scope: 'config', configId: 'cfg' })
    expect(store.moveCommand).toHaveBeenCalledTimes(1)
    expect(store.moveCommand).toHaveBeenCalledWith('g2', null, 'config', 'cfg')
    expect(byTestId('confirm-section-band')).toBeNull()
  })
})

describe('right-click the bar background: the bar menu', () => {
  it('offers add command/section, the overflow mode (current marked ●), hidden tools (none → disabled), Manage and Hide', async () => {
    await mount()
    rightClick(mustGet('command-bar'))
    expect(menus()).toHaveLength(1)
    expect(mustGet('bar-menu')).not.toBeNull()
    expect(byTestId('bar-add-command')).not.toBeNull()
    expect(byTestId('bar-add-section')).not.toBeNull()
    expect(byTestId('bar-overflow-fold')?.textContent?.startsWith('●')).toBe(true)
    expect(byTestId('bar-overflow-wrap2')?.textContent?.startsWith('○')).toBe(true)
    expect(isDisabled(byTestId('bar-show-hidden'))).toBe(true)
    expect(hintOf(byTestId('bar-show-hidden'))).toBe('none')
    click(byTestId('bar-overflow-wrap2'))
    expect(bar.setOverflow).toHaveBeenCalledWith('wrap2')
    expect(menus()).toHaveLength(0)

    const settings = settingsOpens()
    rightClick(mustGet('command-bar'))
    click(byTestId('bar-manage'))
    settings.stop()
    expect(settings.opened).toEqual(['commands'])

    rightClick(mustGet('command-bar'))
    click(byTestId('bar-hide'))
    expect(bar.setBarCollapsed).toHaveBeenCalledWith(true)

    rightClick(mustGet('command-bar'))
    click(byTestId('bar-add-command'))
    expect(byTestId('dialog-mock')?.getAttribute('data-scope')).toBe('config') // a config is active
  })

  it('Add section… creates the section in the Session band when a config is active, and in Global on a session with none', async () => {
    await mount()
    rightClick(mustGet('command-bar'))
    click(byTestId('bar-add-section'))
    expect(menus()).toHaveLength(0)
    typeInto(byTestId('section-name-input'), 'Ops')
    key(byTestId('section-name-input'), 'Enter')
    expect(store.addSection).toHaveBeenCalledTimes(1)
    expect(store.addSection).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-id', name: 'Ops', scope: 'config', configId: 'cfg' }))
    expect(byTestId('section-name-input')).toBeNull()

    SESSIONS = [{ ...LOCAL_CLAUDE, configId: undefined }]
    store.addSection.mockClear()
    await remount({ configId: undefined })
    rightClick(mustGet('command-bar'))
    click(byTestId('bar-add-section'))
    typeInto(byTestId('section-name-input'), 'Ops')
    key(byTestId('section-name-input'), 'Enter')
    expect(store.addSection).toHaveBeenCalledTimes(1)
    expect(store.addSection).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ops', scope: 'global', configId: undefined }))
  })

  it('with a Core tool hidden, Show hidden tools lists it and Show <tool> restores it the way it was hidden', async () => {
    BAR_STATE = { ...freshBarState(), hiddenCoreTools: { everywhere: ['logs'], bySession: {} } }
    await mount()
    expect(byTestId('core-tool-logs')).toBeNull()
    rightClick(mustGet('command-bar'))
    expect(isDisabled(byTestId('bar-show-hidden'))).toBe(false)
    expect(hintOf(byTestId('bar-show-hidden'))).toBe('1')
    click(byTestId('bar-show-hidden'))
    click(byTestId('bar-show-logs'))
    expect(bar.showCoreTool).toHaveBeenCalledWith('logs', 'everywhere', 's-1')

    BAR_STATE = { ...freshBarState(), hiddenCoreTools: { everywhere: [], bySession: { 's-1': ['logs'] } } }
    await remount()
    rightClick(mustGet('command-bar'))
    click(byTestId('bar-show-hidden'))
    click(byTestId('bar-show-logs'))
    expect(bar.showCoreTool).toHaveBeenLastCalledWith('logs', 'session', 's-1')
  })
})

describe('right-click a band: the band menu', () => {
  it('is headed by the band it was opened on and offers add command / add section here', async () => {
    await mount()
    rightClick(mustGet('command-band-global'))
    expect(menus()).toHaveLength(1)
    expect(headerOf(mustGet('band-menu')).title).toBe('Global')
    expect(byTestId('band-add-section')).not.toBeNull()
    click(byTestId('band-add-command'))
    expect(byTestId('dialog-mock')?.getAttribute('data-scope')).toBe('global')
    rightClick(mustGet('command-band-config'))
    expect(headerOf(mustGet('band-menu')).title).toBe('Session')
    click(byTestId('band-add-command'))
    expect(byTestId('dialog-mock')?.getAttribute('data-scope')).toBe('config')
  })

  it('a band is not a thing you rename, move or delete: no such item in its menu', async () => {
    await mount()
    rightClick(mustGet('command-band-global'))
    const labels = menuItemsOf(mustGet('band-menu')).map((b) => b.textContent ?? '')
    expect(labels.length).toBeGreaterThan(0)
    for (const l of labels) expect(l, l).not.toMatch(/^(Rename|Move|Delete)/)
  })

  it('Add section here… on the Global band creates a GLOBAL section (D9: a section belongs to the band it was created in)', async () => {
    await mount()
    rightClick(mustGet('command-band-global'))
    click(byTestId('band-add-section'))
    expect(menus()).toHaveLength(0)
    const input = mustGet('section-name-input')
    expect(input.closest('[role="dialog"]')?.getAttribute('aria-label')).toBe('New section')
    typeInto(input, 'Ops')
    key(input, 'Enter')
    expect(store.addSection).toHaveBeenCalledTimes(1)
    expect(store.addSection).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-id', name: 'Ops', scope: 'global', configId: undefined }))
    expect(byTestId('section-name-input')).toBeNull()
  })

  it('Add section here… on the Session band creates a section of THIS config, carrying the colour picked in the box', async () => {
    await mount()
    rightClick(mustGet('command-band-config'))
    click(byTestId('band-add-section'))
    const input = mustGet('section-name-input')
    click(input.closest('[role="dialog"]')!.querySelector<HTMLElement>('[title="#F9E2AF"]'))
    typeInto(input, 'Deploy')
    key(input, 'Enter')
    expect(store.addSection).toHaveBeenCalledTimes(1)
    expect(store.addSection).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-id', name: 'Deploy', color: '#F9E2AF', scope: 'config', configId: 'cfg' }))
  })

  it('an empty name is not a section: Enter on a blank box writes nothing', async () => {
    await mount()
    rightClick(mustGet('command-band-global'))
    click(byTestId('band-add-section'))
    typeInto(byTestId('section-name-input'), '   ')
    key(byTestId('section-name-input'), 'Enter')
    expect(store.addSection).not.toHaveBeenCalled()
    expect(byTestId('section-name-input')).not.toBeNull()
  })

  it.todo('Collapse band -- not offered by the band menu yet (D9 optional); add the item and its store call when it is wired')
})

describe('the Add caret: the add menu', () => {
  it('offers command, section, note and manage; "Review N commands…" appears only while a visible command needs review', async () => {
    await mount()
    click(mustGet('command-add-caret'))
    expect(menus()).toHaveLength(1)
    expect(mustGet('add-menu')).not.toBeNull()
    for (const id of ['add-command', 'add-section', 'add-note', 'add-manage']) expect(byTestId(id), id).not.toBeNull()
    expect(byTestId('add-review')).toBeNull()
    // Add note… opens the note dialog for a NEW note (the Notes tool in Core, D10).
    click(byTestId('add-note'))
    expect(byTestId('note-dialog')).not.toBeNull()
    expect(byTestId('note-dialog')!.textContent).toContain('New note')
    key(byTestId('note-dialog'), 'Escape')
    expect(byTestId('note-dialog')).toBeNull()

    COMMANDS = ALL.map((c) => (c.id === 'g1' ? { ...c, needsReview: ['section-dissolved'] } : c))
    await remount()
    click(mustGet('command-add-caret'))
    expect(byTestId('add-review')?.textContent).toBe('Review 1 command…')
    click(byTestId('add-review'))
    expect(byTestId('dialog-mock')?.getAttribute('data-initial')).toBe('g1')

    COMMANDS = ALL.map((c) => (c.id === 'g1' || c.id === 'c1' ? { ...c, needsReview: ['section-dissolved'] } : c))
    await remount()
    click(mustGet('command-add-caret'))
    expect(byTestId('add-review')?.textContent).toBe('Review 2 commands…')
  })

  it('Add section… from the caret creates it in the Session band while a config is active', async () => {
    await mount()
    click(mustGet('command-add-caret'))
    click(byTestId('add-section'))
    expect(menus()).toHaveLength(0)
    typeInto(byTestId('section-name-input'), 'Ops')
    key(byTestId('section-name-input'), 'Enter')
    expect(store.addSection).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ops', scope: 'config', configId: 'cfg' }))
  })
})

describe('right-click a Core tool: the core tool menu', () => {
  it('Logs: Hide this tool ▸ In this session / Everywhere, and the foot says where hidden tools come back', async () => {
    await mount()
    rightClick(mustGet('core-tool-logs'))
    expect(menus()).toHaveLength(1)
    const menu = mustGet('core-tool-menu')
    expect(headerOf(menu).title).toBe('Logs')
    click(byTestId('menu-hide-tool'))
    expect(byTestId('menu-hide-session')?.textContent).toBe('In this session')
    expect(byTestId('menu-hide-everywhere')?.textContent).toBe('Everywhere')
    expect(menu.textContent).toContain('Hidden tools come back from Settings → Custom Commands')
    // Core order is not user-sortable yet: the Move item appears only when wired.
    expect(byTestId('menu-move-tool')).toBeNull()
  })

  it('Partner: the first item opens the partner shell (or goes back to the main terminal when it is open) and calls onTogglePartner', async () => {
    const toggle = vi.fn()
    await mount({ onTogglePartner: toggle, isPartnerActive: false })
    rightClick(mustGet('core-tool-partner'))
    const menu = mustGet('core-tool-menu')
    expect(headerOf(menu).title).toBe('Partner')
    const first = menuItemsOf(menu)[0]
    expect(first?.dataset.testid).toBe('menu-partner-toggle')
    expect(first?.textContent).toBe('Open partner shell')
    click(first)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(menus()).toHaveLength(0)

    await remount({ onTogglePartner: toggle, isPartnerActive: true })
    rightClick(mustGet('core-tool-partner'))
    expect(menuItemsOf(mustGet('core-tool-menu'))[0]?.textContent).toBe('Back to the main terminal')
  })

  it('Snap: "Screenshot settings…" asks the app to open Settings on the Commands tab', async () => {
    await mount()
    rightClick(mustGet('core-tool-snap'))
    const menu = mustGet('core-tool-menu')
    expect(headerOf(menu).title).toBe('Snap')
    const item = byTestId('menu-snap-settings')
    expect(item?.textContent).toBe('Screenshot settings…')
    const settings = settingsOpens()
    click(item)
    settings.stop()
    expect(settings.opened).toEqual(['commands'])
    expect(menus()).toHaveLength(0)
  })

  it('Notes: "Add note…" opens the note dialog for a new note; "Open notes" opens the notes list', async () => {
    await mount()
    rightClick(mustGet('core-tool-notes'))
    expect(headerOf(mustGet('core-tool-menu')).title).toBe('Notes')
    click(byTestId('menu-notes-add'))
    expect(menus()).toHaveLength(0)
    expect(byTestId('note-dialog')).not.toBeNull()
    expect(byTestId('note-dialog')!.textContent).toContain('New note')
    key(byTestId('note-dialog'), 'Escape')
    expect(byTestId('note-dialog')).toBeNull()

    rightClick(mustGet('core-tool-notes'))
    click(byTestId('menu-notes-open'))
    await flush()
    expect(menus()).toHaveLength(0)
    expect(byTestId('notes-popover')).not.toBeNull()
  })

  it.todo('Move left/right on a Core tool -- not wired (D9 optional): CoreToolMenu draws the item only when the bar passes onMove')
})

/**
 * Dismissal is MOUSEDOWN on the backdrop, never click (the house rule behind
 * TerminalContextMenu: Ctrl+C in the terminal fires click events on backdrops,
 * so a click-to-close surface vanishes under the user's hands). A synthetic
 * click on the backdrop must leave the surface open; a mousedown inside it
 * must too; only a mousedown on the backdrop closes it. Copilot review on
 * PR #386 caught the click handlers.
 */
describe('dismissal: a backdrop mousedown closes, a click never does (house rule)', () => {
  const mousedown = (el: Element | null) => {
    if (!el) throw new Error('nothing to mousedown')
    act(() => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
  }

  it('a chip menu: click on the backdrop keeps it; mousedown inside keeps it; mousedown on the backdrop closes it', async () => {
    await mount()
    rightClick(chip('g1'))
    const menu = mustGet('command-menu')
    const backdrop = mustGet('command-bar-menu-backdrop')
    expect(backdrop.onclick, 'no click handler on the backdrop').toBeNull()
    click(backdrop)
    expect(menus(), 'still open after a click on the backdrop').toHaveLength(1)
    mousedown(menuItemsOf(menu)[0])
    expect(menus(), 'still open after a mousedown inside').toHaveLength(1)
    mousedown(backdrop)
    expect(menus()).toHaveLength(0)
  })

  it('the arguments popover: typed input survives a click on the backdrop; a mousedown on it closes', async () => {
    COMMANDS = ALL.map((c) => (c.id === 'c1' ? { ...c, defaultArgs: ['--watch'] } : c))
    await mount()
    rightClick(chip('c1'))
    click(byTestId('menu-run-args'))
    const popover = () => container.querySelector<HTMLElement>('[role="dialog"][aria-label="Shell one — arguments"]')
    expect(popover(), 'args popover open').not.toBeNull()
    const backdrop = mustGet('command-args-backdrop')
    expect(backdrop.onclick).toBeNull()
    const input = popover()!.querySelector<HTMLInputElement>('input[type="text"]')
    typeInto(input, '--verbose')
    click(backdrop)
    expect(popover(), 'still open after a click on the backdrop').not.toBeNull()
    expect(popover()!.querySelector<HTMLInputElement>('input[type="text"]')!.value, 'typed input kept').toBe('--verbose')
    mousedown(input)
    expect(popover(), 'still open after a mousedown inside').not.toBeNull()
    mousedown(backdrop)
    expect(popover()).toBeNull()
    expect(ptyWrite).not.toHaveBeenCalled()
  })
})
