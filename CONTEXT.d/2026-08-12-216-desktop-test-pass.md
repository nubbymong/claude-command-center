## 2026-08-12 -- 216: desktop test pass, and the launcher bug it uncovered

Structured five-question pass through the per-account claude.ai web session in the
real app, on the post-adversarial build. Every answer was cross-checked against the
dev log, the stored session records and the filesystem rather than taken on report.

### Results

- BUILD. Confirmed the running bundle was the post-fix one by matching marker
  strings in `out\main\index.js`, not by assuming a restart picked it up.
- SIGN-IN ROUND TRIP. Clean: 18 cookies, no `__Host-` rejection, and a stored
  expiry 28 days out instead of the old 30-minute `__cf_bm` floor.
- ARTIFACTS. Opened as the account that asked.
- ISOLATION (T10). Two accounts signed in, two partitions, each artifacts window
  showed its own account. Previously verified only on the pre-fix build.
- CHROME NEGATIVE PATH. With the picker set to Chrome, Chrome launched and the SSO
  step failed, as predicted. This is the first deliberate confirmation of the
  premise behind the Edge default rather than an inference from one Edge success.

### Fixes proven live rather than only in tests

- The background profile removal fired twice for real (`removed the sign-in profile
  dir on retry 2`). Two teardowns hit EPERM and were cleaned about five seconds
  later; final leftover count zero. This is the path that used to leave a live
  `sessionKey` on disk.
- Browser-exit detection, by inference: `runSignIn` is single-flight, so an
  abandoned sign-in that kept polling for its full five minutes would have made the
  next sign-in fail with "already in progress". It did not. The inference assumes
  no five-minute gap between the two.
- The per-account browser picker demonstrably drives the launch: the log shows
  `launching edge` and `launching chrome` for the same profile as the setting
  changed, and `authBrowsers` persisted the choice.

### The launcher bug this uncovered

Seeding dev credentials from prod was blocked by a symptom that looked unrelated:
with any flag, the dev window opened and closed instantly with no GUI and no log.
Cause: `shift` shifts `%0` as well as `%1..%9`, so after parsing one flag `%~f0` was
no longer the script -- it was the flag, resolved against the current directory.
The launcher then told `start` to run `<cwd>\--seed-accounts`, the child could not
find it, and the window died before the log file was created.

That broke EVERY flag (`--seed`, `--seed-accounts`, `--clean`, `-nv`) while plain
`ccc` worked, because with no arguments the parse loop exits before it ever shifts.
The evidence had been in front of us all session: every log header ever written
reads `vision= seed= clean=`, empty even on runs where a flag was passed. It read
as "the flag did nothing" rather than "the flag killed the handoff".

Two process notes worth keeping. A probe of `start` from a non-interactive tool
cannot create a console window, so an early "reproduction" of the vanishing window
was the harness failing, not the bug -- nearly reported as confirmed. And the first
attempt at teeing seed output to the log used `Tee-Object`, which on PowerShell 5.1
has no `-Encoding` and writes UTF-16, appending mojibake into an ASCII log; the
log-readability fix needed its own fix.

### Not verified

- The revocation race (a sign-out landing mid cookie-write) -- unit-tested only, not
  reachable by hand.
- The POSIX process-group kill -- this is a Windows machine, so that branch has
  never executed.
- Account delete under the new clear-before-teardown ordering -- destructive, so it
  was not exercised.
- No round-4 adversarial pass ran against the round-3 fixes. They carry
  mutation-verified unit guards, but the last independent verdict on this code was
  FINDINGS, not PASS.

### State

Gate at the end of the pass: typecheck clean, build clean, unit suite 3916 passed.
The single failure in a full run is #213 (`insights-cross-account-run`, order and
timing dependent under load) -- it passes in isolation, surfaced as a different test
than last time, and touches no account-web code.
