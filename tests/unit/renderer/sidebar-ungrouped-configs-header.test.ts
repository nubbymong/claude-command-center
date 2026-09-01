// @vitest-environment jsdom
// Phase 6 — the Saved tab's loose tail gets a real "Ungrouped" header, the
// counterpart of #363's header on the Running tab. It used to sit under a bare
// rule with no name: the divider said "something changed here" without saying
// what, leaving the only rows on the tab with no heading of their own. Shown
// only when something organised sits above it (same rule as the divider it
// keeps), and collapsible like a group.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const settings: any = { configPanelPinned: false, theme: 'dark', keyboardShortcuts: undefined, codexEnabled: true }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings, updateSettings: () => {}, isLoaded: true }
  const useSettingsStore: any = (sel: any) => sel(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})
const SESSION_STATE: any = { sessions: [], activeSessionId: null, setActiveSession: () => {}, removeSession: () => {}, addSession: () => {}, updateSession: () => {} }
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (sel?: any) => (sel ? sel(SESSION_STATE) : SESSION_STATE)
  useSessionStore.getState = () => SESSION_STATE
  return { useSessionStore }
})
const CONFIG_STATE: any = { configs: [], groups: [], sections: [] }
vi.mock('../../../src/renderer/stores/configStore', () => {
  ;['addConfig','updateConfig','removeConfig','addGroup','renameGroup','removeGroup','toggleGroupCollapsed','moveConfigToGroup','addSection','renameSection','removeSection','toggleSectionCollapsed','moveGroupToSection','moveConfigToSection','togglePinned','duplicateConfig','reorderConfigs'].forEach(k => CONFIG_STATE[k] = () => {})
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
vi.mock('../../../src/renderer/components/SessionDialog', () => ({ default: () => React.createElement('div', { 'data-testid': 'session-dialog' }) }))
;(globalThis as any).window.electronAPI = { update: { check: () => Promise.resolve(false), onAvailable: () => () => {}, getVersion: () => Promise.resolve('') } }

const { default: Sidebar } = await import('../../../src/renderer/components/Sidebar')

const cfg = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, label: `cfg ${id}`, workingDirectory: 'C:\\w', color: '', sessionType: 'local', provider: 'claude', ...extra })

const HEADER = '[data-testid="ungrouped-configs-header"]'
const DIVIDER = '[data-testid="loose-configs-divider"]'

describe('Sidebar "Ungrouped" configs header (Saved tab, phase 6)', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    CONFIG_STATE.configs = []; CONFIG_STATE.groups = []; CONFIG_STATE.sections = []
    SESSION_STATE.sessions = []
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  /** Render, then switch to the Saved tab (Running is the default). */
  const renderSaved = () => {
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))
    act(() => { (container.querySelector('[data-testid="panel-tab-saved"]') as HTMLButtonElement).click() })
  }
  const rowLabels = () =>
    Array.from(container.querySelectorAll('[data-testid="config-row"]')).map((el) => el.textContent?.trim())

  it('heads the loose tail when a group sits above it — after the divider, before the rows', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' }), cfg('c2'), cfg('c3')]
    renderSaved()
    const header = container.querySelector(HEADER)
    expect(header).not.toBeNull()
    expect(header!.textContent).toMatch(/ungrouped/i)
    // The bare rule is KEPT — the header is added to it, not instead of it.
    const divider = container.querySelector(DIVIDER)!
    expect(divider.compareDocumentPosition(header!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // ...and the loose rows follow the header.
    const rows = container.querySelectorAll('[data-testid="config-row"]')
    const loose = Array.from(rows).find((r) => r.textContent!.includes('cfg c2'))!
    expect(header!.compareDocumentPosition(loose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rowLabels().length).toBe(3)
  })

  it('shows the header when only a SECTION sits above the loose tail', () => {
    CONFIG_STATE.sections = [{ id: 's1', name: 'Work' }]
    CONFIG_STATE.configs = [cfg('c1', { sectionId: 's1' }), cfg('c2')]
    renderSaved()
    expect(container.querySelector(HEADER)).not.toBeNull()
  })

  it('does NOT show the header (or the divider) when EVERY config is loose', () => {
    CONFIG_STATE.configs = [cfg('c1'), cfg('c2')]
    renderSaved()
    expect(container.querySelector(HEADER)).toBeNull()
    expect(container.querySelector(DIVIDER)).toBeNull()
    expect(rowLabels().length).toBe(2)
  })

  it('does NOT show the header when every config is grouped (no loose tail at all)', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' })]
    renderSaved()
    expect(container.querySelector(HEADER)).toBeNull()
  })

  it('collapses and expands the loose rows, leaving the grouped ones alone', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' }), cfg('c2'), cfg('c3')]
    renderSaved()
    const collapse = container.querySelector<HTMLButtonElement>(`${HEADER} button[aria-label="Collapse ungrouped configs"]`)!
    expect(collapse).toBeTruthy()
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    act(() => collapse.click())
    // Only the grouped row survives; the header stays so it can be reopened.
    expect(rowLabels()).toEqual(['cfg c1'])
    expect(container.querySelector(HEADER)).not.toBeNull()
    const expand = container.querySelector<HTMLButtonElement>(`${HEADER} button[aria-label="Expand ungrouped configs"]`)!
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    act(() => expand.click())
    expect(rowLabels().length).toBe(3)
  })

  it('loose rows keep their drag handles and context menu while headed', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' }), cfg('c2')]
    renderSaved()
    const rows = Array.from(container.querySelectorAll('[data-testid="config-row"]'))
    const loose = rows.find((r) => r.textContent!.includes('cfg c2')) as HTMLElement
    expect(loose.getAttribute('draggable')).toBe('true')
    // The context menu opens from the row (it is wired, not swallowed by the
    // new section wrapper).
    act(() => {
      loose.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    expect(container.querySelector('[data-testid="ctx-edit"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="ctx-delete"]')).not.toBeNull()
  })

  it('a collapse cannot strand the rows when the last group disappears', () => {
    // Collapse with a group above, then remove the group: the header goes with
    // it, so the stale `collapsed` must not keep hiding the rows.
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' }), cfg('c2')]
    renderSaved()
    act(() => container.querySelector<HTMLButtonElement>(`${HEADER} button`)!.click())
    expect(rowLabels()).toEqual(['cfg c1'])
    CONFIG_STATE.groups = []
    CONFIG_STATE.configs = [cfg('c2')]
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))
    expect(container.querySelector(HEADER)).toBeNull()
    expect(rowLabels()).toEqual(['cfg c2'])
  })
})
