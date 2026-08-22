// @vitest-environment jsdom
/**
 * The encrypted notes as ONE Core tool (ADR-018 D10, M5): a lock with a grey
 * count of the notes visible here (Global + this config), the list in its
 * popover, and the note dialog in the E5 look.
 *
 * Why this is tested: the header's note chips and lock-plus are removed (M5),
 * so the Core lock is now the ONLY door to the notes. The guards that matter
 * are the ones nobody sees until they break -- the count is the visible set
 * and not the whole store, `notes.list` stays names-only (content is decrypted
 * in the dialog and nowhere else), a save or delete re-reads the list, the
 * scope words are the bar's own, the delete confirm names the scope, and the
 * dialog takes its colours from the theme tokens with no backdrop click-to-
 * close (Ctrl+C fires click events -- AGENTS.md).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { NotesToolHandle } from '../../../src/renderer/components/command-bar/NotesTool'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'note-new' }))

// The notes store as the preload exposes it: a names-only index plus per-id
// content. `list` never returns content; `load` is the only way to it.
interface Note { id: string; label: string; color: string; configId?: string; createdAt: number }
let NOTES: Note[] = []
let CONTENT: Record<string, string> = {}

const notesApi = {
  list: vi.fn(async () => NOTES.map((n) => ({ ...n }))),
  load: vi.fn(async (id: string) => CONTENT[id] ?? ''),
  save: vi.fn(async (id: string, label: string, content: string, color: string, configId?: string) => {
    const i = NOTES.findIndex((n) => n.id === id)
    const createdAt = i >= 0 ? NOTES[i].createdAt : Date.now()
    const next: Note = { id, label, color, createdAt, ...(configId ? { configId } : {}) }
    if (i >= 0) NOTES[i] = next
    else NOTES.push(next)
    CONTENT[id] = content
    return true
  }),
  delete: vi.fn(async (id: string) => {
    NOTES = NOTES.filter((n) => n.id !== id)
    delete CONTENT[id]
    return true
  }),
  reorder: vi.fn(async () => true),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window?.electronAPI, notes: notesApi }

const { default: NotesTool, addedAgo } = await import('../../../src/renderer/components/command-bar/NotesTool')
const { trackUsage } = await import('../../../src/renderer/stores/tipsStore')
const { COMMAND_SWATCHES } = await import('../../../src/renderer/lib/command-swatches')

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  const now = Date.now()
  // Two Global notes, one for this config, one for another -- in this order,
  // so "list order" is not "grouped by scope".
  NOTES = [
    { id: 'g1', label: 'API keys', color: '#F9E2AF', createdAt: now - 2 * DAY },
    { id: 'c1', label: 'Deploy runbook', color: '#89B4FA', configId: 'cfg', createdAt: now - 4 * HOUR },
    { id: 'g2', label: 'Old VPN details', color: '#A6ADC8', createdAt: now - 40 * DAY },
    { id: 'o1', label: 'Staging creds', color: '#F38BA8', configId: 'other', createdAt: now - 5 * MINUTE },
  ]
  CONTENT = { g1: 'OPENAI_KEY=sk-…', c1: 'deploy steps', g2: 'vpn details', o1: 'staging creds' }
  notesApi.list.mockClear()
  notesApi.load.mockClear()
  notesApi.save.mockClear()
  notesApi.delete.mockClear()
  ;(trackUsage as unknown as ReturnType<typeof vi.fn>).mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null
const qa = <T extends Element = HTMLElement>(sel: string) => Array.from(container.querySelectorAll(sel)) as T[]
const byTest = <T extends Element = HTMLElement>(id: string) => q<T>(`[data-testid="${id}"]`)

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// list()/load() resolve on microtasks; a macrotask tick inside act drains them all.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

async function render(props: { configId?: string; configName?: string } = {}, ref?: React.Ref<NotesToolHandle>) {
  await act(async () => { root.render(React.createElement(NotesTool, { ...props, ref } as never)) })
  await flush()
}
async function click(el: Element | null) {
  expect(el).not.toBeNull()
  await act(async () => { (el as HTMLElement).click() })
  await flush()
}
async function press(el: Element | null, key: string) {
  expect(el).not.toBeNull()
  await act(async () => { el!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  await flush()
}
async function typeIn(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(el).not.toBeNull()
  await act(async () => { type(el!, value) })
}

const openPopover = async () => { await click(byTest('notes-tool')); expect(byTest('notes-popover')).not.toBeNull() }
const rowFor = (id: string) => q(`[data-testid="notes-row"][data-note-id="${id}"]`)
const rowEdit = (id: string) => rowFor(id)?.querySelector('[data-testid="notes-edit"]') ?? null
const rowDelete = (id: string) => rowFor(id)?.querySelector('[data-testid="notes-delete"]') ?? null
const confirmCancel = () => Array.from(byTest('confirm-note-delete')?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Cancel') ?? null
const swatch = (hex: string) => q<HTMLButtonElement>(`[data-testid="note-colours"] [aria-label="Colour ${hex}"]`)
const lastSave = () => notesApi.save.mock.calls[notesApi.save.mock.calls.length - 1] as unknown as [string, string, string, string, string | undefined]
/** jsdom may hand a hex colour back as rgb(); accept either spelling. */
const hexOrRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return new RegExp(`^(${hex}|rgb\\(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}\\))$`, 'i')
}

describe('1. the lock with a grey count of the notes visible here', () => {
  it('counts Global + this config for a session with a config', async () => {
    await render({ configId: 'cfg' })
    expect(byTest('notes-tool')).not.toBeNull()
    expect(byTest('notes-count')!.textContent).toBe('3')
    // quiet: the count is grey, the chip is at full opacity
    expect(byTest('notes-count')!.style.color).toBe('var(--text-muted)')
    expect(byTest('notes-tool')!.style.opacity).toBe('1')
    expect(byTest('notes-tool')!.getAttribute('title')).toContain('Notes · 3 here')
  })

  it('counts only the Global notes with no config (Ask Conductor)', async () => {
    await render({})
    expect(byTest('notes-count')!.textContent).toBe('2')
  })

  it('with nothing visible here: no count, the lock alone at 60 %, tooltip "none here — add one"', async () => {
    NOTES = NOTES.filter((n) => n.configId === 'other')
    await render({ configId: 'cfg' })
    expect(byTest('notes-count')).toBeNull()
    expect(byTest('notes-tool')!.style.opacity).toBe('0.6')
    expect(byTest('notes-tool')!.getAttribute('title')).toContain('none here — add one')
  })
})

describe('2. click opens the popover with the visible notes as rows', () => {
  it('lists exactly the visible notes, in list order, with swatch · label · scope · added · Edit · Delete', async () => {
    await render({ configId: 'cfg' })
    expect(byTest('notes-tool')!.getAttribute('aria-expanded')).toBe('false')
    await openPopover()
    const pop = byTest('notes-popover')!
    expect(pop.getAttribute('role')).toBe('dialog')
    expect(byTest('notes-tool')!.getAttribute('aria-expanded')).toBe('true')
    expect(byTest('notes-popover-title')!.textContent).toBe('Notes · 3 here')

    const rows = qa('[data-testid="notes-row"]')
    expect(rows.map((r) => r.getAttribute('data-note-id'))).toEqual(['g1', 'c1', 'g2'])
    const expected: Record<string, { label: string; color: string; scope: string; added: string }> = {
      g1: { label: 'API keys', color: '#F9E2AF', scope: 'Global', added: 'added 2d ago' },
      c1: { label: 'Deploy runbook', color: '#89B4FA', scope: 'Session', added: 'added 4h ago' },
      g2: { label: 'Old VPN details', color: '#A6ADC8', scope: 'Global', added: 'added 1mo ago' },
    }
    for (const row of rows) {
      const e = expected[row.getAttribute('data-note-id')!]
      const dot = row.querySelector<HTMLElement>('span[aria-hidden]')!
      expect(dot.style.background).toMatch(hexOrRgb(e.color))
      expect(row.textContent).toContain(e.label)
      expect(row.querySelector('[data-testid="notes-row-scope"]')!.textContent).toBe(e.scope)
      expect(row.textContent).toContain(e.added)
      expect(row.querySelector('[data-testid="notes-edit"]')!.textContent).toBe('Edit')
      expect(row.querySelector('[data-testid="notes-delete"]')!.textContent).toBe('Delete')
      expect(row.getAttribute('data-other')).toBeNull()
    }
  })

  it('folds the other config\'s note under one line until that line is clicked', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    expect(rowFor('o1')).toBeNull()
    const toggle = byTest('notes-others-toggle')!
    expect(toggle.textContent).toContain('1 more in other config')
    expect(toggle.textContent).not.toContain('configs')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const other = rowFor('o1')!
    expect(other).not.toBeNull()
    expect(other.getAttribute('data-other')).toBe('true')
    expect(other.querySelector('[data-testid="notes-row-scope"]')!.textContent).toBe('Session')
    expect(qa('[data-testid="notes-row"]')).toHaveLength(4)
    // the fold does not change the count -- those notes are not "here"
    expect(byTest('notes-popover-title')!.textContent).toBe('Notes · 3 here')
  })

  it('with no config, this config\'s and the other\'s notes both fold ("2 more in other configs")', async () => {
    await render({})
    await openPopover()
    expect(qa('[data-testid="notes-row"]').map((r) => r.getAttribute('data-note-id'))).toEqual(['g1', 'g2'])
    expect(byTest('notes-others-toggle')!.textContent).toContain('2 more in other configs')
  })
})

describe('3. addedAgo reads the index\'s createdAt in plain words', () => {
  const now = 1_700_000_000_000
  it('just now, minutes, hours, days, months, years', () => {
    expect(addedAgo(now - 30_000, now)).toBe('added just now')
    expect(addedAgo(now - 5 * MINUTE, now)).toBe('added 5m ago')
    expect(addedAgo(now - 3 * HOUR, now)).toBe('added 3h ago')
    expect(addedAgo(now - 2 * DAY, now)).toBe('added 2d ago')
    expect(addedAgo(now - 60 * DAY, now)).toBe('added 2mo ago')
    expect(addedAgo(now - 400 * DAY, now)).toBe('added 1y ago')
    expect(addedAgo(now - 800 * DAY, now)).toBe('added 2y ago')
  })
  it('a createdAt in the future (clock skew) is "just now", never negative', () => {
    expect(addedAgo(now + 5 * MINUTE, now)).toBe('added just now')
  })
})

describe('4. notes.list is names-only -- content is decrypted in the dialog and nowhere else', () => {
  it('never calls notes.load for the tool or the popover; loads the one note when Edit opens it', async () => {
    await render({ configId: 'cfg' })
    expect(notesApi.load).not.toHaveBeenCalled()
    await openPopover()
    expect(notesApi.load).not.toHaveBeenCalled()

    let resolveLoad!: (text: string) => void
    notesApi.load.mockImplementationOnce(() => new Promise<string>((r) => { resolveLoad = r }))
    await click(rowEdit('g1'))
    expect(notesApi.load).toHaveBeenCalledTimes(1)
    expect(notesApi.load).toHaveBeenCalledWith('g1')
    expect(byTest('note-dialog')).not.toBeNull()
    expect(byTest('note-decrypting')).not.toBeNull()
    expect(byTest('note-content')).toBeNull()
    // cannot save while the content is still decrypting
    expect(byTest<HTMLButtonElement>('note-save')!.disabled).toBe(true)

    await act(async () => { resolveLoad('OPENAI_KEY=sk-…') })
    await flush()
    expect(byTest('note-decrypting')).toBeNull()
    expect(byTest<HTMLTextAreaElement>('note-content')!.value).toBe('OPENAI_KEY=sk-…')
    expect(byTest<HTMLButtonElement>('note-save')!.disabled).toBe(false)
    expect(notesApi.load).toHaveBeenCalledTimes(1)
  })
})

describe('5. Edit → save goes through notes.save, is tracked, and re-reads the list', () => {
  it('saves the new label/content with the note\'s colour and scope, then the count follows the re-read', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('g1'))
    expect(byTest('note-dialog')!.querySelector('h2')!.textContent).toContain('Edit note')
    expect(byTest<HTMLInputElement>('note-label')!.value).toBe('API keys')
    expect(byTest<HTMLTextAreaElement>('note-content')!.value).toBe('OPENAI_KEY=sk-…')

    await typeIn(byTest<HTMLInputElement>('note-label'), 'API keys v2')
    await typeIn(byTest<HTMLTextAreaElement>('note-content'), 'OPENAI_KEY=sk-new')
    const listCallsBefore = notesApi.list.mock.calls.length
    // Another window added a Global note meanwhile: only a re-read can show it.
    NOTES.push({ id: 'g3', label: 'Added elsewhere', color: '#A6E3A1', createdAt: Date.now() })

    await click(byTest('note-save'))
    expect(notesApi.save).toHaveBeenCalledTimes(1)
    const [id, label, content, color, cfg] = lastSave()
    expect([id, label, content, color]).toEqual(['g1', 'API keys v2', 'OPENAI_KEY=sk-new', '#F9E2AF'])
    expect(cfg).toBeUndefined()
    expect(trackUsage).toHaveBeenCalledWith('security.encrypted-notes')
    expect(byTest('note-dialog')).toBeNull()
    expect(notesApi.list.mock.calls.length).toBeGreaterThan(listCallsBefore)
    expect(byTest('notes-count')!.textContent).toBe('4')
    // and the list shows the saved label
    await openPopover()
    expect(rowFor('g1')!.textContent).toContain('API keys v2')
  })

  it('a Session note saves with this config\'s id', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('c1'))
    await typeIn(byTest<HTMLInputElement>('note-label'), 'Deploy runbook 2')
    await click(byTest('note-save'))
    const [id, label, content, color, cfg] = lastSave()
    expect([id, label, content, color, cfg]).toEqual(['c1', 'Deploy runbook 2', 'deploy steps', '#89B4FA', 'cfg'])
  })
})

describe('6. Add note from the popover', () => {
  it('opens "New note" defaulting to Session when there is a config, and saves note-new with the default colour', async () => {
    await render({ configId: 'cfg', configName: 'Work' })
    await openPopover()
    await click(byTest('notes-add'))
    expect(byTest('notes-popover')).toBeNull()
    const dlg = byTest('note-dialog')!
    expect(dlg.querySelector('h2')!.textContent).toContain('New note')
    expect(byTest('note-scope')!.getAttribute('role')).toBe('radiogroup')
    expect(byTest('note-scope-config')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('note-scope-global')!.getAttribute('aria-checked')).toBe('false')
    expect(byTest<HTMLButtonElement>('note-scope-config')!.disabled).toBe(false)
    expect(dlg.textContent).toContain('(Work)')
    // no Delete… on a new note; cannot create without a label
    expect(byTest('note-delete')).toBeNull()
    expect(byTest<HTMLButtonElement>('note-save')!.disabled).toBe(true)
    expect(byTest('note-save')!.textContent).toBe('Create note')

    await typeIn(byTest<HTMLInputElement>('note-label'), 'Runbook')
    await typeIn(byTest<HTMLTextAreaElement>('note-content'), 'step 1')
    await click(byTest('note-save'))
    expect(lastSave()).toEqual(['note-new', 'Runbook', 'step 1', '#F9E2AF', 'cfg'])
    expect(byTest('note-dialog')).toBeNull()
    expect(byTest('notes-count')!.textContent).toBe('4')
  })

  it('with Global chosen in a config session, the note is saved with no configId', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(byTest('notes-add'))
    await click(byTest('note-scope-global'))
    expect(byTest('note-scope-global')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('note-scope-config')!.getAttribute('aria-checked')).toBe('false')
    await typeIn(byTest<HTMLInputElement>('note-label'), 'Everywhere')
    await typeIn(byTest<HTMLTextAreaElement>('note-content'), 'x')
    await click(byTest('note-save'))
    const [id, label, content, color, cfg] = lastSave()
    expect([id, label, content, color]).toEqual(['note-new', 'Everywhere', 'x', '#F9E2AF'])
    expect(cfg).toBeUndefined()
  })

  it('without a config the note is Global and the Session chip is disabled with the reason', async () => {
    await render({})
    await openPopover()
    await click(byTest('notes-add'))
    expect(byTest('note-scope-global')!.getAttribute('aria-checked')).toBe('true')
    const session = byTest<HTMLButtonElement>('note-scope-config')!
    expect(session.disabled).toBe(true)
    expect(session.getAttribute('aria-disabled')).toBe('true')
    expect(session.getAttribute('title')).toContain('no saved config')
    expect(byTest('note-dialog')!.textContent).toContain('so the note is Global')
    // clicking the disabled chip changes nothing
    await click(session)
    expect(byTest('note-scope-global')!.getAttribute('aria-checked')).toBe('true')
    await typeIn(byTest<HTMLInputElement>('note-label'), 'Ask notes')
    await typeIn(byTest<HTMLTextAreaElement>('note-content'), 'y')
    await click(byTest('note-save'))
    const [id, , , , cfg] = lastSave()
    expect(id).toBe('note-new')
    expect(cfg).toBeUndefined()
  })
})

describe('7. Delete asks first, names the scope, and re-reads the list', () => {
  it('from a row: Cancel deletes nothing; Delete note calls notes.delete and the count drops', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowDelete('g1'))
    expect(byTest('notes-popover')).toBeNull()
    const card = byTest('confirm-note-delete')!
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('Delete the note "API keys"?')
    expect(card.textContent).toContain('This note is Global — it disappears from every config.')
    expect(card.textContent).toContain('This cannot be undone.')
    await click(confirmCancel())
    expect(byTest('confirm-note-delete')).toBeNull()
    expect(notesApi.delete).not.toHaveBeenCalled()
    expect(byTest('notes-count')!.textContent).toBe('3')

    await openPopover()
    await click(rowDelete('c1'))
    expect(byTest('confirm-note-delete')!.textContent).toContain('This note is Session — it disappears from this config only.')
    const listCallsBefore = notesApi.list.mock.calls.length
    await click(byTest('confirm-note-delete-ok'))
    expect(notesApi.delete).toHaveBeenCalledTimes(1)
    expect(notesApi.delete).toHaveBeenCalledWith('c1')
    expect(byTest('confirm-note-delete')).toBeNull()
    expect(notesApi.list.mock.calls.length).toBeGreaterThan(listCallsBefore)
    expect(byTest('notes-count')!.textContent).toBe('2')
    await openPopover()
    expect(rowFor('c1')).toBeNull()
  })

  it('Delete… inside the edit dialog opens the same confirm and deletes through notes.delete', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('g2'))
    expect(byTest('note-dialog')).not.toBeNull()
    await click(byTest('note-delete'))
    const card = byTest('confirm-note-delete')!
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('Delete the note "Old VPN details"?')
    expect(card.textContent).toContain('This note is Global')
    // the dialog is still there behind the confirm
    expect(byTest('note-dialog')).not.toBeNull()
    await click(byTest('confirm-note-delete-ok'))
    expect(notesApi.delete).toHaveBeenCalledWith('g2')
    expect(byTest('confirm-note-delete')).toBeNull()
    expect(byTest('note-dialog')).toBeNull()
    expect(byTest('notes-count')!.textContent).toBe('2')
  })
})

describe('8. "Where it shows" on an existing note', () => {
  it('a Session note opens with Session checked; flipped to Global, it saves with no configId', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('c1'))
    expect(byTest('note-scope-config')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('note-scope-global')!.getAttribute('aria-checked')).toBe('false')
    await click(byTest('note-scope-global'))
    expect(byTest('note-scope-global')!.getAttribute('aria-checked')).toBe('true')
    await click(byTest('note-save'))
    const [id, label, content, color, cfg] = lastSave()
    expect([id, label, content, color]).toEqual(['c1', 'Deploy runbook', 'deploy steps', '#89B4FA'])
    expect(cfg).toBeUndefined()
    // it is now Global in the list
    await openPopover()
    expect(rowFor('c1')!.querySelector('[data-testid="notes-row-scope"]')!.textContent).toBe('Global')
  })

  it('a Global note opens with Global checked; flipped to Session, it saves with this config', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('g1'))
    expect(byTest('note-scope-global')!.getAttribute('aria-checked')).toBe('true')
    await click(byTest('note-scope-config'))
    await click(byTest('note-save'))
    expect(lastSave()[4]).toBe('cfg')
    // it left the Ask Conductor view: only g2 is Global now
    await openPopover()
    expect(rowFor('g1')!.querySelector('[data-testid="notes-row-scope"]')!.textContent).toBe('Session')
  })
})

describe('9. Colour: the eleven pastels, an off-palette colour kept', () => {
  it('offers exactly the eleven pastels for a palette note, the note\'s own pressed', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('g1'))
    const picks = qa<HTMLButtonElement>('[data-testid="note-colours"] button')
    expect(picks).toHaveLength(11)
    expect(picks.map((b) => b.getAttribute('aria-label'))).toEqual(COMMAND_SWATCHES.map((c) => `Colour ${c}`))
    expect(picks.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('aria-label'))).toEqual(['Colour #F9E2AF'])
  })

  it('an existing off-palette colour is an extra swatch, pressed and marked "kept"; picking a pastel saves it', async () => {
    NOTES = [{ id: 'x1', label: 'Legacy', color: '#FF5C8A', createdAt: Date.now() - DAY }]
    CONTENT = { x1: 'old' }
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('x1'))
    const picks = qa<HTMLButtonElement>('[data-testid="note-colours"] button')
    expect(picks).toHaveLength(12)
    const kept = swatch('#FF5C8A')!
    expect(kept).not.toBeNull()
    expect(kept.getAttribute('aria-pressed')).toBe('true')
    expect(kept.getAttribute('title')).toContain('kept')
    // the pastels carry no such note
    expect(swatch('#89B4FA')!.getAttribute('title')).not.toContain('kept')
    expect(swatch('#89B4FA')!.getAttribute('aria-pressed')).toBe('false')

    await click(swatch('#89B4FA'))
    expect(swatch('#89B4FA')!.getAttribute('aria-pressed')).toBe('true')
    expect(swatch('#FF5C8A')!.getAttribute('aria-pressed')).toBe('false')
    await click(byTest('note-save'))
    expect(lastSave().slice(0, 4)).toEqual(['x1', 'Legacy', 'old', '#89B4FA'])
  })
})

describe('10. Escape', () => {
  it('on the popover closes it and puts focus back on the tool', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    expect(document.activeElement).toBe(byTest('notes-popover'))
    await press(byTest('notes-popover'), 'Escape')
    expect(byTest('notes-popover')).toBeNull()
    expect(byTest('notes-tool')!.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(byTest('notes-tool'))
  })

  it('in the dialog cancels it; with the delete confirm open it closes only the confirm', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('g1'))
    await press(byTest('note-label'), 'Escape')
    expect(byTest('note-dialog')).toBeNull()
    expect(notesApi.save).not.toHaveBeenCalled()

    await openPopover()
    await click(rowEdit('g1'))
    await click(byTest('note-delete'))
    expect(byTest('confirm-note-delete')).not.toBeNull()
    await press(byTest('note-label'), 'Escape')
    expect(byTest('confirm-note-delete')).toBeNull()
    expect(byTest('note-dialog')).not.toBeNull()
    expect(notesApi.delete).not.toHaveBeenCalled()
    // a second Escape now cancels the dialog
    await press(byTest('note-label'), 'Escape')
    expect(byTest('note-dialog')).toBeNull()
  })

  it('on the row-delete confirm (no dialog) closes the confirm and deletes nothing', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowDelete('g1'))
    expect(byTest('confirm-note-delete')).not.toBeNull()
    await press(byTest('confirm-note-delete-ok'), 'Escape')
    expect(byTest('confirm-note-delete')).toBeNull()
    expect(notesApi.delete).not.toHaveBeenCalled()
  })
})

describe('11. the imperative handle (the Add ▾ menu and the Core menu call these)', () => {
  it('addNote() opens the dialog for a new note in this session\'s scope; openList() opens the popover', async () => {
    const ref = React.createRef<NotesToolHandle>()
    await render({ configId: 'cfg' }, ref)
    expect(ref.current).not.toBeNull()

    await act(async () => { ref.current!.addNote() })
    await flush()
    const dlg = byTest('note-dialog')!
    expect(dlg).not.toBeNull()
    expect(dlg.querySelector('h2')!.textContent).toContain('New note')
    expect(byTest('note-scope-config')!.getAttribute('aria-checked')).toBe('true')
    await press(byTest('note-label'), 'Escape')
    expect(byTest('note-dialog')).toBeNull()

    await act(async () => { ref.current!.openList() })
    await flush()
    expect(byTest('notes-popover')).not.toBeNull()
    expect(byTest('notes-popover-title')!.textContent).toBe('Notes · 3 here')
    expect(byTest('notes-tool')!.getAttribute('aria-expanded')).toBe('true')

    // addNote while the list is open: the list gives way to the dialog
    await act(async () => { ref.current!.addNote() })
    await flush()
    expect(byTest('notes-popover')).toBeNull()
    expect(byTest('note-dialog')).not.toBeNull()
  })
})

describe('12. the E5 tokens on the note dialog, and no backdrop click-to-close', () => {
  const PALETTE_CLASS = /^(bg-mantle|bg-surface0|text-subtext0|text-overlay\d?|border-surface1|bg-blue|text-blue|bg-crust)/
  function paletteSurvivors(scope: Element): string[] {
    const out: string[] = []
    for (const el of Array.from(scope.querySelectorAll('[class]')).concat(scope)) {
      for (const token of (el.getAttribute('class') ?? '').split(/\s+/)) {
        if (PALETTE_CLASS.test(token)) out.push(`${el.tagName.toLowerCase()}[data-testid="${el.getAttribute('data-testid') ?? ''}"] .${token}`)
      }
    }
    return out
  }

  it('the panel is the raised surface, the save button the brand colour, and no palette class survives', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('g1'))
    const dlg = byTest('note-dialog')!
    const panel = dlg.querySelector<HTMLElement>('[role="dialog"]')!
    expect(panel.style.background).toBe('var(--surface-raised)')
    expect(panel.style.border).toContain('var(--border-subtle)')
    expect(byTest('note-save')!.style.background).toBe('var(--brand)')
    expect(byTest('note-label')!.style.background).toBe('var(--surface-base)')
    expect(byTest('note-label')!.style.borderColor).toBe('var(--border-strong)')
    expect(paletteSurvivors(dlg)).toEqual([])
    // the delete confirm too, while we are here
    await click(byTest('note-delete'))
    expect(paletteSurvivors(byTest('note-dialog')!)).toEqual([])
  })

  it('the popover is the overlay surface with the strong border, by token', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    const pop = byTest('notes-popover')!
    expect(pop.style.background).toBe('var(--surface-overlay)')
    expect(pop.style.border).toContain('var(--border-strong)')
    expect(paletteSurvivors(pop)).toEqual([])
  })

  it('clicking the dialog overlay does NOT cancel (Ctrl+C fires click events)', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    await click(rowEdit('g1'))
    const overlay = byTest('note-dialog')!
    expect(overlay.onclick).toBeNull()
    await click(overlay)
    await act(async () => { overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(byTest('note-dialog')).not.toBeNull()
    expect(byTest<HTMLInputElement>('note-label')!.value).toBe('API keys')
  })

  it('the popover dismisses on a backdrop MOUSEDOWN, never on a click (the same rule; Copilot on PR #386)', async () => {
    await render({ configId: 'cfg' })
    await openPopover()
    const backdrop = byTest('notes-popover-backdrop')!
    expect(backdrop.onclick, 'no click handler on the backdrop').toBeNull()
    await click(backdrop)
    expect(byTest('notes-popover'), 'still open after a click on the backdrop').not.toBeNull()
    await act(async () => { byTest('notes-popover')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(byTest('notes-popover'), 'still open after a mousedown inside').not.toBeNull()
    await act(async () => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(byTest('notes-popover')).toBeNull()
  })
})
