// Per-session remote MCP listen port (#24).
//
// The Conductor MCP server binds ONE local port (getConductorMcpPort). Before
// #24 every SSH session forwarded `-R <L>:127.0.0.1:<L>` using that single port
// as the REMOTE listen port too, so a second session to the SAME host asked sshd
// to bind <L> again and it was refused ("remote port forwarding failed for
// listen port <L>") — you could not run two sessions against one host.
//
// Fix: give each session its OWN remote listen port R and forward
// `-R <R>:127.0.0.1:<L>` (distinct remote binds, one shared local server). The
// remote Claude's MCP URL then points at localhost:<R> on the remote.
//
// R must be STABLE for the life of a session: a tmux reconnect re-establishes
// the forward, and the already-running remote Claude keeps the URL it launched
// with, so the reconnect must forward the SAME R. Hence the per-session map
// (keyed by the CCC sessionId), populated once and reused on every respawn until
// the session is torn down.

// sessionId -> allocated remote listen port
const bySession = new Map<string, number>()

/**
 * Pick a port in [lo, hi] that is not already in `used`. Pure + injectable rng
 * so the "distinct per concurrent session" property is unit-testable. Throws if
 * the range is exhausted (never in practice — the range is ~40k wide and real
 * concurrent-session counts are tiny).
 */
export function pickRemoteMcpPort(
  used: ReadonlySet<number>,
  rng: () => number = Math.random,
  lo = 20000,
  hi = 60000,
): number {
  const span = hi - lo + 1
  for (let attempt = 0; attempt < span; attempt++) {
    const p = lo + Math.floor(rng() * span)
    if (!used.has(p)) return p
  }
  throw new Error('pickRemoteMcpPort: no free port in range')
}

/**
 * The stable remote MCP listen port for this session. Returns 0 (no forward)
 * when the local server is down (localPort === 0), matching the pre-#24
 * "mcpPort === 0 => no -R, empty remote mcpServers" fail-closed behaviour.
 * Idempotent: the first call allocates, later calls (reconnects) return the
 * same port.
 */
export function getRemoteMcpPort(sessionId: string, localPort: number): number {
  if (localPort <= 0) return 0
  const existing = bySession.get(sessionId)
  if (existing !== undefined) return existing
  const port = pickRemoteMcpPort(new Set(bySession.values()))
  bySession.set(sessionId, port)
  return port
}

/** Free the session's reserved port on teardown so the range can't leak. */
export function releaseRemoteMcpPort(sessionId: string): void {
  bySession.delete(sessionId)
}

/** Test-only: inspect the current mapping. */
export function _getRemoteMcpPortForTest(sessionId: string): number | undefined {
  return bySession.get(sessionId)
}
