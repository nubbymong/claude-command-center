// @vitest-environment node
//
// The transient-consumer registry (#258): a non-session credential consumer (the
// `claude auth status` probe) marks a profile in-use so the usage page's auto
// token-refresh treats it like a live session and won't rotate under it. The
// contract is ref-counted and release-idempotent — a leaked or double-released
// count would either block refresh forever or expose the profile mid-probe.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  acquireProfileConsumer,
  hasTransientProfileConsumer,
  profileConsumerCount,
  noteProfileRefreshInFlight,
  pendingProfileRefresh,
  waitForProfileRefresh,
  _resetProfileConsumersForTest,
  PROFILE_CONSUMER_MAX_AGE_MS,
} from '../../src/main/profile-consumers'

afterEach(() => { vi.useRealTimers(); _resetProfileConsumersForTest() })

describe('profile-consumers', () => {
  it('is not in use until acquired, and is once acquired', () => {
    const id = 'profile-a-1'
    expect(hasTransientProfileConsumer(id)).toBe(false)
    const release = acquireProfileConsumer(id)
    expect(hasTransientProfileConsumer(id)).toBe(true)
    release()
    expect(hasTransientProfileConsumer(id)).toBe(false)
  })

  it('ref-counts overlapping consumers — in-use until the LAST release', () => {
    const id = 'profile-b-2'
    const r1 = acquireProfileConsumer(id)
    const r2 = acquireProfileConsumer(id)
    expect(hasTransientProfileConsumer(id)).toBe(true)
    r1()
    expect(hasTransientProfileConsumer(id)).toBe(true) // r2 still holds it
    r2()
    expect(hasTransientProfileConsumer(id)).toBe(false)
  })

  it('release is idempotent — a double call cannot drop another holder', () => {
    const id = 'profile-c-3'
    const r1 = acquireProfileConsumer(id)
    const r2 = acquireProfileConsumer(id)
    r1(); r1(); r1() // extra releases must be no-ops
    expect(hasTransientProfileConsumer(id)).toBe(true) // r2 unaffected
    r2()
    expect(hasTransientProfileConsumer(id)).toBe(false)
  })

  it('an empty profileId never registers', () => {
    const release = acquireProfileConsumer('')
    expect(hasTransientProfileConsumer('')).toBe(false)
    release()
  })

  it('self-heals a leaked ref: a consumer that never releases expires after the max age', () => {
    // A hung/orphaned probe can leave release() unrun. Without a sweep the profile
    // stays "in use" forever — refresh never fires and the account cannot be
    // deleted. hasTransientProfileConsumer must expire it once past the window.
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = 'profile-leak-9'
    acquireProfileConsumer(id) // deliberately never released
    expect(hasTransientProfileConsumer(id)).toBe(true)
    vi.setSystemTime(PROFILE_CONSUMER_MAX_AGE_MS - 1)
    expect(hasTransientProfileConsumer(id)).toBe(true)  // still inside the window
    vi.setSystemTime(PROFILE_CONSUMER_MAX_AGE_MS)
    expect(hasTransientProfileConsumer(id)).toBe(false) // leaked ref swept
  })

  it('a fresh acquire refreshes the window, so an overlapping live probe is not swept', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = 'profile-overlap-7'
    const r1 = acquireProfileConsumer(id)
    // A second probe starts just before the first would expire, extending the window.
    vi.setSystemTime(PROFILE_CONSUMER_MAX_AGE_MS - 1)
    const r2 = acquireProfileConsumer(id)
    vi.setSystemTime(PROFILE_CONSUMER_MAX_AGE_MS + 1) // past r1's original expiry
    expect(hasTransientProfileConsumer(id)).toBe(true) // r2 refreshed it
    r1(); r2()
    expect(hasTransientProfileConsumer(id)).toBe(false)
  })
})

// #48: the four long-lived consumers (headless run, Insights run, cloud agent,
// shell-only session) live for minutes to days, not the probe's seconds. Each
// ref carries its OWN leak bound, so a probe lapsing beside a running agent
// never sweeps the agent, and an agent's Infinity never keeps a leaked probe.
describe('profile-consumers — per-ref leak bounds (#48)', () => {
  it('a ref with maxAgeMs Infinity is never swept, while a probe ref beside it still is', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = 'profile-long-1'
    const releaseAgent = acquireProfileConsumer(id, { maxAgeMs: Infinity })
    acquireProfileConsumer(id) // a probe that (deliberately) never releases
    expect(profileConsumerCount(id)).toBe(2)
    vi.setSystemTime(PROFILE_CONSUMER_MAX_AGE_MS)
    expect(hasTransientProfileConsumer(id)).toBe(true) // the agent still holds it
    expect(profileConsumerCount(id)).toBe(1)          // the leaked probe was swept on its own clock
    vi.setSystemTime(24 * 3_600_000)
    expect(hasTransientProfileConsumer(id)).toBe(true) // a day later, still held
    releaseAgent()
    expect(hasTransientProfileConsumer(id)).toBe(false)
  })

  it('a bounded ref uses ITS maxAgeMs, not the default', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = 'profile-bounded-2'
    acquireProfileConsumer(id, { maxAgeMs: 5_000 })
    vi.setSystemTime(4_999)
    expect(hasTransientProfileConsumer(id)).toBe(true)
    vi.setSystemTime(5_000)
    expect(hasTransientProfileConsumer(id)).toBe(false)
  })

  it('a probe acquired AFTER a long ref does not shorten the long ref (no shared expiry)', () => {
    // The old single-entry model refreshed ONE expiry per profile on every
    // acquire — a probe starting beside an hour-long agent would have reset the
    // agent's clock to 30s. Each ref must be judged alone.
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const id = 'profile-mixed-3'
    acquireProfileConsumer(id, { maxAgeMs: Infinity })
    vi.setSystemTime(10_000)
    const releaseProbe = acquireProfileConsumer(id)
    vi.setSystemTime(10_000 + PROFILE_CONSUMER_MAX_AGE_MS + 1)
    expect(hasTransientProfileConsumer(id)).toBe(true)
    expect(profileConsumerCount(id)).toBe(1)
    releaseProbe() // releasing an already-swept ref is a harmless no-op
    expect(profileConsumerCount(id)).toBe(1)
  })
})

// #49: the OTHER ordering of the stranding race. A consumer that starts while a
// refresh POST is in flight would read the old credential file and later redeem
// the same single-use refresh token. The refresh publishes itself; a consumer
// that can wait, waits.
describe('profile-consumers — in-flight refresh (#49)', () => {
  it('nothing in flight: pendingProfileRefresh is null and waitForProfileRefresh resolves at once', async () => {
    expect(pendingProfileRefresh('profile-idle-4')).toBeNull()
    let done = false
    await waitForProfileRefresh('profile-idle-4').then(() => { done = true })
    expect(done).toBe(true)
  })

  it('a consumer starting mid-refresh waits until the refresh RESOLVES', async () => {
    const id = 'profile-rotating-5'
    let settle!: (v: unknown) => void
    const refresh = new Promise((resolve) => { settle = resolve })
    noteProfileRefreshInFlight(id, refresh)
    expect(pendingProfileRefresh(id)).not.toBeNull()

    let started = false
    const consumer = waitForProfileRefresh(id).then(() => { started = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toBe(false) // still rotating: the consumer has not started

    settle({ accessToken: 'new' })
    await consumer
    expect(started).toBe(true)
    expect(pendingProfileRefresh(id)).toBeNull() // cleared once settled
  })

  it('a refresh that REJECTS also releases the waiter, and never rejects it', async () => {
    const id = 'profile-failing-6'
    let fail!: (e: unknown) => void
    const refresh = new Promise((_resolve, reject) => { fail = reject })
    refresh.catch(() => { /* the registry attaches its own handlers; this one just keeps the test quiet */ })
    noteProfileRefreshInFlight(id, refresh)
    const waiter = waitForProfileRefresh(id)
    fail(new Error('token endpoint 500'))
    await expect(waiter).resolves.toBeUndefined()
    expect(pendingProfileRefresh(id)).toBeNull()
  })

  it('an older refresh settling does not clear a NEWER one for the same profile', async () => {
    const id = 'profile-overlap-7'
    let settleOld!: (v: unknown) => void
    let settleNew!: (v: unknown) => void
    const older = new Promise((resolve) => { settleOld = resolve })
    const newer = new Promise((resolve) => { settleNew = resolve })
    noteProfileRefreshInFlight(id, older)
    noteProfileRefreshInFlight(id, newer)
    settleOld(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(pendingProfileRefresh(id)).not.toBeNull() // the newer refresh is still the one in flight
    settleNew(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(pendingProfileRefresh(id)).toBeNull()
  })

  it('an empty profileId registers nothing', () => {
    noteProfileRefreshInFlight('', Promise.resolve())
    expect(pendingProfileRefresh('')).toBeNull()
  })
})
