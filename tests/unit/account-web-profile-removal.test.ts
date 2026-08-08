// #216 — the sign-in profile dir must not survive, because it holds a live session.
//
// Observed twice on 2026-08-08: the harvest succeeded, teardown ran, and
// `rmSync` threw EPERM because the browser's child processes still held the
// directory. What stayed on disk was a browser profile containing `sessionKey`.
// The old behaviour gave up there and left it to `sweepAbandonedProfiles` at the
// next app start — which could be days away, or never.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const rmSyncMock = vi.fn()
const existsSyncMock = vi.fn(() => true)
const logs: string[] = []

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: (m: string) => { logs.push(m) },
  logError: (m: string) => { logs.push(m) },
}))
vi.mock('../../src/main/vision-manager', () => ({ getBrowserPaths: () => [] }))
vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('node:fs', () => ({
  existsSync: (...a: any[]) => (existsSyncMock as any)(...a),
  readFileSync: () => '',
  readdirSync: () => [],
  rmSync: (...a: any[]) => rmSyncMock(...a),
}))

const { retryProfileRemoval, PROFILE_REMOVAL_RETRIES_MS } = await import('../../src/main/account-web/sign-in')

const DIR = 'C:/data/account-web/profile-aaa111'

beforeEach(() => {
  vi.useFakeTimers()
  rmSyncMock.mockReset()
  existsSyncMock.mockReset()
  existsSyncMock.mockReturnValue(true)
  logs.length = 0
})
afterEach(() => { vi.useRealTimers() })

describe('retryProfileRemoval', () => {
  it('keeps trying until the directory finally goes', async () => {
    // Locked, locked, then free — the shape of a browser tree shutting down.
    rmSyncMock
      .mockImplementationOnce(() => { throw new Error('EPERM, Permission denied') })
      .mockImplementationOnce(() => { throw new Error('EPERM, Permission denied') })
      .mockImplementationOnce(() => undefined)

    retryProfileRemoval(DIR, [10, 10, 10])
    await vi.advanceTimersByTimeAsync(100)

    expect(rmSyncMock).toHaveBeenCalledTimes(3)
    expect(rmSyncMock).toHaveBeenLastCalledWith(DIR, expect.objectContaining({ recursive: true, force: true }))
    expect(logs.join('\n')).toMatch(/removed the sign-in profile dir on retry 3/)
  })

  it('stops as soon as the directory is gone, without deleting anything else', async () => {
    existsSyncMock.mockReturnValue(false)
    retryProfileRemoval(DIR, [10, 10, 10])
    await vi.advanceTimersByTimeAsync(100)
    expect(rmSyncMock).not.toHaveBeenCalled()
  })

  it('says plainly that a live session is still on disk when it runs out of retries', async () => {
    rmSyncMock.mockImplementation(() => { throw new Error('EPERM, Permission denied') })

    retryProfileRemoval(DIR, [10, 10])
    await vi.advanceTimersByTimeAsync(100)

    expect(rmSyncMock).toHaveBeenCalledTimes(2)
    // The operator has to be able to tell this apart from a tidy-up nit.
    expect(logs.join('\n')).toMatch(/holds a live session/)
  })

  it('does nothing at all when given no delays', async () => {
    retryProfileRemoval(DIR, [])
    await vi.advanceTimersByTimeAsync(1000)
    expect(rmSyncMock).not.toHaveBeenCalled()
  })

  it('backs off over roughly a minute by default', () => {
    // Long enough to outlast a slow browser shutdown, short enough that the
    // window is closed within the same session rather than at the next boot.
    expect([...PROFILE_REMOVAL_RETRIES_MS]).toEqual([2_000, 5_000, 15_000, 45_000])
    expect(PROFILE_REMOVAL_RETRIES_MS.reduce((a, b) => a + b, 0)).toBeGreaterThan(60_000)
  })
})
