// @vitest-environment node
//
// The transient-consumer registry (#258): a non-session credential consumer (the
// `claude auth status` probe) marks a profile in-use so the usage page's auto
// token-refresh treats it like a live session and won't rotate under it. The
// contract is ref-counted and release-idempotent — a leaked or double-released
// count would either block refresh forever or expose the profile mid-probe.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { acquireProfileConsumer, hasTransientProfileConsumer, PROFILE_CONSUMER_MAX_AGE_MS } from '../../src/main/profile-consumers'

afterEach(() => { vi.useRealTimers() })

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
