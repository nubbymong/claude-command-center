// @vitest-environment jsdom
/**
 * The slim Ask Conductor command bar (#465).
 *
 * The Ask session is a help surface, not a workspace: its bar keeps ONLY Snap
 * and Canvas. Everything project-facing — the Add split chip, the Global and
 * Session command bands, Logs, Browser, Artifacts, Partner and the encrypted
 * Notes — must not render there, and the same props on an ordinary session
 * must keep all of it (so the gate is `kind: 'ask'`, not a side effect of the
 * missing config).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ASK_SESSION = {
  id: 'ask-1', label: 'Ask Conductor', kind: 'ask', workingDirectory: '/res/help',
  color: '#5d8bf0', sessionType: 'local', provider: 'claude', model: '',
}
const NORMAL_SESSION = {
  id: 'ask-1', label: 'My config', workingDirectory: '/proj', color: '#89b4fa',
  sessionType: 'local', provider: 'claude', model: 'sonnet', configId: 'cfg',
}
let SESSIONS: Array<Record<string, unknown>> = [ASK_SESSION]

const COMMANDS = [
  { id: 'g1', label: 'Explain', prompt: 'explain this', scope: 'global' as const, order: 0 },
  { id: 'c1', label: 'Test', prompt: 'npm test', scope: 'config' as const, configId: 'cfg', target: 'partner' as const, order: 0 },
]

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: SESSIONS, activeSessionId: 'ask-1', updateSession: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/commandStore', () => {
  const state = () => ({
    commands: COMMANDS, sections: [],
    addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(), reorderCommands: vi.fn(),
    moveCommand: vi.fn(), setCommandSection: vi.fn(), togglePinned: vi.fn(), clearReview: vi.fn(),
    addSection: vi.fn(), updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
  })
  const useCommandStore = (sel?: any) => (sel ? sel(state()) : state())
  useCommandStore.getState = state
  return { useCommandStore }
})
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({
    state: { collapsedSectionIds: [], barCollapsed: false, overflow: 'fold', hiddenCoreTools: { everywhere: [], bySession: {} } },
    toggleSection: vi.fn(), setOverflow: vi.fn(), hideCoreTool: vi.fn(), showCoreTool: vi.fn(), setBarCollapsed: vi.fn(),
  }),
}))
vi.mock('../../../src/renderer/stores/webviewStore', () => {
  const state = { startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), navigate: vi.fn(), setOpen: vi.fn(), bySessionId: {} }
  const useWebviewStore = (sel: any) => sel(state)
  useWebviewStore.getState = () => state
  return {
    useWebviewStore,
    pollUrlForContent: vi.fn(() => Promise.resolve(false)),
    probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
  }
})
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
// Markers so "not drawn" is distinguishable from "drawn empty". The coreWrap
// testids (core-tool-*) come from CommandBar itself, so absence checks read
// those; these mocks just keep the heavy components out.
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => React.createElement('div', { 'data-testid': 'snap-mock' }) }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => React.createElement('div', { 'data-testid': 'canvas-mock' }) }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/LogsButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))

const notesApi = {
  list: vi.fn(async () => []), load: vi.fn(async () => ''), save: vi.fn(async () => true),
  delete: vi.fn(async () => true), reorder: vi.fn(async () => true),
}
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: { write: vi.fn() },
  credentials: { save: vi.fn(), delete: vi.fn() },
  notes: notesApi,
}

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const render = async (props: Record<string, unknown> = {}) => {
  await act(async () => {
    root.render(React.createElement(CommandBar, {
      sessionId: 'ask-1', parentSessionId: 'ask-1',
      // Partner props DELIBERATELY provided: the Ask bar must suppress the
      // partner by kind, not merely because App forgot to wire it.
      partnerEnabled: true, onTogglePartner: vi.fn(), partnerSessionId: 'ask-1-partner',
      ...props,
    } as never))
  })
  await flush()
}
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

beforeEach(() => {
  SESSIONS = [ASK_SESSION]
  // A resolvable primary profile: even with an account the Ask bar must not
  // grow the Artifacts tool (it is a claude.ai surface).
  useAccountProfilesStore.setState({ profiles: [{ id: 'p1', isPrimary: true, name: 'Main', accountEmail: 'a@b.c' } as never] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the Ask session bar is slim (#465)', () => {
  it('keeps only Snap and Canvas; no Add, no bands, no Logs/Browser/Artifacts/Partner/Notes', async () => {
    await render()
    expect(byTestId('core-tool-snap')).not.toBeNull()
    expect(byTestId('core-tool-canvas')).not.toBeNull()

    expect(byTestId('command-add')).toBeNull()
    expect(byTestId('command-band-global')).toBeNull()
    expect(byTestId('command-band-config')).toBeNull()
    expect(byTestId('core-tool-logs')).toBeNull()
    expect(byTestId('core-tool-browser')).toBeNull()
    expect(byTestId('core-tool-artifacts')).toBeNull()
    expect(byTestId('core-tool-partner')).toBeNull()
    expect(byTestId('core-tool-notes')).toBeNull()
  })

  it('an ordinary session with the SAME props keeps everything (the gate is kind, not the missing config)', async () => {
    SESSIONS = [NORMAL_SESSION]
    await render({ configId: 'cfg' })
    expect(byTestId('command-add')).not.toBeNull()
    expect(byTestId('command-band-global')).not.toBeNull()
    expect(byTestId('command-band-config')).not.toBeNull()
    expect(byTestId('core-tool-snap')).not.toBeNull()
    expect(byTestId('core-tool-canvas')).not.toBeNull()
    expect(byTestId('core-tool-logs')).not.toBeNull()
    expect(byTestId('core-tool-browser')).not.toBeNull()
    expect(byTestId('core-tool-artifacts')).not.toBeNull()
    expect(byTestId('core-tool-partner')).not.toBeNull()
    expect(byTestId('core-tool-notes')).not.toBeNull()
  })

  it('the bar right-click menu offers no Add entries on the Ask bar (they would create unreachable commands)', async () => {
    await render()
    act(() => {
      byTestId('command-bar')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }))
    })
    expect(byTestId('bar-menu')).not.toBeNull()
    expect(byTestId('bar-add-command')).toBeNull()
    expect(byTestId('bar-add-section')).toBeNull()
    // The rest of the menu (overflow, show hidden tools, manage, hide) survives.
    expect(byTestId('bar-overflow-fold')).not.toBeNull()
    expect(byTestId('bar-manage')).not.toBeNull()
  })

  it('…and keeps them on an ordinary bar', async () => {
    SESSIONS = [NORMAL_SESSION]
    await render({ configId: 'cfg' })
    act(() => {
      byTestId('command-bar')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }))
    })
    expect(byTestId('bar-add-command')).not.toBeNull()
    expect(byTestId('bar-add-section')).not.toBeNull()
  })
})
