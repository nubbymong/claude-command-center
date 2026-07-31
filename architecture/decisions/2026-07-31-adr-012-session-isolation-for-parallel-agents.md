# ADR-012: Session isolation for parallel agents

- Status: Accepted
- Date: 2026-07-30

## Context

Several Claude Code sessions run against this repository at the same time, and
nothing stopped them from landing in the same place. In practice they did:

- The primary checkout changed branch three times during a single session
  (`fix/145` -> `docs/148` -> `test/154`), driven by other sessions.
- A new `ccc-security` worktree appeared mid-session, from another session.
- PR #127's branch was found carrying three commits that belonged to unrelated
  work (`perf(main)`, two `fix(dev)`), unpushed and on no other branch. Had they
  been pushed, a PR advertised as "docs + gitignore, no code changes" would have
  shipped unreviewed code.
- The `ccc-iso` worktree sat on a branch that was 0 commits ahead of `beta` --
  it reads as disposable -- while holding 32 modified files.

The shared failure is that a session cannot tell whether the directory it is
standing in belongs to it. Convention alone does not fix this: an agent whose
context has been truncated, or that simply never read the rule, will still
`cd` into the primary checkout and commit.

The requirement is to run many agents in parallel against the same repository,
on the same line of work, with no possibility of collision.

## Decision

**One session = one worktree = one branch, branched from a shared base.**

Git already refuses to check out one branch in two worktrees, so the branch ref
is a hard interlock we get for free. Layered on top:

1. **`scripts/session-guard.mjs`** -- claims a worktree + branch
   (`session/<base>/<session-id>`), records a lease, and answers "do I own this
   directory?".
2. **Leases in `<git-common-dir>/ccc-sessions/`** -- one JSON per session, keyed
   by `CLAUDE_CODE_SESSION_ID`, carrying `CLAUDE_PID` for liveness. The common
   git dir is shared by every linked worktree and is never tracked, so all
   sessions see one registry with no repo pollution.
3. **A `PreToolUse` hook** (`.claude/settings.json`) that denies `Edit`/`Write`/
   `NotebookEdit` and git-mutating `Bash`/`PowerShell` commands whenever the
   target is a worktree of this repo that the calling session does not own.
   The harness enforces it, so it cannot be forgotten or reasoned away.

Rejected alternatives:

- **Literal same-branch parallelism** (`git worktree add --force`, N worktrees
  on one ref). Separate index and HEAD per worktree, but a single shared branch
  ref: concurrent commits race and clobber. This reintroduces the exact problem.
- **A clone per agent.** Full isolation, but ~1 GB of `node_modules` per agent
  and a native rebuild each; cross-agent sharing has to round-trip the remote.
- **Convention only** (document the rule in `AGENTS.md`). This is what we had.
  It is what failed.

## Consequences

- Agents never work in the primary checkout. It stays a stable, human-owned
  reference, and `session-guard adopt` explicitly refuses to lease it -- no
  session can fence others out of the shared tree.
- Integration is unchanged: `session/*` branches PR into `beta` like any other.
- Unowned worktrees are blocked for writes, which deliberately covers
  pre-existing ones such as `ccc-iso`. `adopt` is the one-command opt-in, and it
  also covers worktrees made by Claude Code's own `--worktree`/`EnterWorktree`.
- Liveness is a PID probe. `process.kill(pid, 0)` was verified non-destructive
  on Windows before being relied on: it reports liveness, leaves the target
  running, and throws `ESRCH` when dead.
- `reap` refuses to clear a dead session's lease while its worktree holds
  uncommitted changes -- releasing it would invite another session to take a
  directory with unsaved work in it.
- The guard fails **open**. A crash, malformed hook input, or missing script
  exits 0 and allows the action; a bug in the guard must never brick a session.
  `CCC_SESSION_GUARD=off` disables blocking outright.
- The hook adds one short-lived `node` process per matched tool call.
