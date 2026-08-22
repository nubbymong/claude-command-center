# 2026-08-22 — the canvas binding across an account switch is pinned, not changed

Sixth of the #371 follow-ups, and the one where the checklist and an accepted ADR
disagree. The behaviour is not changed here; it is asserted, and the disagreement is
recorded.

## The conflict

The #308 pass left this note:

> The session-to-canvas binding survives an in-tile account switch on its own, without any
> click, because the index is keyed on session id alone and is rebuilt from disk the same
> way. That is pre-existing and not introduced by this branch […] Closing the other one
> means invalidating the binding when the account changes, which touches the spawn path
> and the restart flow, so it belongs in its own change.

ADR-017, accepted the same day, decides the opposite — and pre-emptively answers this
exact follow-up:

> The session→canvas index remains keyed on session id alone, so the active canvas follows
> a tile across an account switch. **Under this ADR that is correct behaviour rather than
> the leak it looked like beforehand.**

> A future adversarial pass will find no account check here. That is intentional, and this
> ADR is the record of why — **do not re-add it without a new decision.**

The ADR is not silent on the cost, either: *"The account is no longer a barrier between
two sessions on the same machine. This is a real reduction in separation, and it is
accepted knowingly: a canvas holds the user's own mockups and their own review notes, both
parties are the same human on the same machine, and no privilege boundary is crossed."*

So implementing the checklist item as written would re-introduce precisely the lockout
ADR-017 was written to fix — a tile that had switched accounts unable to re-open canvases
it had drawn itself, with a refusal message that said the canvas "may belong to a session
that is still running", which was not what had happened. Being locked out of your own
canvas is a bug this app has already shipped once.

The decision is the owner's; it is on the issue. Nothing here changes behaviour either
way.

## What was actually missing, and is now here

**Corrected after review — the original claim here was too broad.** "The property was
load-bearing and unasserted" is false for the ACCOUNT half: two suites on `beta` already
cover it, and they are stronger than what this adds.

- `tests/unit/main/canvas-library-open-own.test.ts` has a whole
  `describe('the ACCOUNT does not decide anything about a canvas (ADR-017)')` block —
  the adopt fast path, the `ownedByThisSession` badge, an unstamped legacy canvas.
- `tests/unit/main/canvas-adoption.test.ts` plants `profileId` **and** `hostileExtra`,
  re-MACs, restarts, and asserts both are gone — strictly stronger than the single-field
  version here.

What genuinely had nothing asserting it is the other half: **nothing on `beta` said the
session→canvas index survives `revokeCanvasUatRoots`**, i.e. the teardown an in-tile
account switch performs. That is what the three binding tests are for, and that is the
whole of this file's novelty.

`canvas-binding-survives-account-switch.test.ts` makes it executable. It drives the real
teardown an account switch performs (the PTY dies, `cleanupSessionResources` revokes the
session's canvas roots) and the respawn under the SAME id — an account switch is
respawn-and-resume, `useSwitchAccount` → `restart` → `forceRemount`, which re-asserts
`id: session.id` and moves only `createdAt`. The three tests that actually pin the
binding assert that the tile still owns its canvas across the teardown, and that the next
render lands as v2 on it rather than v1 on a parallel one.

A fourth — "not offered its own canvas back as a reclaim candidate" — sits beside them
and is explicitly labelled as NOT a binding assertion: `isReclaimCandidate` excludes
own-session records independently of `sessionIndex`, so it stays green under the
mutation. It is there because that is the visible symptom of the lockout, not because it
guards the index.

It also keeps the account from creeping back in, though this half largely restates
coverage that already exists on `beta` (see above):

- a pre-ADR-017 record carrying a `profileId` still loads, and the retired field does not
  survive the read — the record is rebuilt field by field rather than spread, so nothing
  downstream can quietly start consulting it;
- re-opening your own canvas by id is an allowed fast path rather than an adoption. Note
  the stamp-mismatch shape ADR-017 fixed is now UNREACHABLE — the strip means no
  in-memory record can carry a foreign stamp — so the honest pin is the strip itself, and
  that lives in `canvas-adoption.test.ts`.

And, so the boundary is not overstated in the other direction, two tests state what the
switch DOES cost: the roots are revoked with the PTY, so nothing is servable until the
respawn re-registers one — ownership survives, the ability to read from disk does not —
and another session still cannot take the canvas.

## Verification

Mutation-tested with the change the checklist actually asked for: adding
`sessionIndex.delete(sessionId)` to `revokeCanvasUatRoots` — i.e. invalidating the binding
on the switch — turns **3** tests red **in this file**, and no existing suite flips (the
other `revokeCanvasUatRoots` call sites in tests assert on root resolution and serving,
never on `sessionIndex`).

The second count was reported wrong the first time and is corrected here under the Scope
Honesty Rule: letting the retired `profileId` survive the record rebuild turns **1** test
red *in this file* but at least **2** red repo-wide, because `canvas-adoption.test.ts`
already pins the strip. The original "1 red" was scoped to the new file without saying so.

Both mutations restored byte-for-byte.

One fidelity note rather than a finding: the resolver pins a constant
`conversationUuid`, where a real restart binds a fresh transcript and a NEW uuid is the
normal case after a switch. It happens not to matter — post-ADR-017 `conversationUuid` is
display-only and no longer an adoption key — so the test is easier than reality without
being wrong.

No source file changed: the diff is one test file, this fragment, and a dated amendment
to ADR-017 (below).

Full suite on the branch: 7081 passed, 15 skipped, 2 todo (662 files, 2 skipped);
typecheck clean.

## ADR-017 corrected in the same change

The review caught the ADR contradicting the code it governs. ADR-017 says the pre-ADR
`profileId` field "is not validated and not stripped"; `sanitizeRecord` builds a record
field by field rather than spreading, so it **is** stripped at read. A test in this PR
asserts the strip, so leaving the ADR as-is would have left the next reader with an
accepted ADR and a passing test saying opposite things about the same field.

Fixed as a dated amendment appended under the original sentence rather than an edit to
it: what the ADR *decided* (no migration pass rewriting every record on disk) still
holds, and the reasoning stays readable. "Not validated" was accurate and is left alone.
