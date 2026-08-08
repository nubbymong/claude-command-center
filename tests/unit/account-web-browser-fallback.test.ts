// #216 — what happens when the account's chosen sign-in browser is not installed.
//
// The choice exists because the two browsers do NOT behave the same at the
// identity provider: on a managed box Chrome needs a force-installed SSO
// extension that a fresh profile has not fetched yet, and Edge needs none.
// So a substitution must still sign in (a machine may only have one browser) but
// must never be silent — otherwise the setting turns into an unexplained SSO
// failure. This file pins both halves.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cookiesSet = vi.fn()
vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => ({ cookies: { set: cookiesSet }, clearStorageData: vi.fn() })),
  },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

// EDGE IS ABSENT ON THIS FAKE MACHINE, Chrome is present — the case that makes a
// fallback happen at all, given Edge is the default.
vi.mock('../../src/main/vision-manager', () => ({
  getBrowserPaths: (b: 'chrome' | 'edge') =>
    b === 'edge' ? ['C:/none/msedge.exe'] : ['C:/present/chrome.exe'],
}))

const spawned: any[] = []
const spawnSyncMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...a: any[]) => { spawned.push(a); return { killed: false, kill: vi.fn(), on: vi.fn(), pid: 4242, once: vi.fn((_e: string, cb: () => void) => cb()) } },
  spawnSync: (...a: any[]) => spawnSyncMock(...a),
}))
vi.mock('node:fs', () => ({
  // Only the Chrome binary exists. Everything else (the profile dir the code
  // checks before cleaning up) is treated as present.
  existsSync: (p: string) => !String(p).includes('msedge'),
  readFileSync: () => '51234\n',
  readdirSync: () => [],
  rmSync: vi.fn(),
}))

const { runSignIn, resolveBrowserBinary } = await import('../../src/main/account-web/sign-in')
const { CLAUDE_SESSION_COOKIE } = await import('../../src/shared/account-web-session')

const cookie = {
  name: CLAUDE_SESSION_COOKIE, value: 'sk', domain: '.claude.ai', path: '/',
  expires: 1_800_000_000, secure: true, httpOnly: true,
}

const TARGETS = [{ type: 'page', url: 'https://claude.ai/login', id: 't1', webSocketDebuggerUrl: 'ws://t1' }]

/** A fake chrome-remote-interface that reports a signed-in account. */
function fakeCdp() {
  const f: any = () => Promise.resolve({
    Target: { getTargetInfo: async () => ({ targetInfo: { url: 'https://claude.ai/login' } }) },
    Runtime: { evaluate: async () => ({ result: { value: 'me@example.com' } }) },
    Network: { getAllCookies: async () => ({ cookies: [cookie] }) },
    close: async () => {},
  })
  f.List = async () => TARGETS
  return f
}

let setCdp: (f: unknown) => void
beforeEach(async () => {
  const m = await import('../../src/main/account-web/sign-in')
  setCdp = m._setCdpForTest
  setCdp(fakeCdp())
  cookiesSet.mockReset()
  spawned.length = 0
})

describe('resolveBrowserBinary — the account’s preference decides the order', () => {
  it('returns the requested browser when it is installed', () => {
    expect(resolveBrowserBinary('chrome')).toEqual({ browser: 'chrome', path: 'C:/present/chrome.exe' })
  })

  it('falls back to the other browser rather than refusing to sign in', () => {
    expect(resolveBrowserBinary('edge')).toEqual({ browser: 'chrome', path: 'C:/present/chrome.exe' })
  })
})

describe('runSignIn — a substitution is reported, never silent', () => {
  it('signs in with Chrome when Edge was asked for, and says so', async () => {
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5, browser: 'edge' })

    expect(s.phase).toBe('done')
    // It still worked — the fallback is deliberate.
    expect(cookiesSet).toHaveBeenCalledTimes(1)
    // And the UI is told what actually ran, plus why it might matter.
    expect(s.browser).toBe('chrome')
    expect(s.notice).toMatch(/Microsoft Edge is not installed/)
    expect(s.notice).toMatch(/Google Chrome was used instead/)
    expect(spawned[0][0]).toBe('C:/present/chrome.exe')
  })

  it('kills the browser TREE at teardown, not just the process it spawned', async () => {
    // REGRESSION, observed 2026-08-08. proc.kill() signals only the spawned
    // process; Edge's children kept handles on the profile dir, the following
    // rmSync threw EPERM, and a directory containing a live claude.ai
    // sessionKey was left on disk -- the exact outcome the dedicated-profile
    // design exists to prevent.
    spawnSyncMock.mockClear()
    await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5, browser: 'chrome' })

    if (process.platform === 'win32') {
      expect(spawnSyncMock).toHaveBeenCalled()
      const [cmd, args] = spawnSyncMock.mock.calls[0]
      expect(cmd).toBe('taskkill')
      expect(args).toContain('/T')   // the tree
      expect(args).toContain('/F')
      expect(args).toContain('4242') // the pid we spawned
    }
  })

  it('says nothing when the browser that ran is the one that was asked for', async () => {
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 3000, pollMs: 5, browser: 'chrome' })

    expect(s.phase).toBe('done')
    expect(s.browser).toBe('chrome')
    expect(s.notice).toBeUndefined()
  })

  it('stamps the browser onto a FAILED state too, so a failure can be attributed', async () => {
    // No account ever reported: the sign-in times out. Which browser was driving
    // is the first thing worth knowing about an SSO step that never completed.
    const never: any = () => Promise.resolve({
      Runtime: { evaluate: async () => ({ result: { value: null } }) },
      Network: { getAllCookies: async () => ({ cookies: [] }) },
      close: async () => {},
    })
    never.List = async () => TARGETS
    setCdp(never)
    const s = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 120, pollMs: 5, browser: 'edge' })

    expect(s.phase).toBe('failed')
    expect(s.browser).toBe('chrome')
    expect(s.notice).toMatch(/Microsoft Edge is not installed/)
  })
})
