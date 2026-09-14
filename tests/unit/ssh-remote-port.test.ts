import { describe, it, expect } from 'vitest'
import { remoteMcpPortForSession, getRemoteMcpPort } from '../../src/main/ssh-remote-port'

describe('remoteMcpPortForSession (#24 — deterministic, reconnect-stable)', () => {
  it('is a pure function of sessionId: same id ⇒ same port, always in range', () => {
    const sid = 'a1b2c3d4e5f6a1b2c3d4e5f6'
    const p = remoteMcpPortForSession(sid)
    expect(p).toBe(remoteMcpPortForSession(sid)) // stable across calls
    expect(p).toBe(remoteMcpPortForSession(sid)) // ...and again (reconnect/relaunch)
    expect(p).toBeGreaterThanOrEqual(20000)
    expect(p).toBeLessThanOrEqual(60000)
  })

  it('gives different ports to different sessions (no global collision by construction)', () => {
    // A spread of realistic 24-hex ids should not all collide.
    const ports = new Set(
      Array.from({ length: 200 }, (_, i) => remoteMcpPortForSession('sess' + i.toString(16).padStart(20, '0'))),
    )
    // Overwhelmingly distinct across 40k space; allow a couple of birthday hits.
    expect(ports.size).toBeGreaterThan(196)
  })
})

describe('getRemoteMcpPort (#24 local-server gate)', () => {
  it('returns the deterministic port when the local server is up', () => {
    const sid = 'deadbeefdeadbeefdeadbeef'
    expect(getRemoteMcpPort(sid, 19333)).toBe(remoteMcpPortForSession(sid))
  })

  it('returns 0 (no forward) when the local server is down — fail-closed', () => {
    expect(getRemoteMcpPort('anything', 0)).toBe(0)
    expect(getRemoteMcpPort('anything', -1)).toBe(0)
  })

  // The BLOCKER this design fixes: a reconnect (teardown + respawn) must forward
  // the SAME port so the tmux-persisted remote Claude's baked URL still resolves.
  // With a deterministic derivation there is no per-session state to lose.
  it('is identical before and after a simulated teardown+respawn (reconnect)', () => {
    const sid = 'reconnectsession01234567'
    const first = getRemoteMcpPort(sid, 19333)
    // ...session drops, cleanup runs (no state to release), respawn:
    const afterReconnect = getRemoteMcpPort(sid, 19333)
    expect(afterReconnect).toBe(first)
  })
})
