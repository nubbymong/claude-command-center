// @vitest-environment jsdom
/**
 * The two UI invariants that make an Ask session read as the app answering
 * rather than as one of your projects:
 *
 *  - its tab carries the app monogram in place of the identity dot, in BOTH the
 *    normal and the inline-rename branch (the dot was duplicated across the two
 *    before this, which is exactly how they drift apart); and
 *  - a restart clears the one-shot opening question, so restarting an Ask
 *    session does not re-submit whatever you first typed. `forceRemount` merges
 *    the captured session over the live one, so the field survives unless it is
 *    explicitly cleared.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/components/TerminalView', () => ({ killSessionPty: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))
vi.mock('../../../src/renderer/ptyTracker', () => ({ killSessionPty: vi.fn(), clearSpawned: vi.fn() }))

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))

const { default: TabBar } = await import('../../../src/renderer/components/TabBar')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useRestartSession } = await import('../../../src/renderer/hooks/useRestartSession')
const { default: AskConductorDock } = await import('../../../src/renderer/components/sidebar/AskConductorDock')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useTipsStore } = await import('../../../src/renderer/stores/tipsStore')
const askConductor = await import('../../../src/renderer/lib/askConductor')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'API Refactor', workingDirectory: '/x', model: 'opus',
    color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local', ...over,
  } as Session
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(globalThis as any).window.electronAPI = { pty: { kill: vi.fn() } }
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const render = () => act(() => {
  root.render(
    <TabBar activeView="sessions" openPageTabs={[]} onActivateSession={() => {}} onActivatePage={() => {}} onClosePage={() => {}} />,
  )
})

describe('TabBar -- the Ask Conductor tab glyph', () => {
  it('renders the monogram, not an identity dot, for a kind:"ask" session', () => {
    useSessionStore.setState({
      sessions: [makeSession({ id: 'ask', label: 'Ask Conductor', kind: 'ask' })],
      activeSessionId: 'ask',
      renamingSessionId: null,
    })
    render()
    // The monogram is the only <svg> inside a session tab; a plain session has
    // a <span class="rounded-full"> there instead.
    expect(container.querySelector('[data-testid="session-tab"] svg')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-tab"] span.rounded-full')).toBeNull()
  })

  it('keeps the monogram while the tab is being renamed inline', () => {
    useSessionStore.setState({
      sessions: [makeSession({ id: 'ask', label: 'Ask Conductor', kind: 'ask' })],
      activeSessionId: 'ask',
      renamingSessionId: 'ask',
    })
    render()
    expect(container.querySelector('input')).not.toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('span.rounded-full')).toBeNull()
  })

  it('still renders the identity dot for an ordinary session', () => {
    useSessionStore.setState({
      sessions: [makeSession()],
      activeSessionId: 's1',
      renamingSessionId: null,
    })
    render()
    expect(container.querySelector('[data-testid="session-tab"] span.rounded-full')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-tab"] svg')).toBeNull()
  })
})

// [host] WP2 PR 4, P4.3: the dock row's type badge while both assistants are
// on, and the carrier's one-line notices (main raises them; the dock draws
// them and keeps the question a not-delivered one is about).
describe('the Ask Conductor dock row (P4.3)', () => {
  const BOTH = { claudeEnabled: true, codexEnabled: true, codexAnswered: true }
  const q = (id: string) => container.querySelector(`[data-ux-id="${id}"]`)
  let noticeCb: ((n: unknown) => void) | null = null
  const handOff = vi.fn()

  beforeEach(() => {
    noticeCb = null
    askConductor._resetAskNoticesForTest()
    askConductor._resetAskLaunchForTest()
    ;(globalThis as any).window.electronAPI = {
      pty: { kill: vi.fn(), write: vi.fn() },
      help: { workspace: () => Promise.resolve('C:/res/help') },
      askConductor: { handOff, onNotice: (cb: (n: unknown) => void) => { noticeCb = cb; return () => { noticeCb = null } } },
    }
    useSessionStore.setState({ sessions: [], activeSessionId: null, renamingSessionId: null })
    useTipsStore.setState({ currentTipId: null, silencedUntilRestart: false, isLoaded: true } as any)
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, showAskConductor: true } })
  })
  afterEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    askConductor._resetAskNoticesForTest()
  })

  const renderDock = (collapsed = false) => act(() => {
    root.render(<AskConductorDock onOpened={() => {}} isActive={false} collapsed={collapsed} />)
  })
  const badge = () => q('sidebar-ask-type-badge')

  it('one assistant on: no badge, whichever it is', () => {
    for (const on of [{}, { claudeEnabled: false, codexEnabled: true, codexAnswered: true }]) {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...on } })
      renderDock()
      expect(badge(), JSON.stringify(on)).toBeNull()
    }
  })

  it('both on: the badge of the assistant the next start uses -- Claude Code by default, Codex when chosen', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...BOTH } })
    renderDock()
    expect(badge()!.querySelector('[data-testid="type-badge-claude"]')).not.toBeNull()
    act(() => { useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...BOTH, askConductorProvider: 'codex' } }) })
    expect(badge()!.querySelector('[data-testid="type-badge-claude"]')).toBeNull()
    expect(badge()!.querySelector('[data-testid="type-badge-codex"]')).not.toBeNull()
  })

  it('both on, Codex chosen, then Codex off: no badge, and the saved choice is not rewritten', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...BOTH, askConductorProvider: 'codex', codexEnabled: false } })
    renderDock()
    expect(badge()).toBeNull()
    expect(useSettingsStore.getState().settings.askConductorProvider).toBe('codex')
  })

  it('both on, an open tab: the badge is that tab\'s assistant (it keeps the one it started on)', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...BOTH, askConductorProvider: 'codex' } })
    useSessionStore.setState({ sessions: [{ id: 'ask', kind: 'ask', label: 'Ask Conductor', workingDirectory: 'C:/res/help', model: '', color: '', status: 'idle', createdAt: 1, sessionType: 'local', provider: 'claude' } as never] })
    renderDock()
    expect(badge()!.querySelector('[data-testid="type-badge-claude"]')).not.toBeNull()
  })

  it('Codex only: the row is live, not greyed, and says nothing about being off', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true, codexAnswered: true } })
    renderDock()
    expect(q('sidebar-ask-pill')!.getAttribute('aria-disabled')).toBeNull()
    expect(q('sidebar-ask-off')).toBeNull()
  })

  it('neither on: the row is greyed and says why', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false } })
    renderDock()
    expect(q('sidebar-ask-pill')!.getAttribute('aria-disabled')).toBe('true')
    expect(q('sidebar-ask-off')!.textContent).toBe('Ask Conductor runs on Claude Code or Codex, and both are off. Turn one on in Settings, Accounts.')
  })

  it('the removal notice from main: one line saying how many were removed, and Dismiss', () => {
    renderDock()
    expect(noticeCb, 'the dock listens for main\'s notices').not.toBeNull()
    act(() => { noticeCb!({ sessionId: 'ask', kind: 'removed', count: 2 }) })
    expect(q('sidebar-ask-notice-line')!.textContent).toBe('Codex cannot take emoji or some rare characters typed into its prompt; 2 removed from your question.')
    expect(q('sidebar-ask-notice-send')).toBeNull()
    act(() => { (q('sidebar-ask-notice-dismiss') as HTMLButtonElement).click() })
    expect(q('sidebar-ask-notice')).toBeNull()
  })

  it('not delivered: says it was not sent and why, KEEPS the question, and Send again hands it over again', async () => {
    useSessionStore.setState({ sessions: [{ id: 'ask', kind: 'ask', label: 'Ask Conductor', workingDirectory: 'C:/res/help', model: '', color: '', status: 'idle', createdAt: 1, sessionType: 'local', provider: 'claude' } as never] })
    renderDock()
    await act(async () => { await askConductor.launchAskConductor('how do I hide tips?') })
    const write = (globalThis as any).window.electronAPI.pty.write as ReturnType<typeof vi.fn>
    write.mockClear()
    act(() => { noticeCb!({ sessionId: 'ask', kind: 'not-delivered', reason: 'prompt-on-screen' }) })
    expect(q('sidebar-ask-notice-line')!.textContent).toBe('Your question was not sent: Codex was showing a question of its own (folder trust, sandbox setup or an approval). Answer it in the Ask tab first.')
    expect(q('sidebar-ask-notice-question')!.textContent).toBe('"how do I hide tips?"')
    await act(async () => { (q('sidebar-ask-notice-send') as HTMLButtonElement).click() })
    expect(write).toHaveBeenCalledWith('ask', 'how do I hide tips?\r')
    expect(q('sidebar-ask-notice')).toBeNull()
  })

  it('a notice about another session, or one main could not have sent, keeps no question / is not drawn', () => {
    renderDock()
    act(() => { noticeCb!({ sessionId: 'other', kind: 'not-delivered', reason: 'too-tall' }) })
    expect(q('sidebar-ask-notice-line')!.textContent).toContain('too long to check')
    expect(q('sidebar-ask-notice-question')).toBeNull()
    expect(q('sidebar-ask-notice-send')).toBeNull()
    act(() => { askConductor.useAskNoticeStore.getState().dismiss() })
    for (const bad of [null, 'x', { sessionId: 'a', kind: 'removed', count: 0 }, { sessionId: 'a', kind: 'removed', count: 1.5 }, { sessionId: 'a', kind: 'not-delivered', reason: 'toString' }, { sessionId: '', kind: 'removed', count: 1 }, { sessionId: 'a', kind: 'other' }]) {
      act(() => { noticeCb!(bad) })
      expect(q('sidebar-ask-notice'), JSON.stringify(bad)).toBeNull()
    }
  })

  it('collapsed rail: the notice rides the pill\'s tooltip', () => {
    renderDock(true)
    act(() => { noticeCb!({ sessionId: 'ask', kind: 'removed', count: 1 }) })
    expect(q('sidebar-ask-pill')!.getAttribute('title')).toContain('1 removed from your question.')
  })
})

describe('useRestartSession -- the one-shot question', () => {
  function restartOf(session: Session) {
    let restart: () => void = () => {}
    function Harness() {
      restart = useRestartSession(session).restart
      return null
    }
    const c = document.createElement('div')
    const r = createRoot(c)
    act(() => { r.render(React.createElement(Harness)) })
    act(() => { restart() })
    act(() => { r.unmount() })
  }

  it('clears askPrompt so a restart does not re-submit the opening question', () => {
    const session = makeSession({ id: 'ask', kind: 'ask', askPrompt: 'why is my terminal blank?' })
    useSessionStore.setState({ sessions: [session], activeSessionId: 'ask', renamingSessionId: null })
    restartOf(session)
    const after = useSessionStore.getState().sessions.find((s) => s.id === 'ask')
    expect(after).toBeDefined()
    expect(after!.askPrompt).toBeUndefined()
    // The session itself must survive the restart intact as an Ask session.
    expect(after!.kind).toBe('ask')
  })
})
