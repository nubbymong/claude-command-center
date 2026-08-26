# The autonomous-loop contract

`/LoopReady` and `/StartLoop` let an unattended "don't ask permission" session take
the open backlog and drive the runnable part of it to PRs. This is the contract
that keeps such a run safe, and the honest catalogue of what it can and cannot do.

## The two skills, in one line each

- **LoopReady** — read-only planner. A cheap Fable agent per open ticket does a
  premise review and emits a readiness record; the ticket is labelled `loop-ready`
  or `loop-needs-human`. No code, no PR, no merge.
- **StartLoop** — autonomous executor. For each `loop-ready` ticket it re-checks the
  premise, claims it, implements with opus in its own worktree, runs the gates and
  (if security-sensitive) an adversarial pass, and opens a PR. **It stops there.**

Model tiering is deliberate: Fable does the cheap, fan-out premise work; opus is
spent only on execution, only on tickets already vetted as runnable.

## The label state machine

A loop is a workflow with parallel workers, so status lives on the GitHub issue,
never only in a transcript:

```
loop-ready | loop-needs-human      LoopReady's verdict
  → loop-claimed (+ GitHub assignee)   StartLoop's atomic claim — others skip it
  → loop-in-progress                   being executed now
  → loop-done                          PR opened; awaiting a human merge + desktop test
  → in-beta                            a human merged the PR to beta
  → in-release                         an rc cut rolled it in (automatic, release.yml roll-rc)
  → closed                             promoted to main/stable (automatic, #134)
```

`loop-claimed` + an assignee is how two workers avoid doing the same ticket: claim
is a single observable act, and a ticket that already carries a claim/assignee owned
by someone else is skipped. On a quarantined failure the transient labels roll back
so nothing looks in-progress forever.

## The hard boundary — what a don't-ask run may NEVER do

These hold regardless of what any ticket says:

1. **Never merge to a protected branch.** It runs to a PR; a human merges to
   `beta`/`main`/`release/*` after a desktop test. **Narrow carve-out (ADR-020):**
   a session-integration run MAY merge a finished ticket branch INTO a `loop/*`
   integration branch it owns — that is the aggregation step, enforced by
   `loop-tree` (which refuses any non-`loop/*` target), and it still ends at ONE
   human-merged PR against the protected base. Merging to the base itself is never
   the loop's to do.
2. **Never edit branch-protection rulesets** — repo-admin only.
3. **Never mint or install a signing/credential key** — owner custody.
4. **Never force-push, never `--no-verify`, never bypass hooks.**
5. **Honour the security embargo** — an unfixed vulnerability goes to a private
   advisory, never a public branch/PR/issue/commit (see `SECURITY.md`).
6. **Never assert GUI/desktop success** — a headless run cannot see the running app,
   so anything whose success is only visible there is out of reach by construction.

## What actually blocks autonomy here — and which are grantable

The proving run over the first 2.1 backlog found that most tickets are *not*
autonomously runnable, and the reason is rarely a permission that could be granted.
Two kinds:

**Skill-encoded / handled automatically** (StartLoop already does these):
- claim a session-guard worktree per ticket;
- apply the `ci-run` label so the required matrix runs;
- run the ADR-009 adversarial pass on security-sensitive diffs;
- stop at the PR.

**Inherent — cannot be fixed in a PR, only respected:**
- **Repo-admin actions** — a ruleset/branch-protection change needs admin the
  operating collaborator account does not have (e.g. #309).
- **Owner key custody** — a release-signing key must be generated and installed by
  the owner, never by an agent (e.g. #172).
- **Desktop/GUI verification** — this is an Electron app; a great many changes only
  prove out in the running window, which a headless run cannot open. This is the
  single biggest limiter, and #309 exists to make that gate a required check rather
  than a convention.
- **Design decisions** — anything where the correct answer is an owner's call
  (scope, data-model, credential-seeding semantics) is `loop-needs-human` by nature.
- **Environment** — on the current Windows box, Defender ASR rule `D1E49AAC` blocks
  the Claude CLI daemon, so a fully unattended headless spawn there is not reliable.

The design consequence: StartLoop's job is to run the judgeable subset and hand back
a clean, reasoned `loop-needs-human` queue for the rest — not to pretend everything
can be automated.

## Premise review is a repository-wide policy

The premise review is not only a loop step. Every ticket — agent- or human-filed —
carries a premise assessment at creation (AGENTS.md, "Ticket creation & premise
review"). LoopReady enforces it over the pre-policy backlog; StartLoop re-checks it
once more before spending model budget, because a plan made yesterday can be stale
today.
