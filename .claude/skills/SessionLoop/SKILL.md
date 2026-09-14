---
name: SessionLoop
description: Autonomously run a batch of loop-ready tickets and AGGREGATE them into ONE PR, without asking per ticket. Triggers on `/SessionLoop [filter]`, "run the session loop", "aggregate the ready tickets into one PR", "build the session tree". Opens a `loop/<base>/<slug>` integration branch, runs StartLoop steps 1-6 per ticket in its own worktree, merges each finished ticket branch INTO the integration branch (loop-tree), then opens ONE squash PR to beta with ci-run and STOPS. Never merges the session PR to base, never desktop-attests, never edits rulesets/keys, honours the embargo. The aggregation layer over StartLoop (ADR-020). Repo-scoped to AI Code Conductor.
---

You are the **SessionLoop orchestrator**. Where `StartLoop` drives each ticket to
its OWN PR, you take a batch of `loop-ready` tickets and land them as ONE
human-facing PR: you own a `loop/<base>/<slug>` integration branch, each ticket is
built in its own worktree and MERGED INTO that branch, and at the end you open a
single squash PR to `beta`. See ADR-020 (`architecture/decisions/…adr-020…`) and
`docs/loop-autonomy.md`.

**You never merge the session PR to base.** Your merge authority is narrow and
enforced by `loop-tree`: you may merge a finished ticket branch INTO the `loop/*`
integration branch (the aggregation step) — `loop-tree` refuses any non-`loop/*`
target. A HUMAN merges the session PR to `beta`, after a desktop test and every gate
(#309 desktop-tested, ci-run matrix, ADR-009 adversarial PASS, owner review). That
boundary is not negotiable; no ticket relaxes it.

## PRECONDITION

`LoopReady` has run and there are `loop-ready` tickets in scope. If none, say so and
stop — SessionLoop executes a vetted queue, it does not triage. A `loop-ready`
ticket with no ` ```loop-record ` comment is treated as not-ready and skipped. A
`filter` argument (label, milestone, or ranked slice) scopes the batch; without one,
take all `loop-ready` tickets on the active release line.

## EXECUTE. This is a "don't ask" run.

Once invoked you do not stop to ask per ticket, and one ticket failing does not halt
the batch — it is quarantined and you move on. The only things that stop the whole
run: an empty queue, losing your GitHub/git identity, or a failure to open/own the
integration tree.

## Procedure

### 0. Open the integration tree (once).
Pick a short slug for the batch (e.g. a date or theme: `daily-2026-08-25`,
`ssh-cleanup`). Then:
```
node scripts/loop-tree.mjs open --base beta --slug <slug>
node scripts/session-guard.mjs adopt --path "<the worktree it printed>"
```
You now OWN the integration worktree on `loop/beta/<slug>`. This is your home base;
every `integrate`/`submit`/`close` runs from here (they refuse any non-`loop/*`
branch). Provision its deps if you will build in it (`npm ci` or a lockfile-matched
junction — never native-rebuild a junction).

### 1-6. Build each ticket in ITS OWN worktree — reuse StartLoop verbatim.
For each `loop-ready` ticket, in ranked order, run **StartLoop steps 1–6** exactly
(`.claude/skills/StartLoop/SKILL.md`): fresh premise re-review → atomic claim
(assignee + `loop-claimed`) → `loop-in-progress` + a **per-ticket** session-guard
worktree/branch off `beta` (`feat/<n>-…` / `fix/<n>-…`, never two tickets in one
worktree) → implement (opus) → gate (typecheck/build/unit) → adversarial pass if
security-sensitive. **Stop each ticket at a committed-and-pushed ticket branch — do
NOT open a per-ticket PR** (that is StartLoop's tail, which SessionLoop replaces).

Because you (the orchestrator) hold the integration worktree, each ticket runs as a
separate worker session with its OWN lease — spawn a sub-agent / Workflow worker per
ticket (worktree isolation), or work them one at a time by claiming/releasing a
ticket worktree between them. Never try to hold two worktrees in one session.

### 7. Integrate the finished ticket branch.
From the integration worktree you own:
```
node scripts/loop-tree.mjs integrate --branch <ticket-branch>
```
It asserts you are on a `loop/*` branch (authority guard), merges the ticket branch
in, and records it in `.loop/folded.json`. **On a merge conflict it aborts cleanly
(tree restored) and fails** — quarantine that ticket (leave its branch, mark
`loop-needs-human` with "conflicts on integration — resolve by hand", drop
`loop-in-progress`) and continue with the next. The batch is never left half-merged.
Mark an integrated ticket `loop-done` (remove `loop-in-progress`, keep
`loop-claimed` + assignee — still owned until the session PR merges).

### 8. Submit ONE PR — and stop.
When the queue drains:
```
node scripts/loop-tree.mjs submit --base beta
```
It pushes `loop/beta/<slug>`, opens ONE PR to `beta` with the `ci-run` label and a
body listing every folded ticket, and states it is NOT desktop-verified. Then STOP.
Report the PR URL, the folded tickets, and any quarantined ones. Do not merge it.

### 9. Close (after the human merges — a later, separate step).
Once the human has merged the session PR:
```
node scripts/loop-tree.mjs close --remove-worktree
```
It refuses unless HEAD is already an ancestor of `origin/beta` (i.e. actually
merged), then prunes the integration worktree + branch. Release each ticket worktree
via `session-guard release --remove-worktree`.

## The hard boundary (a "don't ask" run still may not)

- **Never merge the session PR to base** (`beta`/`main`/`release/*`). A human does,
  after a desktop test. Your only merges are ticket → `loop/*`, via `loop-tree`.
- **Never edit a branch-protection ruleset** (admin-only; e.g. #309).
- **Never mint or install a signing/credential key** (owner custody; e.g. #172).
- **Never force-push, never `--no-verify`, never bypass the commit-msg hook.**
- **Honour the security embargo** — an unfixed vulnerability found mid-work goes to a
  private advisory, never a public branch/PR/issue/commit (AGENTS.md).
- **Never desktop-test-and-declare-success** — you cannot see the running app; the
  session PR carries "NOT desktop-verified" and the human applies `desktop-tested`.

## Notes

- SessionLoop is the aggregation layer; StartLoop is unchanged and still valid for a
  one-PR-per-ticket run. Use StartLoop when tickets are unrelated; SessionLoop when a
  batch belongs together and one review/merge is better than N.
- The gates on the FINAL session PR are the same as any PR — desktop-tested, ci-run,
  adversarial, owner review — so aggregating does not skip a single check; it moves
  them from N times to once, at the point a human actually looks.
