// @vitest-environment jsdom
/**
 * SSH Persistent — a config launch ALWAYS starts a NEW session (finalized UX).
 *
 * The launch-time resume prompt that once sat in `useLaunchConfig` is GONE: a
 * manual launch of an SSH config never consults the detached-remote registry, so
 * a config with left-running remotes spawns a brand-new session with a FRESH id,
 * immediately, with nothing parked and nothing to dismiss. These tests fail if the
 * gate is ever reintroduced (a launch that does not reach `addSession`, or one
 * that reuses a registry entry's id).
 *
 * Resume itself is NOT dropped — it moved to its own surface, which reattaches
 * through `useLaunchSessionAction` with the remote's ORIGINAL id + reconnect. The
 * id-reuse plumbing that path depends on is pinned here too.
 */
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const addSession = vi.fn()
let liveSessions: { id: string }[] = []

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign((sel: any) => sel({ addSession, sessions: liveSessions }), {
    getState: () => ({ addSession, sessions: liveSessions }),
  }),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: Object.assign((sel: any) => sel({ settings: { codexEnabled: true } }), {
    getState: () => ({ settings: { codexEnabled: true } }),
  }),
}))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({
  markSessionForResumePicker: vi.fn(),
}))

import { useLaunchConfig, useLaunchSessionAction, buildLaunchSession } from '../../../src/renderer/hooks/useLaunchConfig'
import { useDetachedRemotesStore } from '../../../src/renderer/stores/detachedRemotesStore'

const sshCfg: any = {
  id: 'cfg-1',
  label: 'Pi',
  workingDirectory: '',
  color: '#fff',
  sessionType: 'ssh',
  provider: 'claude',
  sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work' },
}

const detEntry = (over: Record<string, unknown> = {}) => ({
  sessionId: 'det-1',
  configId: 'cfg-1',
  host: 'pi.local',
  username: 'mong',
  remotePath: '~/work',
  mux: 'tmux' as const,
  label: 'Pi',
  detachedAt: 1,
  ...over,
})

/** Render a throwaway harness that calls the hook once, and return whatever the
 *  call produced (the launched session, and the id the hook handed back). */
function launchWith(config: any): { session: any; returned: string } {
  let returned = ''
  function Harness() {
    const launch = useLaunchConfig()
    React.useEffect(() => { returned = launch(config) }, [])
    return null
  }
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  act(() => { root.render(React.createElement(Harness)) })
  const session = addSession.mock.calls[0]?.[0]
  act(() => { root.unmount() })
  return { session, returned }
}

/** The resume surface's path: the raw action, with reattach overrides. */
function reattachWith(config: any, opts: { sessionId?: string; reconnect?: boolean }): any {
  function Harness() {
    const launch = useLaunchSessionAction()
    React.useEffect(() => { launch(config, opts) }, [])
    return null
  }
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  act(() => { root.render(React.createElement(Harness)) })
  const session = addSession.mock.calls[0]?.[0]
  act(() => { root.unmount() })
  return session
}

beforeEach(() => {
  addSession.mockClear()
  liveSessions = []
  useDetachedRemotesStore.setState({ entries: [] })
})

describe('a config launch always starts a NEW session (no resume gate)', () => {
  it('spawns immediately — with a fresh id, not the detached one — when a matching remote is left running', () => {
    useDetachedRemotesStore.setState({ entries: [detEntry()] })
    const { session, returned } = launchWith(sshCfg)

    expect(addSession).toHaveBeenCalledTimes(1)
    expect(session.configId).toBe('cfg-1')
    // The whole point: NEW session, never the registry entry's id.
    expect(session.id).toBeTruthy()
    expect(session.id).not.toBe('det-1')
    expect(returned).toBe(session.id)
    // And nothing was pre-latched for reconnect — this is a fresh remote session.
    expect(session.sshReachedClaudeRunning).toBeUndefined()
  })

  it('spawns a NEW id even with SEVERAL matching left-running remotes', () => {
    useDetachedRemotesStore.setState({
      entries: [detEntry(), detEntry({ sessionId: 'det-2' }), detEntry({ sessionId: 'det-3' })],
    })
    const { session } = launchWith(sshCfg)

    expect(addSession).toHaveBeenCalledTimes(1)
    expect(['det-1', 'det-2', 'det-3']).not.toContain(session.id)
  })

  it('leaves the registry untouched — a launch neither consumes nor prunes an entry', () => {
    useDetachedRemotesStore.setState({ entries: [detEntry()] })
    launchWith(sshCfg)
    expect(useDetachedRemotesStore.getState().entries.map((e) => e.sessionId)).toEqual(['det-1'])
  })

  it('spawns straight through when the registry is empty', () => {
    const { session } = launchWith(sshCfg)
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(session.id).toBeTruthy()
  })

  it('spawns straight through when the only match is already live (app-restart path, unchanged)', () => {
    useDetachedRemotesStore.setState({ entries: [detEntry({ sessionId: 'restored-1' })] })
    liveSessions = [{ id: 'restored-1' }]
    const { session } = launchWith(sshCfg)
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(session.id).not.toBe('restored-1')
  })

  it('spawns a non-SSH config even when an entry shares its configId', () => {
    useDetachedRemotesStore.setState({ entries: [detEntry()] })
    launchWith({ ...sshCfg, sessionType: 'local', sshConfig: undefined })
    expect(addSession).toHaveBeenCalledTimes(1)
  })
})

describe('reattach plumbing kept for the resume surface', () => {
  it('reuses the given id and sets the reconnect latch', () => {
    const s = buildLaunchSession(sshCfg, { sessionId: 'orig-id', reconnect: true })
    expect(s?.id).toBe('orig-id')
    expect(s?.sshReachedClaudeRunning).toBe(true)
  })

  it('mints a fresh id and no reconnect latch for a plain launch', () => {
    const s = buildLaunchSession(sshCfg)
    expect(s?.id).not.toBe('orig-id')
    expect(s?.id).toBeTruthy()
    expect(s?.sshReachedClaudeRunning).toBeUndefined()
  })

  it('useLaunchSessionAction adds a session carrying the original id + reconnect', () => {
    useDetachedRemotesStore.setState({ entries: [detEntry()] })
    const session = reattachWith(sshCfg, { sessionId: 'det-1', reconnect: true })
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(session.id).toBe('det-1')
    expect(session.sshReachedClaudeRunning).toBe(true)
  })
})
