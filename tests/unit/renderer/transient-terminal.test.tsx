// @vitest-environment jsdom
/**
 * WP2 commit 6e: the "Run in a terminal" tab runs its confirmed command ONCE.
 *
 * openCommandTerminal marks its tab `transient`:
 *   - it is never in the saved session set, so the next launch cannot resume
 *     it and run the command again (nor is it saved as the active session);
 *   - a Restart re-adds it WITHOUT the command (a plain shell), even from a
 *     captured record that still carries it; a saved terminal-only config
 *     keeps its command, which is configuration.
 * (TerminalView's consumption at the first spawn is pinned in
 * terminalview-account-launch.test.tsx.)
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: vi.fn(),
  clearSpawned: vi.fn(),
  hasSpawned: vi.fn(() => false),
  markSpawned: vi.fn(),
}))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({
  markSessionForResumePicker: vi.fn(),
  shouldUseResumePicker: vi.fn(() => false),
}))
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, pty: { kill: vi.fn() } }

const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
type Session = import('../../../src/renderer/stores/sessionStore').Session
const { buildSessionState } = await import('../../../src/renderer/session-persistence')
const { openCommandTerminal, spentCommand } = await import('../../../src/renderer/utils/commandTerminal')
const { useRestartSession } = await import('../../../src/renderer/hooks/useRestartSession')

const CMD = 'npm install -g @openai/codex'

const project = (over: Partial<Session> = {}): Session => ({
  id: 'proj-1', configId: 'cfg-1', label: 'api', workingDirectory: 'C:/proj', model: '', color: '#89B4FA',
  status: 'idle', createdAt: 1, sessionType: 'local', provider: 'claude', ...over,
})

let container: HTMLDivElement
let root: Root
let restart: (() => void) | null = null

function Harness({ session }: { session: Session }) {
  const actions = useRestartSession(session)
  React.useEffect(() => { restart = () => actions.restart() }, [actions])
  return null
}

beforeEach(() => {
  useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  restart = null
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the install tab is transient', () => {
  it('openCommandTerminal marks it transient, with the command, and makes it active', () => {
    const id = openCommandTerminal({ label: 'Install Codex', command: CMD })
    const s = useSessionStore.getState().sessions.find((x) => x.id === id)!
    expect(s.transient).toBe(true)
    expect(s.shellOnly).toBe(true)
    // noCommandSecrets: the install script it runs never sees the user's
    // command-button secrets (install-tab-command-secrets.test.ts).
    expect(s.terminalOptions).toEqual({ command: CMD, elevated: false, noCommandSecrets: true })
    expect(useSessionStore.getState().activeSessionId).toBe(id)
  })

  it('is never in the saved sessions, and is never saved as the active one', () => {
    useSessionStore.getState().addSession(project())
    const id = openCommandTerminal({ label: 'Install Codex', command: CMD })
    const saved = buildSessionState()
    expect(saved.sessions.map((s) => s.id)).toEqual(['proj-1'])
    expect(JSON.stringify(saved)).not.toContain(CMD)
    expect(useSessionStore.getState().activeSessionId).toBe(id)
    expect(saved.activeSessionId).toBe('proj-1')
  })

  it('alone, it leaves nothing to restore', () => {
    openCommandTerminal({ label: 'Install Codex', command: CMD })
    const saved = buildSessionState()
    expect(saved.sessions).toEqual([])
    expect(saved.activeSessionId).toBeNull()
  })

  it('an ordinary terminal-only session is still saved with its command', () => {
    useSessionStore.getState().addSession(project({ shellOnly: true, terminalOptions: { command: 'npm run dev' } }))
    expect(buildSessionState().sessions[0].terminalOptions).toEqual({ command: 'npm run dev' })
  })
})

describe('a Restart does not run the command again', () => {
  it('re-adds the tab as a plain shell, even from a captured record that still has the command', () => {
    const id = openCommandTerminal({ label: 'Install Codex', command: CMD })
    const captured = useSessionStore.getState().sessions.find((x) => x.id === id)!
    act(() => { root.render(<Harness session={captured} />) })
    act(() => { restart!() })
    const after = useSessionStore.getState().sessions.find((x) => x.id === id)!
    expect(after.terminalOptions?.command).toBeUndefined()
    expect(after.terminalOptions).toEqual({ elevated: false, noCommandSecrets: true })
    expect(after.shellOnly).toBe(true)
    expect(after.transient).toBe(true)
  })

  it('a saved terminal-only config keeps its command across a Restart', () => {
    const s = project({ shellOnly: true, terminalOptions: { command: 'npm run dev' } })
    useSessionStore.getState().addSession(s)
    act(() => { root.render(<Harness session={s} />) })
    act(() => { restart!() })
    expect(useSessionStore.getState().sessions[0].terminalOptions).toEqual({ command: 'npm run dev' })
  })

  it('spentCommand drops only the command', () => {
    expect(spentCommand({ command: CMD, elevated: false, args: '-x' })).toEqual({ elevated: false, args: '-x' })
    expect(spentCommand(undefined)).toBeUndefined()
    const none = { elevated: false }
    expect(spentCommand(none)).toBe(none)
  })
})
