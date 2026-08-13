# 2026-08-10 — Security-alert triage: Dependabot + CodeQL tabs cleared

All 37 open Dependabot alerts + 3 open CodeQL alerts (all tracking the default
branch `main`, frozen at stable 2.0.0) were triaged against `beta` and closed
with evidence. Final state: **0 open on both tabs.**

## What happened

- **23 alerts still applied to beta** → fixed in #246 (merged `9d94779`):
  override floors raised for nanoid 5.1.16, hono →4.13.1, dompurify 3.4.13,
  mermaid 11.16.1, fast-uri 3.1.5, ip-address →10.4.0, undici 7.29.0 top-level
  plus a node-gyp-scoped 6.28.0 (keeps node-gyp on its 6.x line). All
  patch/minor within majors. Typecheck + full 3853-test suite green.
- **14 alerts were already fixed on beta** (electron 43.2.0, immutable 4.3.9,
  postcss, js-yaml, brace-expansion, older fast-uri/dompurify/hono ranges,
  @hono/node-server, body-parser) → dismissed with per-alert evidence comments
  (`fix_started` for runtime scope, `not_used` for development scope), each
  naming the beta version, the vulnerable range, and the frozen-main situation.
- **3 CodeQL alerts** (insecure-randomness ×2, polynomial-redos) were all fixed
  on beta by `a606ef4` (#162) → dismissed `won't fix` (no "fixed on another
  branch" enum exists) with comments leading "FIXED on beta", citing the crypto
  id generator and the measured ReDoS repro (old regex 2209ms @ 80k chars,
  linear parser <1ms).
- **Historical audit-trail repairs:** CodeQL #2 (memory-scanner YAML escaping)
  had been dismissed "false positive" with no comment, but was a true positive
  already fixed in 2.0.0 — reopened and auto-closed as **fixed**. CodeQL #3's
  comment misread a flow alert as per-file — re-dismissed with a correct
  justification (benign UI sink; insecure source fixed on beta by `a606ef4`).

Every dismissal went through the ADR-009 adversarial pass first: four
independent attacker sub-agents (version/range claims, CodeQL fix completeness
including mutation-testing the ReDoS guard, dismissal honesty, coverage gaps).
Verdict PASS recorded on #246. The 23 #246-dependent dismissals ran only after
the merge, via a gated script that re-verified the merged lockfile.

## Follow-ups

- **Alerts track the default branch.** Until 2.1 promotes (or the default branch
  changes), every new alert needs the same manual treatment. At promotion,
  re-check the tab: open alerts auto-close as fixed; dismissed ones stay
  dismissed (fine for audit, but verify nothing reads oddly).
- A dependency regression will NOT re-alert on a dismissed alert — the
  package.json override floors are the guard.
- CodeQL scans `main` only (default setup, weekly). Consider advanced setup
  scanning `beta` too; the fixed-on-beta evidence here is source-read +
  regression tests, machine-unverified by CodeQL.
- `resources/splash/three.module.min.js` is vendored and invisible to
  Dependabot; version bumps are manual.
- Dependabot PRs #227–232 (hygiene bumps, unrelated to the alerts) need rebases
  over the new lockfile; `ci-run` labels applied.
