## 2026-08-28 -- #24: multiple concurrent sessions to the same host (per-session MCP port)

Only one SSH session could have a working Conductor MCP tunnel per host. Root
cause: every session forwarded the SAME fixed remote listen port
(`-R <L>:127.0.0.1:<L>`, L = getConductorMcpPort, 19333/19433) — so a second
session to one host asked sshd to bind L again, which is refused
("remote port forwarding failed for listen port L"). On a forwarding-enabled host
the 2nd session then either dies (user ssh config `ExitOnForwardFailure yes`) or
opens with its MCP silently cross-wired to session 1's tunnel.

Fix: a STABLE per-session remote listen port R, forwarded to the one shared local
server (`-R R:127.0.0.1:L`), with the remote Claude's MCP URL baked to
`localhost:R`. R is DERIVED deterministically from the (random, unique) CCC
sessionId (FNV-1a → [20000,60000]) so it is identical across reconnects AND app
relaunches — the tmux-persisted Claude keeps the URL it launched with, so the
reconnect must forward the same R.
- `src/main/ssh-remote-port.ts` (new): remoteMcpPortForSession (pure,
  deterministic) + getRemoteMcpPort (applies the server-down 0 gate). No map, no
  release.

Adversarial review (fable LEAD) caught the first cut as a BLOCKER: an in-memory
map freed in cleanupSessionResources changed R on every reconnect (cleanup runs
on transient drops AND before each respawn), killing MCP for the default-on tmux
reconnect path. Deterministic derivation removes the per-session state entirely.
- `src/main/ssh-args.ts`: buildSshArgs gains `remoteMcpPort` (defaults to mcpPort
  = pre-#24 shape); forwards `-R remote:127.0.0.1:local`.
- `ssh-shim.ts`: generateRemoteSetupScript + generateWindowsRemoteSetupScript bake
  the URL with `opts.remoteMcpPort` (falls back to the local port). Threaded
  through getRemoteSetupCommand / getWindowsRemoteSetupCommand /
  configureRemoteSettings (+ the SshCapableProvider interface).
- `pty-manager.ts`: allocate R per session, pass to buildSshArgs + setupOpts;
  release on cleanup.

No ExitOnForwardFailure added (would kill a session on a rare unrelated remote
collision); distinct per-session R fully solves the CCC-vs-CCC collision.

Tests: ssh-args.test.ts (per-session -R), ssh-remote-port.test.ts (pick +
stable-per-session + distinct + release), ssh-shim-mcp-port.test.ts (URL bakes R,
POSIX + Windows). typecheck clean; 176 ssh unit tests green.

LIVE VALIDATION BLOCKED on the offered host: p-aai-se01.aai.bnts.us has
`AllowTcpForwarding no` in sshd_config, so `-R` is refused entirely (single or
multi session) — the fix can't be exercised there, and on such a host the
collision is a non-fatal warning, not a hard block. Two plain concurrent sessions
to it already work (no MaxSessions limit). The live SSH matrix for this change
needs a forwarding-ENABLED host; the symptom-match (does the user's "can't open
2nd" host allow forwarding / use ExitOnForwardFailure?) is still to confirm.
