// @vitest-environment jsdom
/**
 * Allow Multi Spawn (phase 4) — the SURFACES.
 *
 * The rule itself is pinned in multi-spawn-rule.test.ts. What is pinned here is
 * that every launch surface actually SHOWS it: a refused launch must never be a
 * dead button. Each surface either offers the ×N control (Multi Spawn on), or
 * a blocked control that raises the popover and offers the way out.
 *
 * Both surfaces import the REAL rule (only `useLaunchConfig` itself is stubbed,
 * to keep the session store out), so flipping the rule fails these too.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SETTINGS: any = { settings: { codexEnabled: true, quickStartCollapsed: false }, updateSettings: vi.fn() }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS)
  useSettingsStore.getState = () => SETTINGS
  return { useSettingsStore }
})
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useLaunchConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/hooks/useLaunchConfig')>()),
  useLaunchConfig: () => () => '',
}))

const { default: ConfigRow } = await import('../../../src/renderer/components/sidebar/ConfigRow')
const { default: QuickStartPanel } = await import('../../../src/renderer/components/sidebar/QuickStartPanel')
const { alreadyRunningLaunchCopy, cannotSelectCopy, flattenPopoverCopy } =
  await import('../../../src/renderer/hooks/useLaunchConfig')

const cfg = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  label: 'Pi-Miner',
  workingDirectory: '/x',
  color: '',
  sessionType: 'local',
  provider: 'claude',
  pinned: true,
  ...over,
}) as any

describe('ConfigRow — the launch affordance under the rule', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const renderRow = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(ConfigRow, {
      config: cfg(), onLaunch: () => {}, onEdit: () => {}, onDelete: () => {}, onContextMenu: () => {}, ...props,
    } as any)))

  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null

  it('idle + one-at-a-time: the ordinary play button, no blocked control', () => {
    renderRow({ runningCount: 0 })
    expect(q('[data-testid="config-row-launch-blocked"]')).toBeNull()
    expect(q('[data-testid="config-row-multi-spawn"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.title)).toContain('Launch')
  })

  it('running + one-at-a-time: the play button is BLOCKED and says why', () => {
    renderRow({ runningCount: 1 })
    const blocked = q('[data-testid="config-row-launch-blocked"]')!
    expect(blocked).toBeTruthy()
    expect(blocked.getAttribute('aria-disabled')).toBe('true')
    expect(blocked.title).toBe(flattenPopoverCopy(alreadyRunningLaunchCopy('Pi-Miner')))
    // The blocked recipe: border-subtle / surface-raised / text-muted.
    expect(blocked.className).toContain('--border-subtle')
    expect(blocked.className).toContain('--surface-raised')
    expect(blocked.className).toContain('--text-muted')
    // The live play button is gone — there is no way to fire the launch.
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.title)).not.toContain('Launch')
  })

  it('the blocked button raises the popover on HOVER, on FOCUS and on CLICK', () => {
    const onBlockedLaunch = vi.fn()
    renderRow({ runningCount: 1, onBlockedLaunch })
    const blocked = q('[data-testid="config-row-launch-blocked"]')!
    act(() => { blocked.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    act(() => { blocked.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    act(() => { blocked.click() })
    expect(onBlockedLaunch).toHaveBeenCalledTimes(3)
    expect(onBlockedLaunch.mock.calls[0][0]).toBe(blocked)
  })

  it('running + Multi Spawn: the ×N control replaces the play button entirely', () => {
    renderRow({ config: cfg({ allowMultiSpawn: true }), runningCount: 2 })
    expect(q('[data-testid="config-row-multi-spawn"]')).toBeTruthy()
    expect(q('[data-testid="config-row-launch-blocked"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.title)).not.toContain('Launch')
  })

  it('the ×N control shows the stored count, launches THAT many, and its ▾ steps + persists', () => {
    const onLaunchMany = vi.fn(); const onSpawnCountChange = vi.fn()
    renderRow({ config: cfg({ allowMultiSpawn: true, multiSpawnCount: 4 }), onLaunchMany, onSpawnCountChange })
    expect(q('[data-testid="config-row-multi-spawn-count"]')!.textContent!.trim()).toBe('4')
    act(() => { q('[data-testid="config-row-multi-spawn-launch"]')!.click() })
    expect(onLaunchMany).toHaveBeenCalledWith(4)
    act(() => { q('[data-testid="config-row-multi-spawn-step"]')!.click() })
    expect(onSpawnCountChange).toHaveBeenCalledWith(5)
  })

  it('a Multi Spawn config with no stored count shows the default 2', () => {
    renderRow({ config: cfg({ allowMultiSpawn: true }) })
    expect(q('[data-testid="config-row-multi-spawn-count"]')!.textContent!.trim()).toBe('2')
  })
})

describe('ConfigRow — select mode', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const renderRow = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(ConfigRow, {
      config: cfg(), onLaunch: () => {}, onEdit: () => {}, onDelete: () => {}, onContextMenu: () => {}, selectMode: true, ...props,
    } as any)))

  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null

  it('off by default — no tick box until select mode is on', () => {
    act(() => root.render(React.createElement(ConfigRow, {
      config: cfg(), onLaunch: () => {}, onEdit: () => {}, onDelete: () => {}, onContextMenu: () => {},
    } as any)))
    expect(q('[data-testid="config-row-select-checkbox"]')).toBeNull()
    expect(q('[data-testid="config-row-select-lock"]')).toBeNull()
  })

  it('a NOT-running one-at-a-time config IS selectable — the rule keys on running state', () => {
    const onToggleSelected = vi.fn()
    renderRow({ runningCount: 0, onToggleSelected })
    const box = q('[data-testid="config-row-select-checkbox"]')!
    expect(box).toBeTruthy()
    expect(q('[data-testid="config-row-select-lock"]')).toBeNull()
    act(() => { box.click() })
    expect(onToggleSelected).toHaveBeenCalledTimes(1)
  })

  it('a RUNNING one-at-a-time config gets a LOCK in the tick box\'s place, and the name dims', () => {
    renderRow({ runningCount: 1 })
    expect(q('[data-testid="config-row-select-checkbox"]')).toBeNull()
    const lock = q('[data-testid="config-row-select-lock"]')!
    expect(lock.title).toBe(flattenPopoverCopy(cannotSelectCopy('Pi-Miner')))
    const name = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === 'Pi-Miner')!
    expect(name.className).toContain('text-overlay0')
  })

  it('a RUNNING Multi Spawn config keeps its tick box', () => {
    renderRow({ config: cfg({ allowMultiSpawn: true }), runningCount: 3 })
    expect(q('[data-testid="config-row-select-checkbox"]')).toBeTruthy()
    expect(q('[data-testid="config-row-select-lock"]')).toBeNull()
  })

  it('the lock raises the needs-Multi-Spawn popover on hover and on click', () => {
    const onBlockedSelect = vi.fn()
    renderRow({ runningCount: 1, onBlockedSelect })
    const lock = q('[data-testid="config-row-select-lock"]')!
    act(() => { lock.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    act(() => { lock.click() })
    expect(onBlockedSelect).toHaveBeenCalledTimes(2)
  })

  it('the tick box reflects selection and the row takes the brand 8% tint', () => {
    renderRow({ runningCount: 0, selected: true })
    const box = q('[data-testid="config-row-select-checkbox"]')!
    expect(box.getAttribute('aria-checked')).toBe('true')
    const row = q('[data-testid="config-row"]')!
    expect(row.getAttribute('style')).toContain('--brand')
    expect(row.getAttribute('style')).toContain('8%')
  })

  it('the ×N control steps aside in select mode — the row is for ticking, not launching', () => {
    renderRow({ config: cfg({ allowMultiSpawn: true }), runningCount: 1 })
    expect(q('[data-testid="config-row-multi-spawn"]')).toBeNull()
  })
})

describe('QuickStartPanel — the same rule, the same way out', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); SETTINGS.settings.quickStartCollapsed = false })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(QuickStartPanel, {
      onLaunch: () => {}, onContextMenu: () => {}, running: new Map(), configs: [cfg()], ...props,
    } as any)))

  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null

  it('idle: the ordinary start button launches', () => {
    const onLaunch = vi.fn()
    render({ onLaunch })
    act(() => { q('[data-testid="quick-start-start"]')!.click() })
    expect(onLaunch).toHaveBeenCalledTimes(1)
  })

  it('running + one-at-a-time: start is BLOCKED (the codex-off recipe) and raises the popover', () => {
    const onLaunch = vi.fn(); const onBlockedLaunch = vi.fn()
    render({ running: new Map([['c1', 1]]), onLaunch, onBlockedLaunch })
    expect(q('[data-testid="quick-start-start"]')).toBeNull()
    const blocked = q('[data-testid="quick-start-start-blocked"]')!
    expect(blocked.getAttribute('aria-disabled')).toBe('true')
    expect(blocked.className).toContain('--border-subtle')
    expect(blocked.className).toContain('--surface-raised')
    expect(blocked.className).toContain('--text-muted')
    expect(blocked.title).toBe(flattenPopoverCopy(alreadyRunningLaunchCopy('Pi-Miner')))
    act(() => { blocked.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    act(() => { blocked.click() })
    expect(onBlockedLaunch).toHaveBeenCalledTimes(2)
    // And the launch itself never fired.
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it('running + Multi Spawn: the ×N control replaces the start button', () => {
    const onLaunchMany = vi.fn()
    render({ configs: [cfg({ allowMultiSpawn: true, multiSpawnCount: 3 })], running: new Map([['c1', 1]]), onLaunchMany })
    expect(q('[data-testid="quick-start-start"]')).toBeNull()
    expect(q('[data-testid="quick-start-start-blocked"]')).toBeNull()
    expect(q('[data-testid="quick-start-multi-spawn-count"]')!.textContent!.trim()).toBe('3')
    act(() => { q('[data-testid="quick-start-multi-spawn-launch"]')!.click() })
    expect(onLaunchMany).toHaveBeenCalledTimes(1)
    expect(onLaunchMany.mock.calls[0][1]).toBe(3)
  })

  it('the header carries the Select toggle, and select mode swaps starts for tick boxes / locks', () => {
    const onToggleSelectMode = vi.fn()
    render({ onToggleSelectMode })
    const toggle = q('[data-testid="quick-start-select-toggle"]')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    act(() => { toggle.click() })
    expect(onToggleSelectMode).toHaveBeenCalledTimes(1)

    render({ onToggleSelectMode, selectMode: true, selectedIds: new Set(['c1']) })
    expect(q('[data-testid="quick-start-select-toggle"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="quick-start-select-checkbox"]')!.getAttribute('aria-checked')).toBe('true')

    render({ onToggleSelectMode, selectMode: true, running: new Map([['c1', 1]]) })
    expect(q('[data-testid="quick-start-select-checkbox"]')).toBeNull()
    expect(q('[data-testid="quick-start-select-lock"]')).toBeTruthy()
  })
})
