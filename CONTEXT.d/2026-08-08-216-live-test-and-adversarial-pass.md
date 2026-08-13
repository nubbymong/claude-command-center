## 2026-08-08 -- 216: first live sign-in, and the ADR-009 adversarial pass

The per-account claude.ai web session was exercised in the desktop app for the first
time. It worked end to end -- two accounts signed in, artifacts opened as each, and
cross-account isolation held -- but only after five defects that no unit test had
caught, and the ADR-009 pass then found nine more across three rounds.

### What the live run found

1. THE POLLER WAS ASKING THE WRONG TAB. `chrome-remote-interface` connects to the
   first page target it is offered. Captured from a real launch, that was an
   extension's own `claude.ai/oauth/authorize?...redirect_uri=chrome-extension://...`
   page -- same origin, so every check passed -- ahead of both `/login` and the
   account-selection tab. The connection was made once and never remade, so when that
   transient page went away, every poll evaluated against a dead target and returned
   null until the five-minute timeout. The user signed in successfully and nothing was
   harvested, with no error logged anywhere. The loop now re-enumerates every poll and
   tries each claude.ai page, human tabs first.
2. A CLOSED BROWSER WAS INDISTINGUISHABLE FROM A SLOW ONE. Closing the window left the
   sign-in polling nothing for the full timeout and then blaming the timeout.
3. THE REPORTED EXPIRY WAS THE WRONG COOKIE'S. `expiresAt` was the earliest expiry
   across the whole jar, and the jar contains Cloudflare's `__cf_bm`, which lasts 30
   minutes -- so a fresh session reported half an hour of life and `statusOf` would
   have called it expired. It is `sessionKey`'s own expiry now.
4. `__Host-` COOKIES WERE REJECTED ON INJECTION. Chromium enforces the prefix on set;
   we passed a domain attribute with a cookie whose prefix means host-only. 18 cookies
   became 19 once the prefix rules were satisfied rather than passed through.
5. A PROFILE DIR HOLDING A LIVE SESSION SURVIVED CLEANUP, twice, with EPERM. Chrome and
   Edge are process trees and `proc.kill()` reaps only the parent. Teardown now takes
   the tree, and removal retries on a backoff instead of deferring to the next app
   start -- which could be days away.

### The browser question this started from

Chrome's policy force-installs `Microsoft Single Sign On`, but force-installed
extensions are fetched ASYNCHRONOUSLY and the sign-in creates a fresh profile by
design, so claude.ai loaded before the extension existed and SSO failed. Edge does
Entra SSO natively. Verified by hand on both. The browser is therefore a per-account
choice defaulting to Edge, and a fallback to the other browser is reported rather than
silent -- see the 2026-08-07 fragment.

### The adversarial pass (ADR-009)

Three rounds, independent attackers, no self-review. Everything found was in unmerged
branch code -- `beta` carries no `account-web` at all -- so no embargo applied and all
of it is recorded here. Nine findings fixed: an identity check that failed OPEN when it
could not ask which page it was talking to (an attacker got a page on another origin
accepted as the account identity); a stale background timer that deleted a LATER
sign-in's live profile, reachable by an ordinary "try again"; a startup sweep that
recursive-deleted by unvalidated directory name; hostname matching that accepted plain
http; a sign-out that a concurrent sign-in silently undid; an account delete that
dropped the record while leaving live cookies and reported success; unbounded waits
that let one hung call wedge sign-in for every account until restart; a blind POSIX
group SIGKILL at a possibly-recycled pid; and a profile-id shape that allowed two ids
differing only in case to name one directory but two partitions.

Two lessons worth keeping. First, EVERY regression guard was reverted and watched to
fail before being accepted -- and the first version of one of them passed against the
very code it was written to catch, which is how a guard becomes worse than no guard.
Second, two existing mocks returned a `ChildProcess` with no `exitCode`, which made a
live browser look already-reaped and silently skipped the tree kill the test was
asserting; the mock, not the code, was doing the lying.

### State

`feat/216-account-web-session`, 8 commits, unpushed, clean. Typecheck and build clean;
unit suite 3908 passed, exit 0. The one failure seen in a full run is #213
(`insights-cross-account-run`, order/timing dependent under load) -- it passes in
isolation and touches no account-web code.

Verified in the desktop app: sign-in through Edge, harvest, artifacts as each of two
accounts, cross-account isolation, sign-out, the per-account browser picker, and
profile-dir cleanup. NOT yet exercised live: the Chrome negative path, and the
adversarial fixes themselves (unit-tested only; the app has not been restarted since).
