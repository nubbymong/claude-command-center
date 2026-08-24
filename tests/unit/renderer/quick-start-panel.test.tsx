// @vitest-environment jsdom
// Quick Start (Running tab, design pass 2026-08-24; owner revision the same
// day): every pinned config shows, running or not — a config is a template
// and Start spawns another instance. Running pins carry a count pill. Start
// launches; the header collapse persists via settings; absent entirely when
// nothing is pinned.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const updateSettings = vi.fn()
const SETTINGS: any = { settings: { codexEnabled: true, quickStartCollapsed: false }, updateSettings }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS)
  useSettingsStore.getState = () => SETTINGS
  return { useSettingsStore }
})
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useLaunchConfig', () => ({
  CODEX_OFF_LAUNCH_REASON: 'Codex is off',
  useLaunchConfig: () => () => {},
}))

const { default: QuickStartPanel } = await import('../../../src/renderer/components/sidebar/QuickStartPanel')

const cfg = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, workingDirectory: `/x/${id}`, color: '', sessionType: 'local', provider: 'claude', pinned: true, ...over,
})

describe('QuickStartPanel', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); updateSettings.mockClear(); SETTINGS.settings.quickStartCollapsed = false })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(QuickStartPanel, {
      onLaunch: () => {}, onContextMenu: () => {}, running: new Map(), ...props,
    } as any)))

  it('lists EVERY pin — a running one stays, with its count pill (owner revision)', () => {
    render({ configs: [cfg('a'), cfg('b'), cfg('c', { pinned: false })], running: new Map([['b', 2]]) })
    const items = container.querySelectorAll('[data-testid="quick-start-item"]')
    expect(items.length).toBe(2)
    const b = Array.from(items).find((el) => el.textContent!.includes('b'))!
    const pill = b.querySelector('[data-testid="quick-start-running-count"]')!
    expect(pill.textContent).toContain('2')
    // The idle pin carries no pill.
    const a = Array.from(items).find((el) => el.textContent!.includes('a'))!
    expect(a.querySelector('[data-testid="quick-start-running-count"]')).toBeNull()
  })

  it('a running pin can still START another instance', () => {
    const onLaunch = vi.fn()
    render({ configs: [cfg('b')], running: new Map([['b', 1]]), onLaunch })
    const start = Array.from(container.querySelectorAll('[data-testid="quick-start-item"] button'))
      .find((el) => el.textContent!.includes('Start')) as HTMLButtonElement
    expect(start.disabled).toBe(false)
    act(() => { start.click() })
    expect(onLaunch).toHaveBeenCalledTimes(1)
  })

  it('Start launches the config', () => {
    const onLaunch = vi.fn()
    render({ configs: [cfg('a')], onLaunch })
    const start = container.querySelector('[data-testid="quick-start-item"] button') as HTMLButtonElement
    act(() => { start.click() })
    expect(onLaunch).toHaveBeenCalledTimes(1)
    expect(onLaunch.mock.calls[0][0].id).toBe('a')
  })

  it('collapse persists via settings and hides the rows', () => {
    render({ configs: [cfg('a')] })
    act(() => { (container.querySelector('[data-testid="quick-start-header"]') as HTMLElement).click() })
    expect(updateSettings).toHaveBeenCalledWith({ quickStartCollapsed: true })
    SETTINGS.settings.quickStartCollapsed = true
    render({ configs: [cfg('a')] })
    expect(container.querySelectorAll('[data-testid="quick-start-item"]').length).toBe(0)
    expect(container.querySelector('[data-testid="quick-start-header"]')).toBeTruthy()
  })

  it('renders nothing at all when no config is pinned', () => {
    render({ configs: [cfg('a', { pinned: false })] })
    expect(container.querySelector('[data-testid="quick-start"]')).toBeNull()
  })

  it('every pin running: the strip shows them all, each with a pill — never empty rows', () => {
    render({ configs: [cfg('a')], running: new Map([['a', 1]]) })
    expect(container.querySelector('[data-testid="quick-start"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="quick-start-item"]').length).toBe(1)
    expect(container.querySelector('[data-testid="quick-start-running-count"]')!.textContent).toContain('1')
  })
})
