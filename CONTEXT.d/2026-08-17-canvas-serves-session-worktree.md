## 2026-08-17 -- Canvas serves the session worktree CCC designates (ADR-016)

Found dogfooding the canvas for the beta.13 mockups: session isolation puts the
agent in `../ccc-wt/<id>` and blocks writes to the primary checkout, while the
canvas served roots were exactly the primary checkout -- so `canvas_render`'s
`htmlPath` was unusable from a worktree and the mockup had to go inline (the
form the skill forbids). Two mandated features in conflict.

Decision: CCC designates the worktree location itself and serves that.
- `pty-manager` computes `<worktree base>/<first 8 of the CCC session id>` from
  the CONFIGURED project directory + CCC's own session id (never the launch cwd),
  puts it in the PTY env as `CCC_SESSION_WORKTREE`, and designates it as a
  PENDING canvas root once the project itself is registered.
- `canvas-store.designateCanvasWorktreeRoot`: lexical, floor-checked; live only
  when it exists as a real directory whose realpath IS the path (junction /
  symlink at or above it -> not served), re-evaluated on every resolution;
  candidates still realpath'd; per session; revoked with the session.
- `scripts/session-guard.mjs claim` honours the env var: creates there, or
  ADOPTS the worktree an earlier conversation of the same CCC session left there
  (`/clear`, restart) -- worktrees are now per tile under CCC, fewer orphans.
  Held by another live session / not a worktree -> default location + a note.
- Skill text: htmlPath / distRoot may live in the session worktree.

Rejected: trusting the guard's lease, or git's worktree metadata (both
agent-writable -- the class the 08-11/14/15 reviews closed); a user-configured
extra-roots setting (sound, but not out-of-the-box and broader than one
session's worktree; possible follow-up).

Tests: canvas-worktree-root (store semantics incl. junction/symlink refusals,
floor, per-session, revoke; pure naming helper), canvas-worktree-spawn (real
spawnPty -> env var + store; poisoned resume target does not move it; no
designation for non-primary / shell-only / home), session-guard-designated-
worktree (real script against a throwaway repo: create / adopt / fall back /
empty dir / relative hint ignored / unset). Mutation-checked: no anti-link
check -> 3 tests fail; designate from the launch cwd -> poison test fails.

Security-sensitive (served-root allowlist) -> ADR-009 adversarial pass on the PR.
