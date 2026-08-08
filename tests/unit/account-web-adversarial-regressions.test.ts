// #216 — regression guards for the findings of the ADR-009 adversarial pass.
//
// Every test here corresponds to a repro an independent attacker actually ran.
// Each was confirmed to FAIL against the pre-fix code before being accepted --
// a guard that cannot fail is worse than no guard, because it gets trusted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookiesSet = vi.fn()
const clearStorageData = vi.fn(async () => {})
vi.mock('electron', () => ({
  session: { fromPartition: vi.fn(() => ({ cookies: { set: cookiesSet }, clearStorageData })) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/vision-manager', () => ({ getBrowserPaths: () => ['C:/present/chrome.exe'] }))

const spawnSyncMock = vi.fn()
const spawned: any[] = []
vi.mock('node:child_process', () => ({
  spawn: (...a: any[]) => {
    spawned.push(a)
    return { killed: false, kill: vi.fn(), on: vi.fn(), pid: 4242, once: vi.fn((_e: string, cb: () => void) => cb()) }
  },
  spawnSync: (...a: any[]) => spawnSyncMock(...a),
}))

const rmSyncMock = vi.fn()
const readdirSyncMock = vi.fn(() => [] as string[])
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readFileSync: () => '51234\n',
  readdirSync: (...a: any[]) => (readdirSyncMock as any)(...a),
  rmSync: (...a: any[]) => rmSyncMock(...a),
}))

const {
  runSignIn, _setCdpForTest, pickSignInTargets, isClaudeUrl,
  retryProfileRemoval, sweepAbandonedProfiles, cancelSignIn, getSignInState,
} = await import('../../src/main/account-web/sign-in')
const { CLAUDE_SESSION_COOKIE } = await import('../../src/shared/account-web-session')

const cookie = {
  name: CLAUDE_SESSION_COOKIE, value: 'sk', domain: '.claude.ai', path: '/',
  expires: 1_900_000_000, secure: true, httpOnly: true,
}
const TARGETS = [{ type: 'page', url: 'https://claude.ai/login', id: 't1', webSocketDebuggerUrl: 'ws://t1' }]

/** A CDP fake whose page claims `email` and whose Target domain behaves as told. */
function cdp(email: string | null, targetInfo: 'ok' | 'throws' | 'missing-url' | 'evil') {
  const f: any = () => Promise.resolve({
    Target: {
      getTargetInfo: async () => {
        if (targetInfo === 'throws') throw new Error('No target with given id found')
        if (targetInfo === 'missing-url') return { targetInfo: {} }
        if (targetInfo === 'evil') return { targetInfo: { url: 'https://evil.test/phish' } }
        return { targetInfo: { url: 'https://claude.ai/login' } }
      },
    },
    Runtime: { evaluate: async () => ({ result: { value: email } }) },
    Network: { getAllCookies: async () => ({ cookies: [cookie] }) },
    close: async () => {},
  })
  f.List = async () => TARGETS
  return f
}

const RUN = { profileId: 'profile-aaa111', dataDir: 'C:/data', timeoutMs: 400, pollMs: 5 } as const

beforeEach(() => {
  cookiesSet.mockReset()
  clearStorageData.mockClear()
  rmSyncMock.mockReset()
  spawnSyncMock.mockReset()
  readdirSyncMock.mockReset()
  readdirSyncMock.mockReturnValue([])
  spawned.length = 0
  cancelSignIn()          // clear any leftover in-flight state between tests
})

describe('BLOCKER — the identity check fails CLOSED when it cannot ask', () => {
  // Attacker repro: with Target.getTargetInfo throwing, a page on evil.test was
  // accepted and 'attacker@evil.test' was stored as the account identity.
  // Pre-fix this reached phase 'done'; the catch treated "could not ask" as "fine".
  it('refuses the account when Target.getTargetInfo throws', async () => {
    _setCdpForTest(cdp('attacker@evil.test', 'throws'))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('refuses the account when the target reports no url', async () => {
    _setCdpForTest(cdp('attacker2@evil.test', 'missing-url'))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('still refuses on an explicit host mismatch', async () => {
    _setCdpForTest(cdp('attacker3@evil.test', 'evil'))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('accepts the real thing, so the guard is not just refusing everything', async () => {
    _setCdpForTest(cdp('me@example.com', 'ok'))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('done')
    expect(s.session?.accountEmail).toBe('me@example.com')
  })
})

describe('MAJOR — claude.ai over plain http is not claude.ai', () => {
  it('rejects http:// on the host check', () => {
    // A fresh profile carries no HSTS state, so a captive portal or transparent
    // proxy can answer plaintext on this host and the origin-relative bootstrap
    // fetch would be asking the attacker who is signed in.
    expect(isClaudeUrl('http://claude.ai/')).toBe(false)
    expect(isClaudeUrl('https://claude.ai/')).toBe(true)
  })

  it('keeps out an http target even though the hostname matches', () => {
    expect(pickSignInTargets([{ type: 'page', url: 'http://claude.ai/', id: 'x' }])).toEqual([])
  })
})

describe('BLOCKER — a stale retry never deletes a newer run’s profile', () => {
  it('no-ops once a later sign-in has claimed the same path', async () => {
    // The timer must still be PENDING when the second run claims the path --
    // an earlier version of this test let it fire first, which made it pass
    // against the unfixed code too.
    vi.useFakeTimers()
    try {
      const dir = 'C:/data/account-web/profile-aaa111'
      _setCdpForTest(cdp('me@example.com', 'ok'))

      // Run 1 claims the dir.
      const first = runSignIn({ ...RUN })
      await vi.advanceTimersByTimeAsync(500)
      await first

      // Its teardown was blocked, so it leaves a retry pending at ITS generation.
      retryProfileRemoval(dir, [5_000])

      // Run 2 claims the same deterministic path before that retry fires --
      // the ordinary "sign in again after a failure" action.
      const second = runSignIn({ ...RUN })
      await vi.advanceTimersByTimeAsync(500)
      await second

      rmSyncMock.mockClear()
      await vi.advanceTimersByTimeAsync(6_000)
      // The stale timer must not touch run 2's live profile.
      expect(rmSyncMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still deletes when it is the current owner', async () => {
    vi.useFakeTimers()
    try {
      rmSyncMock.mockImplementationOnce(() => { throw new Error('EPERM') })
      retryProfileRemoval('C:/data/account-web/profile-zzz999', [10, 10])
      await vi.advanceTimersByTimeAsync(100)
      expect(rmSyncMock).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MAJOR — the startup sweep only deletes things shaped like profile dirs', () => {
  it('refuses an entry that is not a profile id', () => {
    readdirSyncMock.mockReturnValue(['..', '.', 'Partitions', 'evil', 'profile-../../etc'] as never)
    sweepAbandonedProfiles('C:/data')
    expect(rmSyncMock).not.toHaveBeenCalled()
  })

  it('still sweeps a genuine abandoned profile', () => {
    readdirSyncMock.mockReturnValue(['profile-mrbhy8is-b85405'] as never)
    sweepAbandonedProfiles('C:/data')
    expect(rmSyncMock).toHaveBeenCalledTimes(1)
    expect(String(rmSyncMock.mock.calls[0][0])).toContain('profile-mrbhy8is-b85405')
  })
})

describe('BLOCKER — the profile dir removal on the success path is pinned', () => {
  /** Recursive-delete targets, separator-normalised (join yields \ on Windows). */
  const recursiveRemovals = (): string[] =>
    rmSyncMock.mock.calls
      .filter((c) => (c[1] as any)?.recursive === true)
      .map((c) => String(c[0]).replace(/\\/g, '/'))

  it('removes the sign-in profile dir when the harvest succeeds', async () => {
    // Deleting the rmSync call from cleanup() used to leave every test green,
    // while leaving a directory holding a live sessionKey on disk.
    _setCdpForTest(cdp('me@example.com', 'ok'))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('done')
    expect(recursiveRemovals()).toContain('C:/data/account-web/profile-aaa111')
  })

  it('removes it on the failure path too', async () => {
    _setCdpForTest(cdp(null, 'ok'))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(recursiveRemovals()).toContain('C:/data/account-web/profile-aaa111')
  })
})

describe('BLOCKER — a sign-out landing mid-write is not silently undone', () => {
  it('discards a partial write and FAILS when the session is revoked during injection', async () => {
    // Attacker repro: the revocation check ran once before the loop, but every
    // `cookies.set` is an await the sign-out handler can run in. Observed
    // pre-fix: set:sessionKey -> cleared -> set:x -> set:y, phase 'done' — so
    // the IPC layer then re-saved a record for a session just signed out of.
    const { clearWebSession } = await import('../../src/main/account-web/sign-in')
    const jar = [cookie, { ...cookie, name: 'lastActiveOrg' }, { ...cookie, name: 'activitySessionId' }]
    const timeline: string[] = []

    let fired = false
    cookiesSet.mockImplementation(async (c: any) => {
      timeline.push(`set:${c.name}`)
      if (!fired) {           // sign out immediately after the first write
        fired = true
        await clearWebSession('profile-aaa111')
        timeline.push('cleared')
      }
    })

    const f: any = () => Promise.resolve({
      Target: { getTargetInfo: async () => ({ targetInfo: { url: 'https://claude.ai/' } }) },
      Runtime: { evaluate: async () => ({ result: { value: 'me@example.com' } }) },
      Network: { getAllCookies: async () => ({ cookies: jar }) },
      close: async () => {},
    })
    f.List = async () => TARGETS
    _setCdpForTest(f)

    const s = await runSignIn({ ...RUN })

    expect(timeline.filter((t) => t.startsWith('set:'))).toHaveLength(1)  // no writes after the clear
    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/signed out/i)
    expect(clearStorageData).toHaveBeenCalled()   // the partial write was undone
    cookiesSet.mockReset()
  })
})

describe('BLOCKER — a hung CDP call cannot wedge every account', () => {
  it('gives up on a promise that never settles instead of parking forever', async () => {
    // Pre-fix, `current.phase` stayed in flight and the single-flight latch
    // never released: every account's sign-in was dead until an app restart,
    // and cancelSignIn could not help because the loop was not running.
    const f: any = () => Promise.resolve({
      Target: { getTargetInfo: async () => ({ targetInfo: { url: 'https://claude.ai/' } }) },
      Runtime: { evaluate: () => new Promise(() => {}) },   // never settles
      Network: { getAllCookies: async () => ({ cookies: [cookie] }) },
      close: async () => {},
    })
    f.List = async () => TARGETS
    _setCdpForTest(f)

    const s = await runSignIn({ ...RUN, timeoutMs: 300, pollMs: 5 })

    expect(s.phase).toBe('failed')
    // And the latch is free: the next account can sign in.
    _setCdpForTest(cdp('me@example.com', 'ok'))
    const next = await runSignIn({ ...RUN })
    expect(next.phase).toBe('done')
  }, 30_000)
})

describe('MINOR — the identity check has no shape-based escape hatch left', () => {
  it('refuses a client whose Target.getTargetInfo is not callable', async () => {
    const f: any = () => Promise.resolve({
      Target: { getTargetInfo: undefined },
      Runtime: { evaluate: async () => ({ result: { value: 'attacker@evil.test' } }) },
      Network: { getAllCookies: async () => ({ cookies: [cookie] }) },
      close: async () => {},
    })
    f.List = async () => TARGETS
    _setCdpForTest(f)
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(cookiesSet).not.toHaveBeenCalled()
  })
})

describe('MAJOR — a profile id cannot differ from another only by case', () => {
  it('refuses uppercase, so two ids can never name one directory but two partitions', async () => {
    const { PROFILE_ID_RE } = await import('../../src/shared/account-web-session')
    // On Windows the filesystem folds case and the partition string does not,
    // so `profile-a` and `profile-A` were one dir and two accounts.
    expect(PROFILE_ID_RE.test('profile-abc123')).toBe(true)
    expect(PROFILE_ID_RE.test('profile-ABC123')).toBe(false)
    expect(PROFILE_ID_RE.test('profile-AbC123')).toBe(false)
  })
})

describe('MINOR — cancel is scoped to the account that asked', () => {
  it('does not cancel another account’s sign-in', async () => {
    _setCdpForTest(cdp('me@example.com', 'ok'))
    const run = runSignIn({ ...RUN })
    cancelSignIn('profile-someone-else')
    const s = await run
    expect(s.phase).toBe('done')
  })

  it('cancels its own', async () => {
    _setCdpForTest(cdp(null, 'ok'))
    const run = runSignIn({ ...RUN, timeoutMs: 5_000 })
    cancelSignIn('profile-aaa111')
    const s = await run
    expect(s.phase).toBe('failed')
    expect(s.error).toMatch(/cancelled/i)
    expect(getSignInState().phase).toBe('failed')
  })
})
