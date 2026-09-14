// @vitest-environment jsdom
// #363 — an "Ungrouped" header over the loose running sessions, shown only
// when there is a group (or section) above them, so a sidebar of nothing but
// loose sessions stays clean. Collapsible and close-all like the group headers.
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

const removeSession = vi.fn()
const SESSION_STATE: any = { sessions: [], activeSessionId: null, setActiveSession: () => {}, removeSession, addSession: () => {}, updateSession: () => {} }
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
const killSessionPty = vi.fn()
vi.mock('../../../src/renderer/ptyTracker', () => ({ killSessionPty: (id: string) => killSessionPty(id) }))
vi.mock('../../../src/renderer/stores/insightsStore', () => ({ useInsightsStore: (sel: any) => sel({ status: null, statusMessage: null }) }))
vi.mock('../../../src/renderer/stores/cloudAgentStore', () => ({ useCloudAgentStore: (sel: any) => sel({ agents: [] }) }))
vi.mock('../../../src/renderer/stores/conductorMcpStore', () => ({ useConductorMcpStore: (sel: any) => sel({ browserRunning: false, serverRunning: true }) }))
vi.mock('../../../src/renderer/stores/appMetaStore', () => ({ useAppMetaStore: (sel: any) => sel({ meta: { hasCreatedFirstConfig: true, firstRunCardDismissed: true }, update: () => {} }) }))
;(globalThis as any).window.electronAPI = { update: { check: () => Promise.resolve(false), onAvailable: () => () => {}, getVersion: () => Promise.resolve('') } }

const { default: Sidebar } = await import('../../../src/renderer/components/Sidebar')

function cfg(id: string, extra: Record<string, unknown> = {}) {
  return { id, label: `cfg ${id}`, workingDirectory: 'C:\\w', color: '#fff', sessionType: 'local', ...extra }
}
function sess(id: string, configId?: string) {
  return { id, configId, label: `session ${id}`, workingDirectory: 'C:\\w', model: 'x', color: '#fff', status: 'running', createdAt: 1, sessionType: 'local' }
}

const HEADER = '[data-testid="ungrouped-sessions-header"]'

describe('Sidebar "Ungrouped" sessions header (#363)', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    CONFIG_STATE.configs = []; CONFIG_STATE.groups = []; CONFIG_STATE.sections = []
    SESSION_STATE.sessions = []
    removeSession.mockClear(); killSessionPty.mockClear()
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const render = () => act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))
  const rowLabels = () => Array.from(container.querySelectorAll('[title^="session "]')).map(el => el.textContent)
  // The Saved Configs panel (above the session list) renders the same group /
  // section names; the LAST match is the one in the session list.
  const lastSpan = (text: string) => Array.from(container.querySelectorAll('span')).filter(s => s.textContent === text).at(-1)!

  it('shows the header over the loose sessions when a group sits above them', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' }), cfg('c2'), cfg('c3')]
    SESSION_STATE.sessions = [sess('s1', 'c1'), sess('s2', 'c2'), sess('s3', 'c3')]
    render()
    const headers = container.querySelectorAll(HEADER)
    expect(headers.length).toBe(1)
    expect(headers[0].textContent).toMatch(/ungrouped/i)
    // The header comes AFTER the group header and BEFORE the loose rows.
    const groupHeader = lastSpan('Backend')
    expect(groupHeader.compareDocumentPosition(headers[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const loose = container.querySelector('[title="session s2"]')!
    expect(headers[0].compareDocumentPosition(loose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rowLabels()).toEqual(['session s1', 'session s2', 'session s3'])
  })

  it('does NOT show the header when every session is loose', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]   // a group with no running session is not "above"
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' }), cfg('c2'), cfg('c3')]
    SESSION_STATE.sessions = [sess('s2', 'c2'), sess('s3'), sess('s4', 'c3')]
    render()
    expect(container.querySelector(HEADER)).toBeNull()
    expect(rowLabels()).toEqual(['session s2', 'session s3', 'session s4'])
  })

  it('does NOT show the header when every session is grouped', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' })]
    SESSION_STATE.sessions = [sess('s1', 'c1')]
    render()
    expect(container.querySelector(HEADER)).toBeNull()
  })

  it('collapses and expands the loose sessions without touching the grouped ones', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' }), cfg('c2')]
    SESSION_STATE.sessions = [sess('s1', 'c1'), sess('s2', 'c2'), sess('s3')]
    render()
    const toggle = container.querySelector<HTMLButtonElement>(`${HEADER} button[aria-label="Collapse ungrouped sessions"]`)!
    expect(toggle).toBeTruthy()
    act(() => toggle.click())
    expect(rowLabels()).toEqual(['session s1'])
    expect(container.querySelector(HEADER)).not.toBeNull()   // header stays while collapsed
    const reopen = container.querySelector<HTMLButtonElement>(`${HEADER} button[aria-label="Expand ungrouped sessions"]`)!
    act(() => reopen.click())
    expect(rowLabels()).toEqual(['session s1', 'session s2', 'session s3'])
  })

  it('close-all closes only the loose sessions', () => {
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend' }]
    CONFIG_STATE.configs = [cfg('c1', { groupId: 'g1' }), cfg('c2')]
    SESSION_STATE.sessions = [sess('s1', 'c1'), sess('s2', 'c2'), sess('s3')]
    render()
    const closeAll = container.querySelector<HTMLButtonElement>(`${HEADER} button[title="Close all ungrouped sessions"]`)!
    expect(closeAll).toBeTruthy()
    act(() => closeAll.click())
    expect(killSessionPty.mock.calls.map(c => c[0]).sort()).toEqual(['s2', 's3'])
    expect(removeSession.mock.calls.map(c => c[0]).sort()).toEqual(['s2', 's3'])
  })

  it('gets the same treatment inside a section: header only when the section also has a group', () => {
    CONFIG_STATE.sections = [{ id: 'sec1', name: 'Work' }, { id: 'sec2', name: 'Play' }]
    CONFIG_STATE.groups = [{ id: 'g1', name: 'Backend', sectionId: 'sec1' }]
    CONFIG_STATE.configs = [
      cfg('c1', { groupId: 'g1' }),           // grouped, in sec1 via the group
      cfg('c2', { sectionId: 'sec1' }),       // loose in sec1
      cfg('c3', { sectionId: 'sec2' })        // loose in sec2 (no group there)
    ]
    SESSION_STATE.sessions = [sess('s1', 'c1'), sess('s2', 'c2'), sess('s3', 'c3')]
    render()
    const headers = container.querySelectorAll(HEADER)
    expect(headers.length).toBe(1)
    // The one header is inside the Work section — after the Backend group,
    // before "session s2" — and before the Play section's header.
    const play = lastSpan('Play')
    expect(headers[0].compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const s2 = container.querySelector('[title="session s2"]')!
    expect(headers[0].compareDocumentPosition(s2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Collapsing the section's ungrouped header hides s2 only.
    const toggle = container.querySelector<HTMLButtonElement>(`${HEADER} button[aria-label="Collapse ungrouped sessions"]`)!
    act(() => toggle.click())
    expect(rowLabels()).toEqual(['session s1', 'session s3'])
  })

  it('shows the unsectioned header when only a SECTION sits above the loose sessions', () => {
    // Mirrors the loose-configs divider: anything organised above the loose
    // tail is enough, otherwise the tail reads as part of the section.
    CONFIG_STATE.sections = [{ id: 'sec1', name: 'Work' }]
    CONFIG_STATE.configs = [cfg('c1', { sectionId: 'sec1' }), cfg('c2')]
    SESSION_STATE.sessions = [sess('s1', 'c1'), sess('s2', 'c2')]
    render()
    // sec1 has only loose sessions (no group) -> no in-section header; the
    // unsectioned tail gets one because the section is above it.
    const headers = container.querySelectorAll(HEADER)
    expect(headers.length).toBe(1)
    const s1 = container.querySelector('[title="session s1"]')!
    expect(s1.compareDocumentPosition(headers[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
