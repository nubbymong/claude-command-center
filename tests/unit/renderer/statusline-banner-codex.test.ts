// @vitest-environment jsdom
/**
 * P5.4 regression, corrected in WP2 P2: with a Codex session in front, the
 * Status Line tab says these settings apply to Codex sessions too (the strip
 * is one component for every session) and which items a Codex session cannot
 * fill yet. It never claims the settings are Claude-only. The note is
 * informational; StatusLineTab controls remain visible and functional.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let mockSessions: Array<{ id: string; provider?: 'claude' | 'codex'; label: string; workingDirectory: string; color: string; sessionType: 'local' | 'ssh' }> = []
let mockActiveSessionId: string | null = null
/** Usage track MP6: the saved provider switches the note reads. */
let mockChoice: Record<string, unknown> = {}

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
    // Read at load by onboarding/hello-codex.ts (SettingsPage imports it).
    DEFAULT_CONDUCTOR_TOOLS: { vision: true, codexReview: true, claudeReview: true, hostTransfer: true, canvas: true },
    useSettingsStore: (selector: any) =>
      selector({
        settings: { statusLine: DEFAULT_STATUS_LINE, ...mockChoice },
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
    accountProfiles: {
      globalEmail: vi.fn().mockResolvedValue(null),
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
    act(() => { root.render(React.createElement(SettingsPage as React.ComponentType<{ initialTab?: string }>, { initialTab: 'statusline' })) })
    // Usage track MP6: its account now shows (the footer names it), so the
    // note no longer says it does not. P3.7: nor its lines changed, which a
    // Codex session now reports (counted from the edits its rollout records).
    expect(container.querySelector('[data-testid="statusline-codex-note"]')?.textContent).toBe(
      'These settings apply to Codex sessions too. A Codex session does not report session time yet, so Duration does not show for it.',
    )
    expect(container.textContent).not.toMatch(/Claude-only/)
  })

  // P3.7 (row 37): the Model and Account items apply to a Codex session too
  // (its model shows, and its account chip is hidden by Account since P3.6),
  // so their descriptions name no provider.
  it('the Model and Account items say what they show for every provider', () => {
    mockSessions = [{ id: 's-1', provider: 'codex', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local' }]
    mockActiveSessionId = 's-1'
    act(() => { root.render(React.createElement(SettingsPage as React.ComponentType<{ initialTab?: string }>, { initialTab: 'statusline' })) })
    const text = container.textContent ?? ''
    expect(text).toContain('Shows the active model')
    expect(text).toContain('The account this session runs as')
    expect(text).not.toContain('Claude model')
    expect(text).not.toContain('Claude account this session')
  })

  it('does NOT render the Codex banner when active session is Claude', () => {
    mockSessions = [{ id: 's-1', provider: 'claude', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local' }]
    mockActiveSessionId = 's-1'
    act(() => { root.render(React.createElement(SettingsPage as React.ComponentType<{ initialTab?: string }>, { initialTab: 'statusline' })) })
    expect(container.querySelector('[data-testid="statusline-codex-note"]')).toBeNull()
  })

  // Usage track MP6 (as drawn): the note shows while Codex is in use, whatever
  // session is in front.
  it('renders the Codex banner while Codex is in use, with a Claude session in front', async () => {
    const { choiceSettings } = await import('../../../src/renderer/onboarding/provider-choice')
    mockChoice = { ...choiceSettings('both'), codexAnswered: true }
    mockSessions = [{ id: 's-1', provider: 'claude', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local' }]
    mockActiveSessionId = 's-1'
    act(() => { root.render(React.createElement(SettingsPage as React.ComponentType<{ initialTab?: string }>, { initialTab: 'statusline' })) })
    expect(container.querySelector('[data-testid="statusline-codex-note"]')).not.toBeNull()
    mockChoice = {}
  })
})
