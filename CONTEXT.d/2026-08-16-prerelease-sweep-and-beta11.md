## 2026-08-16 -- Pre-release adversarial sweep of the unreleased commits, then beta.11

Before cutting 2.1.0-beta.11, every commit on `beta` not yet released
(v2.1.0-beta.10 .. HEAD) went through a bounded multi-agent adversarial sweep
(per-cluster investigators + attackers + synthesis, one attack round). Canvas P2/P3
got an interaction-and-completeness pass only -- its sanitiser/envelope/served-HTML
core already held a recorded PASS from rounds 3-8 and was not re-attacked. Verdict
was FINDINGS; the release-relevant items were fixed and merged (#282), each
mutation-proven (revert -> named test red -> restore), with the full unit suite
green and typecheck clean.

Recording the ADR-009 sign-off the tracked log still said was owed:

- **Agent Canvas P2/P3 (ADR-009).** The security core held under the sweep's
  interaction/completeness probe -- served-root allowlist (per-session, taken from
  the configured project dir, not the resume override), content-egress/frame-nav
  confinement, user-authorized reclaim, and the Windows plugin-tree DACL all held.
  The deliberate configured-project-dir -> canvas served-root registration is
  owner-signed-off as of this release.

Fixes that landed in #282 (the sweep survivors):

- **terminal:** the clipboard sanitiser added last round was not the single
  chokepoint it claimed -- xterm's own native paste handler (reached via the
  Edit>Paste menu / webContents.paste, and via Ctrl+V while a modal keeps the
  terminal focused) pasted the raw clipboard past it. A capture-phase paste listener
  on the terminal container now sanitises at the real boundary, so every native
  paste route is covered. Public fix, no advisory (base bug was owner-reported and
  fixed via public PRs; this route is on unreleased beta code).
- **account-web:** the Cloudflare sign-in's `getAllCookies` was a bare await outside
  the per-target try/catch, so a routine mid-challenge target death aborted the flow
  and force-killed the browser; it now fails soft and retries.
- **accounts:** parked accounts are no longer offered a sign-in on the Insights
  re-auth banner (matching the usage page); the usage panel's blue Sign in is gated
  on the active flag; the sidebar web actions gate on `!shellOnly`; the CLI auth
  probe coalesces overlapping calls and the transient-consumer registry self-heals a
  leaked ref (bounded to a max age).
- **onboarding:** the canvas consent copy no longer claims "nothing while the pane is
  closed" (the snapshot self-check lays a page out headless), keeping the accurate
  folder-scope promise.

Security advisories published with this release:

- **GHSA-3ghm-39v2-53ph (high).** On Windows the credential-directory hardening was a
  POSIX-only no-op, leaving the Claude OAuth token files modifiable by any local
  authenticated user. The Windows ACL hardening (icacls) shipped with the canvas DACL
  work and is wired on every credential directory. Fixed in beta.11; beta.10 and
  earlier affected.
- **GHSA-f3wv-ppx5-m3v4 (medium).** The Conductor MCP server's `POST /messages`
  authenticated the caller but routed the POST to whichever transport the query
  string named, without binding it to the authenticated session. Now bound via a
  pure, tested `authorizeMessagePost` (owner must equal the authenticated session;
  fails closed on an ownerless transport or absent session; an owner mismatch returns
  the same 404 as an unknown transport, so it is not an existence oracle). This fix
  had its own independent ADR-009 pass (two attackers, bypass + regression lenses,
  both PASS; legit same-session POSTs confirmed intact end to end). Fixed in beta.11;
  beta.10 and earlier affected.
