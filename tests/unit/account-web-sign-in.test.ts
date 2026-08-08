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
vi.mock('../../src/main/vision-manager', () => ({
  getBrowserPaths: () => ['C:/nonexistent/chrome.exe'],
}))

const spawned: any[] = []
const spawnSyncMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...a: any[]) => { spawned.push(a); return { killed: false, kill: vi.fn(), on: vi.fn(), pid: 4242, once: vi.fn((_e: string, cb: () => void) => cb()) } },
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

const { runSignIn, _setCdpForTest, getSignInState } = await import('../../src/main/account-web/sign-in')
const { CLAUDE_SESSION_COOKIE } = await import('../../src/shared/account-web-session')

/** A fake chrome-remote-interface whose page reports `email` and returns `cookies`. */
function fakeCdp(email: string | null, cookies: any[]) {
  const f: any = () => Promise.resolve({
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
})

describe('runSignIn', () => {
  it('injects the cookies and reports the account once signed in', async () => {
    _setCdpForTest(fakeCdp('me@example.com', [sessionCookie]))
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5 })

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
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 120, pollMs: 5 })

    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/Timed out/)
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('times out rather than hanging when the user never signs in', async () => {
    _setCdpForTest(fakeCdp(null, []))
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 120, pollMs: 5 })

    expect(s.phase).toBe('failed')
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('never copies a non-claude.ai cookie into the partition', async () => {
    _setCdpForTest(fakeCdp('me@example.com', [
      sessionCookie,
      { ...sessionCookie, name: 'SID', domain: 'mail.google.com' },
      { ...sessionCookie, name: 'user_session', domain: 'github.com' },
    ]))
    await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5 })

    expect(cookiesSet).toHaveBeenCalledTimes(1)
    expect(cookiesSet.mock.calls[0][0].name).toBe(CLAUDE_SESSION_COOKIE)
  })

  it('refuses a profile id that is not the expected shape, before launching anything', async () => {
    _setCdpForTest(fakeCdp('me@example.com', [sessionCookie]))
    const s = await runSignIn({ profileId: '../evil', dataDir: 'C:/data', timeoutMs: 120, pollMs: 5 })

    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/unexpected profile id/)
    expect(spawned.length).toBe(0)
  })
})
