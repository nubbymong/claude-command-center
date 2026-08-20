## 2026-08-21 -- the canvas account floor comes out again

Shipped an account floor on the canvas adoption path yesterday (#308), as the fix
for a fence the 2026-08-14 adversarial review had installed and the "open your own
canvas" fast path had bypassed. The owner's call on seeing it: a canvas is
PROJECT-centric, not account-centric. Which Claude account was signed in when a
mockup was drawn is a property of the session that drew it, not of the artifact.

The floor was wrong in an ordinary way rather than an exotic one. A session id
outlives an account switch -- switching accounts in a tile restarts the session
with the same id -- while the record's stamp is fixed at first render. So after a
switch the tile's own canvases still read as "mine" in the library and "Open here"
refused them, with a message about a session that was still running, which was not
what had happened. Meanwhile the ACTIVE canvas kept working, because the
session-to-canvas index is keyed on the session id alone. One canvas behaved and
its siblings refused.

Removed: `profileId` from the adoption query, the session-info resolver, the record
stamp and all three decisions (reclaim candidacy, the own-canvas fast path, the
library badge). Records written earlier keep the field; nothing reads it, and
rewriting every record on disk to drop a dead field is the riskier change.

I also tried making the project a FILTER on the reclaim list, and backed it out
when the tests said so: the library is already per-project, so filtering there too
would leave a canvas whose project you never open again with no route back. The
project marks and sorts that list instead. Being locked out of your own canvas is
a bug this app has already shipped once.

What the 2026-08-14 review actually established is untouched, and ADR-017 says so
explicitly so it is not re-litigated: a directory match must never be what MOVES a
canvas. It still isn't -- the user picks a row by id, and "a canvas whose owner
might still come back is never taken" remains, with its oracle failing safe.

The follow-up I raised at the end of the #308 pass -- the session-to-canvas binding
surviving an account switch -- is answered by this decision rather than fixed. Under
ADR-017 it is correct behaviour.
