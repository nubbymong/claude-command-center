// @vitest-environment jsdom
/**
 * T8b (bug #5): resumeUuid/resumeCwd serialize through buildSessionState and the
 * async enrichment (buildSessionStateWithResumeTargets) refreshes them from the
 * live binder via IPC — fail-safe when IPC is absent or throws.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import {
  buildSessionState,
  buildSessionStateWithResumeTargets,
} from '../../../src/renderer/session-persistence'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-resume-1',
  label: 'test',
  workingDirectory: 'C:/work',
  model: '',
  color: '#89B4FA',
  status: 'idle',
  createdAt: 1714850000000,
  sessionType: 'local',
  provider: 'claude',
  ...overrides,
})

function setApi(getResumeTarget?: (id: string) => Promise<{ uuid: string; cwd: string } | null>) {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(globalThis as any).window.electronAPI = {
    ...((globalThis as any).window?.electronAPI ?? {}),
    logsdb: getResumeTarget ? { getResumeTarget } : {},
  }
}

describe('session-persistence — resumeUuid/resumeCwd (T8b)', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
  })

  it('buildSessionState serializes resumeUuid/resumeCwd from the store record', () => {
    useSessionStore.setState({
      sessions: [makeSession({ resumeUuid: 'uuid-abc', resumeCwd: 'F:/wt' })],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect(state.sessions[0].resumeUuid).toBe('uuid-abc')
    expect(state.sessions[0].resumeCwd).toBe('F:/wt')
  })

  it('buildSessionState serializes the custom work name (survives restart by id)', () => {
    useSessionStore.setState({
      sessions: [makeSession({ customName: 'IM-8315 keychain fix' })],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect(state.sessions[0].id).toBe('sess-resume-1')
    expect(state.sessions[0].customName).toBe('IM-8315 keychain fix')
    expect(state.sessions[0].label).toBe('test') // origin preserved alongside
  })

  it('omits customName when unset (sparse)', () => {
    useSessionStore.setState({
      sessions: [makeSession()],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    expect(buildSessionState().sessions[0].customName).toBeUndefined()
  })

  it('omits the fields when unset (sparse)', () => {
    useSessionStore.setState({
      sessions: [makeSession()],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect(state.sessions[0].resumeUuid).toBeUndefined()
    expect(state.sessions[0].resumeCwd).toBeUndefined()
  })

  it('enrichment overwrites the persisted target with the live binder value', async () => {
    setApi(async () => ({ uuid: 'live-uuid', cwd: 'F:/live/wt' }))
    useSessionStore.setState({
      sessions: [makeSession({ resumeUuid: 'stale', resumeCwd: 'F:/stale' })],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    const state = await buildSessionStateWithResumeTargets()
    expect(state.sessions[0].resumeUuid).toBe('live-uuid')
    expect(state.sessions[0].resumeCwd).toBe('F:/live/wt')
  })

  it('keeps the existing record when the binder returns null', async () => {
    setApi(async () => null)
    useSessionStore.setState({
      sessions: [makeSession({ resumeUuid: 'keep', resumeCwd: 'F:/keep' })],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    const state = await buildSessionStateWithResumeTargets()
    expect(state.sessions[0].resumeUuid).toBe('keep')
    expect(state.sessions[0].resumeCwd).toBe('F:/keep')
  })

  it('is fail-safe when getResumeTarget throws (keeps record, no throw)', async () => {
    setApi(async () => {
      throw new Error('IPC down')
    })
    useSessionStore.setState({
      sessions: [makeSession({ resumeUuid: 'keep', resumeCwd: 'F:/keep' })],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    const state = await buildSessionStateWithResumeTargets()
    expect(state.sessions[0].resumeUuid).toBe('keep')
  })

  it('skips shell-only sessions (no binder, no IPC call)', async () => {
    const spy = vi.fn(async () => ({ uuid: 'x', cwd: 'y' }))
    setApi(spy)
    useSessionStore.setState({
      sessions: [makeSession({ shellOnly: true })],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    await buildSessionStateWithResumeTargets()
    expect(spy).not.toHaveBeenCalled()
  })

  it('skips non-Claude (codex) sessions', async () => {
    const spy = vi.fn(async () => ({ uuid: 'x', cwd: 'y' }))
    setApi(spy)
    useSessionStore.setState({
      sessions: [makeSession({ provider: 'codex' })],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    await buildSessionStateWithResumeTargets()
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns the plain state when logsdb.getResumeTarget is unavailable', async () => {
    setApi(undefined)
    useSessionStore.setState({
      sessions: [makeSession({ resumeUuid: 'r', resumeCwd: 'F:/r' })],
      activeSessionId: 'sess-resume-1',
      isRestoring: false,
    })
    const state = await buildSessionStateWithResumeTargets()
    expect(state.sessions[0].resumeUuid).toBe('r')
  })
})
