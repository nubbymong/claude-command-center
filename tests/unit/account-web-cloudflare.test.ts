// #269 — the sign-in must not run script in the login page while Cloudflare is
// challenging.
//
// Cloudflare's Turnstile treats an attached debugger evaluating in the page as
// automation and re-arms its "verify you are human" challenge indefinitely. The
// first version of this feature ran `Runtime.evaluate` in the login page on EVERY
// 1.5s poll, which made the challenge un-clearable on residential IPs and fresh
// VMs. The fix: read the origin and the cookies (neither runs page script), and
// only run the single identity `Runtime.evaluate` AFTER a real session cookie has
// appeared -- by which point the challenge is demonstrably already cleared.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cookiesSet = vi.fn()
vi.mock('electron', () => ({
  session: { fromPartition: vi.fn(() => ({ cookies: { set: cookiesSet }, clearStorageData: vi.fn() })) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/browser-paths', () => ({ getBrowserPaths: () => ['C:/present/chrome.exe'] }))
vi.mock('node:child_process', () => ({
  spawn: () => ({ exitCode: null, signalCode: null, killed: false, kill: vi.fn(), on: vi.fn(), pid: 4242, once: vi.fn((_e: string, cb: () => void) => cb()) }),
  spawnSync: vi.fn(),
}))
vi.mock('node:fs', () => ({
  existsSync: () => true, readFileSync: () => '51234\n', readdirSync: () => [], rmSync: vi.fn(),
}))

const { runSignIn, _setCdpForTest, isCloudflareChallenge } = await import('../../src/main/account-web/sign-in')
const { CLAUDE_SESSION_COOKIE } = await import('../../src/shared/account-web-session')

const sessionCookie = {
  name: CLAUDE_SESSION_COOKIE, value: 'sk', domain: '.claude.ai', path: '/',
  expires: 1_900_000_000, secure: true, httpOnly: true,
}
const analytics = { ...sessionCookie, name: 'ajs_anonymous_id' }

const LOGIN = { type: 'page', url: 'https://claude.ai/login', id: 't1', webSocketDebuggerUrl: 'ws://t1' }
const CF_FRAME = { type: 'iframe', url: 'https://challenges.cloudflare.com/turnstile/v0/x', id: 'cf' }

/**
 * A CDP fake with an `evaluate` SPY, whose cookie jar is produced fresh per poll
 * by `cookiesFor()` -- so a test can withhold the session cookie for N polls to
 * simulate the challenge, then grant it.
 */
function makeCdp(opts: { targets: any[]; cookiesFor: () => any[]; evaluate: ReturnType<typeof vi.fn> }) {
  const f: any = () => Promise.resolve({
    Target: { getTargetInfo: async () => ({ targetInfo: { url: 'https://claude.ai/login' } }) },
    Runtime: { evaluate: opts.evaluate },
    Network: { getAllCookies: async () => ({ cookies: opts.cookiesFor() }) },
    close: async () => {},
  })
  f.List = async () => opts.targets
  return f
}

const RUN = { profileId: 'profile-aaa111', dataDir: 'C:/data', pollMs: 5 } as const

beforeEach(() => { cookiesSet.mockReset() })

describe('isCloudflareChallenge', () => {
  it('matches the challenge iframe, the cdn-cgi platform path, and the interstitial title', () => {
    expect(isCloudflareChallenge({ type: 'iframe', url: 'https://challenges.cloudflare.com/x' })).toBe(true)
    expect(isCloudflareChallenge({ type: 'page', url: 'https://claude.ai/cdn-cgi/challenge-platform/y' })).toBe(true)
    expect(isCloudflareChallenge({ type: 'page', url: 'https://claude.ai/login', title: 'Just a moment...' })).toBe(true)
  })

  it('does not match an ordinary claude.ai page', () => {
    expect(isCloudflareChallenge({ type: 'page', url: 'https://claude.ai/login', title: 'Claude' })).toBe(false)
    expect(isCloudflareChallenge({ type: 'page', url: 'https://claude.ai/' })).toBe(false)
    expect(isCloudflareChallenge({})).toBe(false)
  })
})

describe('runSignIn — no page script while the challenge is unsolved (#269)', () => {
  it('NEVER calls Runtime.evaluate when the session cookie never appears', async () => {
    // This is the whole bug: a poll that runs evaluate re-arms the challenge. With
    // no session cookie ever granted, the run must time out WITHOUT one evaluate.
    const evaluate = vi.fn(async () => ({ result: { value: 'me@example.com' } }))
    _setCdpForTest(makeCdp({ targets: [LOGIN, CF_FRAME], cookiesFor: () => [analytics], evaluate }))

    const s = await runSignIn({ ...RUN, timeoutMs: 120 })

    expect(s.phase).toBe('failed')
    expect(evaluate).not.toHaveBeenCalled()   // <-- the guarantee
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('runs evaluate exactly once, AFTER the session cookie appears, then completes', async () => {
    // The challenge clears (session cookie granted from the 3rd poll on). Only then
    // may the single identity read run -- proving the evaluate is deferred past the
    // challenge, not merely removed.
    let polls = 0
    const evaluate = vi.fn(async () => ({ result: { value: 'me@example.com' } }))
    _setCdpForTest(makeCdp({
      targets: [LOGIN, CF_FRAME],
      cookiesFor: () => (++polls >= 3 ? [sessionCookie] : [analytics]),
      evaluate,
    }))

    const s = await runSignIn({ ...RUN, timeoutMs: 3000 })

    expect(s.phase).toBe('done')
    expect(s.session?.accountEmail).toBe('me@example.com')
    expect(evaluate).toHaveBeenCalledTimes(1)   // once, and only after clearance
    expect(cookiesSet).toHaveBeenCalled()
  })

  it('surfaces a Cloudflare notice while the challenge is up and no session exists', async () => {
    const { getSignInState } = await import('../../src/main/account-web/sign-in')
    const evaluate = vi.fn(async () => ({ result: { value: 'me@example.com' } }))
    _setCdpForTest(makeCdp({ targets: [LOGIN, CF_FRAME], cookiesFor: () => [analytics], evaluate }))

    // Kick off a run and sample the live state mid-flight, then let it time out.
    const run = runSignIn({ ...RUN, timeoutMs: 200 })
    await new Promise((r) => setTimeout(r, 60))
    const mid = getSignInState()
    await run

    expect(mid.phase).toBe('awaiting-user')
    expect(mid.notice).toMatch(/Cloudflare is verifying/i)
  })

  it('shows NO Cloudflare notice when there is no challenge target', async () => {
    const { getSignInState } = await import('../../src/main/account-web/sign-in')
    const evaluate = vi.fn(async () => ({ result: { value: 'me@example.com' } }))
    _setCdpForTest(makeCdp({ targets: [LOGIN], cookiesFor: () => [analytics], evaluate }))

    const run = runSignIn({ ...RUN, timeoutMs: 200 })
    await new Promise((r) => setTimeout(r, 60))
    const mid = getSignInState()
    await run

    expect(mid.notice).toBeUndefined()
  })
})
