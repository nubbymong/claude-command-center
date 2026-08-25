## 2026-08-25 -- session-integration ("loop") branch layer (#522)

The autonomous loop already had every piece except aggregation: session-guard (worktree/branch/
lease + the PreToolUse ownership hook, ADR-012), LoopReady (premise review), StartLoop steps 1-6,
the loop-* label machine, and the desktop-test/ci-run/adversarial gates. StartLoop's TAIL, though,
opens one PR PER ticket to beta and stops -- and ADR-012 stated "integration is unchanged: session/*
branches PR into beta like any other." So many related tickets arrived as N PRs / N desktop tests /
N merges. This adds the missing layer: many ticket branches -> one `loop/<base>/<slug>` integration
branch -> ONE human PR.

Key design call, made after reading session-guard in full: **the PreToolUse hook already permits a
`git merge` inside a worktree you own** (`ownership === 'mine'`). The orchestrator OWNS the
integration worktree (an ordinary session-guard claim/adopt), so aggregation needs NO change to
session-guard and NO weakening of the hook. The audit had assumed a hook carve-out was needed; it is
not. The isolation guard is untouched -- a much smaller, safer security surface. The one new safety
property lives at the command instead: `scripts/loop-tree.mjs` refuses every mutating verb unless the
CURRENT branch is `loop/*` (`assertLoopBranch`), and refuses folding a protected/self/nested branch.
Segments are charset-gated before they reach a git ref or a `gh` argv, with `git check-ref-format`
below.

Namespace: `loop/<base>/<slug>` is NEW, distinct from session-guard's per-conversation
`session/<base>/<short>` -- reusing `session/*` would overload one prefix with two meanings. Per-ticket
work keeps `feat/<n>-…` / `fix/<n>-…`.

Merge authority is narrow and written into the autonomy contract: the AI merges ticket -> `loop/*`
(the aggregation) and opens the session PR; it NEVER merges the session PR to beta/main/release -- a
human does, through every gate. `docs/loop-autonomy.md` boundary #1 gains that carve-out; ADR-020
supersedes ADR-012's non-aggregation consequence.

Pieces: `scripts/loop-tree.mjs` (open/integrate/submit/status/close + the pure guards, unit-tested),
`.claude/skills/SessionLoop/SKILL.md` (the orchestrator over StartLoop 1-6, ending at ONE PR then
STOP), the ADR, the loop-autonomy carve-out, `.loop/` gitignored (bookkeeping, never in a PR).

Bug the temp-repo smoke caught: `.loop/folded.json` made the integration worktree read as "dirty",
so the SECOND `integrate` refused. Fixed two ways -- gitignore `.loop/`, and a `dirtyPorcelain` that
filters `.loop/` out of the clean-tree check so the command is correct even in a repo without the
ignore. Re-smoked: two tickets fold cleanly, both authority guards fire (refuse merging beta as a
source; refuse operating from beta).

StartLoop is UNCHANGED -- its stop-at-one-PR contract is load-bearing and cited in loop-autonomy;
SessionLoop reuses steps 1-6 and only replaces the tail.

Gate: typecheck clean (3 tsconfigs, via a real rc.2 npm ci -- the junction was stale for the new
@xterm/headless dep), 8531 unit tests pass (16 new for loop-tree's guards), changelog in sync,
loop-tree smoked end-to-end in a throwaway repo. Security-sensitive (grants merge authority, builds
git/gh argv, branch operations) -> ADR-009 adversarial pass owed before merge. A human still merges
the resulting PR.
