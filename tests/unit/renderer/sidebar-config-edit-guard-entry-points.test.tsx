// @vitest-environment jsdom
/**
 * The #54 config-edit guard has ONE chokepoint in the Sidebar
 * (`requestEditConfig`): an SSH config with a live (or left-running) session
 * gets the warn-and-advise dialog before the editor; everything else opens the
 * editor directly. The pure decision and the dialog are pinned in
 * config-edit-guard.test.tsx; what is pinned HERE (adversarial pass on #598) is
 * that every "edit this config" entry point actually routes through the
 * chokepoint -- the row's Edit button and the context menu's Edit item are
 * driven on a mounted Sidebar, and the colour-migration notice (one-time, not
 * mountable on demand) is pinned by shape. A single entry point that called
 * `setEditingConfig` directly would bypass the guard for that path.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const settings: any = { configPanelPinned: false, theme: 'dark', keyboardShortcuts: undefined, sessionsPanelDefaultTab: 'saved', quickStartCollapsed: false, codexEnabled: true }
const SETTINGS_STATE: any = { settings, updateSettings: () => {}, isLoaded: true }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS_STATE)
  useSettingsStore.getState = () => SETTINGS_STATE
  return { useSettingsStore }
})

const SESSION_STATE: any = {
  sessions: [] as any[],
  activeSessionId: null,
  setActiveSession: () => {},
  removeSession: () => {},
  addSession: vi.fn(),
  updateSession: () => {},
  getSession: () => undefined,
}
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (sel?: any) => (sel ? sel(SESSION_STATE) : SESSION_STATE)
  useSessionStore.getState = () => SESSION_STATE
  return { useSessionStore }
})

const CONFIG_STATE: any = { configs: [], groups: [], sections: [], updateConfig: vi.fn() }
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
// The editor itself is a marker: the assertion is WHEN it appears, not what it shows.
vi.mock('../../../src/renderer/components/SessionDialog', () => ({ default: () => React.createElement('div', { 'data-testid': 'session-dialog' }) }))
;(globalThis as any).window.electronAPI = {
  update: { check: () => Promise.resolve(false), onAvailable: () => () => {}, getVersion: () => Promise.resolve('') },
  github: { notifyFocusChanged: () => {} },
}

const { default: Sidebar } = await import('../../../src/renderer/components/Sidebar')

const SSH = { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work' }
const cfg = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, workingDirectory: `/x/${id}`, color: '', sessionType: 'local', provider: 'claude', ...over,
})
const sshCfg = (id: string) => cfg(id, { sessionType: 'ssh', sshConfig: SSH })
/** A live session complete enough for SessionRow to render. */
const sess = (id: string, configId: string, over: Record<string, unknown> = {}) => ({
  id, configId, label: configId, workingDirectory: `/x/${configId}`, color: '#888888',
  status: 'idle', createdAt: 0, sessionType: 'local', provider: 'claude', ...over,
})

describe('Sidebar — every config-edit entry point goes through the #54 guard chokepoint', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    SESSION_STATE.sessions = []
    CONFIG_STATE.configs = []
    settings.sessionsPanelDefaultTab = 'saved'
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = () =>
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))
  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
  const guard = () => q('[data-testid="config-edit-guard"]')
  const editor = () => q('[data-testid="session-dialog"]')
  const click = (el: HTMLElement | null) => act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const rowEditButton = () => q('[data-testid="config-row"] button[title="Edit"]')

  it('REGRESSION: the row\'s Edit button on a running SSH config opens the guard, not the editor; Edit anyway then opens the editor', async () => {
    CONFIG_STATE.configs = [sshCfg('ssh-1')]
    SESSION_STATE.sessions = [sess('s1', 'ssh-1', { sessionType: 'ssh', sshConfig: SSH })]
    render()
    expect(rowEditButton()).toBeTruthy()
    await click(rowEditButton())
    expect(guard()).toBeTruthy()
    expect(editor()).toBeNull()
    await click(q('[data-testid="cfg-guard-proceed"]'))
    expect(guard()).toBeNull()
    expect(editor()).toBeTruthy()
  })

  it('Cancel on the guard opens nothing', async () => {
    CONFIG_STATE.configs = [sshCfg('ssh-1')]
    SESSION_STATE.sessions = [sess('s1', 'ssh-1', { sessionType: 'ssh', sshConfig: SSH })]
    render()
    await click(rowEditButton())
    await click(q('[data-testid="cfg-guard-cancel"]'))
    expect(guard()).toBeNull()
    expect(editor()).toBeNull()
  })

  it('the context menu\'s Edit item on a running SSH config opens the guard too', async () => {
    CONFIG_STATE.configs = [sshCfg('ssh-1')]
    SESSION_STATE.sessions = [sess('s1', 'ssh-1', { sessionType: 'ssh', sshConfig: SSH })]
    render()
    const row = q('[data-testid="config-row"]')!
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
    const item = q('[data-testid="ctx-edit"]')
    expect(item, 'context-menu Edit item').toBeTruthy()
    await click(item)
    expect(guard()).toBeTruthy()
    expect(editor()).toBeNull()
  })

  it('an SSH config with NO session, and a local config with a session, open the editor directly (the guard is warn-only, and SSH-only)', async () => {
    CONFIG_STATE.configs = [sshCfg('ssh-idle')]
    render()
    await click(rowEditButton())
    expect(guard()).toBeNull()
    expect(editor()).toBeTruthy()
    act(() => root.unmount()); container.remove()

    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    CONFIG_STATE.configs = [cfg('local-1')]
    SESSION_STATE.sessions = [sess('s1', 'local-1')]
    render()
    await click(rowEditButton())
    expect(guard()).toBeNull()
    expect(editor()).toBeTruthy()
  })
})

// Shape checks over the source. Deliberately loose: a reformat that moves a
// brace fails them LOUDLY (red), never silently -- widen the window or the
// pattern, do not delete the check.
describe('Sidebar source shape: no entry point opens the editor around the chokepoint', () => {
  const src = readFileSync(resolve(__dirname, '../../../src/renderer/components/Sidebar.tsx'), 'utf8').replace(/\r\n/g, '\n')

  it('every onEdit / onOpenConfigEditor handler calls requestEditConfig', () => {
    const handlers = [...src.matchAll(/(onEdit|onOpenConfigEditor)=\{([\s\S]*?)\}\s*\n/g)]
    expect(handlers.length).toBeGreaterThanOrEqual(3) // row, context menu, colour-migration notice
    for (const [whole] of handlers) expect(whole, whole).toContain('requestEditConfig(')
  })

  it('setEditingConfig(<config>) is called from exactly two places: the chokepoint and the guard\'s Edit anyway', () => {
    const opens = [...src.matchAll(/setEditingConfig\((?!null\))/g)]
    expect(opens).toHaveLength(2)
    const chokepoint = src.indexOf('const requestEditConfig = ')
    const proceed = src.indexOf('onProceed={() => { setEditingConfig(editGuardConfig)')
    expect(chokepoint).toBeGreaterThan(0)
    expect(proceed).toBeGreaterThan(0)
    for (const m of opens) {
      const inChokepoint = m.index! > chokepoint && m.index! < chokepoint + 400
      const inProceed = m.index! >= proceed && m.index! < proceed + 80
      expect(inChokepoint || inProceed, `setEditingConfig at ${m.index}`).toBe(true)
    }
  })
})
