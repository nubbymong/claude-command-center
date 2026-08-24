// @vitest-environment jsdom
// The locked launcher row (design pass 2026-08-24): a config with a live
// session shows the type icon leading, greyed label, lock + Running pill, NO
// launch/edit/delete affordances, and a click jumps to its session.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { codexEnabled: true } }
  const useSettingsStore: any = (sel: any) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
vi.mock('../../../src/renderer/hooks/useLaunchConfig', () => ({
  CODEX_OFF_LAUNCH_REASON: 'Codex is off',
  useLaunchConfig: () => () => {},
}))

const { default: ConfigRow } = await import('../../../src/renderer/components/sidebar/ConfigRow')

const config: any = {
  id: 'c1',
  label: 'App Dev',
  workingDirectory: '/dev/app',
  color: '',
  sessionType: 'local',
  provider: 'claude',
  pinned: true,
}

describe('ConfigRow — running lock', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const renderRow = (props: Record<string, unknown>) =>
    act(() => root.render(React.createElement(ConfigRow, {
      config,
      onLaunch: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onContextMenu: () => {},
      ...props,
    } as any)))

  it('a running config locks: Running pill, no launch/edit/delete buttons, click opens the session', () => {
    const opened = vi.fn()
    renderRow({ running: true, onOpenSession: opened })
    const row = container.querySelector('[data-testid="config-row-running"]') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.textContent).toMatch(/running/i)
    // The type icon still leads the row.
    expect(row.querySelector('[data-testid="type-badge-claude"]')).toBeTruthy()
    // No action buttons at all on a locked row.
    expect(row.querySelectorAll('button').length).toBe(0)
    act(() => { row.click() })
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('a launchable config keeps the actions and the Quick Start pin verb', () => {
    renderRow({ running: false, onPin: () => {} })
    expect(container.querySelector('[data-testid="config-row-running"]')).toBeNull()
    const titles = Array.from(container.querySelectorAll('button')).map((b) => b.getAttribute('title'))
    expect(titles).toContain('Launch')
    expect(titles).toContain('Edit')
    expect(titles).toContain('Delete')
    expect(titles).toContain('Unpin from Quick Start') // config.pinned = true
  })
})
