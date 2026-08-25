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
vi.mock('../../../src/renderer/stores/appMetaStore', () => {
  // getState included: Sidebar's document-level keydown handler (Ctrl+T
  // suppression during onboarding) reads it, and the menu-dismissal test
  // dispatches real keydowns at the document.
  const STATE = { meta: { hasCreatedFirstConfig: true, firstRunCardDismissed: true }, update: () => {} }
  const useAppMetaStore: any = (sel: any) => sel(STATE)
  useAppMetaStore.getState = () => STATE
  return { useAppMetaStore }
})
;(globalThis as any).window.electronAPI = { update: { check: () => Promise.resolve(false), onAvailable: () => () => {}, getVersion: () => Promise.resolve('') } }
// The New menu's Config action opens the real dialog — heavy and store-hungry;
// the menu's own behaviour is what's under test.
vi.mock('../../../src/renderer/components/SessionDialog', () => ({ default: () => React.createElement('div', { 'data-testid': 'session-dialog' }) }))

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

  it('clicking Saved switches mode: the launcher (search + New) replaces the session list', () => {
    render()
    act(() => { tabs().saved!.click() })
    expect(tabs().saved!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-testid="saved-tab"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="running-tab"]')).toBeNull()
    // One central + New button (#483): the two creations live in its menu.
    const newButton = container.querySelector('[data-testid="new-button"]')
    expect(newButton).toBeTruthy()
    expect(newButton!.textContent).toMatch(/new/i)
    expect(container.querySelector('[data-testid="new-menu"]')).toBeNull()
    // The old fly-out disclosure stays gone — the only expander is the New menu button.
    const disclosures = Array.from(container.querySelectorAll('button')).filter(b => b.getAttribute('aria-expanded') !== null)
    expect(disclosures).toEqual([newButton])
  })

  it('the New menu offers Config and Section, and each option does its job (#483)', async () => {
    render()
    act(() => { tabs().saved!.click() })
    const newButton = () => container.querySelector('[data-testid="new-button"]') as HTMLButtonElement

    act(() => { newButton().click() })
    expect(newButton().getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="new-menu-config"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="new-menu-section"]')).toBeTruthy()

    // Section: menu closes, the inline section-name input appears and takes
    // focus (the focus hop rides a setTimeout(0) — flush it before asserting).
    act(() => { (container.querySelector('[data-testid="new-menu-section"]') as HTMLButtonElement).click() })
    expect(container.querySelector('[data-testid="new-menu"]')).toBeNull()
    const sectionInput = container.querySelector('input[placeholder="Section name"]')
    expect(sectionInput).toBeTruthy()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.activeElement).toBe(sectionInput)

    // Config: menu closes, the New Config dialog opens.
    act(() => { newButton().click() })
    act(() => { (container.querySelector('[data-testid="new-menu-config"]') as HTMLButtonElement).click() })
    expect(container.querySelector('[data-testid="new-menu"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-dialog"]')).toBeTruthy()
  })

  it('the New menu dismisses on outside mousedown, Escape, and tab switch (#483)', () => {
    render()
    act(() => { tabs().saved!.click() })
    const newButton = () => container.querySelector('[data-testid="new-button"]') as HTMLButtonElement
    const menu = () => container.querySelector('[data-testid="new-menu"]')

    // Outside mousedown (useClickOutside listens on mousedown, not click).
    act(() => { newButton().click() })
    expect(menu()).toBeTruthy()
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(menu()).toBeNull()

    // Escape.
    act(() => { newButton().click() })
    expect(menu()).toBeTruthy()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu()).toBeNull()

    // Leaving the Saved body (keyboard-only path — no mousedown fires): the
    // state must not latch and resurface the menu unrequested on return.
    act(() => { newButton().click() })
    expect(menu()).toBeTruthy()
    act(() => { tabs().running!.click() })
    act(() => { tabs().saved!.click() })
    expect(menu()).toBeNull()
    expect(newButton().getAttribute('aria-expanded')).toBe('false')

    // Same latch via the other keyboard-only unmount: collapsing to the rail.
    act(() => { newButton().click() })
    expect(menu()).toBeTruthy()
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {}, collapsed: true } as any)))
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))
    expect(menu()).toBeNull()
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

describe('Sidebar width (#461)', () => {
  let container: HTMLDivElement; let root: Root
  const updateSettingsSpy = vi.fn()
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    SETTINGS_STATE.isLoaded = true
    SETTINGS_STATE.updateSettings = updateSettingsSpy
    updateSettingsSpy.mockClear()
    delete SETTINGS_STATE.settings.sidebarWidth
  })
  afterEach(() => {
    act(() => root.unmount()); container.remove()
    delete SETTINGS_STATE.settings.sidebarWidth
    SETTINGS_STATE.isLoaded = false
    SETTINGS_STATE.updateSettings = () => {}
  })

  const render = () =>
    act(() => root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {} } as any)))
  const aside = () => container.querySelector('aside') as HTMLElement
  const handle = () => container.querySelector('[data-testid="sidebar-resize-handle"]') as HTMLElement

  const drag = (from: number, to: number) => {
    act(() => { handle().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: from })) })
    // TWO moves, so a write leaked into onMove shows up as two calls — the
    // one-write-per-drag assertion must be able to tell release from frame.
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: Math.round((from + to) / 2) })) })
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: to })) })
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', {})) })
  }

  it('defaults to the built-in width and carries the resize handle', () => {
    render()
    expect(aside().style.width).toBe('256px')
    expect(handle()).toBeTruthy()
  })

  it('adopts a stored width once settings are loaded', () => {
    SETTINGS_STATE.settings.sidebarWidth = 320
    render()
    expect(aside().style.width).toBe('320px')
  })

  it('clamps a hand-edited stored width — a bad value cannot wedge the panel', () => {
    SETTINGS_STATE.settings.sidebarWidth = 99999
    render()
    expect(aside().style.width).toBe('420px')
    act(() => root.unmount())
    root = createRoot(container)
    SETTINGS_STATE.settings.sidebarWidth = 3
    render()
    expect(aside().style.width).toBe('200px')
  })

  it('a drag resizes live, writes settings ONCE on release, and clamps', () => {
    render()
    drag(256, 316)
    expect(aside().style.width).toBe('316px')
    expect(updateSettingsSpy).toHaveBeenCalledTimes(1)
    expect(updateSettingsSpy).toHaveBeenCalledWith({ sidebarWidth: 316 })
    // A second drag past the max clamps and still writes once.
    updateSettingsSpy.mockClear()
    drag(316, 2000)
    expect(aside().style.width).toBe('420px')
    expect(updateSettingsSpy).toHaveBeenCalledTimes(1)
    expect(updateSettingsSpy).toHaveBeenCalledWith({ sidebarWidth: 420 })
  })

  it('a bare click on the handle writes nothing', () => {
    render()
    drag(256, 256)
    expect(updateSettingsSpy).not.toHaveBeenCalled()
    expect(aside().style.width).toBe('256px')
  })

  it('a later settings hydrate does not stomp a width the user dragged', () => {
    render()
    drag(256, 300)
    expect(aside().style.width).toBe('300px')
    SETTINGS_STATE.settings.sidebarWidth = 250
    render()
    expect(aside().style.width).toBe('300px')
  })

  it('double-click on the handle resets to the default and persists the reset', () => {
    SETTINGS_STATE.settings.sidebarWidth = 380
    render()
    expect(aside().style.width).toBe('380px')
    act(() => { handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(aside().style.width).toBe('256px')
    // Loose-equality trap: toHaveBeenCalledWith({sidebarWidth: undefined})
    // also matches {}. Assert the key is genuinely present-and-undefined.
    const resetArg = updateSettingsSpy.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(Object.hasOwn(resetArg, 'sidebarWidth')).toBe(true)
    expect(resetArg.sidebarWidth).toBeUndefined()
  })
})
