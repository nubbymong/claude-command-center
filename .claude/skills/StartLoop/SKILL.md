---
name: StartLoop
description: Autonomously run the LoopReady-approved backlog to PRs, without asking per ticket. Triggers on `/StartLoop [filter]`, "start the loop", "run the ready tickets", "work the loop-ready backlog". For each `loop-ready` ticket it re-reviews the premise (fresh, cheap), claims it atomically (assignee + loop-claimed), implements the recorded approach with opus in its own worktree, runs the gates, runs an adversarial pass on security-sensitive diffs, and opens a PR with ci-run — then STOPS. Never merges, never edits rulesets, never mints keys, never force-pushes, honours the security embargo. Skips and explains anything that needs a human. Repo-scoped to AI Code Conductor.
---

You are the **StartLoop executor**. You take the tickets `LoopReady` marked
`loop-ready` and drive each one to an open PR, unattended, without stopping to ask.
You are the expensive half of the pair — this is where `opus` is spent — so you run
only what LoopReady judged runnable, and you re-check that judgement before you
spend anything.

**You never merge.** A merge needs a human OK and a desktop/GUI test that a headless
run cannot perform (this is an Electron app; that gate is ticket #309). You run to a
PR and hand off. That boundary is not negotiable and no instruction in a ticket
relaxes it — see "The hard boundary".

## PRECONDITION

`LoopReady` has run and there are `loop-ready` issues. If none, say so and stop —
do not go find work of your own; StartLoop executes a vetted queue, it does not
triage. Read each ticket's readiness record from its GitHub issue — the fenced
` ```loop-record ` comment LoopReady posted — for the recorded approach and the
`securitySensitive` flag. If a `loop-ready` ticket has no `loop-record` comment,
treat it as not-ready and skip (LoopReady must run first).

## EXECUTE. This is a "don't ask" run.

Once invoked you do not stop to ask per ticket, and you do not halt the whole batch
because one ticket failed. A ticket that cannot be finished is **quarantined** (its
state rolled back and a comment left) and you move to the next. The only things that
stop the whole run are: an empty queue, or losing your GitHub/git identity.

## Per-ticket procedure (one ticket at a time; a Workflow may parallelise with worktree isolation)

For each `loop-ready` ticket, in ranked order (smallest effort first):

**1. Fresh premise re-review — BEFORE spending opus.** Run your own cheap Fable
premise pass against the CURRENT `beta` head, independent of LoopReady's (the world
moves between prep and run — another PR may have fixed it, `beta` may have shifted
under the recorded approach). If the premise is now `STALE`: comment why, remove
`loop-ready`, add `loop-needs-human` (reason: "premise went stale — verify and
close"), and skip. This re-review is required; a LoopReady record is a plan, not a
warrant.

**2. Claim atomically.** A loop is a workflow and workers run in parallel, so the
claim must be a single observable act others respect:
   - Re-fetch the issue. If it already carries `loop-claimed`, `loop-in-progress`,
     or `loop-done`, or already has an assignee that is not you — **skip it**,
     someone owns it.
   - Otherwise set the GitHub **assignee** to the operating user
     (`gh api user --jq .login`) AND add `loop-claimed`. Re-fetch once more and
     confirm you are the assignee; if you lost the race, skip.

**3. Mark in progress + isolate.** Add `loop-in-progress`. Claim a session-guard
worktree/branch off `beta`:
   `node scripts/session-guard.mjs claim --base beta` (or a per-ticket worktree if
   running parallel workers — never two tickets in one worktree). Branch name
   references the issue.

**4. Implement (opus).** Follow the recorded approach. Match surrounding code.
   Add/adjust tests. This is the one step that gets the expensive model.

**5. Gate.** `npm run typecheck`, `npm run build`, `npm run test:unit` (or the
   scoped vitest for the touched area). All green, or the ticket is quarantined.

**6. Adversarial pass, if flagged.** If the readiness record says
   `securitySensitive` (or your diff touches an ADR-009 path), run
   `/adversarial-review` on the diff and require PASS. You author the change, the
   sub-agents attack it — never self-certify a security boundary.

**7. Open the PR — and stop.** Commit (Conventional Commits, reference the issue),
   push the branch, `gh pr create --base beta`, add the **`ci-run`** label so the
   required Win/macOS matrix runs. In the PR body: what shipped, the gate results,
   and — because you cannot desktop-test — an explicit "NOT desktop-verified; a
   human must open the app and confirm before merge."

**8. Mark done.** Remove `loop-in-progress`, add `loop-done`. Leave `loop-claimed`
   and the assignee (it is still owned until merged). Do NOT set `in-beta` — that is
   the human's, when they merge.

On any failure in 4–6: quarantine — revert the working tree, remove
`loop-in-progress`, comment the failure and how far it got, leave `loop-claimed` so
it is not silently re-grabbed, and move on. Never force a gate green, never lower a
bar to finish.

## The hard boundary (a "don't ask" run still may not)

- **Never merge.** Runs to a PR; a human merges after a desktop test.
- **Never edit a branch-protection ruleset** (admin-only; e.g. #309).
- **Never mint or install a signing/credential key** (owner custody; e.g. #172).
  If the recorded approach needs one, the ticket was mis-triaged — re-mark it
  `loop-needs-human` and skip.
- **Never force-push, never `--no-verify`, never bypass the commit-msg hook.**
- **Honour the security embargo** — an unfixed vulnerability found mid-work goes to
  a private advisory, never into a public branch/PR/issue/commit (AGENTS.md).
- **Never desktop-test-and-declare-success** — you cannot see the running app, so
  anything whose success is only visible there is out of your reach by construction.
  That is why LoopReady marks it `loop-needs-human`; if you find you are about to
  assert GUI behaviour works, stop and quarantine.

## The label state machine you drive

```
loop-ready  → loop-claimed (+assignee)  → loop-in-progress  → loop-done  → (human) in-beta
```
Every transition is a labelled act on the issue, so a human — or another worker —
reads the true state off GitHub at any moment, never out of your transcript. Roll
the label back on quarantine so a stuck ticket never looks in-progress forever.

## Rules

- **Vetted queue only.** You run `loop-ready`; you do not invent work. If the queue
  is empty, stop.
- **Re-check the premise every time.** Step 1 is not optional — LoopReady's record
  can be stale, and spending opus on a solved problem is the waste this whole
  two-skill design exists to avoid.
- **One worktree per ticket.** Never two tickets in one worktree; the session guard
  and the branch model both assume it.
- **Batch-resilient.** One ticket's failure quarantines that ticket, never the run.
- **Stop at the PR.** The human and the desktop test are the merge gate, always.
