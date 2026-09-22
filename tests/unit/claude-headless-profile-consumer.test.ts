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
/** One fake child per spawn, in spawn order, so a test with two runs settles each on its own. */
const children: Array<ReturnType<typeof makeChild>> = []

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    const child = makeChild()
    children.push(child)
    return child
  },
  execSync: vi.fn(),
}))
// withProfileHome pulls in the heavy pty-manager graph (reaches electron); stub it.
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: (env: any) => env }))
// `logWarn` belongs in this mock's surface too: the project gate below logs
// through it, and a mock that omits a function the code under test calls turns
// a log line into a TypeError inside the scan's own catch -- which then looks
// exactly like a directory that carries nothing.
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { spawnClaudeHeadless, HEADLESS_CONSUMER_GRACE_MS } = await import('../../src/main/claude-headless')
const {
  hasTransientProfileConsumer,
  profileConsumerCount,
  noteProfileRefreshInFlight,
  _resetProfileConsumersForTest,
} = await import('../../src/main/profile-consumers')
// The project-settings gate (2026-09-22). A headless run inherits this
// process's working directory, and that directory's own settings files are
// gated like any other launch's. The spawn stays SYNCHRONOUS on a cache hit
// (`peekGateVerdict`), which is what lets overlapping runs for one profile
// share a single subprocess; only a MISS defers it.
const { gateManagedLaunch, peekGateVerdict, _resetProjectScanStateForTest } =
  await import('../../src/main/managed-launch-diagnostics')

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
// The shape getProfileConfigDir builds: <resources>/account-profiles/<id>. The
// coupling of that root name to profile-id.ts is pinned against the REAL
// getProfileConfigDir in tests/unit/main/profile-id.test.ts.
const HOME = path.join(os.tmpdir(), 'account-profiles', PROFILE)
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await Promise.resolve() }

beforeEach(async () => {
  spawnCalls.length = 0
  children.length = 0
  _resetProfileConsumersForTest()
  _resetProjectScanStateForTest()
  // WARM the gate for this process's directory, so the cases below drive the
  // synchronous path they are about (the hold, the release, the timeout clock)
  // rather than whichever earlier test happened to leave a verdict cached --
  // the reuse window is five seconds, so a slow run would otherwise flip them.
  // The one case that is ABOUT the miss resets this itself.
  await gateManagedLaunch(process.cwd())
})

describe('spawnClaudeHeadless — the run is a profile consumer (#48)', () => {
  it('holds the profile from spawn until the child closes', async () => {
    const p = spawnClaudeHeadless(['-p'], 10_000, 'prompt', HOME)
    // Still synchronous: nothing is rotating and the gate verdict for this
    // directory is cached (see beforeEach).
    expect(spawnCalls).toHaveLength(1)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    children[0].handlers.close(0)
    await p
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
  })

  it('releases on the error path', async () => {
    const p = spawnClaudeHeadless(['-p'], 10_000, undefined, HOME)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    children[0].handlers.error(new Error('spawn ENOENT'))
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
    children[0].handlers.close(0)
    children[1].handlers.close(0)
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
    // ...but already HELD (adversarial pass on #598): the hold is what stops a
    // NEW rotation from starting in the gap between this one settling and the spawn.
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)

    settle({ accessToken: 'new' })
    await tick()
    expect(spawnCalls).toHaveLength(1)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    children[0].handlers.close(0)
    await p
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
  })

  it('a refresh of ANOTHER profile does not delay this run', async () => {
    noteProfileRefreshInFlight('profile-other-00', new Promise(() => { /* never settles */ }))
    const p = spawnClaudeHeadless(['-p'], 10_000, undefined, HOME)
    expect(spawnCalls).toHaveLength(1)
    children[0].handlers.close(0)
    await p
  })

  it('the FIRST run for a directory defers behind the project gate, and holds the profile across it', async () => {
    // The cache miss. `peekGateVerdict` answers synchronously only once a scan
    // has run for that directory, so the first headless run of the process --
    // and one after the five-second reuse window -- awaits the gate before it
    // spawns. The hold must be taken BEFORE that wait, for the same reason it
    // is taken before the refresh wait: it is what stops a new rotation
    // starting in the gap, and the run is about to read the credential file.
    _resetProjectScanStateForTest()
    expect(peekGateVerdict(process.cwd()), 'the gate was still warm').toBeUndefined()

    const p = spawnClaudeHeadless(['-p'], 10_000, undefined, HOME)
    expect(spawnCalls, 'the first run spawned before the gate answered').toHaveLength(0)
    expect(hasTransientProfileConsumer(PROFILE), 'the hold was taken only after the gate').toBe(true)

    for (let i = 0; i < 400 && spawnCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls, 'the run never spawned after the gate answered').toHaveLength(1)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    // ...and the verdict is now cached, so the NEXT run is synchronous again.
    expect(peekGateVerdict(process.cwd())).toEqual({ status: 'clean' })
    children[0].handlers.close(0)
    await p
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
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
    children[0].handlers.close(0)
    await p
  })
})
