// @vitest-environment jsdom
/**
 * P5.4 regression: Statusline tab shows a provider-aware banner when the active
 * session is Codex, explaining that statusline customisation is Claude-only.
 * The banner is informational; StatusLineTab controls remain visible and functional.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let mockSessions: Array<{ id: string; provider?: 'claude' | 'codex'; label: string; workingDirectory: string; color: string; sessionType: 'local' | 'ssh' }> = []
let mockActiveSessionId: string | null = null

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({
    sessions: mockSessions,
    activeSessionId: mockActiveSessionId,
  }),
}))

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const DEFAULT_STATUS_LINE = {
    showModel: true,
    showTokens: true,
    showContextBar: true,
    showCost: true,
    showLinesChanged: true,
    showDuration: true,
    showRateLimits: true,
    showResetTime: true,
    font: 'sans',
    fontSize: 12,
  }
  return {
    DEFAULT_STATUS_LINE,
    useSettingsStore: (selector: any) =>
      selector({
        settings: { statusLine: DEFAULT_STATUS_LINE },
        updateSettings: vi.fn(),
      }),
  }
})

// Mock window.electronAPI to avoid IPC calls
if (typeof window !== 'undefined') {
  (window as any).electronAPI = {
    debug: {
      isEnabled: vi.fn().mockResolvedValue(false),
    },
  }
}

import SettingsPage from '../../../src/renderer/components/SettingsPage'

describe('Statusline tab provider-aware banner', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders the Codex banner on the statusline tab when active session is Codex', () => {
    mockSessions = [{ id: 's-1', provider: 'codex', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local' }]
    mockActiveSessionId = 's-1'
    act(() => { root.render(React.createElement(SettingsPage, { initialTab: 'statusline' })) })
    expect(container.textContent).toContain('Statusline customisation is Claude-only')
  })

  it('does NOT render the Codex banner when active session is Claude', () => {
    mockSessions = [{ id: 's-1', provider: 'claude', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local' }]
    mockActiveSessionId = 's-1'
    act(() => { root.render(React.createElement(SettingsPage, { initialTab: 'statusline' })) })
    expect((container.textContent ?? '')).not.toContain('Statusline customisation is Claude-only')
  })
})
