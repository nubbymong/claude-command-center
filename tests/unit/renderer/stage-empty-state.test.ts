// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { theme: 'dark' as const } }
  const useSettingsStore: any = (sel: any) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
const { default: StageEmptyState } = await import('../../../src/renderer/components/StageEmptyState')

const cfg = (id: string, label: string) => ({ id, label, provider: 'claude', workingDirectory: '.', sessionType: 'local', identityColorKey: 'mauve', color: '', pinned: true })

describe('StageEmptyState', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('configs exist -> "Start a saved config" + a launch card + "Show all configs"', () => {
    const onLaunch = vi.fn(); const onShowAll = vi.fn(); const onCreate = vi.fn()
    act(() => root.render(React.createElement(StageEmptyState, { configs: [cfg('a','Alpha')] as any, onLaunch, onShowAllConfigs: onShowAll, onCreateConfig: onCreate })))
    expect(container.textContent).toContain('Start a saved config')
    const card = Array.from(container.querySelectorAll('button')).find(b => /Alpha/.test(b.textContent || ''))
    expect(card).toBeTruthy()
    act(() => card!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onLaunch).toHaveBeenCalledTimes(1)
    expect(Array.from(container.querySelectorAll('button')).some(b => /show all configs/i.test(b.textContent || ''))).toBe(true)
  })

  it('no configs -> "Create a terminal config" primary action', () => {
    const onLaunch = vi.fn(); const onShowAll = vi.fn(); const onCreate = vi.fn()
    act(() => root.render(React.createElement(StageEmptyState, { configs: [] as any, onLaunch, onShowAllConfigs: onShowAll, onCreateConfig: onCreate })))
    expect(container.textContent).toContain('Create a terminal config')
    const create = Array.from(container.querySelectorAll('button')).find(b => /create a terminal config/i.test(b.textContent || ''))
    expect(create).toBeTruthy()
    act(() => create!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})
