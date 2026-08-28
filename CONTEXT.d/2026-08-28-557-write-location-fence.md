## 2026-08-28 -- #557: session-guard write-location fence

Owner found stray roots on the workspace drive (ccc-attack-*, ccc-probe-scratch-*, an advisory
clone at a hand-rolled root, plus POSIX-path mangling artifacts \c, \Users, \tmp) and asked for
the behaviour to be stopped mechanically, not just by convention.

Decision: extend the PreToolUse hook in `scripts/session-guard.mjs` (tooling only -- no app code,
no release needed). Outside the repo's own worktrees a write is now allowed only under a
sanctioned root: OS temp (the session scratchpad), the primary checkout's `<name>_RESOURCES`
sibling, the worktree base (`CCC_WT_ROOT`), plus `CCC_WRITE_ROOTS` extras. Fenced operations:
Edit/Write/NotebookEdit targets, `mkdir`/`md`/`New-Item`, `git clone`/`init`/`worktree add`
targets, and `>`/`>>` redirects to resolvable literal paths.

Design points:
- Ownership is checked BEFORE the sanctioned roots so the worktree base can never launder a
  write into another session's worktree (caught by the first test run).
- Existing FOREIGN repos stay writable -- editing another project is a task; a new drive root is
  clutter.
- Only statically resolvable literals are denied; tokens with `$`/`%`/backtick expansion pass
  (fail open), and a guard bug still fails open in cmdHook. `CCC_SESSION_GUARD=off` remains the
  deliberate-exception hatch.
- `/tmp/x` and MSYS `/f/x` resolve to the drive paths a Windows-native tool would actually hit,
  so the drive-mangling class (F:\tmp) is fenced, not just hand-rolled roots.

Tests: `tests/unit/session-guard-write-fence.test.ts` drives the real `hook` subcommand against a
throwaway repo (18 cases: allow/deny across all fenced operations, env extension, escape hatch,
mangling, MSYS translation). AGENTS.md gains the "Where files go" rule.
