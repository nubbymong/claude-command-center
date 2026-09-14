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
  distinctHosts,
  foldPingResult,
  isHostDemoted,
  recoveredHosts,
  displayLiveness,
  DEMOTE_AFTER_FAILURES,
  type LivenessMap,
  type HostReachabilityMap,
} from '../../../src/renderer/utils/detachedRemotesLiveness'
import type { DetachedRemote, DetachedRemoteLiveness } from '../../../src/shared/types'

const entry = (id: string, host = 'pi.local'): DetachedRemote => ({
  sessionId: id,
  configId: 'cfg-1',
  host,
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
  it('stops counting entries on a DEMOTED host (tier 1 takes state away)', () => {
    const hosts: HostReachabilityMap = { 'pi.local': { reachable: false, consecutiveFailures: 2, lastCheckedAt: 1 } }
    expect(verifiedLiveCount(entries, { a: 'live', b: 'live', c: 'live' })).toBe(3)
    expect(verifiedLiveCount(entries, { a: 'live', b: 'live', c: 'live' }, hosts)).toBe(0)
  })
})

// ── Tier 1: host reachability ──────────────────────────────────────────────

describe('distinctHosts (one ping per HOST, not per entry)', () => {
  it('dedupes three entries on one host down to a single host', () => {
    expect(distinctHosts([entry('a'), entry('b'), entry('c')])).toEqual(['pi.local'])
  })
  it('keeps distinct hosts in first-seen order', () => {
    expect(distinctHosts([entry('a', 'mac'), entry('b', 'pi'), entry('c', 'mac')])).toEqual(['mac', 'pi'])
  })
  it('is empty for an empty registry', () => {
    expect(distinctHosts([])).toEqual([])
  })
})

describe('foldPingResult (DEMOTE-ONLY)', () => {
  it('a reachable ping records reachability and NOTHING about any session', () => {
    const m = foldPingResult({}, 'pi.local', true, 10)
    expect(m['pi.local']).toEqual({ reachable: true, consecutiveFailures: 0, lastCheckedAt: 10 })
    // The crucial negative: a successful ping cannot make an entry 'live'.
    expect(displayLiveness(entry('a'), {}, m)).toBe('unknown')
    expect(displayLiveness(entry('a'), { a: 'unverified' }, m)).toBe('unverified')
  })

  it('ONE failure does not demote — it only arms the counter', () => {
    const m = foldPingResult({}, 'pi.local', false, 10)
    expect(m['pi.local'].consecutiveFailures).toBe(1)
    expect(m['pi.local'].reachable).toBe(true)
    expect(isHostDemoted(m, 'pi.local')).toBe(false)
  })

  it('the SECOND consecutive failure demotes the host', () => {
    let m = foldPingResult({}, 'pi.local', false, 10)
    m = foldPingResult(m, 'pi.local', false, 20)
    expect(m['pi.local'].consecutiveFailures).toBe(DEMOTE_AFTER_FAILURES)
    expect(isHostDemoted(m, 'pi.local')).toBe(true)
  })

  it('a success between failures RESETS the counter, so it takes two more to demote', () => {
    let m = foldPingResult({}, 'pi.local', false, 10)
    m = foldPingResult(m, 'pi.local', true, 20)
    expect(m['pi.local'].consecutiveFailures).toBe(0)
    m = foldPingResult(m, 'pi.local', false, 30)
    expect(isHostDemoted(m, 'pi.local')).toBe(false)
    m = foldPingResult(m, 'pi.local', false, 40)
    expect(isHostDemoted(m, 'pi.local')).toBe(true)
  })

  it('leaves other hosts untouched', () => {
    const prev = foldPingResult({}, 'mac', true, 5)
    const next = foldPingResult(prev, 'pi', false, 6)
    expect(next.mac).toEqual(prev.mac)
  })

  it('an unknown host is not demoted', () => {
    expect(isHostDemoted({}, 'never-seen')).toBe(false)
    expect(isHostDemoted(undefined, 'never-seen')).toBe(false)
  })
})

describe('recoveredHosts (the "host came back" transition)', () => {
  it('reports a host that went demoted -> reachable', () => {
    const prev: HostReachabilityMap = { pi: { reachable: false, consecutiveFailures: 2, lastCheckedAt: 1 } }
    const next = foldPingResult(prev, 'pi', true, 2)
    expect(recoveredHosts(prev, next)).toEqual(['pi'])
  })

  it('reports NOTHING for a host that was never demoted (a single flaky failure costs no ssh)', () => {
    const prev = foldPingResult({}, 'pi', false, 1)
    const next = foldPingResult(prev, 'pi', true, 2)
    expect(recoveredHosts(prev, next)).toEqual([])
  })

  it('reports nothing while a demoted host STAYS down, and nothing once it stays up', () => {
    const down: HostReachabilityMap = { pi: { reachable: false, consecutiveFailures: 2, lastCheckedAt: 1 } }
    expect(recoveredHosts(down, foldPingResult(down, 'pi', false, 2))).toEqual([])
    const up = foldPingResult(down, 'pi', true, 3)
    expect(recoveredHosts(up, foldPingResult(up, 'pi', true, 4))).toEqual([])
  })
})

describe('displayLiveness (both tiers folded, strongest evidence first)', () => {
  const demoted: HostReachabilityMap = { 'pi.local': { reachable: false, consecutiveFailures: 2, lastCheckedAt: 1 } }

  it('an unreachable host outranks a STALE verified-live', () => {
    expect(displayLiveness(entry('a'), { a: 'live' }, demoted)).toBe('unreachable')
  })
  it('a VERIFIED dead outranks unreachable — an authenticated answer beats an inferred one', () => {
    expect(displayLiveness(entry('a'), { a: 'dead' }, demoted)).toBe('dead')
  })
  it('passes tier-2 state through when the host is fine', () => {
    const ok = foldPingResult({}, 'pi.local', true, 1)
    expect(displayLiveness(entry('a'), { a: 'live' }, ok)).toBe('live')
    expect(displayLiveness(entry('a'), { a: 'checking' }, ok)).toBe('checking')
  })
  it('is unknown for an entry nothing has checked', () => {
    expect(displayLiveness(entry('a'), {})).toBe('unknown')
  })
})
