// @vitest-environment jsdom
/**
 * Saved Configs panel -- the Settings choice actually switches the panel (#362).
 *
 * Absent setting => today's list (its own "Search configs..." box, no cards,
 * no chips); 'cards' => the cards view; 'find' => the find view. And the
 * running-session rule is wired: a config with a live session is not listed
 * in either new view.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const settings: any = { configPanelPinned: true, theme: 'dark', keyboardShortcuts: undefined, codexEnabled: true }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings, updateSettings: () => {} }
  const useSettingsStore: any = (sel: any) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
const SESSIONS: any = { sessions: [] as any[], activeSessionId: null, setActiveSession: () => {}, removeSession: () => {}, addSession: () => {}, updateSession: () => {} }
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (sel?: any) => (sel ? sel(SESSIONS) : SESSIONS)
  useSessionStore.getState = () => SESSIONS
  return { useSessionStore }
})
const CONFIGS: any = {
  configs: [
    { id: 'c1', label: 'Alpha', workingDirectory: '/w/a', color: '', sessionType: 'local', provider: 'claude', identityColorKey: 'blue', groupId: 'g1' },
    { id: 'c2', label: 'Beta', workingDirectory: '/w/b', color: '', sessionType: 'local', provider: 'claude', identityColorKey: 'blue', groupId: 'g1' },
  ],
  groups: [{ id: 'g1', name: 'Work' }],
  sections: [],
}
vi.mock('../../../src/renderer/stores/configStore', () => {
  ;['addConfig','updateConfig','removeConfig','addGroup','renameGroup','removeGroup','toggleGroupCollapsed','moveConfigToGroup','addSection','renameSection','removeSection','toggleSectionCollapsed','moveGroupToSection','moveConfigToSection','togglePinned','duplicateConfig','reorderConfigs'].forEach(k => CONFIGS[k] = () => {})
  const useConfigStore: any = (sel?: any) => (sel ? sel(CONFIGS) : CONFIGS)
  useConfigStore.getState = () => CONFIGS
  return { useConfigStore }
})
vi.mock('../../../src/renderer/stores/insightsStore', () => ({ useInsightsStore: (sel: any) => sel({ status: null, statusMessage: null }) }))
vi.mock('../../../src/renderer/stores/cloudAgentStore', () => ({ useCloudAgentStore: (sel: any) => sel({ agents: [] }) }))
vi.mock('../../../src/renderer/stores/conductorMcpStore', () => ({ useConductorMcpStore: (sel: any) => sel({ browserRunning: false, serverRunning: true }) }))
vi.mock('../../../src/renderer/stores/appMetaStore', () => ({ useAppMetaStore: (sel: any) => sel({ meta: { hasCreatedFirstConfig: true, firstRunCardDismissed: true }, update: () => {} }) }))
;(globalThis as any).window.electronAPI = { update: { check: () => Promise.resolve(false), onAvailable: () => () => {}, getVersion: () => Promise.resolve('') } }

const { default: Sidebar } = await import('../../../src/renderer/components/Sidebar')

describe('Sidebar: Saved Configs layout setting (#362)', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); SESSIONS.sessions = []; delete settings.savedConfigsView })
  afterEach(() => { act(() => root.unmount()); container.remove() })
  const render = () => act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))
  const legacySearch = () => container.querySelector('input[placeholder="Search configs..."]')

  it('absent setting renders today\'s list untouched', () => {
    render()
    expect(legacySearch()).toBeTruthy()
    expect(container.querySelector('[data-ux-id="saved-configs-cards"]')).toBeNull()
    expect(container.querySelector('[data-ux-id="saved-configs-find"]')).toBeNull()
  })

  it('"cards" renders the cards view in place of the list', () => {
    settings.savedConfigsView = 'cards'
    render()
    expect(legacySearch()).toBeNull()
    expect(container.querySelector('[data-ux-id="saved-configs-cards"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-ux-id="saved-config-card"]')).toHaveLength(2)
  })

  it('"find" renders the find view in place of the list', () => {
    settings.savedConfigsView = 'find'
    render()
    expect(legacySearch()).toBeNull()
    expect(container.querySelector('[data-ux-id="saved-configs-find"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-ux-id="saved-config-row"]')).toHaveLength(2)
  })

  it('a config with a live session is not listed in the new views (the Ask session never counts)', () => {
    settings.savedConfigsView = 'cards'
    SESSIONS.sessions = [
      { id: 's1', configId: 'c1', label: 'Alpha', status: 'idle', createdAt: 1, sessionType: 'local', workingDirectory: '/w/a', model: '', color: '' },
      { id: 'ask', configId: 'c2', kind: 'ask', label: 'Ask', status: 'idle', createdAt: 1, sessionType: 'local', workingDirectory: '/w/b', model: '', color: '' },
    ]
    render()
    const ids = Array.from(container.querySelectorAll<HTMLElement>('[data-ux-id="saved-config-card"]')).map((c) => c.dataset.configId)
    expect(ids).toEqual(['c2'])
  })

  it('an unknown value falls back to the list', () => {
    settings.savedConfigsView = 'grid'
    render()
    expect(legacySearch()).toBeTruthy()
  })
})
