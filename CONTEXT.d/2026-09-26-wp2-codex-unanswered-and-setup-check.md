## 2026-09-26 -- WP2: an unanswered Codex starts nothing, a read-only setup check, and the start-up adoption retired

Draft PR #625 (branch `session/beta/c4d568ce-wp2-codex`). Finishes the parity
reset recorded in `docs/wp1/owner-decisions-2026-09-26.md` (U1 upgrade, U2
setup check, U3 small rules, P1 parity rule). Local commit only; not pushed.

### What landed

- **Three-state Codex preference.** Codex is on only when the saved setting is
  answered yes (`codexAnswered` + `codexEnabled`). An upgrader whose settings
  carry `codexEnabled` without an answer sees the one-time "Do you use Codex?"
  page (`CodexReconfirmPage`, `codex-reconfirm-gate.ts`). Until then nothing of
  Codex starts: main refuses every CLI-starting operation, launch, review and
  secret handle through one rule (`cliRefusal`, reusing `launchRefusal`), and an
  in-memory switch-on never counts while the saved setting reads unanswered or
  cannot be read. The last-provider rule counts only a provider that could
  launch. Renderer surfaces (status strip, onboarding tools and recap, review
  tools, launch rows, New session dialog) say "Codex not set up" through shared
  helpers (`codexPreference`, `usesCodex`, `providerAnsweredOn`,
  `providerNotSetUp`); an unreadable Claude preference no longer reads as "not
  set up". New failure code `provider-not-set-up`.
- **Read-only setup check (U2).** `probeExternalDefault` asks Codex whether this
  computer's `~/.codex` is signed in and keeps nothing: no account, no journal,
  no lease. It shares `externalDefaultStatus` with the explicit adoption, takes
  no lease, is aborted by a switch-off or a lost answer (new optional
  `AuthStatusOptions.signal`), and leftovers from an interrupted run are dropped
  at start (`dropLeftoverExternalReservations`). IPC
  `providerAccounts:probeExternal`. Only "Use this sign-in" or the Settings
  button adopts; "check again" after the page's own check re-runs the check.
  The Codex CLI itself keeps scratch files under `~/.codex/tmp/` when asked;
  the app writes nothing there (PRIVACY.md, release-qualification evidence).
- **Start-up adoption retired.** No shipped build ever ran it, so the
  `RUN_MIGRATION` channel, `migrateExternalDefault`, `external-default-migration.ts`
  and its test are gone; WP1 tests repointed to the probe.
- **Guidance.** Guided tour, Memory and Statusline banners, device-code copy
  removed, the setup-page known issue replaced by the check. Superseded notes
  in `docs/wp2/plan.md` and `docs/wp2/hello-codex-spec.md`. Tracked parity
  checklist `docs/wp2/parity-checklist.md` keeps Mocked / Real CLI / Packaged
  evidence apart.

### Verification

- `npm run typecheck`, `npm run changelog:check`, non-ASCII scan: clean.
- Host-safe explicit batch (201 files): green except the legacy-codex gate pair,
  which needs this commit's index; the gate is 0 problems / 372 paths.
- Mutation proofs: every guarded fix has a test that fails under its mutant
  (journals kept locally).
- Independent spec-compliance and code-quality reviews, fixed, re-reviewed: PASS.
- ADR-009 adversarial pass, bounded to one round plus one confirmation round,
  Opus lenses (answer bypass, setup-check state machine, IPC + MCP): round one
  found one major and several minors, all introduced by this change; each fixed
  with a regression test; confirmation round PASS, 0 blockers, 0 majors open.

### Still owed

- VM: the full e2e run including `tests/e2e/codex-reconfirm-upgrade.spec.ts`
  (written, unrun), the upgrade walk and screenshots.
- Real-CLI rows of the parity checklist (e.g. the setup check against a real
  `codex login status` beyond 0.153.4).
- Held for owner review: account summary, usage footer and Tokenomics UX.
