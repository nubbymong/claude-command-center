// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { theme: 'dark' as const } }
  const useSettingsStore: any = (sel: (s: typeof STATE) => unknown) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
const { default: ConfigRow } = await import('../../../src/renderer/components/sidebar/ConfigRow')

const baseConfig = { id: 'c1', provider: 'claude' as const, label: 'My Config', workingDirectory: '.', sessionType: 'local' as const, identityColorKey: 'mauve' as const, color: '' }
const rowProps = { onLaunch: () => {}, onEdit: () => {}, onDelete: () => {}, onContextMenu: () => {} }

describe('ConfigRow quiet launcher', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('does NOT render a Claude badge for the default provider', () => {
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: baseConfig })))
    expect(container.querySelector('[title="Claude is working"]')).toBeNull()
  })

  it('launch button is not status-green (neutral affordance)', () => {
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: baseConfig })))
    const launch = container.querySelector('[title="Launch"]') as HTMLElement
    expect(launch).toBeTruthy()
    expect(launch.className).not.toContain('text-green')
  })

  it('keeps the SSH pill for ssh configs', () => {
    act(() => root.render(React.createElement(ConfigRow, { ...(rowProps as any), config: { ...baseConfig, sessionType: 'ssh' } })))
    expect(container.querySelector('[title="SSH session"]')).toBeTruthy()
  })
})
