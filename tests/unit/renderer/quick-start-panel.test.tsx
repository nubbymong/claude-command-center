// @vitest-environment jsdom
// Quick Start (Running tab, design pass 2026-08-24): launch-only — a pinned
// config with a live session is omitted and counted in the header; Start
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
      onLaunch: () => {}, onContextMenu: () => {}, running: new Set(), ...props,
    } as any)))

  it('lists only launchable pins and counts the running ones in the header', () => {
    render({ configs: [cfg('a'), cfg('b'), cfg('c', { pinned: false })], running: new Set(['b']) })
    const items = container.querySelectorAll('[data-testid="quick-start-item"]')
    expect(items.length).toBe(1)
    expect(items[0].textContent).toContain('a')
    expect(container.querySelector('[data-testid="quick-start-header"]')!.textContent).toMatch(/1 running/)
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

  it('still shows the strip when every pin is running (the counter explains why it is empty)', () => {
    render({ configs: [cfg('a')], running: new Set(['a']) })
    expect(container.querySelector('[data-testid="quick-start"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="quick-start-item"]').length).toBe(0)
    expect(container.querySelector('[data-testid="quick-start-header"]')!.textContent).toMatch(/1 running/)
  })
})
