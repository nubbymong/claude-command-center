// @vitest-environment node
//
// Re-attack round 2, item 6: a launch waiting on a profile's token refresh
// (waitForProfileRefresh) also waits for a pending macOS Keychain write-back
// of a refreshed token -- BOUNDED, failing open to the launch (with a log) if
// the Keychain stays unanswered. Nothing pending = nothing to wait for (null),
// so a synchronous spawn stays synchronous.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  setPendingWriteBackSettler, pendingProfileRefresh, waitForProfileRefresh, noteProfileRefreshInFlight,
  PENDING_WRITE_BACK_WAIT_MS,
} from '../../src/main/profile-consumers'

afterEach(() => { setPendingWriteBackSettler(null); vi.useRealTimers() })

describe('pending write-back settle on launch', () => {
  it('nothing pending: no wait at all (null)', () => {
    setPendingWriteBackSettler(() => null)
    expect(pendingProfileRefresh('profile-a')).toBeNull()
  })

  it('pending: the launch waits for the write-back to settle', async () => {
    let settled = false
    setPendingWriteBackSettler(() => new Promise<void>((r) => setTimeout(() => { settled = true; r() }, 5)))
    await waitForProfileRefresh('profile-a')
    expect(settled).toBe(true)
  })

  it('after an in-flight refresh, the write-back is settled too, in that order', async () => {
    const order: string[] = []
    let release!: () => void
    noteProfileRefreshInFlight('profile-b', new Promise<void>((r) => { release = () => { order.push('refresh'); r() } }))
    setPendingWriteBackSettler(() => Promise.resolve().then(() => { order.push('write-back') }))
    const w = waitForProfileRefresh('profile-b')
    release()
    await w
    expect(order).toEqual(['refresh', 'write-back'])
  })

  it('a Keychain that never answers: the launch goes ahead after the bound, and it is logged', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPendingWriteBackSettler(() => new Promise<void>(() => { /* never */ }))
    let done = false
    const w = waitForProfileRefresh('profile-c').then(() => { done = true })
    await vi.advanceTimersByTimeAsync(PENDING_WRITE_BACK_WAIT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await w
    expect(done).toBe(true)
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/did not settle/)
    warn.mockRestore()
  })
})
