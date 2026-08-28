import { describe, it, expect } from 'vitest'
import {
  pickRemoteMcpPort,
  getRemoteMcpPort,
  releaseRemoteMcpPort,
  _getRemoteMcpPortForTest,
} from '../../src/main/ssh-remote-port'

describe('pickRemoteMcpPort (#24)', () => {
  it('returns a port in range not already used', () => {
    const p = pickRemoteMcpPort(new Set(), () => 0.5, 20000, 60000)
    expect(p).toBe(20000 + Math.floor(0.5 * 40001))
    expect(p).toBeGreaterThanOrEqual(20000)
    expect(p).toBeLessThanOrEqual(60000)
  })

  it('skips a used port and advances the rng', () => {
    // First rng() lands on a used port, second lands free.
    const used = new Set([20000])
    let calls = 0
    const rng = () => (calls++ === 0 ? 0 : 0.5) // 0 -> 20000 (used), then 0.5
    const p = pickRemoteMcpPort(used, rng, 20000, 60000)
    expect(p).not.toBe(20000)
  })

  it('throws when the range is exhausted', () => {
    const used = new Set([20000, 20001])
    expect(() => pickRemoteMcpPort(used, () => 0, 20000, 20001)).toThrow(/no free port/)
  })
})

describe('getRemoteMcpPort (#24 stable per-session mapping)', () => {
  it('is stable across calls for one session (reconnect keeps the same port)', () => {
    const sid = 'sess-stable-' + Math.random().toString(36).slice(2)
    const first = getRemoteMcpPort(sid, 19333)
    const second = getRemoteMcpPort(sid, 19333)
    expect(second).toBe(first)
    releaseRemoteMcpPort(sid)
  })

  it('gives DISTINCT ports to two concurrent sessions', () => {
    const a = 'sess-a-' + Math.random().toString(36).slice(2)
    const b = 'sess-b-' + Math.random().toString(36).slice(2)
    const pa = getRemoteMcpPort(a, 19333)
    const pb = getRemoteMcpPort(b, 19333)
    expect(pa).not.toBe(pb)
    releaseRemoteMcpPort(a)
    releaseRemoteMcpPort(b)
  })

  it('returns 0 (no forward) when the local server is down', () => {
    const sid = 'sess-down-' + Math.random().toString(36).slice(2)
    expect(getRemoteMcpPort(sid, 0)).toBe(0)
    expect(_getRemoteMcpPortForTest(sid)).toBeUndefined()
  })

  it('release frees the mapping', () => {
    const sid = 'sess-rel-' + Math.random().toString(36).slice(2)
    getRemoteMcpPort(sid, 19333)
    expect(_getRemoteMcpPortForTest(sid)).toBeDefined()
    releaseRemoteMcpPort(sid)
    expect(_getRemoteMcpPortForTest(sid)).toBeUndefined()
  })
})
