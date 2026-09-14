// @vitest-environment jsdom
/**
 * #501: the Artifacts core-tool button in the command bar. It opens the current
 * account's artifacts via the existing accountWeb.openArtifacts IPC (the Sidebar's
 * per-session action), and appears for a non-shell Claude session that resolves
 * to an account profile — a LOCAL session's own/primary profile, or an SSH
 * session's mapped local profile (harmonise-remote: the remote's reported email
 * matched to a local profile, with the launch profileId standing in only until
 * the remote identity arrives).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The session under test — overwritten per test before render.
let SESSION: Record<string, unknown> = {}
let PROFILES: Array<Record<string, unknown>> = []

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: [SESSION], activeSessionId: SESSION.id, updateSession: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel({ profiles: PROFILES }),
}))
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    commands: [], sections: [],
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
const trackUsage = vi.fn()
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: (...a: unknown[]) => trackUsage(...a) }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/LogsButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/PasteHint', () => ({ default: () => null }))

const openArtifacts = vi.fn(() => Promise.resolve({ ok: true as const }))
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: { write: vi.fn() },
  accountWeb: { openArtifacts },
}
;(globalThis as any).window.alert = vi.fn()

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  openArtifacts.mockClear(); trackUsage.mockClear()
  PROFILES = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})
const render = () => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg' } as never)) })
}
const artifactsBtn = () => container.querySelector('[data-testid="artifacts-open"]') as HTMLButtonElement | null

describe('#501 Artifacts command-bar button', () => {
  it('renders for a local, non-shell session with a profile and opens that account on click', () => {
    SESSION = { id: 's-1', label: 't', workingDirectory: '/', sessionType: 'local', provider: 'claude', profileId: 'prof-1' }
    render()
    const b = artifactsBtn()
    expect(b).not.toBeNull()
    expect(b!.textContent).toContain('Artifacts')
    act(() => { b!.click() })
    expect(openArtifacts).toHaveBeenCalledWith('prof-1')
    expect(trackUsage).toHaveBeenCalledWith('artifacts.opened')
  })

  it('falls back to the primary profile when the session has none', () => {
    SESSION = { id: 's-1', label: 't', workingDirectory: '/', sessionType: 'local', provider: 'claude' }
    PROFILES = [{ id: 'prim', isPrimary: true }, { id: 'other', isPrimary: false }]
    render()
    act(() => { artifactsBtn()!.click() })
    expect(openArtifacts).toHaveBeenCalledWith('prim')
  })

  it('is hidden for a shell-only session', () => {
    SESSION = { id: 's-1', label: 't', workingDirectory: '/', sessionType: 'local', provider: 'claude', profileId: 'prof-1', shellOnly: true }
    render()
    expect(artifactsBtn()).toBeNull()
  })

  it('is hidden for a session with no resolvable profile', () => {
    SESSION = { id: 's-1', label: 't', workingDirectory: '/', sessionType: 'local', provider: 'claude' }
    PROFILES = [] // no primary either
    render()
    expect(artifactsBtn()).toBeNull()
  })

  it('renders for an SSH session whose reported remote account maps to a local profile, and opens THAT profile', () => {
    SESSION = { id: 's-1', label: 't', workingDirectory: '/', sessionType: 'ssh', provider: 'claude', accountEmail: 'me@work.co' }
    PROFILES = [{ id: 'prof-1', accountEmail: 'me@work.co' }]
    render()
    const b = artifactsBtn()
    expect(b).not.toBeNull()
    act(() => { b!.click() })
    expect(openArtifacts).toHaveBeenCalledWith('prof-1')
  })

  it('renders for a fresh SSH session via the launch profileId before the remote identity arrives', () => {
    SESSION = { id: 's-1', label: 't', workingDirectory: '/', sessionType: 'ssh', provider: 'claude', profileId: 'prof-1' }
    PROFILES = [{ id: 'prof-1' }]
    render()
    const b = artifactsBtn()
    expect(b).not.toBeNull()
    act(() => { b!.click() })
    expect(openArtifacts).toHaveBeenCalledWith('prof-1')
  })

  it('is hidden for an SSH session whose KNOWN remote account matches no local profile — even with a launch profileId', () => {
    SESSION = { id: 's-1', label: 't', workingDirectory: '/', sessionType: 'ssh', provider: 'claude', accountEmail: 'stranger@nowhere.dev', profileId: 'prof-1' }
    PROFILES = [{ id: 'prof-1', accountEmail: 'me@work.co' }]
    render()
    expect(artifactsBtn()).toBeNull()
  })

  it('is hidden for an unmapped SSH session (no remote identity, no launch profile)', () => {
    SESSION = { id: 's-1', label: 't', workingDirectory: '/', sessionType: 'ssh', provider: 'claude' }
    PROFILES = [{ id: 'prof-1', accountEmail: 'me@work.co' }]
    render()
    expect(artifactsBtn()).toBeNull()
  })
})
