// @vitest-environment jsdom
/**
 * SSH Persistent — the manual-launch resume GATE (Phase 2) and id-reuse (Phase 3).
 *
 * A manual launch of an SSH config that has a matching left-running remote must
 * open the resume prompt instead of spawning; a launch with no match (or one
 * whose only match is already live — the app-restart case) must spawn straight
 * through exactly as before. Resume reuses the entry's ORIGINAL id + reconnect.
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

import { useLaunchConfig, buildLaunchSession } from '../../../src/renderer/hooks/useLaunchConfig'
import { useDetachedRemotesStore } from '../../../src/renderer/stores/detachedRemotesStore'
import { useResumeLaunchStore } from '../../../src/renderer/stores/resumeLaunchStore'

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

function launchWith(config: any): void {
  function Harness() {
    const launch = useLaunchConfig()
    React.useEffect(() => { launch(config) }, [])
    return null
  }
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  act(() => { root.render(React.createElement(Harness)) })
  act(() => { root.unmount() })
}

beforeEach(() => {
  addSession.mockClear()
  liveSessions = []
  useDetachedRemotesStore.setState({ entries: [] })
  useResumeLaunchStore.setState({ pending: null })
})

describe('buildLaunchSession id reuse (Phase 3)', () => {
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
})

describe('resume gate on manual launch', () => {
  it('opens the resume prompt (does NOT spawn) when a matching remote is left running', () => {
    useDetachedRemotesStore.setState({ entries: [detEntry()] })
    launchWith(sshCfg)
    expect(addSession).not.toHaveBeenCalled()
    const pending = useResumeLaunchStore.getState().pending
    expect(pending?.config.id).toBe('cfg-1')
    expect(pending?.entries.map((e) => e.sessionId)).toEqual(['det-1'])
  })

  it('spawns straight through — no prompt — when the only match is already live (app-restart path)', () => {
    // The detached id came back as a restored, live session: it must be filtered
    // out, so restore never triggers the prompt.
    useDetachedRemotesStore.setState({ entries: [detEntry({ sessionId: 'restored-1' })] })
    liveSessions = [{ id: 'restored-1' }]
    launchWith(sshCfg)
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(useResumeLaunchStore.getState().pending).toBeNull()
  })

  it('spawns straight through when the registry is empty', () => {
    launchWith(sshCfg)
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(useResumeLaunchStore.getState().pending).toBeNull()
  })

  it('never prompts for a non-SSH config even when an entry shares its id (SSH-only)', () => {
    useDetachedRemotesStore.setState({ entries: [detEntry()] })
    launchWith({ ...sshCfg, sessionType: 'local', sshConfig: undefined })
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(useResumeLaunchStore.getState().pending).toBeNull()
  })
})
