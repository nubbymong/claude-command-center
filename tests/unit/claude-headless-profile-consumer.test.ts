// #48/#49 (rc.14 review F4/F5): a headless `claude` run under a profile home
// reads -- and can rotate -- that profile's credentials, exactly like a session,
// but registered nowhere. The usage page's auto-refresh could therefore rotate the
// token under a live run (stranding the account), and a run could START mid-
// rotation and read the file before the new lineage landed. The spawner is the
// one choke point every headless run passes through, so it registers there.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

const spawnCalls: Array<{ executable: string; args: string[]; opts: any }> = []
let fakeChild: any

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    return fakeChild
  },
  execSync: vi.fn(),
}))
// withProfileHome pulls in the heavy pty-manager graph (reaches electron); stub it.
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: (env: any) => env }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { spawnClaudeHeadless, HEADLESS_CONSUMER_GRACE_MS } = await import('../../src/main/claude-headless')
const {
  hasTransientProfileConsumer,
  profileConsumerCount,
  noteProfileRefreshInFlight,
  _resetProfileConsumersForTest,
} = await import('../../src/main/profile-consumers')

/** A child whose 'close' / 'error' the test fires by hand. */
function makeChild() {
  const handlers: Record<string, (...a: any[]) => void> = {}
  return {
    pid: 4242,
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: (ev: string, cb: (...a: any[]) => void) => { handlers[ev] = cb },
    kill: vi.fn(),
    handlers,
  }
}

const PROFILE = 'profile-a1b2-ff'
const HOME = path.join(os.tmpdir(), 'account-profiles', PROFILE)
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await Promise.resolve() }

beforeEach(() => {
  spawnCalls.length = 0
  fakeChild = makeChild()
  _resetProfileConsumersForTest()
})

describe('spawnClaudeHeadless — the run is a profile consumer (#48)', () => {
  it('holds the profile from spawn until the child closes', async () => {
    const p = spawnClaudeHeadless(['-p'], 10_000, 'prompt', HOME)
    expect(spawnCalls).toHaveLength(1) // spawn is still synchronous when nothing is rotating
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    fakeChild.handlers.close(0)
    await p
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
  })

  it('releases on the error path', async () => {
    const p = spawnClaudeHeadless(['-p'], 10_000, undefined, HOME)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    fakeChild.handlers.error(new Error('spawn ENOENT'))
    await p
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
  })

  it('releases when the run times out (the child never closes)', async () => {
    const p = spawnClaudeHeadless(['-p'], 30, undefined, HOME)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    const res = await p
    expect(res.code).toBe(1)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
  })

  it('bounds the ref by the run\'s own kill timeout plus the grace, so a leaked ref is swept, a live run is not', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      spawnClaudeHeadless(['-p'], 600_000, undefined, HOME) // default 10-minute run; never settles here
      vi.setSystemTime(600_000 + HEADLESS_CONSUMER_GRACE_MS - 1)
      expect(hasTransientProfileConsumer(PROFILE)).toBe(true)  // the run is legitimately still alive
      vi.setSystemTime(600_000 + HEADLESS_CONSUMER_GRACE_MS)
      expect(hasTransientProfileConsumer(PROFILE)).toBe(false) // past the kill timeout + grace: a leak
    } finally {
      vi.useRealTimers()
    }
  })

  it('registers nothing for the default home or a non-profile path', async () => {
    const p1 = spawnClaudeHeadless(['--version'], 10_000)
    const p2 = spawnClaudeHeadless(['--version'], 10_000, undefined, '/home')
    expect(spawnCalls).toHaveLength(2)
    expect(profileConsumerCount('home')).toBe(0)
    fakeChild.handlers.close(0)
    await Promise.all([p1, p2])
  })

  it('still throws synchronously on an unsafe argv (the sink guard is untouched)', () => {
    expect(() => spawnClaudeHeadless(['-p', 'x;echo PWNED'], 10_000, undefined, HOME)).toThrow(/unsafe argv element/)
    expect(spawnCalls).toHaveLength(0)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false) // nothing acquired before the throw
  })
})

describe('spawnClaudeHeadless — starting mid-rotation waits for the refresh (#49)', () => {
  it('defers the spawn until an in-flight refresh of THIS profile settles, then holds as usual', async () => {
    let settle!: (v: unknown) => void
    noteProfileRefreshInFlight(PROFILE, new Promise((resolve) => { settle = resolve }))

    const p = spawnClaudeHeadless(['-p'], 10_000, undefined, HOME)
    await tick()
    expect(spawnCalls).toHaveLength(0) // not spawned: it would read a file mid-rotation
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false) // and holds nothing yet

    settle({ accessToken: 'new' })
    await tick()
    expect(spawnCalls).toHaveLength(1)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    fakeChild.handlers.close(0)
    await p
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
  })

  it('a refresh of ANOTHER profile does not delay this run', async () => {
    noteProfileRefreshInFlight('profile-other-00', new Promise(() => { /* never settles */ }))
    const p = spawnClaudeHeadless(['-p'], 10_000, undefined, HOME)
    expect(spawnCalls).toHaveLength(1)
    fakeChild.handlers.close(0)
    await p
  })

  it('a refresh that FAILS still releases the run to spawn (a failed refresh leaves the file untouched)', async () => {
    let fail!: (e: unknown) => void
    const refresh = new Promise((_r, reject) => { fail = reject })
    refresh.catch(() => { /* quiet */ })
    noteProfileRefreshInFlight(PROFILE, refresh)
    const p = spawnClaudeHeadless(['-p'], 10_000, undefined, HOME)
    fail(new Error('500'))
    await tick()
    expect(spawnCalls).toHaveLength(1)
    fakeChild.handlers.close(0)
    await p
  })
})
