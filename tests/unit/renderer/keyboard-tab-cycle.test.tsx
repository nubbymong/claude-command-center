// @vitest-environment jsdom
/**
 * Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1-9 cycle the WHOLE main strip — session
 * tabs AND open page tabs (Tokenomics, Logs, …) — in the order the TabBar
 * renders them: sessions first, then page tabs. Proves the unified-tab
 * navigation, not sessions-only cycling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ViewType } from '../../../src/renderer/types/views'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Onboarding gate: keep it not-due so the shortcut handler doesn't early-return.
vi.mock('../../../src/renderer/onboarding/gate', () => ({ deriveOnboarding: () => ({ due: false, steps: [] }) }))
// Alt+V path pulls image transfer; unused here, mock so imports stay light.
vi.mock('../../../src/renderer/utils/imageTransfer', () => ({ sendImageToSession: vi.fn() }))

const { useKeyboardShortcuts } = await import('../../../src/renderer/hooks/useKeyboardShortcuts')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
const { DEFAULT_SHORTCUTS } = await import('../../../src/renderer/utils/shortcuts')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(id: string): Session {
  return { id, label: id, workingDirectory: '/x', model: 'opus', color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local' } as Session
}

// Host renders the hook and exposes the active tab (view + active session) so
// the test can read where each keystroke landed. setView actually updates state
// so the next keystroke sees the new view (the effect rebinds on view change).
let currentView: ViewType = 'sessions'
function Host({ openPageTabs }: { openPageTabs: ViewType[] }) {
  const [view, setView] = useState<ViewType>('sessions')
  currentView = view
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  useKeyboardShortcuts(activeSessionId, () => {}, setView, view, openPageTabs, () => {})
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  currentView = 'sessions'
  useSessionStore.setState({ sessions: [makeSession('s1'), makeSession('s2')], activeSessionId: 's1', renamingSessionId: null })
  useSettingsStore.setState({ settings: { keyboardShortcuts: DEFAULT_SHORTCUTS } as any })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(<Host openPageTabs={['tokenomics']} />) })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function press(key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: mods.ctrl ?? true, shiftKey: mods.shift ?? false, bubbles: true }))
  })
}
const activeTab = () => (currentView === 'sessions' ? `session:${useSessionStore.getState().activeSessionId}` : `page:${currentView}`)

describe('unified tab keyboard cycling', () => {
  it('Ctrl+Tab cycles sessions then page tabs, and wraps', () => {
    expect(activeTab()).toBe('session:s1')
    press('Tab')
    expect(activeTab()).toBe('session:s2')
    press('Tab')
    expect(activeTab()).toBe('page:tokenomics')
    press('Tab')
    expect(activeTab()).toBe('session:s1') // wrapped past the last page tab
  })

  it('Ctrl+Shift+Tab cycles backwards into the page tab', () => {
    expect(activeTab()).toBe('session:s1')
    press('Tab', { ctrl: true, shift: true })
    expect(activeTab()).toBe('page:tokenomics') // one step back from the first tab
  })

  it('Ctrl+3 jumps to the third tab (the page tab)', () => {
    press('3')
    expect(activeTab()).toBe('page:tokenomics')
  })
})
