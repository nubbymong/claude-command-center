## 2026-08-14 -- 269: stop running page script during the Cloudflare challenge

Nubby found the #216 web sign-in loops forever on residential IPs and fresh VMs:
claude.ai serves a Cloudflare managed challenge, and ticking "verify you are human"
re-issues indefinitely. Root cause, well-diagnosed in the report: the poll loop ran
`readAccountEmail` -- which calls `Runtime.evaluate` to run script IN the login page
-- on EVERY 1.5s poll. Turnstile treats an attached debugger evaluating in the page
as automation and re-arms the challenge, so the mechanism that READ the sign-in
result was what made the sign-in un-clearable. Does not reproduce behind a corporate
Cloudflare-trusted IP, which is how it got through review.

### The fix (nubby's direction 1)

Reorder the per-poll inner loop so no page script runs until the challenge is
demonstrably cleared:

  connect -> targetIsClaudeAi (Target.getTargetInfo, no page script)
          -> Network.getAllCookies (no page script)
          -> if NO session cookie: stop here (this is the whole challenge window)
          -> only once a sessionKey exists: the single readAccountEmail evaluate

`Runtime.evaluate` now runs at most once, after a real session cookie proves the
challenge already passed. Pinned by test: with the session cookie withheld the run
times out and evaluate is NEVER called; once granted it runs exactly once. Verified
by reverting to the old order and watching both fail.

Plus: a pure `isCloudflareChallenge()` classifier (url has challenges.cloudflare.com
or /cdn-cgi/challenge-platform/, or title "just a moment...") surfaces a live notice
so the challenge no longer looks like nothing happening until the 5-minute timeout
blames a closed window. And a renderer gating fix: the account context-menu items
(Authenticate / Open artifacts) were hidden when a session had no explicit
profileId -- the fresh-install default-account case, exactly when a user first needs
them. They now fall back to the primary profile, which is the account a
no-explicit-profile local session actually runs as (pty-manager resolves the same).

### Adversarial pass (ADR-009): PASS

Independent attacker re-verified the three #216 hardening guarantees survive the
reorder -- fail-closed dual-origin identity, claude.ai-only cookie harvesting, and
completion requiring BOTH a real session cookie and a genuine account email. The
classifier is pure and drives only a constant UI string (no attacker content into
the renderer). All committed account-web suites pass. Two MINOR/cosmetic notes,
neither a security impact: `tag()` lets a browser-substitution notice override the
Cloudflare notice in the rare case both apply; and the Sidebar primary-fallback also
covers shell-only local sessions (harmless -- signs the primary's own web partition).

### The load-bearing caveat

CANNOT be confirmed to fix #269 from here. The change removes the REPORTED detection
vector (per-poll page script), but a page-target attach, getTargetInfo and
getAllCookies still run each poll on the challenge page. If Turnstile keys on the
debugger ATTACH itself rather than on script execution, this is necessary-but-not-
sufficient and the fallback is nubby's direction 3: drop --remote-debugging-port
entirely and read+decrypt the cookie DB off disk after the browser exits. The
diagnostic that decides it -- offered by the reporter -- is whether the loop persists
with --remote-debugging-port manually removed from the argv. This environment
(corporate/Cloudflare-trusted IP) does not serve the challenge, so nubby is the only
one who can verify.

### State

Gate: typecheck clean, build clean, unit suite 4213 passed. NOT merged, NOT
desktop-verifiable here. On fix/269-cloudflare-cdp-challenge; PR opened for nubby to
verify on the repro machine before any merge is recommended.
