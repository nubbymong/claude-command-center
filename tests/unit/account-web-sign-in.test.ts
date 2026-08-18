// #216 — the sign-in orchestrator's decision logic, with a fake CDP.
//
// The case worth pinning is "claude.ai says you are signed in, but the jar has
// no session cookie". Declaring success there would inject a partition that
// LOOKS authenticated and 401s on every request — a failure that surfaces much
// later, somewhere else, as a confusing bug.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cookiesSet = vi.fn()
const clearStorageData = vi.fn()
vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => ({
      cookies: { set: cookiesSet },
      clearStorageData,
    })),
  },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

// Keep the real getBrowserPaths out of it; we are not testing binary discovery.
vi.mock('../../src/main/browser-paths', () => ({
  getBrowserPaths: () => ['C:/nonexistent/chrome.exe'],
}))

const spawned: any[] = []
const spawnSyncMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...a: any[]) => { spawned.push(a); return { exitCode: null, signalCode: null, killed: false, kill: vi.fn(), on: vi.fn(), pid: 4242, once: vi.fn((_e: string, cb: () => void) => cb()) } },
  // Teardown kills the browser TREE, not just the process we spawned.
  spawnSync: (...a: any[]) => spawnSyncMock(...a),
}))
vi.mock('node:fs', () => ({
  existsSync: () => true,            // browser binary + profile dir "exist"
  // Chrome writes the real port here; the code reads it back to prove the CDP
  // endpoint belongs to the browser it launched.
  readFileSync: () => '51234\n',
  readdirSync: () => [],
  rmSync: vi.fn(),
}))

// The in-app path (BrowserWindow) is tested on its own; here it is mocked so the
// ROUTING decision can be checked without a window. A non-SSO account must take
// this path (no browser spawn); an SSO account must NOT.
const runInAppSignInMock = vi.fn(async () => ({
  ok: true,
  session: { profileId: 'profile-aaa111', accountEmail: 'inapp@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' as const },
}))
const closeInAppMock = vi.fn()
vi.mock('../../src/main/account-web/in-app-sign-in', () => ({
  runInAppSignIn: (...a: any[]) => runInAppSignInMock(...a),
  closeInAppSignInWindow: () => closeInAppMock(),
}))

const { runSignIn, _setCdpForTest, getSignInState } = await import('../../src/main/account-web/sign-in')
const { CLAUDE_SESSION_COOKIE } = await import('../../src/shared/account-web-session')

/** A fake chrome-remote-interface whose page reports `email` and returns `cookies`. */
function fakeCdp(email: string | null, cookies: any[]) {
  const f: any = () => Promise.resolve({
    // A real chrome-remote-interface client always carries Target, and the
    // identity check now REFUSES a client without it — "could not ask which page
    // this is" must not mean "trust the page".
    Target: { getTargetInfo: async () => ({ targetInfo: { url: 'https://claude.ai/login' } }) },
    Runtime: { evaluate: async () => ({ result: { value: email } }) },
    Network: { getAllCookies: async () => ({ cookies }) },
    close: async () => {},
  })
  // The poller enumerates targets each cycle instead of taking whichever one it
  // is handed first — see pickSignInTargets.
  f.List = async () => [
    { type: 'page', url: 'https://claude.ai/login', id: 't1', webSocketDebuggerUrl: 'ws://t1' },
  ]
  return f
}

const sessionCookie = { name: CLAUDE_SESSION_COOKIE, value: 'sk', domain: '.claude.ai', path: '/', expires: 1_800_000_000, secure: true, httpOnly: true }

beforeEach(() => {
  cookiesSet.mockReset()
  clearStorageData.mockReset()
  spawned.length = 0
  runInAppSignInMock.mockClear()
  closeInAppMock.mockClear()
})

describe('runSignIn', () => {
  it('injects the cookies and reports the account once signed in', async () => {
    _setCdpForTest(fakeCdp('me@example.com', [sessionCookie]))
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5, method: 'sso' })

    expect(s.phase).toBe('done')
    expect(s.session?.accountEmail).toBe('me@example.com')
    expect(s.session?.origin).toBe('system-browser')
    expect(cookiesSet).toHaveBeenCalledTimes(1)
    expect(getSignInState().phase).toBe('done')
  })

  it('does NOT declare success when the jar has no session cookie', async () => {
    // Authenticated bootstrap, but only an analytics cookie: injecting this
    // yields a partition that looks signed in and 401s on every request.
    _setCdpForTest(fakeCdp('me@example.com', [{ ...sessionCookie, name: 'ajs_anonymous_id' }]))
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 120, pollMs: 5, method: 'sso' })

    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/Timed out/)
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('times out rather than hanging when the user never signs in', async () => {
    _setCdpForTest(fakeCdp(null, []))
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 120, pollMs: 5, method: 'sso' })

    expect(s.phase).toBe('failed')
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('never copies a non-claude.ai cookie into the partition', async () => {
    _setCdpForTest(fakeCdp('me@example.com', [
      sessionCookie,
      { ...sessionCookie, name: 'SID', domain: 'mail.google.com' },
      { ...sessionCookie, name: 'user_session', domain: 'github.com' },
    ]))
    await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5, method: 'sso' })

    expect(cookiesSet).toHaveBeenCalledTimes(1)
    expect(cookiesSet.mock.calls[0][0].name).toBe(CLAUDE_SESSION_COOKIE)
  })

  it('refuses a profile id that is not the expected shape, before launching anything', async () => {
    _setCdpForTest(fakeCdp('me@example.com', [sessionCookie]))
    const s = await runSignIn({ profileId: '../evil', dataDir: 'C:/data', timeoutMs: 120, pollMs: 5, method: 'sso' })

    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/unexpected profile id/)
    expect(spawned.length).toBe(0)
  })
})

describe('runSignIn — routing by auth method (#265 follow-up)', () => {
  it('a non-SSO account signs in IN-APP: no browser is spawned, no CDP is used', async () => {
    _setCdpForTest(fakeCdp('me@example.com', [sessionCookie]))   // would succeed IF the CDP path ran
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5 })

    expect(runInAppSignInMock).toHaveBeenCalledTimes(1)
    expect(spawned.length).toBe(0)              // the system browser was never launched
    expect(cookiesSet).not.toHaveBeenCalled()   // no CDP harvest/injection
    expect(s.phase).toBe('done')
    expect(s.session?.origin).toBe('in-app')
  })

  it('the console method also routes in-app', async () => {
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5, method: 'console' })
    expect(runInAppSignInMock).toHaveBeenCalledTimes(1)
    expect(spawned.length).toBe(0)
    expect(s.session?.origin).toBe('in-app')
  })

  it('an SSO account keeps the system-browser path: in-app is NOT used', async () => {
    _setCdpForTest(fakeCdp('me@example.com', [sessionCookie]))
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5, method: 'sso' })

    expect(runInAppSignInMock).not.toHaveBeenCalled()
    expect(spawned.length).toBe(1)              // the system browser WAS launched
    expect(s.phase).toBe('done')
    expect(s.session?.origin).toBe('system-browser')
  })

  it('a throw from the in-app path lands as failed, not a wedged single-flight latch', async () => {
    // runInAppSignIn is contracted never to throw, but if it ever did, runSignIn
    // must fail the state (releasing the latch) rather than propagate — otherwise
    // getSignInState stays 'awaiting-user' and every account's sign-in is refused.
    runInAppSignInMock.mockRejectedValueOnce(new Error('boom in window'))
    const s1 = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5 })
    expect(s1.phase).toBe('failed')
    expect(getSignInState().phase).toBe('failed')   // latch released, not stuck awaiting-user

    // A second sign-in for another account is accepted, not blocked by a wedge.
    const s2 = await runSignIn({ profileId: 'profile-bbb222', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5 })
    expect(s2.phase).toBe('done')
    expect(s2.session?.origin).toBe('in-app')
  })
})
