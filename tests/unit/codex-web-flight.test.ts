// [host] WP2 PR 4, P4.6 second half (row 58): one web sign-in at a time ACROSS
// services. Claude's claude.ai sign-in (sign-in.ts) refuses to start while a
// Codex account's chatgpt.com sign-in is in flight, and reports its own run to
// the shared probe (sign-in-flight.ts) so the Codex side refuses in turn.
// Claude's routing is mocked (no window, no browser) exactly as
// account-web-sign-in.test.ts mocks it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const wiped: string[] = []
vi.mock('electron', () => ({
  session: { fromPartition: vi.fn((p: string) => ({ cookies: { set: vi.fn() }, clearStorageData: vi.fn(async () => { wiped.push(p) }) })) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/browser-paths', () => ({ getBrowserPaths: () => ['C:/nonexistent/chrome.exe'] }))
vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: () => false, readFileSync: () => '', readdirSync: () => [], rmSync: vi.fn() }))

let finishInApp: (v: unknown) => void = () => {}
const runInAppSignInMock = vi.fn(() => new Promise((r) => { finishInApp = r }))
const runServiceSignInMock = vi.fn(async (): Promise<unknown> => { throw new Error('simulated failure inside the run') })
vi.mock('../../src/main/account-web/in-app-sign-in', () => ({
  runInAppSignIn: () => runInAppSignInMock(),
  runServiceSignIn: () => runServiceSignInMock(),
  closeInAppSignInWindow: vi.fn(),
  createSignInWindowHandle: () => ({ window: null }),
  bounded: <T>(p: Promise<T>) => p,
}))

const { runSignIn } = await import('../../src/main/account-web/sign-in')
const { registerSignInFlight, signInInFlightElsewhere } = await import('../../src/main/account-web/sign-in-flight')
const CWS = await import('../../src/main/account-web/codex-web-session')

let codexBusy = false
beforeEach(() => {
  codexBusy = false
  registerSignInFlight('codex', () => codexBusy)
  runInAppSignInMock.mockClear()
})

describe("[host] Claude's sign-in and the cross-service single flight", () => {
  it('refuses to start while a Codex sign-in is in flight, before any window', async () => {
    codexBusy = true
    const st = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/fake/data', method: 'claudeai' })
    expect(st.phase).toBe('failed')
    expect(st.error).toMatch(/already in progress/)
    expect(runInAppSignInMock).not.toHaveBeenCalled()
  })

  it('a probe that throws counts as in flight (fail closed)', async () => {
    registerSignInFlight('codex', () => { throw new Error('probe failed') })
    const st = await runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/fake/data', method: 'claudeai' })
    expect(st.error).toMatch(/already in progress/)
    expect(runInAppSignInMock).not.toHaveBeenCalled()
  })

  it('reports its own run to the Codex side while it is in flight, and stops when it ends', async () => {
    const run = runSignIn({ profileId: 'profile-aaa111', dataDir: 'C:/fake/data', method: 'claudeai' })
    await new Promise((r) => setTimeout(r, 0))
    expect(runInAppSignInMock).toHaveBeenCalledTimes(1)
    expect(signInInFlightElsewhere('codex')).toBe(true)
    finishInApp({ ok: false, error: 'Sign-in cancelled.', cancelled: true })
    await run
    expect(signInInFlightElsewhere('codex')).toBe(false)
  })
})

describe('[host] the Codex run keeps its never-throw contract whatever its window does', () => {
  it('a failure thrown inside the run ends it failed, wipes the partition and releases the single flight', async () => {
    const ACCT = 'acct-0123456789abcdef'
    wiped.length = 0
    const st = await CWS.runCodexWebSignIn({ accountId: ACCT, pollMs: 5 })
    expect(st).toMatchObject({ phase: 'failed', accountId: ACCT, error: expect.stringMatching(/simulated failure/) })
    expect(wiped).toEqual([`persist:codex-web-${ACCT}`])
    expect(CWS.getCodexWebSignInState().phase).toBe('failed')
  })
})
