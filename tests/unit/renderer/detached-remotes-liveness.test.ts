/**
 * SSH Persistent — the renderer reconcile helpers over the liveness map.
 *
 * These encode the fail-open/closed rules the whole feature turns on:
 *   - OFFER (resume surface): hide only a CONFIRMED-dead remote; a checking /
 *     unverified / live remote is still offered (fail-open — reattach self-heals).
 *   - PRUNE (registry): drop VERIFIED-dead only — never on an 'unverified' probe.
 *   - AMBER count: VERIFIED-live only — never "maybe".
 */
import { describe, it, expect } from 'vitest'
import {
  markChecking,
  applyLivenessResult,
  offerableEntries,
  hasUnverifiedOffer,
  deadSessionIds,
  verifiedLiveCount,
  type LivenessMap,
} from '../../../src/renderer/utils/detachedRemotesLiveness'
import type { DetachedRemote, DetachedRemoteLiveness } from '../../../src/shared/types'

const entry = (id: string): DetachedRemote => ({
  sessionId: id,
  configId: 'cfg-1',
  host: 'pi.local',
  username: 'mong',
  remotePath: '~/work',
  mux: 'tmux',
  label: id,
  detachedAt: 1,
})

const entries = [entry('a'), entry('b'), entry('c')]

describe('markChecking / applyLivenessResult', () => {
  it('marks queried ids as checking without disturbing others', () => {
    const m = markChecking({ z: 'live' }, ['a', 'b'])
    expect(m).toEqual({ z: 'live', a: 'checking', b: 'checking' })
  })

  it('a verified result splits queried ids into live and dead', () => {
    const result: DetachedRemoteLiveness = { outcome: 'verified', liveSessionIds: ['a'] }
    const m = applyLivenessResult({}, ['a', 'b', 'c'], result)
    expect(m).toEqual({ a: 'live', b: 'dead', c: 'dead' })
  })

  it('an unverified result marks every queried id unverified (fail-open)', () => {
    const result: DetachedRemoteLiveness = { outcome: 'unverified', liveSessionIds: [] }
    const m = applyLivenessResult({ a: 'checking' }, ['a', 'b'], result)
    expect(m).toEqual({ a: 'unverified', b: 'unverified' })
  })
})

describe('offerableEntries (resume surface; fail-open — hide only confirmed-dead)', () => {
  it('offers live, unverified, checking and not-yet-checked; hides confirmed-dead', () => {
    const map: LivenessMap = { a: 'live', b: 'dead', c: 'unverified' }
    expect(offerableEntries(entries, map).map((e) => e.sessionId)).toEqual(['a', 'c'])
  })

  it('offers everything while all are still checking', () => {
    const map: LivenessMap = { a: 'checking', b: 'checking', c: 'checking' }
    expect(offerableEntries(entries, map)).toHaveLength(3)
  })

  it('offers everything before any probe has run (empty map)', () => {
    expect(offerableEntries(entries, {})).toHaveLength(3)
  })

  it('hides all when all are confirmed dead (drives the dialog empty-state)', () => {
    const map: LivenessMap = { a: 'dead', b: 'dead', c: 'dead' }
    expect(offerableEntries(entries, map)).toHaveLength(0)
  })
})

describe('hasUnverifiedOffer', () => {
  it('is true when an OFFERED entry is unverified', () => {
    expect(hasUnverifiedOffer(entries, { a: 'live', b: 'dead', c: 'unverified' })).toBe(true)
  })
  it('is false when the only unverified entry is not offered (it is dead — impossible, but guards the AND)', () => {
    expect(hasUnverifiedOffer(entries, { a: 'live', b: 'live', c: 'live' })).toBe(false)
  })
})

describe('deadSessionIds (prune set)', () => {
  it('returns verified-dead ids', () => {
    expect(deadSessionIds(['a', 'b', 'c'], { outcome: 'verified', liveSessionIds: ['b'] })).toEqual(['a', 'c'])
  })

  it('returns NOTHING on an unverified outcome — never prune a host that was merely unreachable', () => {
    expect(deadSessionIds(['a', 'b', 'c'], { outcome: 'unverified', liveSessionIds: [] })).toEqual([])
  })
})

describe('verifiedLiveCount (amber counter)', () => {
  it('counts only verified-live entries', () => {
    expect(verifiedLiveCount(entries, { a: 'live', b: 'dead', c: 'unverified' })).toBe(1)
  })
  it('is 0 when only unverified/checking are present (never counts "maybe")', () => {
    expect(verifiedLiveCount(entries, { a: 'unverified', b: 'checking' })).toBe(0)
  })
})
