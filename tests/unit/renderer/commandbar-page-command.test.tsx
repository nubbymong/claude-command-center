// @vitest-environment jsdom
/**
 * An "Open a page" button in the command bar (item 26) types NOTHING: it
 * points the session's browser pane at its page. And the Browser button is
 * rendered for a session with no webview command at all.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let COMMANDS: Array<Record<string, unknown>> = []

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({
      sessions: [{ id: 's-1', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet' }],
      activeSessionId: 's-1',
      updateSession: vi.fn(),
    }),
}))
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    commands: COMMANDS, sections: [],
    addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(), reorderCommands: vi.fn(),
    updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
  }),
}))
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: { collapsedSectionIds: [] }, toggleSection: vi.fn() }),
}))
const navigate = vi.fn()
const webviewState = { startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), navigate, bySessionId: {} }
vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: Object.assign((sel: any) => sel(webviewState), { getState: () => webviewState }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))
const trackUsage = vi.fn()
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: (...a: unknown[]) => trackUsage(...a) }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/LogsButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({
  default: (p: { sessionId: string }) => React.createElement('button', { 'data-testid': 'browser-toggle', 'data-sid': p.sessionId }, 'Browser'),
}))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/PasteHint', () => ({ default: () => null }))

const ptyWrite = vi.fn()
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, pty: { write: ptyWrite } }

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  COMMANDS = []
  navigate.mockClear(); ptyWrite.mockClear(); trackUsage.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})
const render = (props: Record<string, unknown> = {}) => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 'pty-1', parentSessionId: 's-1', configId: 'cfg', ...props } as never)) })
}
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined

describe('the Browser button is always there', () => {
  it('renders with no webview command configured, keyed by the SESSION id (not the PTY id)', () => {
    render()
    const b = container.querySelector('[data-testid="browser-toggle"]')
    expect(b).not.toBeNull()
    expect(b!.getAttribute('data-sid')).toBe('s-1')
  })
})

describe('an "Open a page" button', () => {
  it('navigates the session browser to its page and writes NOTHING to any pty', () => {
    COMMANDS = [{ id: 'p1', label: 'Docs', prompt: '', scope: 'global', kind: 'page', pageUrl: 'https://docs.example.com/' }]
    render()
    const b = buttonNamed('Docs')!
    expect(b).toBeDefined()
    expect(b.querySelector('[data-testid="command-page-glyph"]')).not.toBeNull()
    expect(b.title).toContain('Opens https://docs.example.com/ in the browser pane')
    act(() => { b.click() })
    expect(navigate).toHaveBeenCalledWith('s-1', 'https://docs.example.com/')
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(trackUsage).toHaveBeenCalledWith('webview.opened')
  })
  it('a page button whose stored url is not http(s) (hand-edited file) does nothing', () => {
    COMMANDS = [{ id: 'p2', label: 'Evil', prompt: '', scope: 'global', kind: 'page', pageUrl: 'file:///C:/x' }]
    render()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    act(() => { buttonNamed('Evil')!.click() })
    expect(navigate).not.toHaveBeenCalled()
    expect(ptyWrite).not.toHaveBeenCalled()
    warn.mockRestore()
  })
  it('a typing command still types (nothing else changed)', () => {
    COMMANDS = [{ id: 'c1', label: 'Explain', prompt: 'explain this', scope: 'global' }]
    render()
    act(() => { buttonNamed('Explain')!.click() })
    expect(ptyWrite).toHaveBeenCalledWith('pty-1', 'explain this\r')
    expect(navigate).not.toHaveBeenCalled()
  })
})
