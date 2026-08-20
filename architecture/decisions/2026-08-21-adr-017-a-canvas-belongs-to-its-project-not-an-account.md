# ADR-017: A canvas belongs to its project, not to an account

- Date: 2026-08-21
- Status: Accepted
- Supersedes: the account half of the adoption key introduced by the adversarial
  review of 2026-08-14 (see ADR-015 / `CONTEXT.d/2026-08-14-*` for that review).

## Context

A canvas records the account a session was running under (`profileId`), stamped
once at first render, and three decisions consulted it:

- `isReclaimCandidate` refused a canvas whose stamp differed from the asking
  session's account, exactly, `undefined` included;
- `adoptCanvasForSession`'s "re-opening your own canvas" fast path required the
  same match;
- the library badged a row `ownedByThisSession` only when it matched.

The rule came from the 2026-08-14 adversarial review, which found a real
canvas-theft primitive: adopting on a **project-directory match** let a second
tile on the same repo inherit the first tile's canvas *and* its private review
notes the moment the first tile's PTY exited. The fix correctly removed the
directory as an automatic key. The account was added alongside it as a further
floor.

That floor turned out to be wrong, and its wrongness is ordinary rather than
exotic. **A session id outlives an account switch** — switching accounts in a
tile restarts the session with the same id — while the record's stamp is fixed at
birth. So after a switch:

- every canvas that tile had drawn still read as "mine" in the library, and
  "Open here" refused it;
- the refusal said "it may belong to a session that is still running", which was
  not what had happened;
- and the *active* canvas kept working, because the session→canvas index is keyed
  on the session id alone, so the user saw one canvas behave and its siblings
  refuse.

Asked about it, the owner was unambiguous: **a canvas is project-centric, not
account-centric.**

That is also the better model. A canvas is a mockup of something in a project.
Which Claude account happened to be signed in while it was drawn is a property of
the session that drew it, not of the artifact — and users switch accounts inside
one tile for reasons (rate limits, work vs personal) that have nothing to do with
what they are designing.

## Decision

**The account decides nothing about a canvas.** `profileId` is removed from the
adoption query, from the session-info resolver, from the record stamp, and from
all three decisions above.

**The project is the axis, and it organises rather than forecloses:**

- the **library** is scoped to the project directory (unchanged — relevance, and
  fail-open when either side has no cwd);
- the **reclaim list** offers every reclaimable canvas and *marks* which are from
  the project you are in (`sameProject`, sorted first) rather than hiding the
  others.

The distinction in that second point is deliberate. The library is already
per-project; if the reclaim list filtered by project too, a canvas whose project
you never open again would have no route back at all. Being locked out of your
own canvas is a bug this app has already shipped once.

**What the 2026-08-14 review actually established is untouched**, and it is worth
restating so it is not re-litigated: a directory match must never be what MOVES a
canvas. It still isn't. The user picks a row by id, and the one floor their
choice cannot lower remains "a canvas whose owner might still come back is never
taken", with its oracle failing safe.

Records written before this ADR keep their `profileId` field. Nothing reads it.
It is not validated and not stripped — rewriting every record on disk to remove a
field nothing consults would be the riskier change.

## Consequences

- A tile that switches accounts keeps full access to the canvases it drew. This
  is the reported problem, fixed.
- The account is no longer a barrier between two sessions on the same machine.
  This is a real reduction in separation, and it is accepted knowingly: a canvas
  holds the user's own mockups and their own review notes, both parties are the
  same human on the same machine, and no privilege boundary is crossed. The
  guards that stop one *session* taking another's canvas are unchanged.
- A future adversarial pass will find no account check here. That is intentional,
  and this ADR is the record of why — do not re-add it without a new decision.
- The session→canvas index remains keyed on session id alone, so the active
  canvas follows a tile across an account switch. Under this ADR that is correct
  behaviour rather than the leak it looked like beforehand.
