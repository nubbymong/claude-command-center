// @vitest-environment jsdom
/**
 * A command button with a secret argument types a REFERENCE, never the value,
 * and never the literal {secret} token.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const COMMANDS = [
  { id: 'abc123', label: 'Deploy', prompt: './deploy.ps1', scope: 'global' as const, target: 'partner' as const,
    defaultArgs: ['-Env prod', '-Token {secret}'], hasSecretArg: true },
  { id: 'def456', label: 'Plain', prompt: './plain.ps1', scope: 'global' as const, target: 'partner' as const,
    defaultArgs: ['-Token {secret}'] },
]

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({ sessions: [{ id: 's-1', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet' }],
      activeSessionId: 's-1', updateSession: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    commands: COMMANDS, sections: [], addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(),
    reorderCommands: vi.fn(), updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
  }),
}))
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: { collapsedSectionIds: [] }, toggleSection: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: (sel: any) => sel({ startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), bySessionId: {} }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))

const ptyWrite = vi.fn()
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = { pty: { write: ptyWrite }, credentials: { save: vi.fn(), delete: vi.fn() } }
;(globalThis as any).window.electronPlatform = 'win32'

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ptyWrite.mockClear()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  act(() => {
    root.render(React.createElement(CommandBar, {
      sessionId: 's-1', parentSessionId: 's-1', partnerEnabled: true, partnerSessionId: 's-1-partner', isPartnerActive: true,
    } as never))
  })
})
afterEach(() => { act(() => { root.unmount() }); container.remove() })

const click = (label: string) => {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement
  act(() => { btn.click() })
}

describe('what a secret-bearing button types', () => {
  it('types the env reference where {secret} was, and the rest verbatim', () => {
    click('Deploy')
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    const [, text] = ptyWrite.mock.calls[0]
    expect(text).toBe('./deploy.ps1 -Env prod -Token "${env:CCC_CMD_SECRET_abc123}"\r')
  })

  it('never types the literal token for a secret-bearing command', () => {
    click('Deploy')
    expect(ptyWrite.mock.calls[0][1]).not.toContain('{secret}')
  })

  it('leaves {secret} as literal text on a command that has NO stored secret', () => {
    // Visible and harmless, rather than silently typing nothing where a value
    // was meant -- and it tells the user the command was not set up.
    click('Plain')
    expect(ptyWrite.mock.calls[0][1]).toBe('./plain.ps1 -Token {secret}\r')
  })
})
