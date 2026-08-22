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

The property was load-bearing and **unasserted**. Nothing failed if someone re-added an
account check or invalidated the index on the switch, and an adversarial pass finding no
account check had no way to tell *deliberate* from *missing*. ADR-017 says a future pass
will find none — but said it only in prose, in a file the code does not reference.

`canvas-binding-survives-account-switch.test.ts` makes it executable. It drives the real
teardown an account switch performs (the PTY dies, `cleanupSessionResources` revokes the
session's canvas roots) and the respawn under the SAME id — an account switch is
respawn-and-resume, `useSwitchAccount` → `restart` → `forceRemount`, which re-asserts
`id: session.id` and moves only `createdAt`. Then it asserts the tile still owns its
canvas, renders v2 onto it rather than a parallel v1, and is never offered its own live
canvas to "reclaim".

It also pins the two things that keep the account from creeping back in:

- a pre-ADR-017 record carrying a `profileId` still loads, and the retired field does not
  survive the read — the record is rebuilt field by field rather than spread, so nothing
  downstream can quietly start consulting it;
- re-opening your own canvas by id is allowed whatever stamp it carries — the exact
  regression ADR-017 fixed.

And, so the boundary is not overstated in the other direction, two tests state what the
switch DOES cost: the roots are revoked with the PTY, so nothing is servable until the
respawn re-registers one — ownership survives, the ability to read from disk does not —
and another session still cannot take the canvas.

## Verification

Mutation-tested with the change the checklist actually asked for: adding
`sessionIndex.delete(sessionId)` to `revokeCanvasUatRoots` — i.e. invalidating the binding
on the switch — turns **3** tests red. Letting the retired `profileId` survive the record
rebuild turns **1** red. Both restored byte-for-byte.

No source file changed: the diff is one test file and this fragment.

Full suite on the branch: 7081 passed, 15 skipped, 2 todo (662 files, 2 skipped);
typecheck clean.
