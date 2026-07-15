import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub Electron so the module resolves; pushAccountIdentity becomes a no-op
// (no identity file exists during this test, so it is never reached anyway).
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

// The async poll must do its per-tick mtime check WITHOUT calling the sync fs API.
// We also make the ASYNC stat slow + counted so the concurrency guard is observable:
// two overlapping recheckAllAsync calls must only fan out ONE stat.
// `vi.hoisted` so the spy exists before the hoisted vi.mock factory runs.
const { asyncStat } = vi.hoisted(() => ({
  asyncStat: vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); throw new Error('ENOENT') }),
}))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return {
    ...real,
    statSync: vi.fn(() => { throw new Error('statSync must not run on the poll tick') }),
    promises: { ...real.promises, stat: asyncStat },
  }
})

import * as identity from '../../../src/main/claude-account-identity'

describe('recheckAllAsync', () => {
  beforeEach(() => identity._resetForTest?.())

  it('exists and resolves without calling statSync on the tick path', async () => {
    identity.startWatchingAccountIdentity('s1', undefined)
    await expect(identity.recheckAllAsync()).resolves.toBeUndefined()
  })

  it('does not run recheckAllAsync concurrently (in-flight guard)', async () => {
    identity.startWatchingAccountIdentity('s1', undefined)
    asyncStat.mockClear()
    expect(identity.__isRecheckInFlightForTest()).toBe(false)
    // Two overlapping calls without awaiting the first; the second must short-circuit
    // (return immediately) so only the first iterates the watched sessions.
    const first = identity.recheckAllAsync()
    const second = identity.recheckAllAsync()
    expect(identity.__isRecheckInFlightForTest()).toBe(true)
    await Promise.all([first, second])
    expect(identity.__isRecheckInFlightForTest()).toBe(false)
    // The slow stat ran exactly ONCE (the second call short-circuited at the guard).
    expect(asyncStat).toHaveBeenCalledTimes(1)
  })
})
