// @vitest-environment jsdom
/**
 * useRestartSession hook -- unit tests (P4 Task A)
 *
 * Verifies that restart() and recover() behave identically to the
 * inline functions previously in SessionHeader:
 *   1. restart() on a local non-shell session marks it for the resume picker
 *      and re-adds with status 'idle' and a fresh createdAt.
 *   2. restart(isShowingPartner=true) kills the partner PTY and calls
 *      clearSpawned on the partner ID.
 *   3. restart() is a no-op when session is null.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import type { Session } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// -- mocks ------------------------------------------------------------------

const killSessionPtyMock = vi.fn()
const clearSpawnedMock = vi.fn()
vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: (...args: unknown[]) => killSessionPtyMock(...args),
  clearSpawned: (...args: unknown[]) => clearSpawnedMock(...args),
  hasSpawned: vi.fn(() => false),
  markSpawned: vi.fn(),
}))

const markSessionForResumePickerMock = vi.fn()
vi.mock('../../../src/renderer/utils/resumePicker', () => ({
  markSessionForResumePicker: (...args: unknown[]) => markSessionForResumePickerMock(...args),
  shouldUseResumePicker: vi.fn(() => false),
}))

// pty.kill needs to be on window.electronAPI which is set by setup.ts -- but
// setup.ts doesn't include pty. We augment it here per-test-file.
const ptyKillMock = vi.fn()
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { kill: ptyKillMock },
}

// -- import hook after mocks ------------------------------------------------
const { useRestartSession } = await import('../../../src/renderer/hooks/useRestartSession')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const { listenForSpawnEnd } = await import('../../../src/renderer/utils/spawnEndNotice')

// -- helpers ----------------------------------------------------------------

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'test-sess-1',
  label: 'My Session',
  workingDirectory: 'C:/work',
  model: 'claude-sonnet',
  color: '#89B4FA',
  status: 'idle',
  createdAt: 1_000_000,
  sessionType: 'local',
  provider: 'claude',
  ...overrides,
})

// Tiny wrapper component that calls the hook and exposes actions via callbacks
// stored on the element's dataset so tests can invoke them synchronously.
function HookHarness({
  session,
  isShowingPartner,
  onMount,
}: {
  session: Session | null
  isShowingPartner?: boolean
  onMount: (actions: { restart: () => void; recover: () => void }) => void
}) {
  const actions = useRestartSession(session, isShowingPartner)
  React.useEffect(() => { onMount(actions) }, [actions, onMount])
  return null
}

// -- tests ------------------------------------------------------------------

describe('useRestartSession (P4 Task A)', () => {
  let container: HTMLDivElement
  let root: Root
  let capturedActions: { restart: () => void; recover: () => void } | null = null

  beforeEach(() => {
    // Reset store to a clean state
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
    killSessionPtyMock.mockReset()
    clearSpawnedMock.mockReset()
    ptyKillMock.mockReset()
    markSessionForResumePickerMock.mockReset()
    capturedActions = null

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  function renderHarness(session: Session | null, isShowingPartner = false) {
    act(() => {
      root.render(
        React.createElement(HookHarness, {
          session,
          isShowingPartner,
          onMount: (actions) => { capturedActions = actions },
        }),
      )
    })
  }

  // 1. restart() on a local non-shell session ---------------------------------

  it('restart() calls markSessionForResumePicker and re-adds session with status idle', () => {
    const session = makeSession({ sessionType: 'local', shellOnly: false })
    useSessionStore.getState().addSession(session)
    const before = Date.now()

    renderHarness(session)
    act(() => { capturedActions!.restart() })

    // resume picker was marked
    expect(markSessionForResumePickerMock).toHaveBeenCalledWith(session.id)

    // session exists in store with status idle and fresher createdAt
    const stored = useSessionStore.getState().sessions.find((s) => s.id === session.id)
    expect(stored).toBeDefined()
    expect(stored!.status).toBe('idle')
    expect(stored!.createdAt).toBeGreaterThanOrEqual(before)

    // stale telemetry fields cleared
    expect(stored!.contextPercent).toBeUndefined()
    expect(stored!.costUsd).toBeUndefined()
    expect(stored!.needsAttention).toBe(false)
    expect(stored!.modelName).toBeUndefined()
    expect(stored!.linesAdded).toBeUndefined()
    expect(stored!.linesRemoved).toBeUndefined()
    expect(stored!.inputTokens).toBeUndefined()
    expect(stored!.outputTokens).toBeUndefined()
    expect(stored!.totalDurationMs).toBeUndefined()
    expect(stored!.rateLimitCurrent).toBeUndefined()
    expect(stored!.rateLimitCurrentResets).toBeUndefined()
    expect(stored!.rateLimitWeekly).toBeUndefined()
    expect(stored!.rateLimitWeeklyResets).toBeUndefined()
    expect(stored!.rateLimitExtra).toBeUndefined()
    expect(stored!.usageBuckets).toBeUndefined()
  })

  // 1b. Regression (Fable usage): a hit per-model limit must not linger across
  //     the remount that a mid-session account switch also routes through.
  it("restart() clears usageBuckets so a prior account's hit limit does not linger", () => {
    const session = makeSession({
      sessionType: 'local',
      shellOnly: false,
      usageBuckets: [
        { key: 'weekly:Fable', label: 'Fable', group: 'weekly', percent: 100, resetsAt: '', severity: 'critical' },
      ],
    })
    useSessionStore.getState().addSession(session)

    renderHarness(session)
    act(() => { capturedActions!.restart() })

    const stored = useSessionStore.getState().sessions.find((s) => s.id === session.id)
    expect(stored).toBeDefined()
    expect(stored!.usageBuckets).toBeUndefined()
  })

  it('restart() does NOT call markSessionForResumePicker for shell sessions', () => {
    const session = makeSession({ sessionType: 'local', shellOnly: true })
    useSessionStore.getState().addSession(session)

    renderHarness(session)
    act(() => { capturedActions!.restart() })

    expect(markSessionForResumePickerMock).not.toHaveBeenCalled()
  })

  // 2. restart() with isShowingPartner=true ------------------------------------

  it('restart(isShowingPartner=true) kills only the partner PTY and calls clearSpawned on partner', () => {
    const session = makeSession()
    useSessionStore.getState().addSession(session)

    renderHarness(session, true)
    act(() => { capturedActions!.restart() })

    const partnerId = session.id + '-partner'
    expect(ptyKillMock).toHaveBeenCalledWith(partnerId)
    expect(clearSpawnedMock).toHaveBeenCalledWith(partnerId)
    // killSessionPty (which also kills main) must NOT be called
    expect(killSessionPtyMock).not.toHaveBeenCalled()
    // resume picker must NOT be marked for partner-only restart
    expect(markSessionForResumePickerMock).not.toHaveBeenCalled()
  })

  // 2b. T8b: persisted resumeUuid/resumeCwd survive the forceRemount merge -----

  it('restart() preserves a persisted resumeUuid/resumeCwd through the remount merge', () => {
    const session = makeSession({
      sessionType: 'local',
      shellOnly: false,
      resumeUuid: 'persisted-uuid',
      resumeCwd: 'F:/wt',
    })
    useSessionStore.getState().addSession(session)

    renderHarness(session)
    act(() => { capturedActions!.restart() })

    const stored = useSessionStore.getState().sessions.find((s) => s.id === session.id)
    expect(stored).toBeDefined()
    // The fields round-trip through removeSession + addSession (...session merge).
    expect(stored!.resumeUuid).toBe('persisted-uuid')
    expect(stored!.resumeCwd).toBe('F:/wt')
  })

  // 2c. Walk fix W4: a Restart of a tab whose launch started nothing is a launch
  //     of its config, so it passes the Multi Spawn one-at-a-time rule. -------

  describe('a Restart of a Not started tab passes the Multi Spawn rule', () => {
    const cfg = (over: Record<string, unknown> = {}): any => ({ id: 'cfg-1', label: 'Web App', workingDirectory: 'C:/w', color: '', sessionType: 'local', provider: 'claude', ...over })
    const notStarted = makeSession({ id: 'old', configId: 'cfg-1', neverStarted: true, ptyExited: true })
    const running = makeSession({ id: 'new', configId: 'cfg-1' })
    const listen = (id: string) => {
      const heard: Array<string | null> = []
      return { heard, stop: listenForSpawnEnd(id, (l) => { heard.push(l) }) }
    }
    afterEach(() => { useConfigStore.setState({ configs: [] }) })

    it('its config now running elsewhere and not Multi Spawn: nothing is killed or remounted, the tab stays Not started and says why', () => {
      useConfigStore.setState({ configs: [cfg()] })
      useSessionStore.getState().addSession(notStarted)
      useSessionStore.getState().addSession(running)
      const view = listen('old')
      renderHarness(notStarted)
      act(() => { capturedActions!.restart() })
      act(() => { capturedActions!.recover() })
      view.stop()
      expect(killSessionPtyMock).not.toHaveBeenCalled()
      expect(ptyKillMock).not.toHaveBeenCalled()
      const stored = useSessionStore.getState().sessions.find((s) => s.id === 'old')!
      expect(stored.neverStarted).toBe(true)
      expect(stored.createdAt).toBe(1_000_000)
      const line = "\r\n\x1b[90mNot started: Web App is already running. It isn't a Multi Spawn config, so it runs one at a time.\x1b[0m"
      expect(view.heard).toEqual([line, line])
    })

    it('walk fix X3: restarting its PARTNER terminal goes ahead; the main tab keeps its Not started flag for the remounted view to check', () => {
      useConfigStore.setState({ configs: [cfg()] })
      useSessionStore.getState().addSession(notStarted)
      useSessionStore.getState().addSession(running)
      const view = listen('old')
      renderHarness(notStarted, true)
      act(() => { capturedActions!.restart() })
      view.stop()
      // The partner restarts: its PTY is killed and the views remount.
      expect(ptyKillMock).toHaveBeenCalledWith('old-partner')
      expect(clearSpawnedMock).toHaveBeenCalledWith('old-partner')
      const after = useSessionStore.getState().sessions.find((s) => s.id === 'old')!
      expect(after.createdAt).toBeGreaterThan(1_000_000)
      // The main tab is neither killed nor started here, and stays Not started:
      // the remounted main view refuses to start it (terminalview-account-launch).
      expect(killSessionPtyMock).not.toHaveBeenCalled()
      expect(after.neverStarted).toBe(true)
      expect(view.heard).toEqual([])
    })

    it('a Multi Spawn config, or nothing of it running: the Restart goes ahead and the flag goes', () => {
      for (const [configs, others] of [[[cfg({ allowMultiSpawn: true })], [running]], [[cfg()], []]] as const) {
        useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
        killSessionPtyMock.mockReset()
        useConfigStore.setState({ configs: [...configs] })
        useSessionStore.getState().addSession(notStarted)
        for (const s of others) useSessionStore.getState().addSession(s)
        renderHarness(notStarted)
        act(() => { capturedActions!.restart() })
        expect(killSessionPtyMock).toHaveBeenCalledWith('old')
        expect(useSessionStore.getState().sessions.find((s) => s.id === 'old')!.neverStarted).toBeUndefined()
      }
    })

    it('a tab that started is its config\'s running copy: its Restart only replaces it, as before', () => {
      useConfigStore.setState({ configs: [cfg()] })
      useSessionStore.getState().addSession(running)
      renderHarness(running)
      act(() => { capturedActions!.restart() })
      expect(killSessionPtyMock).toHaveBeenCalledWith('new')
    })
  })

  // 3. no-op when session is null ---------------------------------------------

  it('restart() is a no-op (no throws, no side-effects) when session is null', () => {
    renderHarness(null)
    expect(() => {
      act(() => { capturedActions!.restart() })
    }).not.toThrow()

    expect(ptyKillMock).not.toHaveBeenCalled()
    expect(killSessionPtyMock).not.toHaveBeenCalled()
    expect(clearSpawnedMock).not.toHaveBeenCalled()
    expect(markSessionForResumePickerMock).not.toHaveBeenCalled()
  })
})
