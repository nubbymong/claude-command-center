# ADR-020: Session-integration branch — aggregate many tickets into one PR

- Status: Accepted
- Date: 2026-08-25

## Context

The autonomous loop (ADR-009 adversarial gate + `LoopReady`/`StartLoop` + ADR-012
session isolation) drives each ticket to its own PR against `beta` and stops. That
is correct for a single ticket, but a batch of related tickets then arrives as N
separate PRs — N desktop tests, N reviews, N merges — even when they belong
together. ADR-012 codified this explicitly: *"Integration is unchanged: `session/*`
branches PR into `beta` like any other."*

There was one hand-made exception (`session/beta/fce45881`, "fold #188 … single
combined PR"), proving the need, with no machinery behind it.

We want a loop that pulls `loop-ready` tickets, works each in its own worktree,
then **aggregates** the finished branches into ONE human-facing PR — so a human
desktop-tests and merges the batch once.

## Decision

Introduce a **session-integration branch**: a durable `loop/<base>/<slug>` branch
that multiple finished ticket branches merge INTO, which then becomes a single
squash-friendly PR to `<base>`.

1. **Namespace.** The integration branch is `loop/<base>/<slug>` — a NEW namespace,
   distinct from session-guard's per-conversation `session/<base>/<short>`. Reusing
   `session/*` would overload one prefix with two meanings (per-conversation
   worktree vs aggregate). Per-ticket work keeps `feat/<n>-…` / `fix/<n>-…`.

2. **Ownership, not a new guard.** The orchestrator OWNS the integration worktree
   via an ordinary session-guard claim/adopt. Because the PreToolUse hook already
   permits a `git merge` inside a worktree you own (`ownership === 'mine'`), the
   aggregation needs **no change to session-guard and no weakening of the hook**.
   The isolation model of ADR-012 is untouched.

3. **AI merge authority — narrow.** The AI merges finished ticket branches INTO the
   `loop/*` branch (the aggregation step) and opens the session PR. It NEVER merges
   the session PR to `beta`/`main`/`release/*` — a human does, through every gate
   (desktop-tested #309, `ci-run` matrix, ADR-009 adversarial PASS, owner review).
   This is a bounded carve-out to the "never merge" rule in `docs/loop-autonomy.md`.

4. **The guard lives at the command, on the branch.** `scripts/loop-tree.mjs`
   implements `open` / `integrate` / `submit` / `close`. Every mutating verb first
   asserts the CURRENT branch is `loop/*` (`assertLoopBranch`) and refuses any
   protected ref (`isProtectedRef`: beta/main/release/*). A ticket branch being
   folded is refused if it is protected, is the loop branch itself, or is another
   loop branch (no nested trees). Segments are charset-gated before they reach a
   git ref or a `gh` argv, with `git check-ref-format` as the belt below.

5. **Lifecycle.** `open` mints the branch+worktree off `origin/<base>`; the
   orchestrator adopts it. Each ticket runs `StartLoop` steps 1–6 (re-review →
   atomic claim → isolate → implement → gate → adversarial) in its own worktree;
   `integrate --branch <ticket>` folds it in and records it in `.loop/folded.json`.
   At scope-drain, `submit` pushes and opens ONE PR (`--base <base>`, `ci-run`,
   body listing folded tickets), then STOP. After the human merges, `close
   --remove-worktree` prunes — but only once HEAD is an ancestor of
   `origin/<base>`, so work is never pruned before it lands.

6. **StartLoop is unchanged.** Its "one PR per ticket, then stop" contract is
   load-bearing for the standalone don't-ask run and cited in loop-autonomy. The
   new `SessionLoop` orchestrator reuses StartLoop steps 1–6 as a sub-procedure and
   only replaces the tail (integrate instead of PR-to-beta).

## Consequences

- **Supersedes ADR-012's non-aggregation consequence.** `session/*` still PRs to
  `beta` per-conversation; `loop/*` is the new aggregate path. Both coexist.
- A conflict during `integrate` aborts cleanly (tree restored) and the ticket is
  reported for a human — the batch is never left half-merged.
- The human still gates the whole batch once: the session PR carries every check a
  single-ticket PR would. Merge authority to base stays with the human and branch
  protection.
- No new attack surface on the isolation guard: `loop-tree` is additive and the
  session-guard hook is not touched. Its own authority guard (loop/*-only) is the
  reviewed boundary.
