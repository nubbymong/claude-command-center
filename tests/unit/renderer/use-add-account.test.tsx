// @vitest-environment jsdom
/**
 * useAddAccount hook -- unit tests.
 *
 * Verifies:
 *   - create() is called with the given name
 *   - a session is added with { profileId, shellOnly: true, needsLogin: true }
 *   - once refreshIdentity resolves an email, updateSession is called with
 *     { needsLogin: false } (poll fires on timer advance)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'
import type { AccountProfile } from '../../../src/shared/account-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Mocks

vi.mock('../../../src/renderer/utils/id', () => ({
  generateId: () => 'mock-session-id',
}))

const createMock = vi.fn<[string?], Promise<AccountProfile>>()
const listMock = vi.fn<[], Promise<AccountProfile[]>>()
const refreshIdentityMock = vi.fn<[string], Promise<{ ok: boolean; email: string; configDir: string } | null>>()

// Partial window.electronAPI augment (does NOT replace the whole window so
// jsdom survives the render phase — same pattern as use-account-identity-subscription).
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  accountProfiles: {
    create: createMock,
    list: listMock,
    refreshIdentity: refreshIdentityMock,
  },
}

// ---------------------------------------------------------------------------
// Local renderHook shim (this repo has no @testing-library/react dependency)

function renderHook<T>(hook: () => T): { result: { current: T }; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const result: { current: T } = { current: undefined as unknown as T }

  const HookHost: React.FC = () => {
    result.current = hook()
    return null
  }
  act(() => { root.render(<HookHost />) })

  return {
    result,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

// ---------------------------------------------------------------------------
// Import hook AFTER mocks are in place

const { useAddAccount } = await import('../../../src/renderer/hooks/useAddAccount')

// ---------------------------------------------------------------------------
// Tests

const profile: AccountProfile = {
  id: 'profile-work',
  name: 'Work',
  accountEmail: '',
  createdAt: 1_000_000,
}

describe('useAddAccount', () => {
  let unmount: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
    useAccountProfilesStore.setState({ profiles: [] })

    createMock.mockReset()
    listMock.mockReset()
    refreshIdentityMock.mockReset()

    createMock.mockResolvedValue(profile)
    listMock.mockResolvedValue([profile])
    refreshIdentityMock.mockResolvedValue(null) // no email yet by default
  })

  afterEach(() => {
    unmount?.()
    vi.useRealTimers()
  })

  it('calls create() with the name and adds a session with profileId + shellOnly + needsLogin', async () => {
    const { result, unmount: u } = renderHook(() => useAddAccount())
    unmount = u

    let returned: { profile: AccountProfile; sessionId: string } | undefined
    await act(async () => {
      returned = await result.current('Work')
    })

    expect(createMock).toHaveBeenCalledWith('Work')
    expect(returned!.profile).toEqual(profile)
    expect(returned!.sessionId).toBe('mock-session-id')

    const sessions = useSessionStore.getState().sessions
    expect(sessions).toHaveLength(1)
    const sess = sessions[0]
    expect(sess.profileId).toBe('profile-work')
    expect(sess.shellOnly).toBe(true)
    expect(sess.needsLogin).toBe(true)
  })

  it('clears needsLogin + updates label once refreshIdentity resolves an email', async () => {
    refreshIdentityMock.mockResolvedValue({ ok: true, email: 'work@corp.com', configDir: '/p/work' })

    const { result, unmount: u } = renderHook(() => useAddAccount())
    unmount = u

    await act(async () => {
      await result.current('Work')
    })

    // Advance the poll interval; the timer callback runs and flushes the promise.
    await act(async () => {
      vi.advanceTimersByTime(4100)
      // Flush the async refreshIdentity + then-chain
      await Promise.resolve()
      await Promise.resolve()
    })

    const sess = useSessionStore.getState().sessions[0]
    expect(sess).toBeDefined()
    expect(sess.needsLogin).toBe(false)
    expect(sess.label).toBe('work@corp.com')
  })

  it('stops polling once the session is closed (removed from store)', async () => {
    const { result, unmount: u } = renderHook(() => useAddAccount())
    unmount = u

    await act(async () => {
      await result.current('Work')
    })

    // Remove the session before the first poll fires
    act(() => {
      useSessionStore.getState().removeSession('mock-session-id')
    })

    await act(async () => {
      vi.advanceTimersByTime(4100)
      await Promise.resolve()
      await Promise.resolve()
    })

    // refreshIdentity should NOT have been called because the poll bails early
    expect(refreshIdentityMock).not.toHaveBeenCalled()
  })

  it('keeps polling past the old 2-minute cap while the session is alive', async () => {
    refreshIdentityMock.mockResolvedValue(null) // login never completes

    const { result, unmount: u } = renderHook(() => useAddAccount())
    unmount = u

    await act(async () => {
      await result.current('Work')
    })

    // Advance 40 ticks (40 * 4100ms = ~164 s, well past the old 30-attempt cap).
    // With MAX_ATTEMPTS = 300 the poll must still be running and have called
    // refreshIdentity 40 times (one per tick, session still present).
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        vi.advanceTimersByTime(4100)
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    expect(refreshIdentityMock.mock.calls.length).toBeGreaterThan(30)
    // Login never completed, so the banner flag is still set on the session.
    const sess = useSessionStore.getState().sessions[0]
    expect(sess.needsLogin).toBe(true)
  })
})
