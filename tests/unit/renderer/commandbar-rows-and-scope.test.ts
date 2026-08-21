// @vitest-environment jsdom
/**
 * The command bar says where a button runs, and whose it is.
 *
 * Three things it used to get wrong, all of them invisible state:
 *   - a button targeted "Any" sat in the Claude row and ran in whichever pane
 *     happened to be open, so the row could lie (fixed by dropping "Any");
 *   - the partner row appeared when its first command was created and vanished
 *     when the last was deleted, so the bar changed height under the pointer and
 *     nothing told you the row could exist at all;
 *   - a global command and a this-config command looked identical, while
 *     editing or deleting the global reached every config you own.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mutable so a test can change what exists BEFORE rendering; the store mock
// reads it at call time rather than closing over a snapshot.
let COMMANDS: Array<Record<string, unknown>> = []
const ALL = [
  { id: 'c1', label: 'Prompt one', prompt: 'do a thing', scope: 'global' as const },
  { id: 'c2', label: 'Shell one', prompt: 'npm test', scope: 'config' as const, configId: 'cfg', target: 'partner' as const },
  { id: 'c3', label: 'Claude one', prompt: 'explain', scope: 'config' as const, configId: 'cfg', target: 'claude' as const },
]

beforeEach(() => { COMMANDS = ALL })

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({
      sessions: [{ id: 's-1', label: 't', workingDirectory: '/', color: '#89b4fa',
        sessionType: 'local', provider: 'claude', model: 'sonnet' }],
      activeSessionId: 's-1',
      updateSession: vi.fn(),
    }),
}))

vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    commands: COMMANDS,
    sections: [],
    addCommand: vi.fn(),
    updateCommand: vi.fn(),
    removeCommand: vi.fn(),
    reorderCommands: vi.fn(),
    updateSection: vi.fn(),
    removeSection: vi.fn(),
    reorderSections: vi.fn(),
  }),
}))

vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: { collapsedSectionIds: [] }, toggleSection: vi.fn() }),
}))

vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: (sel: any) =>
    sel({ startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), bySessionId: {} }),
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

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = { pty: { write: vi.fn() } }

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

let container: HTMLDivElement
let root: Root

const render = (props: Record<string, unknown>) => {
  act(() => {
    root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg', ...props } as never))
  })
}

const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('both rows are present whenever a partner terminal exists', () => {
  it('renders a named Claude row and a named Shell row', () => {
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    const text = container.textContent || ''
    expect(text).toContain('Claude')
    expect(text).toContain('Shell')
  })

  it('keeps the Shell row when NOTHING targets it -- the empty row is the affordance', () => {
    // The case that used to make the bar's height change under the pointer: no
    // partner commands meant no row, so creating the first one materialised a
    // row nobody knew was possible, and deleting the last took it away again.
    COMMANDS = ALL.filter((c) => c.target !== 'partner')
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    const labels = Array.from(container.querySelectorAll('span'))
      .map((s) => s.textContent?.trim())
    expect(labels).toContain('Shell')
    // …and it really is empty: no partner button rendered.
    expect(buttonNamed('Shell one')).toBeUndefined()
  })

  it('keeps the Claude row when nothing targets THAT either', () => {
    COMMANDS = ALL.filter((c) => c.target === 'partner')
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    const labels = Array.from(container.querySelectorAll('span'))
      .map((s) => s.textContent?.trim())
    expect(labels).toContain('Claude')
  })

  it('renders no Shell row at all when the session has no partner terminal', () => {
    render({ partnerEnabled: false })
    // The Claude row still names itself; "Shell" belongs to a pane that does
    // not exist here.
    const rowLabels = Array.from(container.querySelectorAll('span'))
      .map((s) => s.textContent?.trim())
      .filter((t) => t === 'Shell')
    expect(rowLabels).toEqual([])
  })
})

describe('scope is visible on the button', () => {
  it('marks a global command and leaves a config-scoped one unmarked', () => {
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    const chips = container.querySelectorAll('[data-testid="command-global-chip"]')
    // Exactly one of the three fixtures is global.
    expect(chips).toHaveLength(1)
    const globalBtn = buttonNamed('Prompt one')
    expect(globalBtn?.textContent).toContain('global')
    expect(buttonNamed('Claude one')?.textContent).not.toContain('global')
  })

  it('says in the tooltip which pane a button runs in, and what global costs', () => {
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    expect(buttonNamed('Shell one')?.getAttribute('title')).toContain('partner shell')
    expect(buttonNamed('Claude one')?.getAttribute('title')).toContain('Claude terminal')
    expect(buttonNamed('Prompt one')?.getAttribute('title')).toContain('every config')
  })
})
