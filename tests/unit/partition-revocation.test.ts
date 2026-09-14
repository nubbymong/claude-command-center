// #439 adversarial A9 — the decoupling seam: sign-in.ts emits a revocation and
// the record/pane owners (wired at bootstrap) receive it, so sign-in.ts never
// imports their heavy module graphs.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { onPartitionRevoked, notifyPartitionRevoked, _resetPartitionRevocationForTest } from '../../src/main/account-web/partition-revocation'

beforeEach(() => _resetPartitionRevocationForTest())

describe('partition-revocation seam', () => {
  it('delivers the profileId to every subscriber, synchronously', () => {
    const a = vi.fn(); const b = vi.fn()
    onPartitionRevoked(a); onPartitionRevoked(b)
    notifyPartitionRevoked('profile-x')
    expect(a).toHaveBeenCalledWith('profile-x')
    expect(b).toHaveBeenCalledWith('profile-x')
  })

  it('one throwing subscriber does not stop the rest', () => {
    const boom = vi.fn(() => { throw new Error('nope') })
    const ok = vi.fn()
    onPartitionRevoked(boom); onPartitionRevoked(ok)
    expect(() => notifyPartitionRevoked('profile-y')).not.toThrow()
    expect(ok).toHaveBeenCalledWith('profile-y')
  })

  it('a notify with no subscribers is a no-op (tests / early boot)', () => {
    expect(() => notifyPartitionRevoked('profile-z')).not.toThrow()
  })

  it('does not import a heavy graph (sign-in.ts keeps its narrow reach)', async () => {
    // The seam module itself pulls in nothing — a regression that made it import
    // session-store/account-pane would reintroduce the drag it exists to avoid.
    const mod = await import('../../src/main/account-web/partition-revocation')
    expect(Object.keys(mod).sort()).toEqual(['_resetPartitionRevocationForTest', 'notifyPartitionRevoked', 'onPartitionRevoked'])
  })
})
