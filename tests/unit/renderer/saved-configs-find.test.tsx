// @vitest-environment jsdom
/**
 * Saved Configs -- the FIND + CATEGORIES view (#362).
 *
 * Pins: chips for All / Pinned / sections / groups with counts over the
 * launchable set; a chip filters the flat list; launch-all on a group chip
 * never launches a running config; type -> arrow -> Enter launches; the hover
 * edit/delete actions do not also launch the row; running configs are hidden.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SETTINGS: any = { settings: { theme: 'dark', codexEnabled: true } }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: (s: any) => unknown) => sel(SETTINGS)
  useSettingsStore.getState = () => SETTINGS
  return { useSettingsStore }
})

const { default: SavedConfigsFind } = await import('../../../src/renderer/components/sidebar/SavedConfigsFind')
type Props = React.ComponentProps<typeof SavedConfigsFind>

const cfg = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, workingDirectory: `/w/${id}`, color: '', sessionType: 'local' as const, provider: 'claude' as const, identityColorKey: 'blue' as const, ...over,
})
const groups = [{ id: 'g1', name: 'Work', sectionId: 's1' }, { id: 'g2', name: 'Personal' }]
const sections = [{ id: 's1', name: 'Day job' }]
const configs: any[] = [
  cfg('alpha', { groupId: 'g1', pinned: true }),
  cfg('beta', { groupId: 'g1' }),
  cfg('gamma', { groupId: 'g1', provider: 'codex' }),
  cfg('blog', { groupId: 'g2' }),
  cfg('delta'),
  cfg('notes', { sectionId: 's1' }),
]

let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); SETTINGS.settings.codexEnabled = true })
afterEach(() => { act(() => root.unmount()); container.remove() })

function render(over: Partial<Props> = {}) {
  const props: Props = {
    configs, groups, sections, runningIds: new Set(),
    onLaunch: vi.fn(), onLaunchMany: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onContextMenu: vi.fn(),
    ...over,
  }
  act(() => root.render(<SavedConfigsFind {...props} />))
  return props
}
const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-ux-id="saved-config-row"]'))
const rowIds = () => rows().map((r) => r.dataset.configId)
const chips = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-ux-id="saved-configs-category"]'))
const chipByLabel = (label: string) => chips().find((c) => c.textContent!.startsWith(label))!
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Find a saved config"]')!
const type = (text: string) => act(() => {
  const el = input()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (k: string) => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

describe('SavedConfigsFind', () => {
  it('renders the chips with counts over the launchable set, and a flat list', () => {
    render({ runningIds: new Set(['beta']) })
    expect(chips().map((c) => c.textContent)).toEqual(['All5', 'Pinned1', 'Day job3', 'Work2', 'Personal1'])
    expect(rowIds()).toEqual(['alpha', 'gamma', 'blog', 'delta', 'notes'])
    expect(container.querySelector('[data-ux-id="saved-configs-running-note"]')!.textContent).toContain('1 running')
  })

  it('a chip filters the list; a section chip covers its groups and loose configs', () => {
    render()
    click(chipByLabel('Work'))
    expect(rowIds()).toEqual(['alpha', 'beta', 'gamma'])
    expect(chipByLabel('Work').getAttribute('aria-pressed')).toBe('true')
    click(chipByLabel('Day job'))
    expect(rowIds()).toEqual(['alpha', 'beta', 'gamma', 'notes'])
    click(chipByLabel('Pinned'))
    expect(rowIds()).toEqual(['alpha'])
  })

  it('shows launch-all only on a group/section chip and never launches a running config', () => {
    const p = render({ runningIds: new Set(['alpha']) })
    expect(container.querySelector('[data-ux-id="saved-configs-launch-all"]')).toBeNull() // All: no launch-all
    click(chipByLabel('Work'))
    const btn = container.querySelector<HTMLButtonElement>('[data-ux-id="saved-configs-launch-all"]')!
    expect(btn.textContent).toBe('Launch all 2')
    click(btn)
    const launched = (p.onLaunchMany as any).mock.calls[0][0].map((c: any) => c.id)
    expect(launched).toEqual(['beta', 'gamma'])
    expect(launched).not.toContain('alpha')
  })

  it('launch-all skips a Codex config while Codex is off', () => {
    SETTINGS.settings.codexEnabled = false
    const p = render()
    click(chipByLabel('Work'))
    click(container.querySelector('[data-ux-id="saved-configs-launch-all"]')!)
    expect((p.onLaunchMany as any).mock.calls[0][0].map((c: any) => c.id)).toEqual(['alpha', 'beta'])
  })

  it('type -> arrow -> Enter launches the selected row, with inline completion', () => {
    const p = render()
    type('bl')
    expect(rowIds()).toEqual(['blog'])
    expect(container.querySelector('[data-ux-id="saved-configs-completion"]')!.textContent).toBe('og')
    type('ta')
    expect(rowIds()).toEqual(['beta', 'delta'])
    key('ArrowDown'); key('ArrowDown')
    expect(container.querySelector<HTMLElement>('[aria-selected="true"]')!.dataset.configId).toBe('delta')
    key('Enter')
    expect((p.onLaunch as any).mock.calls[0][0].id).toBe('delta')
  })

  it('Enter with nothing selected launches the first match, and a chip resets the selection', () => {
    const p = render()
    click(chipByLabel('Personal'))
    key('Enter')
    expect((p.onLaunch as any).mock.calls[0][0].id).toBe('blog')
  })

  it('the hover edit and delete actions do not also launch the row', () => {
    const p = render()
    const row = rows()[0]
    click(row.querySelector('[title="Edit"]')!)
    click(row.querySelector('[title="Delete"]')!)
    expect(p.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'alpha' }))
    expect(p.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'alpha' }))
    expect(p.onLaunch).not.toHaveBeenCalled()
    click(row)
    expect((p.onLaunch as any).mock.calls[0][0].id).toBe('alpha')
  })

  it('falls back to All when the active chip loses its last config to a running session', () => {
    const p = render()
    click(chipByLabel('Personal'))
    expect(rowIds()).toEqual(['blog'])
    act(() => root.render(<SavedConfigsFind {...p} runningIds={new Set(['blog'])} />))
    expect(chipByLabel('All').getAttribute('aria-pressed')).toBe('true')
    expect(rowIds()).toEqual(['alpha', 'beta', 'gamma', 'delta', 'notes'])
  })

  it('says "Nothing matches" for a query with no hits', () => {
    render()
    type('zzz')
    expect(rows()).toHaveLength(0)
    expect(container.querySelector('[data-ux-id="saved-configs-no-match"]')!.textContent).toContain('zzz')
  })
})
