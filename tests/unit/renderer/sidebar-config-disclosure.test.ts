// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const settings = { configPanelPinned: false, theme: 'dark', keyboardShortcuts: undefined }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings, updateSettings: () => {} }
  const useSettingsStore: any = (sel: any) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const STATE = { sessions: [], activeSessionId: null, setActiveSession: () => {}, removeSession: () => {}, addSession: () => {}, updateSession: () => {} }
  const useSessionStore: any = (sel?: any) => (sel ? sel(STATE) : STATE)
  useSessionStore.getState = () => STATE
  return { useSessionStore }
})
vi.mock('../../../src/renderer/stores/configStore', () => {
  const STATE: any = { configs: [], groups: [], sections: [] }
  ;['addConfig','updateConfig','removeConfig','addGroup','renameGroup','removeGroup','toggleGroupCollapsed','moveConfigToGroup','addSection','renameSection','removeSection','toggleSectionCollapsed','moveGroupToSection','moveConfigToSection','togglePinned','duplicateConfig','reorderConfigs'].forEach(k => STATE[k] = () => {})
  const useConfigStore: any = (sel?: any) => (sel ? sel(STATE) : STATE)
  useConfigStore.getState = () => STATE
  return { useConfigStore }
})
vi.mock('../../../src/renderer/stores/insightsStore', () => ({ useInsightsStore: (sel: any) => sel({ status: null, statusMessage: null }) }))
vi.mock('../../../src/renderer/stores/cloudAgentStore', () => ({ useCloudAgentStore: (sel: any) => sel({ agents: [] }) }))
vi.mock('../../../src/renderer/stores/conductorMcpStore', () => ({ useConductorMcpStore: (sel: any) => sel({ browserRunning: false, serverRunning: true }) }))
vi.mock('../../../src/renderer/stores/appMetaStore', () => ({ useAppMetaStore: (sel: any) => sel({ meta: { hasCreatedFirstConfig: true, firstRunCardDismissed: true }, update: () => {} }) }))
;(globalThis as any).window.electronAPI = { update: { check: () => Promise.resolve(false), onAvailable: () => () => {}, getVersion: () => Promise.resolve('') } }

const { default: Sidebar } = await import('../../../src/renderer/components/Sidebar')

describe('Sidebar config disclosure', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('exposes a keyboard-focusable "Saved Configs" disclosure button with aria-expanded', () => {
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))
    const btn = Array.from(container.querySelectorAll('button')).find(b => /saved configs/i.test(b.textContent || ''))
    expect(btn).toBeTruthy()
    expect(btn!.getAttribute('aria-expanded')).not.toBeNull()
  })
})
