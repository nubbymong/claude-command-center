// @vitest-environment jsdom
/**
 * rc.14 review F7 (aicc_planning#51): re-authenticating an EXISTING account
 * must not report success until the credentials actually change.
 *
 * refreshIdentity only reads the identity file, and an expired account still
 * has its email there, so the old poll completed on its first 4 s tick with no
 * login having happened: needsLogin cleared, the completion callback fired, and
 * a login finished later was never observed. The poll now also requires the
 * credential generation (a stat-only stamp) to differ from the one captured
 * when the login shell opened, and the account to read as signed in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'reauth-session' }))

const refreshIdentityMock = vi.fn()
const credentialStampMock = vi.fn()
const listMock = vi.fn(async () => [])
;(globalThis as any).window = (globalThis as any).window ?? {}
const api = ((globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  accountProfiles: {
    list: listMock,
    refreshIdentity: refreshIdentityMock,
    credentialStamp: credentialStampMock,
  },
})

function renderHook<T>(hook: () => T): { result: { current: T }; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const result: { current: T } = { current: undefined as unknown as T }
  const HookHost: React.FC = () => { result.current = hook(); return null }
  act(() => { root.render(<HookHost />) })
  return { result, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

const { useReauthAccount } = await import('../../../src/renderer/hooks/useReauthAccount')

/** One poll interval plus enough microtask turns for the two awaits inside it. */
async function tick() {
  await act(async () => {
    vi.advanceTimersByTime(4100)
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}
const session = () => useSessionStore.getState().sessions.find((s) => s.id === 'reauth-session')

describe('useReauthAccount completion', () => {
  let unmount: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false } as never)
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-aaa111', name: 'Work', accountEmail: 'work@corp.com', createdAt: 1 }] } as never)
    refreshIdentityMock.mockReset()
    credentialStampMock.mockReset()
    api.accountProfiles.credentialStamp = credentialStampMock
    // The expired account: its email is still on disk, its credentials unchanged.
    refreshIdentityMock.mockResolvedValue({ ok: true, email: 'work@corp.com', configDir: '/p/work' })
    credentialStampMock.mockResolvedValue({ ok: true, stamp: '100:50', signedIn: true })
  })
  afterEach(() => { unmount?.(); unmount = undefined; vi.useRealTimers() })

  it('REGRESSION: with the email present but credentials unchanged, the login stays pending past 4 s', async () => {
    const { result, unmount: u } = renderHook(() => useReauthAccount())
    unmount = u
    const onDone = vi.fn()
    await act(async () => { result.current({ id: 'profile-aaa111', name: 'Work' }, onDone); for (let i = 0; i < 4; i++) await Promise.resolve() })
    expect(session()?.needsLogin).toBe(true)

    await tick(); await tick(); await tick()
    expect(refreshIdentityMock).toHaveBeenCalled()
    expect(session()?.needsLogin).toBe(true)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('completes once the credentials change and the account reads as signed in', async () => {
    const { result, unmount: u } = renderHook(() => useReauthAccount())
    unmount = u
    const onDone = vi.fn()
    await act(async () => { result.current({ id: 'profile-aaa111', name: 'Work' }, onDone); for (let i = 0; i < 4; i++) await Promise.resolve() })
    await tick()
    expect(session()?.needsLogin).toBe(true)

    // /login rewrote .credentials.json
    credentialStampMock.mockResolvedValue({ ok: true, stamp: '200:61', signedIn: true })
    await tick()
    expect(session()?.needsLogin).toBe(false)
    expect(session()?.label).toBe('work@corp.com')
    expect(onDone).toHaveBeenCalledTimes(1)

    // The poll stopped: no further completion calls.
    await tick()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('a rewrite that leaves the account signed OUT does not complete', async () => {
    const { result, unmount: u } = renderHook(() => useReauthAccount())
    unmount = u
    const onDone = vi.fn()
    await act(async () => { result.current({ id: 'profile-aaa111', name: 'Work' }, onDone); for (let i = 0; i < 4; i++) await Promise.resolve() })
    credentialStampMock.mockResolvedValue({ ok: true, stamp: '300:10', signedIn: false })
    await tick(); await tick()
    expect(session()?.needsLogin).toBe(true)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('an older preload without the stamp API keeps the previous email-only rule', async () => {
    api.accountProfiles.credentialStamp = undefined
    const { result, unmount: u } = renderHook(() => useReauthAccount())
    unmount = u
    const onDone = vi.fn()
    await act(async () => { result.current({ id: 'profile-aaa111', name: 'Work' }, onDone) })
    await tick()
    expect(session()?.needsLogin).toBe(false)
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

describe('an abandoned re-auth tab still stops polling', () => {
  it('after the attempt backstop, no further identity/stamp reads happen even though the login stayed pending', async () => {
    vi.useFakeTimers()
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false } as never)
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-aaa111', name: 'Work', accountEmail: 'work@corp.com', createdAt: 1 }] } as never)
    refreshIdentityMock.mockReset()
    credentialStampMock.mockReset()
    api.accountProfiles.credentialStamp = credentialStampMock
    refreshIdentityMock.mockResolvedValue({ ok: true, email: 'work@corp.com', configDir: '/p/work' })
    credentialStampMock.mockResolvedValue({ ok: true, stamp: '100:50', signedIn: true })
    const { result, unmount } = renderHook(() => useReauthAccount())
    await act(async () => { result.current({ id: 'profile-aaa111', name: 'Work' }); for (let i = 0; i < 4; i++) await Promise.resolve() })
    for (let i = 0; i < 300; i++) await tick()
    const calls = refreshIdentityMock.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(300)
    await tick(); await tick()
    expect(refreshIdentityMock.mock.calls.length).toBe(calls)
    expect(session()?.needsLogin).toBe(true)
    unmount()
    vi.useRealTimers()
  })
})
