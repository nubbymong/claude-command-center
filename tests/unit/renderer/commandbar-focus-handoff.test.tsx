// @vitest-environment jsdom
/**
 * Focus hand-off after a command chip runs (owner bug report 2026-08-27):
 * clicking a chip used to leave focus ON the button, so the user's follow-up
 * Enter re-pressed it and injected the command a second time. Pinned here:
 *  - a mouse click BLURS the chip, whatever kind of command it runs;
 *  - a pty-typing command additionally dispatches `ccc:focus-terminal` with
 *    the target pty's session id, so the terminal takes the keyboard;
 *  - a page command dispatches nothing (no pty was written).
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
const webviewState = { startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), navigate: vi.fn(), bySessionId: {} }
vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: Object.assign((sel: any) => sel(webviewState), { getState: () => webviewState }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/LogsButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/PasteHint', () => ({ default: () => null }))

const ptyWrite = vi.fn()
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, pty: { write: ptyWrite } }

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

let container: HTMLDivElement
let root: Root
let focusEvents: Array<{ sessionId?: string }>
const captureFocusEvent = (ev: Event) => {
  focusEvents.push((ev as CustomEvent<{ sessionId?: string }>).detail ?? {})
}

beforeEach(() => {
  COMMANDS = []
  ptyWrite.mockClear()
  focusEvents = []
  window.addEventListener('ccc:focus-terminal', captureFocusEvent)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  window.removeEventListener('ccc:focus-terminal', captureFocusEvent)
  act(() => { root.unmount() })
  container.remove()
})
const render = () => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 'pty-1', parentSessionId: 's-1', configId: 'cfg' } as never)) })
}
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined

describe('focus hand-off after a chip runs', () => {
  it('a typing command blurs the chip and asks the target terminal to take focus', () => {
    COMMANDS = [{ id: 'c1', label: 'Resume Prompt', prompt: 'resume from the handoff', scope: 'global' }]
    render()
    const chip = buttonNamed('Resume Prompt')!
    chip.focus()
    expect(document.activeElement).toBe(chip)
    act(() => { chip.click() })
    expect(ptyWrite).toHaveBeenCalledWith('pty-1', 'resume from the handoff\r')
    // The whole bug: Enter must not find the chip focused any more.
    expect(document.activeElement).not.toBe(chip)
    expect(focusEvents).toEqual([{ sessionId: 'pty-1' }])
  })

  it('a page command blurs the chip but requests no terminal focus (nothing was typed)', () => {
    COMMANDS = [{ id: 'p1', label: 'Docs', prompt: '', scope: 'global', kind: 'page', pageUrl: 'https://docs.example.com/' }]
    render()
    const chip = buttonNamed('Docs')!
    chip.focus()
    expect(document.activeElement).toBe(chip)
    act(() => { chip.click() })
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(chip)
    expect(focusEvents).toEqual([])
  })
})
