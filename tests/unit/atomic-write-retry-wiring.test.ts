import { describe, it, expect, beforeEach, vi } from 'vitest'

// isTransientRenameError is well tested as a pure function. The WIRING is what
// round 1 got wrong: a platform baked in at the call site silently removes the
// EPERM/EACCES retry on Windows — the exact race #213 exists to fix — and every
// pure-function test still passes. So assert the live behaviour of
// renameWithRetry itself, and assert the retry option is honoured.

const h = vi.hoisted(() => ({
  code: 'EPERM',
  attempts: 0
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    renameSync: () => {
      h.attempts++
      const e = new Error(`${h.code}: simulated`) as NodeJS.ErrnoException
      e.code = h.code
      throw e
    }
  }
  return { ...patched, default: patched }
})

import { renameWithRetry } from '../../src/main/atomic-write'

/** Six = the first try plus the five backoff steps. */
const FULL_BUDGET = 6
const IS_WIN = process.platform === 'win32'

describe('renameWithRetry uses the LIVE platform, not a baked one', () => {
  beforeEach(() => { h.attempts = 0; h.code = 'EPERM' })

  it('spends the whole budget on EPERM on Windows, and gives up at once elsewhere', () => {
    expect(() => renameWithRetry('a', 'b')).toThrow(/EPERM/)
    expect(h.attempts).toBe(IS_WIN ? FULL_BUDGET : 1)
  })

  it('same for EACCES', () => {
    h.code = 'EACCES'
    expect(() => renameWithRetry('a', 'b')).toThrow(/EACCES/)
    expect(h.attempts).toBe(IS_WIN ? FULL_BUDGET : 1)
  })

  it('spends the whole budget on EBUSY on EVERY platform', () => {
    h.code = 'EBUSY'
    expect(() => renameWithRetry('a', 'b')).toThrow(/EBUSY/)
    expect(h.attempts).toBe(FULL_BUDGET)
  })

  it('never retries an error a wait cannot fix, on any platform', () => {
    h.code = 'ENOSPC'
    expect(() => renameWithRetry('a', 'b')).toThrow(/ENOSPC/)
    expect(h.attempts).toBe(1)
  })

  it('honours retry:false, and only a literal false disables it', () => {
    h.code = 'EBUSY'

    expect(() => renameWithRetry('a', 'b', false)).toThrow(/EBUSY/)
    expect(h.attempts).toBe(1)

    // A sloppy caller value must fail SAFE — still retrying, never silently off.
    // This was NOT true at first: the guard was `!retry`, so null/0/'' quietly
    // disabled the retry while the option's whole point is that only an explicit
    // opt-out does.
    for (const sloppy of [undefined, null, 0, '', NaN] as unknown[]) {
      h.attempts = 0
      expect(() => renameWithRetry('a', 'b', sloppy as boolean)).toThrow(/EBUSY/)
      expect(h.attempts, `retry=${String(sloppy)}`).toBe(FULL_BUDGET)
    }
  })
})
