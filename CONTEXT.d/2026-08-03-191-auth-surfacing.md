## 2026-08-03 -- Surface an expired sign-in on the Insights page, with the fix attached (#191)

An expired OAuth session was the cause of 2 of 4 accounts producing no KPIs, and of a
cross-account roll-up losing its entire written analysis. The reason was reaching the log
and (after the previous commit) a note in the KPI sidebar -- but only if you first selected
the failed run. That is not surfacing it: the report generates fine, so nothing looks
broken, and the metrics simply never appear.

Reused the existing mechanism rather than inventing a parallel one. `AccountUsagePanel`
already lists accounts whose sign-in has expired, and `useReauthAccount` already performs
the fix by opening a login shell pinned to the profile and polling until `/login` rewrites
its credentials. Insights now calls the same hook, and `App.tsx` passes
`onNavigateToSessions` so the user lands on the login session -- the same contract
AccountUsagePanel uses.

New `src/shared/claude-auth-errors.ts`: `isAuthFailureMessage`. Shared because main
classifies (it holds the CLI's reply) and the renderer reacts (it owns the re-auth
affordance). Deliberately a NARROW allow-list of phrases: this drives a button that sends
the user into a login shell, so a false positive tells them to re-authenticate a perfectly
good account, which is worse than showing the raw message. Tested in both directions,
including against the other real failure reasons (truncated reply, unrecoverable JSON,
"Only 1 of 4 accounts produced KPIs", the PTY timeout) so none of them trip it.

`InsightsRun.authFailed` and `InsightsRunMember.authFailed` carry the classification.
Where it now shows:

- A page-level banner on Insights, in BOTH the populated and the empty state -- an expired
  sign-in is exactly why there may be no reports yet, so the empty state is when it matters
  most. One button per affected account: "Sign in: <name>".
- The banner reads each account's MOST RECENT run only. A historical auth failure that has
  since been fixed must not keep nagging; same calibration as the nav status dot, where a
  warning means "needs attention now", not "once failed".
- The roll-up's deterministic banner now states WHY there is no written analysis, naming
  the account. Silently degrading made a run look like the model had nothing to say when
  in fact the synthesis account's sign-in had expired.
- The KPI sidebar note keeps the raw reason for the non-auth cases.

Derived from the catalogue, not probed: costs nothing, needs no new IPC, and reflects
exactly what the feature actually hit rather than a separate opinion about account health.

Gate: 3454 unit tests pass (8 new), typecheck clean. The banner itself is not yet verified
in the running app.
