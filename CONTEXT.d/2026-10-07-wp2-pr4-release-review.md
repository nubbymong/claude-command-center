## 2026-10-07 -- WP2 PR 4: fix pass 16, the two findings of the release review

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
takes a sign-in or a pane once its own wipe ends, as after any clear. Owed:
its spec and quality reviews, the ADR-009 pass (account sign-in storage) and
CI at its head.

Where PR 4 stood before it: the reviews and attack passes of fix passes 10 to
15 PASS; CI is green at 91e438fd (run 37553704348), the Linux and Codex
conformance jobs included, and the Desktop test gate waits on the owner
(#309); the VM final pass ran at dc9d6aeb (the package upgrade, e2e 94 of 94,
native 226 of 226, the quarantine suites, the paste and colour checks), and
the commits from there to 91e438fd change no main or preload source. Still
owed: the SSH live matrix and the owner's checks.
