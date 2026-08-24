// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const settings: any = { configPanelPinned: false, theme: 'dark', keyboardShortcuts: undefined, sessionsPanelDefaultTab: undefined }
const SETTINGS_STATE: any = { settings, updateSettings: () => {}, isLoaded: false }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS_STATE)
  useSettingsStore.getState = () => SETTINGS_STATE
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

describe('Sidebar panel tabs (two-mode left panel)', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    SETTINGS_STATE.isLoaded = false
    SETTINGS_STATE.settings.sessionsPanelDefaultTab = undefined
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = () =>
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))

  const tabs = () => ({
    saved: container.querySelector('[data-testid="panel-tab-saved"]') as HTMLButtonElement | null,
    running: container.querySelector('[data-testid="panel-tab-running"]') as HTMLButtonElement | null,
  })

  it('exposes Saved and Running as accessible tabs, Running selected by default (plan Q1)', () => {
    render()
    const { saved, running } = tabs()
    expect(saved).toBeTruthy()
    expect(running).toBeTruthy()
    expect(saved!.getAttribute('role')).toBe('tab')
    expect(running!.getAttribute('role')).toBe('tab')
    expect(running!.getAttribute('aria-selected')).toBe('true')
    expect(saved!.getAttribute('aria-selected')).toBe('false')
    // Running tab body is on screen; the Saved launcher is not.
    expect(container.querySelector('[data-testid="running-tab"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="saved-tab"]')).toBeNull()
  })

  it('clicking Saved switches mode: the launcher (search + New config) replaces the session list', () => {
    render()
    act(() => { tabs().saved!.click() })
    expect(tabs().saved!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-testid="saved-tab"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="running-tab"]')).toBeNull()
    const newConfig = container.querySelector('[data-testid="new-config-button"]')
    expect(newConfig).toBeTruthy()
    expect(newConfig!.textContent).toMatch(/new config/i)
    // The old fly-out disclosure is gone with the overlay it opened.
    const disclosure = Array.from(container.querySelectorAll('button')).find(b => b.getAttribute('aria-expanded') !== null)
    expect(disclosure).toBeUndefined()
  })

  it('clicking Running returns to the session list', () => {
    render()
    act(() => { tabs().saved!.click() })
    act(() => { tabs().running!.click() })
    expect(tabs().running!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-testid="running-tab"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="saved-tab"]')).toBeNull()
  })

  it("adopts a stored 'saved' default once settings hydrate", () => {
    render()
    expect(tabs().running!.getAttribute('aria-selected')).toBe('true')
    SETTINGS_STATE.isLoaded = true
    SETTINGS_STATE.settings.sessionsPanelDefaultTab = 'saved'
    render() // hydration re-render — the adoption effect fires
    expect(tabs().saved!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-testid="saved-tab"]')).toBeTruthy()
  })

  it('never stomps a tab the user clicked before hydration', () => {
    render()
    act(() => { tabs().saved!.click() }) // user chooses Saved pre-hydration
    SETTINGS_STATE.isLoaded = true
    SETTINGS_STATE.settings.sessionsPanelDefaultTab = 'running'
    render() // hydration arrives with a 'running' default
    expect(tabs().saved!.getAttribute('aria-selected')).toBe('true')
  })

  it('junk stored value resolves to Running — even after a valid default applied', () => {
    // Start from an ADOPTED 'saved' state so this proves the resolver path in
    // the effect, not just the useState seed (which is already 'running').
    SETTINGS_STATE.isLoaded = true
    SETTINGS_STATE.settings.sessionsPanelDefaultTab = 'saved'
    render()
    expect(tabs().saved!.getAttribute('aria-selected')).toBe('true')
    SETTINGS_STATE.settings.sessionsPanelDefaultTab = 'cards'
    render() // stored value changes to junk → effect re-fires → resolver default
    expect(tabs().running!.getAttribute('aria-selected')).toBe('true')
  })

  it('the tour anchor [data-tour="new-config"] resolves while the DEFAULT (Running) tab is active', () => {
    render()
    // GuidedTour.available() silently skips a step whose selector misses; the
    // anchor therefore lives on the always-mounted Saved tab button.
    const anchor = container.querySelector('[data-tour="new-config"]')
    expect(anchor).toBeTruthy()
    expect(anchor).toBe(tabs().saved)
  })
})
