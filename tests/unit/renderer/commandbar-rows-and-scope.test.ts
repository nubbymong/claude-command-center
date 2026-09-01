// @vitest-environment jsdom
/**
 * The command bar says where a button runs, and whose it is (ADR-018 D1, D4).
 *
 * The one-row bar has no CLAUDE / SHELL row labels and no dashed "global"
 * chip. Instead:
 *   - two fixed SCOPE bands, Global and Session, each labelled, each present
 *     whenever it can exist (a band is never created by its first button or
 *     removed by its last -- the empty band is the affordance, and the bar's
 *     height never changes under the pointer);
 *   - inside a band, a muted target mark opens each cluster and says where
 *     those buttons run (the agent / the partner shell / the browser pane);
 *   - the chip's tooltip carries the scope in words ("Global — every config" /
 *     "Session — this config only") and the pane it runs in.
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

const byTestId = (id: string, within: ParentNode = container) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const allByTestId = (id: string, within: ParentNode = container) => Array.from(within.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const chipNamed = (label: string, within: ParentNode = container) =>
  allByTestId('command-chip', within).find((b) => b.textContent?.includes(label))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('both scope bands are present whenever the session has a config', () => {
  it('renders both scope bands with NO GLOBAL/SESSION text labels (harmonise-remote removal) -- and no CLAUDE / SHELL row labels', () => {
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    // Bands (drop targets / containers) still present…
    expect(byTestId('command-band-global')).not.toBeNull()
    expect(byTestId('command-band-config')).not.toBeNull()
    // …but the GLOBAL/SESSION text labels are retired: the divider separates the
    // bands, and each button carries its scope in its own tooltip/menu.
    expect(byTestId('command-band-label-global')).toBeNull()
    expect(byTestId('command-band-label-config')).toBeNull()
    const spans = Array.from(container.querySelectorAll('span')).map((s) => s.textContent?.trim())
    expect(spans).not.toContain('Global')
    expect(spans).not.toContain('Session')
    expect(spans).not.toContain('Claude')
    expect(spans).not.toContain('Shell')
    expect(spans).not.toContain('Commands')
  })

  it('keeps the Session band as a drop target when NOTHING is scoped to it (label retired, so nothing to hide)', () => {
    // The band DIV stays (the row height no longer changes under the pointer —
    // Add + core tools always hold the row open — and it is still the drop
    // target that scopes a command Session-only). Its GLOBAL/SESSION text label
    // is retired entirely, so there is never a label to show or hide.
    COMMANDS = ALL.filter((c) => c.scope !== 'config')
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    const band = byTestId('command-band-config')
    expect(band).not.toBeNull()                                  // drop target still present
    expect(byTestId('command-band-label-config')).toBeNull()     // no text label, ever
    expect(allByTestId('command-chip', band!)).toHaveLength(0)
    expect(band!.querySelector('[data-testid^="command-cluster-"]')).toBeNull()
  })

  it('the Global band likewise has no text label', () => {
    COMMANDS = ALL.filter((c) => c.scope !== 'global')
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    const band = byTestId('command-band-global')
    expect(band).not.toBeNull()
    expect(byTestId('command-band-label-global')).toBeNull()
    expect(allByTestId('command-chip', band!)).toHaveLength(0)
  })

  it('a non-empty band still renders no GLOBAL/SESSION text label', () => {
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    expect(byTestId('command-band-label-global')).toBeNull()
    expect(byTestId('command-band-label-config')).toBeNull()
  })

  it('shows a NEUTRAL drop placeholder (not the GLOBAL/SESSION label) in an empty band during a drag', () => {
    COMMANDS = ALL.filter((c) => c.scope !== 'config')          // empty Session band
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    expect(byTestId('command-band-droptarget-config')).toBeNull()  // idle: nothing
    expect(byTestId('command-band-label-config')).toBeNull()       // label retired
    // Start dragging a global chip: onDragStart sets dragId, which reveals every
    // empty band's neutral drop placeholder as a drop target.
    const chip = allByTestId('command-chip')[0]
    expect(chip).toBeTruthy()
    act(() => {
      const ev = new Event('dragstart', { bubbles: true }) as any
      ev.dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' }
      chip!.dispatchEvent(ev)
    })
    // The drop zone is present, WORDLESS (no GLOBAL/SESSION text ever).
    const dz = byTestId('command-band-droptarget-config')
    expect(dz).not.toBeNull()
    expect(dz?.textContent).toBe('')
    expect(byTestId('command-band-label-config')).toBeNull()
  })

  it('draws no Session band at all when the session has no saved config', () => {
    // Ask Conductor, a resumed folder: there is no "this config" to scope to,
    // so the band does not exist -- the Global band still does.
    render({ configId: undefined, partnerEnabled: true, partnerSessionId: 's-1-partner' })
    expect(byTestId('command-band-global')).not.toBeNull()
    expect(byTestId('command-band-config')).toBeNull()
    expect(byTestId('command-band-label-config')).toBeNull()
  })
})

describe('scope and target are visible on the chip', () => {
  it('files each button in the band that IS its scope', () => {
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    const global = byTestId('command-band-global')!
    const session = byTestId('command-band-config')!
    expect(chipNamed('Prompt one', global)).toBeDefined()
    expect(chipNamed('Prompt one', session)).toBeUndefined()
    expect(chipNamed('Shell one', session)).toBeDefined()
    expect(chipNamed('Claude one', session)).toBeDefined()
    expect(chipNamed('Shell one', global)).toBeUndefined()
  })

  it('opens each cluster with a target mark that says where those buttons run', () => {
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    const session = byTestId('command-band-config')!
    // Session band holds one agent button and one partner button: two marks.
    const agentMark = byTestId('command-cluster-agent', session)
    const partnerMark = byTestId('command-cluster-partner', session)
    expect(agentMark?.getAttribute('title')).toBe('These run in Claude')
    expect(partnerMark?.getAttribute('title')).toBe('These run in the partner shell')
    // The Global band holds only a prompt: an agent mark, no partner mark.
    const global = byTestId('command-band-global')!
    expect(byTestId('command-cluster-agent', global)).not.toBeNull()
    expect(byTestId('command-cluster-partner', global)).toBeNull()
  })

  it('says in the tooltip which pane a button runs in, and what Global costs -- there is no dashed "global" chip', () => {
    render({ partnerEnabled: true, partnerSessionId: 's-1-partner' })
    expect(chipNamed('Shell one')?.getAttribute('title')).toContain('runs in the partner shell')
    expect(chipNamed('Claude one')?.getAttribute('title')).toContain('runs in the Claude terminal')
    expect(chipNamed('Prompt one')?.getAttribute('title')).toContain('Global — every config')
    expect(chipNamed('Claude one')?.getAttribute('title')).toContain('Session — this config only')
    // Scope is words in the tooltip, not a badge on the chip surface.
    expect(allByTestId('command-global-chip')).toHaveLength(0)
    expect(chipNamed('Prompt one')?.textContent).not.toContain('global')
  })
})
