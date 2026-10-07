## 2026-10-07 -- WP2 PR 4: fix passes 16 to 18, the release review and its reviews

Fix pass 16 (aff08b70, 3332c3ac), for the release review of 2026-10-07,
each fix with tests red before it (6 new tests; 7 mutants, 7 red). A Codex
Insights report counts a session whole or not at all: a session larger than
the read limit is left out and counted, the prompt says how many and why, and
a run with none left gives that reason, so every figure, the digest and the
saved report stand for whole sessions (the approved design reads each session
whole, and the prompt is where sessions not read are already named). The start
sweep of chatgpt.com sessions with no record chooses and bars its accounts
before its first wait, with no wait coming between the record read and the
bars, so a sign-in that completes on another account while it runs keeps its
session and its record, in the sign-in window or the account pane; a chosen
account takes a sign-in or a pane once its own wipe ends, as after any clear.
Its spec and quality reviews and its ADR-009 pass are answered by fix pass 17,
below.

Where PR 4 stood before it: the reviews and attack passes of fix passes 10 to
15 PASS; CI is green at 91e438fd (run 37553704348), the Linux and Codex
conformance jobs included, and the Desktop test gate waits on the owner
(#309); the VM final pass ran at dc9d6aeb (the package upgrade, e2e 94 of 94,
native 226 of 226, the quarantine suites, the paste and colour checks), and
the commits from there to 91e438fd change no main or preload source.

Fix pass 17 (3e50a9cf, 05b629fb), for fix pass 16's spec and quality reviews
and its ADR-009 pass (the Insights read, account sign-in storage), each change
with a test red before it (7 new tests, 8 changed; 19 mutants, 18 red, and 1
equivalent survivor: dropping the close right before each wipe, which the
close at bar time already covers). A completed Codex Insights report now says
on the page, not only in the prompt and the run log, that a session was left
out as larger than the read limit: the saved report's subtitle ends "1 session
left out: larger than the 256 MB read limit", and report.json keeps it. The
spec review read the release review's "accurate explanation" as owed to the
user, not only to the model, and the subtitle is the report's own line for
the app's counts, so no new field or screen was needed. Such a session is now
left out wherever it sits in the newest-first order: a re-run, whose newest
rollout is the report's own earlier run, reads the same sessions as the first
run, and an account with a newer session ahead of the large one reads its
older sessions too. The limit is worded from its constant, and the prompt
calls the sessions read the most recent "not left out" when one was. The
start sweep of chatgpt.com sessions with no record closes a chosen account's
open panes as it bars it, so no sign-in is recorded under the bar; its tests
now pin the bars in the call's own tick, each bar lifting when its own wipe
ends, and a failed wipe lifting its bar.

Known and left as is (cosmetic): a run that finds no session it can read, in
a sessions folder that holds a link as well as a session larger than the
limit, gives the link as its reason and does not name the large session; the
link reason came first before fix pass 16 too.

The user-facing surfaces for the new subtitle text: app knowledge, the
Feature Guide, the tour, the tips, the report's help text and the changelog
make no Insights claim it contradicts, so none needs a change.

The T27 move (0061b2b2): T27 needs a host with a system tmux, and the Pi
lane's host is deliberately without one, so it moved to the linuxKey lane
with the same assertions; that lane passed 4 of 4.

Fix pass 17b, for fix pass 17's spec and quality reviews (PASS, with nits)
and its ADR-009 re-attack (two minors), and fix passes 17c and 17d, for 17b's
and then 17c's spec and quality reviews, each new test red before its change
(17b: 4 new tests, 2 changed for typing only, 6 mutants, 6 red; 17c and 17d:
3 new tests, 1 changed, 10 mutants, 10 red, 17d's test pinning where the
first chunk ends). How the report's own earlier runs meet the read limit:
- A file the read can tell, within its first chunk, is one of the report's
  own earlier runs is left out there, is not counted as a session, and spends
  none of the limit.
- A file that names a run folder only after its first chunk is left out
  too, but spends its full size like any other file.
- When the next file does not fit what is left but fits the whole limit, the
  read looks at its first chunk before stopping: an own run told there is
  passed over at no cost to the limit and the read goes on; anything else
  stops the read as before, with what that chunk held set aside and the file
  counted as not read.
- So the sessions read stay within the limit, and on top of it each such own
  run costs at most its first chunk (of at most 200 files), as does the one
  file the read stops at.
A session behind such an own run that fits the limit is read, and the run
completes on it. New tests also pin that a session grown since the walk is
read only to its size at the walk, that the read stops at the first session
that does not fit what is left, and that the start sweep leaves an account
it did not choose alone (a pane open on it stays open, and it is never
barred). Two older test lines typecheck now with no change in what they
test, and the sweep's comment says no wait comes between the record read
and the bars. Fix pass 17c passed its spec and quality reviews and the
ADR-009 re-attack; 17d closed their two nits.

Fix pass 18: a Codex account stays barred until its storage clear actually
ends. Every wipe of an account's chatgpt.com partition bars it from a
sign-in or a pane. The wait for the storage clear stays bounded, so a
sign-out, an archive or the start sweep still answers or moves on in time,
but the bar now lifts only when the clear itself ends. A clear that ends
with an error has ended too, so a failed wipe still lifts its bar at once;
one that never ends keeps the account barred for the rest of the run, with
the existing "being cleared" message. Overlapping wipes each lift only
their own share, once. 3 new tests; 7 mutants, 6 red, and 1 equivalent
survivor (removing only the once-only guard, which no path needs while each
share is released once).

The owner approved the README and Feature Guide images on 2026-10-07; they
are committed separately.

Owed now: the reviews and the ADR-009 confirmation of fix pass 18, and CI at
the new head; the PR-level ADR-009 pass at PR 4's final head; the SSH live
matrix and the owner's other checks.
