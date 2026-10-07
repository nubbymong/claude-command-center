## 2026-10-07 -- WP2 PR 4: fix passes 16 and 17, the release review and its reviews

Fix pass 16 (aff08b70, 3332c3ac), for the release review of 2026-10-07,
each fix with tests red before it (6 new tests; 7 mutants, 7 red). A Codex
Insights report counts a session whole or not at all: a session larger than
the read limit is left out and counted, the prompt says how many and why, and
a run with none left gives that reason, so every figure, the digest and the
saved report stand for whole sessions (the approved design reads each session
whole, and the prompt is where sessions not read are already named). The start
sweep of chatgpt.com sessions with no record chooses and bars its accounts
before its first wait, with nothing run between the record read and the bars,
so a sign-in that completes on another account while it runs keeps its session
and its record, in the sign-in window or the account pane; a chosen account
takes a sign-in or a pane once its own wipe ends, as after any clear. Its spec
and quality reviews and its ADR-009 pass are answered by fix pass 17, below.

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

Owed now: the confirmations of fix passes 16 and 17 by the same reviewers and
attackers, and CI at their head; the PR-level ADR-009 pass at PR 4's final
head; the SSH live matrix and the owner's checks.
