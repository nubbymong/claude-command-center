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

const { default: TabBar } = await import('../../../src/renderer/components/TabBar')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useRestartSession } = await import('../../../src/renderer/hooks/useRestartSession')
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
