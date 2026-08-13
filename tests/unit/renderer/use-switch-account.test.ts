// @vitest-environment jsdom
/**
 * useSwitchAccount hook + shouldSwitch guard -- unit tests.
 *
 * Verifies the locked "switch = respawn + resume" design:
 *   - shouldSwitch is a no-op only when current === next (undefined-safe).
 *   - switchAccount sets the new profileId on the session BEFORE respawning,
 *     and reuses the existing Restart path (which marks the resume picker).
 *   - switching to the session's current account is a no-op (no store write,
 *     no PTY teardown).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import type { Session } from '../../../src/renderer/stores/sessionStore'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'
import { shouldSwitch } from '../../../src/renderer/hooks/useSwitchAccount'

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

const ptyKillMock = vi.fn()
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { kill: ptyKillMock },
}

const { useSwitchAccount } = await import('../../../src/renderer/hooks/useSwitchAccount')

// -- helpers ----------------------------------------------------------------

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-1',
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

function HookHarness({
  session,
  onMount,
}: {
  session: Session | null
  onMount: (fn: (sessionId: string, newProfileId: string | undefined) => void) => void
}) {
  const switchAccount = useSwitchAccount(session)
  React.useEffect(() => { onMount(switchAccount) }, [switchAccount, onMount])
  return null
}

// -- tests ------------------------------------------------------------------

describe('shouldSwitch', () => {
  it('is false when current and next are both undefined (default -> default)', () => {
    expect(shouldSwitch(undefined, undefined)).toBe(false)
  })
  it('is false when current === next', () => {
    expect(shouldSwitch('profile-a', 'profile-a')).toBe(false)
  })
  it('is true when switching from default to a profile', () => {
    expect(shouldSwitch(undefined, 'profile-a')).toBe(true)
  })
  it('is true when switching from a profile to default', () => {
    expect(shouldSwitch('profile-a', undefined)).toBe(true)
  })
  it('is true when switching between two profiles', () => {
    expect(shouldSwitch('profile-a', 'profile-b')).toBe(true)
  })
})

describe('useSwitchAccount', () => {
  let container: HTMLDivElement
  let root: Root
  let captured: ((sessionId: string, newProfileId: string | undefined) => void) | null = null

  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
    useAccountProfilesStore.setState({ profiles: [] })
    killSessionPtyMock.mockReset()
    clearSpawnedMock.mockReset()
    ptyKillMock.mockReset()
    markSessionForResumePickerMock.mockReset()
    captured = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  function renderHarness(session: Session | null) {
    act(() => {
      root.render(
        React.createElement(HookHarness, {
          session,
          onMount: (fn) => { captured = fn },
        }),
      )
    })
  }

  it('updates profileId then respawns via the Restart path (sets new account, marks resume)', () => {
    const session = makeSession({ profileId: undefined, sessionType: 'local', shellOnly: false })
    useSessionStore.getState().addSession(session)

    renderHarness(session)
    act(() => { captured!('sess-1', 'profile-b') })

    // New profileId is pinned on the (respawned) session record.
    const stored = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1')
    expect(stored).toBeDefined()
    expect(stored!.profileId).toBe('profile-b')
    // Reused the Restart path: PTY killed + resume picker marked + clean remount.
    expect(killSessionPtyMock).toHaveBeenCalledWith('sess-1')
    expect(markSessionForResumePickerMock).toHaveBeenCalledWith('sess-1')
    expect(stored!.status).toBe('idle')
  })

  it('is a no-op when selecting the current account (no store write, no PTY teardown)', () => {
    const session = makeSession({ profileId: 'profile-a' })
    useSessionStore.getState().addSession(session)
    const originalCreatedAt = session.createdAt

    renderHarness(session)
    act(() => { captured!('sess-1', 'profile-a') })

    const stored = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1')
    expect(stored!.profileId).toBe('profile-a')
    expect(stored!.createdAt).toBe(originalCreatedAt) // not respawned
    expect(killSessionPtyMock).not.toHaveBeenCalled()
    expect(markSessionForResumePickerMock).not.toHaveBeenCalled()
  })

  it('switching a profile session back to default (undefined) respawns', () => {
    const session = makeSession({ profileId: 'profile-a', sessionType: 'local', shellOnly: false })
    useSessionStore.getState().addSession(session)

    renderHarness(session)
    act(() => { captured!('sess-1', undefined) })

    const stored = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1')
    expect(stored!.profileId).toBeUndefined()
    expect(killSessionPtyMock).toHaveBeenCalledWith('sess-1')
  })

  it('is a no-op when the target account is inactive (backstop)', () => {
    useAccountProfilesStore.setState({
      profiles: [
        { id: 'profile-b', name: 'B', accountEmail: 'b@example.com', active: false, createdAt: 1 },
      ],
    })
    const session = makeSession({ profileId: 'profile-a', sessionType: 'local', shellOnly: false })
    useSessionStore.getState().addSession(session)

    renderHarness(session)
    act(() => { captured!('sess-1', 'profile-b') })

    const stored = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1')
    expect(stored!.profileId).toBe('profile-a') // unchanged: the switch was refused
    expect(killSessionPtyMock).not.toHaveBeenCalled()
    expect(markSessionForResumePickerMock).not.toHaveBeenCalled()
  })

  it('still switches to an active target when other profiles are inactive', () => {
    useAccountProfilesStore.setState({
      profiles: [
        { id: 'profile-b', name: 'B', accountEmail: 'b@example.com', active: true, createdAt: 1 },
      ],
    })
    const session = makeSession({ profileId: 'profile-a', sessionType: 'local', shellOnly: false })
    useSessionStore.getState().addSession(session)

    renderHarness(session)
    act(() => { captured!('sess-1', 'profile-b') })

    const stored = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1')
    expect(stored!.profileId).toBe('profile-b')
    expect(killSessionPtyMock).toHaveBeenCalledWith('sess-1')
  })

  it('is a no-op when the sessionId does not match the hook session', () => {
    const session = makeSession({ profileId: 'profile-a' })
    useSessionStore.getState().addSession(session)

    renderHarness(session)
    act(() => { captured!('other-id', 'profile-b') })

    const stored = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1')
    expect(stored!.profileId).toBe('profile-a')
    expect(killSessionPtyMock).not.toHaveBeenCalled()
  })
})
