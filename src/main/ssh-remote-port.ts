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
// R MUST be STABLE for a session across reconnects AND app relaunches: a tmux
// reconnect re-establishes the forward while the already-running remote Claude
// keeps the URL it launched with, so the reconnect must forward the SAME R — and
// an app relaunch that reattaches a persisted session must too. So R is DERIVED
// deterministically from the (random, unique) CCC sessionId rather than drawn
// from a live counter/map: the same sessionId always maps to the same port, with
// no per-session state to allocate, free, or lose on restart. (An in-memory map
// freed on teardown looked simpler but broke exactly this: cleanupSessionResources
// runs on transient drops and before every respawn, so R would change on every
// reconnect — regressing MCP for the default-on tmux-persistence path.)
//
// The port space is [20000, 60000] (40001 values). Two DIFFERENT sessions to the
// SAME host could hash to the same R (birthday-style), but with the handful of
// concurrent sessions a user runs against one host the probability is ~N^2/80002
// — negligible — and a collision degrades to the pre-#24 "one session's MCP
// wins" behaviour, never a hard failure. sshd picks the loser's forward off with
// a non-fatal warning (CCC sets no ExitOnForwardFailure).

const PORT_LO = 20000
const PORT_HI = 60000
const PORT_SPAN = PORT_HI - PORT_LO + 1

/**
 * Deterministic remote listen port for a session — pure function of sessionId
 * (FNV-1a → [20000, 60000]). Stable across reconnects and app relaunches. Same
 * sessionId ⇒ same port; different sessionIds ⇒ (almost always) different ports.
 */
export function remoteMcpPortForSession(sessionId: string): number {
  let h = 2166136261 >>> 0 // FNV-1a offset basis
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return PORT_LO + (h % PORT_SPAN)
}

/**
 * The remote MCP listen port to forward for this session, or 0 (no forward) when
 * the local server is down (localPort === 0) — matching the pre-#24 "mcpPort ===
 * 0 ⇒ no -R, empty remote mcpServers" fail-closed behaviour.
 */
export function getRemoteMcpPort(sessionId: string, localPort: number): number {
  if (localPort <= 0) return 0
  return remoteMcpPortForSession(sessionId)
}
