// @vitest-environment jsdom
/**
 * Allow Multi Spawn (phase 4) — the Sidebar wiring.
 *
 * The rule and the affordances are pinned elsewhere; what is pinned HERE is
 * that pressing them does the whole job:
 *   - the ×N control launches N sessions,
 *   - select mode assembles a set, launches it once each, and exits,
 *   - the popover's "Enable Multi Spawn & launch" sets the flag, persists it,
 *     and launches — in that order, so the launch is not refused by its own
 *     backstop,
 *   - every one of those paths lands the user on the Running tab.
 *
 * The store mocks are the sidebar-panel-tabs set plus a real `updateConfig`
 * spy; `useLaunchConfig` is the REAL hook, so the backstop is live throughout.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const settings: any = { configPanelPinned: false, theme: 'dark', keyboardShortcuts: undefined, sessionsPanelDefaultTab: 'saved', quickStartCollapsed: false, codexEnabled: true }
const SETTINGS_STATE: any = { settings, updateSettings: () => {}, isLoaded: true }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS_STATE)
  useSettingsStore.getState = () => SETTINGS_STATE
  return { useSettingsStore }
})

const addSession = vi.fn()
const SESSION_STATE: any = {
  sessions: [] as any[],
  activeSessionId: null,
  setActiveSession: () => {},
  removeSession: () => {},
  addSession,
  updateSession: () => {},
  getSession: () => undefined,
}
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (sel?: any) => (sel ? sel(SESSION_STATE) : SESSION_STATE)
  useSessionStore.getState = () => SESSION_STATE
  return { useSessionStore }
})

const updateConfig = vi.fn((id: string, patch: Record<string, unknown>) => {
  CONFIG_STATE.configs = CONFIG_STATE.configs.map((c: any) => (c.id === id ? { ...c, ...patch } : c))
})
const CONFIG_STATE: any = { configs: [], groups: [], sections: [], updateConfig }
vi.mock('../../../src/renderer/stores/configStore', () => {
  ;['addConfig', 'removeConfig', 'addGroup', 'renameGroup', 'removeGroup', 'toggleGroupCollapsed', 'moveConfigToGroup', 'addSection', 'renameSection', 'removeSection', 'toggleSectionCollapsed', 'moveGroupToSection', 'moveConfigToSection', 'togglePinned', 'duplicateConfig', 'reorderConfigs'].forEach((k) => { CONFIG_STATE[k] = () => {} })
  const useConfigStore: any = (sel?: any) => (sel ? sel(CONFIG_STATE) : CONFIG_STATE)
  useConfigStore.getState = () => CONFIG_STATE
  return { useConfigStore }
})
vi.mock('../../../src/renderer/stores/insightsStore', () => ({ useInsightsStore: (sel: any) => sel({ status: null, statusMessage: null }) }))
vi.mock('../../../src/renderer/stores/cloudAgentStore', () => ({ useCloudAgentStore: (sel: any) => sel({ agents: [] }) }))
vi.mock('../../../src/renderer/stores/conductorMcpStore', () => ({ useConductorMcpStore: (sel: any) => sel({ browserRunning: false, serverRunning: true }) }))
vi.mock('../../../src/renderer/stores/appMetaStore', () => {
  const STATE = { meta: { hasCreatedFirstConfig: true, firstRunCardDismissed: true }, update: () => {} }
  const useAppMetaStore: any = (sel: any) => sel(STATE)
  useAppMetaStore.getState = () => STATE
  return { useAppMetaStore }
})
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ markSessionForResumePicker: vi.fn() }))
vi.mock('../../../src/renderer/components/SessionDialog', () => ({ default: () => React.createElement('div', { 'data-testid': 'session-dialog' }) }))
;(globalThis as any).window.electronAPI = {
  update: { check: () => Promise.resolve(false), onAvailable: () => () => {}, getVersion: () => Promise.resolve('') },
  github: { notifyFocusChanged: () => {} },
}

const { default: Sidebar } = await import('../../../src/renderer/components/Sidebar')

const cfg = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, workingDirectory: `/x/${id}`, color: '', sessionType: 'local', provider: 'claude', ...over,
})

/** A live session complete enough for SessionRow to render (the Running tab is
 *  mounted for a frame before the stored 'saved' default is adopted). */
const sess = (id: string, configId: string) => ({
  id, configId, label: configId, workingDirectory: `/x/${configId}`, color: '#888888',
  status: 'idle', createdAt: 0, sessionType: 'local', provider: 'claude',
})

describe('Sidebar — Allow Multi Spawn actions', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    addSession.mockClear(); updateConfig.mockClear()
    SESSION_STATE.sessions = []
    CONFIG_STATE.configs = []
    settings.sessionsPanelDefaultTab = 'saved'
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = () =>
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))

  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
  const all = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
  const onSaved = () => q('[data-testid="saved-tab"]') !== null
  const onRunning = () => q('[data-testid="running-tab"]') !== null

  it('the ×N control launches exactly N sessions and lands on Running', async () => {
    CONFIG_STATE.configs = [cfg('a', { allowMultiSpawn: true, multiSpawnCount: 3 })]
    render()
    expect(onSaved()).toBe(true)
    await act(async () => { q('[data-testid="config-row-multi-spawn-launch"]')!.click() })
    expect(addSession).toHaveBeenCalledTimes(3)
    const ids = addSession.mock.calls.map((c) => c[0].id)
    expect(new Set(ids).size).toBe(3)
    expect(onRunning()).toBe(true)
  })

  it("the ▾ step persists the new count on the config", () => {
    CONFIG_STATE.configs = [cfg('a', { allowMultiSpawn: true, multiSpawnCount: 2 })]
    render()
    act(() => { q('[data-testid="config-row-multi-spawn-step"]')!.click() })
    expect(updateConfig).toHaveBeenCalledWith('a', { multiSpawnCount: 3 })
  })

  it('select mode: pick two, Launch 2 spawns one each, then exits the mode', async () => {
    CONFIG_STATE.configs = [cfg('a'), cfg('b'), cfg('c')]
    render()
    expect(q('[data-testid="select-launch-bar"]')).toBeNull()

    act(() => { q('[data-testid="config-select-toggle"]')!.click() })
    expect(q('[data-testid="config-select-toggle"]')!.getAttribute('aria-pressed')).toBe('true')
    const boxes = all('[data-testid="config-row-select-checkbox"]')
    expect(boxes).toHaveLength(3)

    act(() => { boxes[0].click() })
    act(() => { boxes[2].click() })
    expect(q('[data-testid="select-launch-bar"]')!.textContent).toContain('2 selected')

    await act(async () => { q('[data-testid="select-launch-run"]')!.click() })
    expect(addSession).toHaveBeenCalledTimes(2)
    expect(addSession.mock.calls.map((c) => c[0].configId)).toEqual(['a', 'c'])
    // Out of select mode, selection cleared, and following the sessions.
    expect(q('[data-testid="select-launch-bar"]')).toBeNull()
    expect(q('[data-testid="config-row-select-checkbox"]')).toBeNull()
    expect(onRunning()).toBe(true)
  })

  it('select mode: Cancel leaves the mode and launches nothing', () => {
    CONFIG_STATE.configs = [cfg('a')]
    render()
    act(() => { q('[data-testid="config-select-toggle"]')!.click() })
    act(() => { all('[data-testid="config-row-select-checkbox"]')[0].click() })
    act(() => { q('[data-testid="select-launch-cancel"]')!.click() })
    expect(q('[data-testid="select-launch-bar"]')).toBeNull()
    expect(addSession).not.toHaveBeenCalled()
    expect(onSaved()).toBe(true)
  })

  it('select mode: a running one-at-a-time config is locked, and Enable gives it a ticked box', () => {
    CONFIG_STATE.configs = [cfg('a')]
    SESSION_STATE.sessions = [sess('s1', 'a')]
    render()
    act(() => { q('[data-testid="config-select-toggle"]')!.click() })
    expect(q('[data-testid="config-row-select-checkbox"]')).toBeNull()
    const lock = q('[data-testid="config-row-select-lock"]')!

    act(() => { lock.click() })
    const popover = q('[data-testid="multi-spawn-popover"]')!
    expect(popover.textContent).toContain("can't be selected")
    expect(popover.textContent).toContain('Enable Multi Spawn')

    act(() => { q('[data-testid="multi-spawn-popover-enable"]')!.click() })
    expect(updateConfig).toHaveBeenCalledWith('a', { allowMultiSpawn: true })
    expect(q('[data-testid="multi-spawn-popover"]')).toBeNull()
    const box = q('[data-testid="config-row-select-checkbox"]')!
    expect(box).toBeTruthy()
    expect(box.getAttribute('aria-checked')).toBe('true')
    // Nothing launched — enabling in select mode only makes the row eligible.
    expect(addSession).not.toHaveBeenCalled()
  })

  it('a running one-at-a-time config: the blocked launch raises the popover, and Enable & launch does all three', async () => {
    CONFIG_STATE.configs = [cfg('a')]
    SESSION_STATE.sessions = [sess('s1', 'a')]
    render()
    const blocked = q('[data-testid="config-row-launch-blocked"]')!
    act(() => { blocked.click() })
    const popover = q('[data-testid="multi-spawn-popover"]')!
    expect(popover.textContent).toContain('is already running')
    expect(q('[data-testid="multi-spawn-popover-enable"]')!.textContent).toContain('Enable Multi Spawn & launch')

    await act(async () => { q('[data-testid="multi-spawn-popover-enable"]')!.click() })
    // 1. set + persist
    expect(updateConfig).toHaveBeenCalledWith('a', { allowMultiSpawn: true })
    // 2. launch — NOT refused by the backstop, because the patched config went
    //    through rather than this render's stale copy.
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(addSession.mock.calls[0][0].configId).toBe('a')
    // 3. follow the session
    expect(onRunning()).toBe(true)
    expect(q('[data-testid="multi-spawn-popover"]')).toBeNull()
  })

  it('Escape closes the popover without enabling anything', () => {
    CONFIG_STATE.configs = [cfg('a')]
    SESSION_STATE.sessions = [sess('s1', 'a')]
    render()
    act(() => { q('[data-testid="config-row-launch-blocked"]')!.click() })
    expect(q('[data-testid="multi-spawn-popover"]')).toBeTruthy()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(q('[data-testid="multi-spawn-popover"]')).toBeNull()
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('a plain single launch still lands on Running (phase 3 behaviour, unchanged)', async () => {
    CONFIG_STATE.configs = [cfg('a')]
    render()
    const launch = all('button').find((b) => b.title === 'Launch')!
    await act(async () => { launch.click() })
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(onRunning()).toBe(true)
  })
})
