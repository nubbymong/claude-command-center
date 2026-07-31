# Session isolation (parallel agents)

How to run many Claude Code sessions against this repo at once without them
colliding. The rationale and the rejected alternatives are in
`architecture/decisions/2026-07-30-adr-011-session-isolation-for-parallel-agents.md`.

## The rule

**One session = one worktree = one branch.** Every session works in its own
directory, on its own branch, branched from a shared base (normally `beta`).
Sessions never work in the primary checkout and never share a branch.

```
beta  (shared base -- no agent ever checks it out)
  |-- session/beta/55158424  ->  ../ccc-wt/55158424      agent A
  |-- session/beta/a91f3c02  ->  ../ccc-wt/a91f3c02      agent B
  `-- session/beta/7d0e11bb  ->  ../ccc-wt/7d0e11bb      agent C
```

All three work the same line of work in parallel and integrate the normal way:
`session/*` -> PR -> `beta`.

## Start of session: claim

```bash
node scripts/session-guard.mjs claim --base beta
```

Creates `../ccc-wt/<session>` on `session/beta/<session>` branched from
`origin/beta`, records the lease, and prints the path. Add `--slug docs` to make
the branch and directory self-describing. Re-running is a no-op that reprints
your existing worktree.

Already standing in a worktree someone made for you -- by hand, or via Claude
Code's own `--worktree` / `EnterWorktree`? Take ownership of it instead:

```bash
node scripts/session-guard.mjs adopt
```

Then do all your work in that directory. Address git at it explicitly rather
than relying on the shell's current directory:

```bash
git -C "<your worktree>" status
```

## Any time: who owns what

```bash
node scripts/session-guard.mjs status   # your cwd, your lease, guard state
node scripts/session-guard.mjs list     # every session, with liveness
node scripts/session-guard.mjs verify   # exit 0 only if you own the cwd
```

## End of session: release

```bash
node scripts/session-guard.mjs release                    # drop the lease
node scripts/session-guard.mjs release --remove-worktree  # and remove the dir
node scripts/session-guard.mjs reap                       # clear dead sessions
```

`release --remove-worktree` refuses while the worktree is dirty. `reap` clears
leases whose owning process is gone, but keeps any whose worktree still holds
uncommitted changes -- otherwise it would hand that directory to another
session with unsaved work in it.

## The hook

`.claude/settings.json` registers a `PreToolUse` hook that runs the guard before
`Edit`, `Write`, `NotebookEdit`, `Bash`, and `PowerShell`. It denies the call
when the target is a worktree of this repo that you do not own:

```
session-guard: BLOCKED -- you (session 55158424) do not own this location.
  target    .../ccc-iso/package.json
  worktree  .../ccc-iso
  leased to session a91f3c02 (pid 4120, ALIVE) on branch fix/128-dev-prod-isolation

That session is running right now. Editing here would collide with it.
```

What it does **not** block:

- Anything inside the worktree you own.
- Read-only git (`status`, `log`, `diff`, `show`, `rev-parse`, ...) anywhere.
- `git worktree add` / `list` -- how a session bootstraps itself.
- Files outside this repository entirely.
- Any tool other than the five matched above.

It **does** block, outside your own worktree: file writes, mutating git
(`commit`, `checkout`, `reset`, `rebase`, `push`, `stash`, `clean`, ...),
destructive `branch -D` / `tag -d`, and `git worktree remove` / `prune`. A
`-C <path>` argument is honoured, so `git -C <someone-else's-worktree> commit`
is caught even when your own cwd is fine.

The guard fails open by design: malformed input, a missing script, or a bug in
the guard exits 0 and allows the call. It is a collision guard, not a security
boundary.

## Escape hatch

```bash
CCC_SESSION_GUARD=off <command>
```

Disables blocking for that invocation. Use it when you genuinely need to touch a
shared checkout, and prefer `git -C` at a specific path over changing directory.

## Notes

- Identity is `CLAUDE_CODE_SESSION_ID`; liveness is `CLAUDE_PID`. Both are
  provided by Claude Code. Outside a Claude session `claim` refuses to run.
- Leases live in `<git-common-dir>/ccc-sessions/` -- shared by every linked
  worktree, never tracked by git.
- Worktree location defaults to `../ccc-wt/` beside the primary checkout;
  override with `CCC_WT_ROOT`.
- Worktrees share the primary checkout's object store, so they are cheap. They
  do **not** share `node_modules`; install per worktree, or junction it if the
  lockfile matches. Never run a native rebuild against a junctioned
  `node_modules` -- it mutates the install every other worktree is using.
