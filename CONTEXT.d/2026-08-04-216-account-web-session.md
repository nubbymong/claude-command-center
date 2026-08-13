## 2026-08-04 -- Per-account claude.ai web session via a system-browser handoff (#216)

A CCC account has TWO credentials that look like one thing to a user: the Claude Code CLI's OAuth
token, and a claude.ai WEB session. Three things the app wants -- importing an organisation-scoped
share, listing a secondary account's conversations, and opening artifacts as the account that
produced them -- are web features, and the OAuth token does not authenticate them.

Verified rather than assumed, on 2026-08-04:

```
GET https://claude.ai/api/organizations        Bearer <claudeAiOauth.accessToken>  -> 403
GET https://claude.ai/api/bootstrap             (same token)                        -> 200, account: False
GET https://claude.ai/api/bootstrap             (no token)                          -> 200, account: False
GET https://api.anthropic.com/api/oauth/profile (same token)                        -> 200
```

`account: False` on an AUTHENTICATED bootstrap is the proof: the token is for `api.anthropic.com`,
not `claude.ai`. There is no way to derive the web session from it.

### Why the browser, and why the user's own one

The obvious shape -- a loopback "SSO server" doing our own OAuth -- cannot work here. claude.ai's
SSO `redirect_uri` is registered server-side (`https://claude.ai/sso-callback`, brokered through
WorkOS), so a client cannot substitute a `127.0.0.1` callback; the redirect allowlist is the security
property of the flow. And the one loopback flow that DOES exist is Claude Code's own, which produces
the token the web API rejects above.

An embedded Electron window is also out, and #209 proved it on a real machine: that window loads no
browser extensions, so a compliance-mandated SSO plugin is absent and the login never completes.
Widening its navigation allowlist fixed the symptom, never the premise.

What makes the system browser viable is one verified fact: Chrome's `ExtensionInstallForcelist` is
set under **HKCU**, and force-installed extensions install into ANY profile -- including a fresh one
CCC creates. So a dedicated profile still gets the compliance plugin. Chrome 136+ refuses
`--remote-debugging-port` against the DEFAULT profile anyway, so debugging the user's everyday
browser was never an option -- and should not be: CCC must not attach a debugger to the browser
someone reads their mail in.

Two things were considered and rejected outright. Shipping our own helper extension: Edge policy
here is `ExtensionSettings: {"*": {"installation_mode": "blocked"}}`, so it cannot be installed.
Reading cookies out of the user's existing profile: that is what App-Bound Encryption exists to
prevent, it is the infostealer pattern, it breaks on Chrome updates, and it conflicts with the very
compliance posture that motivated the ticket.

### The shape

CCC launches the user's real Chrome with a dedicated per-account profile and a loopback debug port,
the human completes SSO with their plugin and their MFA, CCC polls claude.ai's own `/api/bootstrap`
until it reports an account, harvests ONLY the claude.ai cookies over CDP, injects them into that
account's Electron partition, then kills the browser and destroys the profile dir.

The pieces where the security lives are pure and tested without launching anything:

- **`webPartitionForProfile`** -- one persistent partition per account. That IS the isolation model;
  a shared partition would let a session running as account B read account A's cookies. The profile
  id names a security boundary, so it is re-validated rather than trusted: a traversal-ish id throws
  instead of being sanitised into something that resolves elsewhere.
- **`harvestClaudeCookies`** -- exact host membership, not a suffix test, so `claude.ai.attacker.example`
  and `evilclaude.ai` are rejected. Only claude.ai cookies are copied; the profile is the user's and a
  wholesale jar copy would sweep unrelated sites' sessions into CCC storage for no benefit. A session
  cookie is never given an `expirationDate`, which would promote it to persistent and outlive the
  browser session it came from.
- **Success needs BOTH** an authenticated bootstrap and a real `sessionKey`. A jar without one keeps
  waiting rather than declaring victory -- injecting it would leave the partition looking signed in
  while every request 401s, a failure that surfaces much later and somewhere else.

The debug port is loopback-bound, open only while a sign-in runs, and on a DIFFERENT port from
Vision's. Sharing would be worse than colliding: Vision's port is reachable by every session's MCP
tooling, and this browser briefly holds a live claude.ai session.

### The code half is delegated, not reinvented

CCC already refuses to implement Codex's OAuth -- it shells out to `codex login` and reads
`~/.codex/auth.json`. The same seam exists for Claude (`claude auth`, `claude setup-token`), and it
is the right one for a managed machine for exactly the reason the embedded window failed: the CLI
drives the user's real browser. `claude-cli-auth.ts` therefore reports STATE and hands back the
command; it never handles a token, because the CLI owns that file and a second copy is a second
thing to protect. `parseCliAuth` fails CLOSED on a malformed file -- the UI decides whether to prompt
for a sign-in from it, and guessing "authenticated" would hide a broken account.

Doing the web sign-in FIRST means the CLI's OAuth hop is a consent click rather than a second
credential entry. One human sign-in, both credentials.

### A bug the tests caught

`runSignIn` documents that it never throws, but the profile-id validation sat OUTSIDE the guarded
path, so a malformed id escaped as an exception while every other failure returned a state object.
Resolved inside it now.

### Not done here

The share-link fetch rewire to the per-account partition is NOT in this branch: #209 is unmerged, so
`share-link.ts` does not exist on `beta` yet. It is a one-line change to
`webPartitionForProfile(profileId)` once #209 lands, and the seam is already pinned by a test on that
branch.

Untested by machine and needing a human on a managed workstation: whether the compliance plugin
actually loads in the fresh profile. That is the premise the whole design rests on, it was derived
from the policy registry rather than observed, and no unit test can stand in for it.
