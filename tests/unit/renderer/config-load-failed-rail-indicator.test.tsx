// @vitest-environment jsdom
/**
 * #370 -- the config-load-failed notice lives in the sidebar's session list,
 * so with the sidebar COLLAPSED nothing on screen said the app was running on
 * defaults with saving paused. The collapsed rail now carries a danger glyph
 * whenever writes are latched; it has a tooltip and opens the full notice
 * (reason text + "start fresh") in a popover beside the rail.
 *
 * Pinned here:
 *  - nothing renders while writes are not locked (no idle glyph in the rail);
 *  - locked -> a button with the failure named in its accessible label;
 *  - click -> the notice, with the lock reason verbatim, is on screen;
 *  - Escape and backdrop MOUSEDOWN close the popover (a synthetic click does
 *    not -- Ctrl+C in a terminal fires click events); the glyph stays;
 *  - "start fresh" inside the popover unlocks and the glyph goes with it;
 *  - the full Sidebar, collapsed, renders the glyph (the regression itself).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The Sidebar mount needs the same store stand-ins sidebar-config-disclosure
// uses; they are harmless for the indicator-only cases.
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

const { default: ConfigLoadFailedRailIndicator } = await import('../../../src/renderer/components/sidebar/ConfigLoadFailedRailIndicator')
const { default: Sidebar } = await import('../../../src/renderer/components/Sidebar')
const { useConfigWriteLockStore } = await import('../../../src/renderer/stores/configWriteLockStore')
const { readFailureLockReason } = await import('../../../src/renderer/utils/configHydration')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useConfigWriteLockStore.getState().unlock()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useConfigWriteLockStore.getState().unlock()
})

const q = (id: string) => container.querySelector<HTMLElement>(`[data-ux-id="${id}"]`)
const REASON = readFailureLockReason({ readFailed: false, failedKeys: ['settings', 'commands'] })!

const mountIndicator = () => act(() => { root.render(<ConfigLoadFailedRailIndicator />) })
const lock = () => act(() => { useConfigWriteLockStore.getState().lock(REASON) })
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const mousedown = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
const escape = () => act(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})

describe('ConfigLoadFailedRailIndicator', () => {
  it('renders nothing while writes are not locked', () => {
    mountIndicator()
    expect(q('config-load-failed-rail-indicator')).toBeNull()
  })

  it('shows a danger glyph that names the failure in its label once locked', () => {
    lock()
    mountIndicator()
    const btn = q('config-load-failed-rail-indicator')
    expect(btn).not.toBeNull()
    expect(btn!.tagName).toBe('BUTTON')
    expect(btn!.getAttribute('aria-label')).toMatch(/configuration could not be loaded/i)
    expect(btn!.getAttribute('aria-label')).toMatch(/saving is paused/i)
    // The tooltip text is in the DOM too, for the hover affordance.
    expect(btn!.textContent).toMatch(/configuration could not be loaded/i)
    // Nothing open yet.
    expect(q('config-load-failed-notice')).toBeNull()
    expect(btn!.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the full notice -- reason text included -- on click', () => {
    lock()
    mountIndicator()
    click(q('config-load-failed-rail-indicator')!)
    expect(q('config-load-failed-notice')).not.toBeNull()
    expect(q('config-load-failed-reason')?.textContent).toBe(REASON)
    expect(q('config-load-failed-rail-indicator')!.getAttribute('aria-expanded')).toBe('true')
    // Clicking the glyph again toggles the popover shut; the glyph stays.
    click(q('config-load-failed-rail-indicator')!)
    expect(q('config-load-failed-notice')).toBeNull()
    expect(q('config-load-failed-rail-indicator')).not.toBeNull()
  })

  it('closes on Escape and keeps the glyph', () => {
    lock()
    mountIndicator()
    click(q('config-load-failed-rail-indicator')!)
    expect(q('config-load-failed-notice')).not.toBeNull()
    escape()
    expect(q('config-load-failed-notice')).toBeNull()
    expect(q('config-load-failed-rail-indicator')).not.toBeNull()
  })

  it('closes on backdrop MOUSEDOWN, not on a synthetic click', () => {
    lock()
    mountIndicator()
    click(q('config-load-failed-rail-indicator')!)
    const backdrop = q('config-load-failed-popover-backdrop')!
    expect(backdrop).not.toBeNull()
    // A click alone (what Ctrl+C in a terminal can synthesise) must not dismiss.
    click(backdrop)
    expect(q('config-load-failed-notice')).not.toBeNull()
    // A mousedown inside the popover must not dismiss either.
    mousedown(q('config-load-failed-notice')!)
    expect(q('config-load-failed-notice')).not.toBeNull()
    mousedown(backdrop)
    expect(q('config-load-failed-notice')).toBeNull()
    expect(q('config-load-failed-rail-indicator')).not.toBeNull()
  })

  it('"start fresh" inside the popover unlocks and removes the glyph', () => {
    lock()
    mountIndicator()
    click(q('config-load-failed-rail-indicator')!)
    click(q('config-load-failed-start-fresh')!)
    expect(useConfigWriteLockStore.getState().lockedReason).toBeNull()
    expect(q('config-load-failed-notice')).toBeNull()
    expect(q('config-load-failed-rail-indicator')).toBeNull()
  })

  it('disappears when the lock clears from elsewhere', () => {
    lock()
    mountIndicator()
    expect(q('config-load-failed-rail-indicator')).not.toBeNull()
    act(() => { useConfigWriteLockStore.getState().unlock() })
    expect(q('config-load-failed-rail-indicator')).toBeNull()
  })
})

describe('Sidebar, collapsed, with a config load failure (#370)', () => {
  const mountSidebar = (collapsed: boolean) => act(() => {
    root.render(React.createElement(Sidebar, { currentView: 'sessions', onViewChange: () => {}, collapsed } as any))
  })

  it('shows the failure in the collapsed rail and the reason is reachable by click', () => {
    lock()
    mountSidebar(true)
    // Sanity: this IS the collapsed rail (the expanded notice is not mounted).
    expect(q('config-load-failed-notice')).toBeNull()
    const btn = q('config-load-failed-rail-indicator')
    expect(btn).not.toBeNull()
    click(btn!)
    expect(q('config-load-failed-notice')).not.toBeNull()
    expect(q('config-load-failed-reason')?.textContent).toBe(REASON)
  })

  it('keeps the rail free of the glyph when nothing failed', () => {
    mountSidebar(true)
    expect(q('config-load-failed-rail-indicator')).toBeNull()
  })

  it('keeps the expanded notice as it was', () => {
    lock()
    mountSidebar(false)
    expect(q('config-load-failed-notice')).not.toBeNull()
    expect(q('config-load-failed-reason')?.textContent).toBe(REASON)
    // The glyph is a collapsed-rail affordance only.
    expect(q('config-load-failed-rail-indicator')).toBeNull()
  })
})
