## 2026-09-27 -- WP2 P3: the multi-provider usage track (MP1 to MP13)

**What.** The owner approved the usage UX on 2026-09-27 (account summary,
usage footer, Tokenomics; `docs/wp1/owner-decisions-2026-09-27.md`) and the
track built it in thirteen phases on PR #625's branch:

- MP2, MP3: Codex allowance readings normalised from rollouts and the
  app-server answer (5h, Weekly, one per separate limit), a provider-neutral
  usage port, the last-seen reader of a realm's newest rollout, and the
  usage stream and one-account IPC (strict schemas, trusted sender).
- MP4: the Usage page grouped by provider, Codex cards with live, fresh and
  last-seen figures, no-session and per-token notes; the rail shows the page
  at two or more accounts across both providers.
- MP5, MP6: the footer as one pill per identity, grouped by provider, never
  merged; bars hidden per provider (the bare-label list migrated); the strip's
  no-reading meter after a reset and cost wording per sign-in method.
- MP7, MP8 (ADR-022, the scoped WP1.41 exception): one short
  `codex app-server` read of a closed ChatGPT account, only on the page's own
  asks (open, Refresh, Retry), one at a time, never for an API key, this
  computer's own Codex folder or an account in use; launches, sign-ins and
  lifecycle changes stop and wait for it. The VM walk verified 0.153.4 and
  0.155.1 and never read 0.157.1. The argv stays the constant `app-server`:
  a `--disable remote_plugin` experiment made the helper contact GitHub and
  leave clone folders in the realm, so it was reverted (MP8 round 3).
- MP9 to MP12: Tokenomics records whose usage each row is (Codex by realm
  folder, Claude by the profile home's .claude/projects folder a local
  session's transcript is in, from now on), keeps the v1 rollups for
  older builds, splits every figure by provider, reads "no price" instead of
  $0, and adds Provider and Account filters.
- MP13: the user-facing sweep (changelog, app knowledge, tips, tour, README,
  user guide, privacy) and the parity checklist rows 17 to 21 and 25 to 30.

**Why this way.** Parity with Claude where it carries over (the page, the
footer, the strip); the app-server read because a closed Codex account has
no other current figure; fail closed to the last-seen reading everywhere;
no manual attribution (June decision).

**Residuals and what is owed** are in `docs/wp2/plan.md`: a read also
refreshes Codex's model list and checks its plugin cache (listed in
PRIVACY.md); Codex usage stored during a downgrade stays Not recorded; the
account chip on the strip and sidebar; a real 0.155.1 rollout fixture; the
VM screenshots of the Usage page and Tokenomics in three modes; macOS,
Linux and packaged runs.
