// @vitest-environment jsdom
/**
 * Saved Configs -- the CARDS view (#362).
 *
 * Pins: running configs are not listed; launch-all on a stack never launches
 * a running config (even one that started after the stack was built); the
 * find box completes inline and type -> arrow -> Enter launches; a click on a
 * card launches it; a Codex config is inert while Codex is off.
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

const { default: SavedConfigsCards } = await import('../../../src/renderer/components/sidebar/SavedConfigsCards')
type Props = React.ComponentProps<typeof SavedConfigsCards>

const cfg = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, workingDirectory: `/w/${id}`, color: '', sessionType: 'local' as const, provider: 'claude' as const, identityColorKey: 'blue' as const, ...over,
})
const groups = [{ id: 'g1', name: 'Work' }]
const configs: any[] = [
  cfg('alpha', { groupId: 'g1' }),
  cfg('beta', { groupId: 'g1' }),
  cfg('gamma', { groupId: 'g1', provider: 'codex' }),
  cfg('delta'),
  cfg('Checkout', { pinned: true }),
]

let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); SETTINGS.settings.codexEnabled = true })
afterEach(() => { act(() => root.unmount()); container.remove() })

function render(over: Partial<Props> = {}) {
  const props: Props = {
    configs, groups, sections: [], runningIds: new Set(),
    onLaunch: vi.fn(), onLaunchMany: vi.fn(), onContextMenu: vi.fn(),
    ...over,
  }
  act(() => root.render(<SavedConfigsCards {...props} />))
  return props
}
const cards = () => Array.from(container.querySelectorAll<HTMLElement>('[data-ux-id="saved-config-card"]'))
const cardIds = () => cards().map((c) => c.dataset.configId)
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Find a saved config"]')!
const type = (text: string) => act(() => {
  const el = input()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (k: string) => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

describe('SavedConfigsCards', () => {
  it('lists every config as a card, pinned pulled out first, and never a running one', () => {
    render({ runningIds: new Set(['beta']) })
    expect(cardIds()).toEqual(['Checkout', 'alpha', 'gamma', 'delta'])
    expect(container.querySelector('[data-ux-id="saved-configs-running-note"]')!.textContent).toContain('1 running')
  })

  it('says so when every config is running instead of rendering an empty list', () => {
    render({ runningIds: new Set(configs.map((c) => c.id)) })
    expect(cards()).toHaveLength(0)
    expect(container.querySelector('[data-ux-id="saved-configs-all-running"]')).toBeTruthy()
  })

  it('launch-all on a stack launches only the configs that are not running', () => {
    const p = render({ runningIds: new Set(['alpha']) })
    const btn = container.querySelector<HTMLButtonElement>('[data-ux-id="saved-configs-launch-all"]')!
    expect(btn).toBeTruthy()
    click(btn)
    expect(p.onLaunchMany).toHaveBeenCalledTimes(1)
    const launched = (p.onLaunchMany as any).mock.calls[0][0].map((c: any) => c.id)
    expect(launched).toEqual(['beta', 'gamma'])
    expect(launched).not.toContain('alpha')
  })

  it('launch-all skips a Codex config while Codex is off', () => {
    SETTINGS.settings.codexEnabled = false
    const p = render()
    click(container.querySelector('[data-ux-id="saved-configs-launch-all"]')!)
    expect((p.onLaunchMany as any).mock.calls[0][0].map((c: any) => c.id)).toEqual(['alpha', 'beta'])
  })

  it('offers no launch-all on the pinned or ungrouped stacks', () => {
    render()
    const stacks = Array.from(container.querySelectorAll<HTMLElement>('[data-ux-id="saved-configs-stack"]'))
    for (const s of stacks) {
      const has = !!s.querySelector('[data-ux-id="saved-configs-launch-all"]')
      expect(has).toBe(s.dataset.stackKind === 'group')
    }
  })

  it('typing narrows the cards and shows the inline completion', () => {
    render()
    type('che')
    expect(cardIds()).toEqual(['Checkout'])
    expect(container.querySelector('[data-ux-id="saved-configs-completion"]')!.textContent).toBe('ckout')
    key('Tab')
    expect(input().value).toBe('checkout')
  })

  it('type -> arrow -> Enter launches the selected card', () => {
    const p = render()
    type('a')                       // alpha, beta, gamma, delta all contain "a"
    key('ArrowDown'); key('ArrowDown')
    const selected = container.querySelector<HTMLElement>('[aria-selected="true"]')!
    expect(selected.dataset.configId).toBe('beta')
    key('Enter')
    expect(p.onLaunch).toHaveBeenCalledTimes(1)
    expect((p.onLaunch as any).mock.calls[0][0].id).toBe('beta')
  })

  it('Enter with nothing selected launches the first match', () => {
    const p = render()
    type('del')
    key('Enter')
    expect((p.onLaunch as any).mock.calls[0][0].id).toBe('delta')
  })

  it('a click on a card launches it; a Codex card is inert while Codex is off', () => {
    SETTINGS.settings.codexEnabled = false
    const p = render()
    click(cards().find((c) => c.dataset.configId === 'alpha')!)
    click(cards().find((c) => c.dataset.configId === 'gamma')!)
    expect((p.onLaunch as any).mock.calls.map((c: any[]) => c[0].id)).toEqual(['alpha'])
    expect(cards().find((c) => c.dataset.configId === 'gamma')!.getAttribute('aria-disabled')).toBe('true')
  })

  it('right-click hands the config to the context menu', () => {
    const p = render()
    act(() => { cards()[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    expect(p.onContextMenu).toHaveBeenCalledWith(expect.anything(), 'alpha')
  })
})
