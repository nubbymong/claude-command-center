## 2026-07-30 -- Session isolation for parallel agents (session-guard + PreToolUse hook)

Problem observed live, not hypothetical. During one session: the primary
checkout changed branch three times under us (fix/145 -> docs/148 -> test/154)
driven by other sessions; a ccc-security worktree appeared mid-session; and
PR #127's branch was found holding three unrelated, unpushed commits
(perf(main) + two fix(dev)) that existed on no other branch. Pushing from that
branch tip would have injected unreviewed code into a PR described as
"docs + gitignore, no code changes". Separately, ccc-iso reads as disposable
(0 commits ahead of beta) while holding 32 modified files.

Root cause: a session had no way to tell whether the directory it stood in
belonged to it, and convention alone does not bind an agent whose context has
been truncated.

Decision (ADR-011): one session = one worktree = one branch, all branched from a
shared base. Git already refuses to check out one branch in two worktrees, so
the branch ref is the hard interlock; the new tooling supplies the bookkeeping
git has no opinion about.

Added:
- scripts/session-guard.mjs -- claim / adopt / verify / status / list / reap /
  release / hook. Leases are one JSON per session under
  <git-common-dir>/ccc-sessions/ (shared by all linked worktrees, never
  tracked), keyed by CLAUDE_CODE_SESSION_ID with CLAUDE_PID for liveness.
- .claude/settings.json -- PreToolUse hook over
  Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell that denies writes and
  mutating git against a worktree of this repo the caller does not own. Honours
  a -C <path> argument, so `git -C <other-worktree> commit` is caught even when
  cwd is fine.
- docs/session-isolation.md, ADR-011, AGENTS.md + docs/agent-conventions.md
  sections.

Rejected: literal same-branch parallelism via `git worktree add --force` (N
worktrees, one shared ref -- concurrent commits clobber, which is the original
problem); a clone per agent (~1GB node_modules each); convention-only (what we
had, and what failed).

Verified before relying on it: process.kill(pid, 0) on Windows reports liveness,
leaves the target process running, and throws ESRCH when dead -- checked against
a real spawned Windows pid, confirming the probe never signals. Hook decisions
pipe-tested across 12 cases (own worktree, primary checkout, another unmanaged
worktree, outside the repo, git -C targeting each, read-only verbs, chained
`&&` commands, worktree add vs remove, PowerShell push) plus live-rival,
stale-lease, dirty-reap and escape-hatch paths.

Notable design points:
- adopt refuses the primary checkout outright -- no session may fence others out
  of the shared tree.
- reap keeps a dead session's lease when its worktree is dirty, rather than
  handing a directory with unsaved work to someone else.
- The guard fails OPEN (bad input / missing script / internal error -> exit 0).
  It is a collision guard, not a security boundary.
- Bug caught in testing: claiming from inside a worktree anchored the sibling
  root to the current worktree, nesting ccc-wt/ccc-wt/. Now anchored to the
  primary checkout via --git-common-dir.
