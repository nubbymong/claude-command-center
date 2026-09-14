## 2026-08-02 -- Cross-account insights: batch every account, then one combined report (#191)

Insights could only ever look at one account. `insights:run` takes a single optional
`profileId`, and the same-account scoping added in Unit 3 W5 means a multi-account setup
never compares accounts to each other -- by design, since diffing account A's run against
account B's is nonsense. The gap that leaves is the whole point of running several
accounts: where the volume actually is, which account carries the friction, what one
account should copy from another.

Added `insights:runAll` -> `runCrossAccountInsights()`: fans out one ordinary per-account
run per targeted profile, then synthesizes ONE roll-up from the results. The roll-up is a
first-class catalogue entry (`kind: 'aggregate'`, `memberRunIds`, a `members[]` row per
account), so it shows up in the existing run picker as "All accounts (N)". Decision and
the rejected alternatives are in ADR-013.

The design call worth recording: NUMBERS ARE COMPUTED, PROSE IS MODEL-WRITTEN. Every value
in the comparison table is copied out of a member run's own kpis.json; the synthesis pass
is asked only for narrative and is told not to restate the metric tables. Three things
fall out of that and none of them are incidental:

- A roll-up cannot report a metric no account produced.
- Only metrics at least two accounts reported get a row. A single-account metric has
  nothing to compare against and is already in that account's own report.
- When the synthesis pass fails or returns unusable JSON, the roll-up still completes as a
  numbers-only comparison flagged `synthesis: 'deterministic'` and the UI says so. That
  fallback is only possible because the numbers were never the model's to produce.

Totals are per-format, not universal: sums appear only for `format: 'number'`. Percentages
and durations need weights we do not have, and an UNTAGGED metric gets no total either --
summing an untagged rate as though it were a count is exactly the invented number the rule
above exists to prevent.

Found while scoping, fixed here: adding a run with no `profileId` breaks the same-account
comparison. `loadPreviousKpis()` and `InsightsPage`'s previous-run selection both match on
`(r.profileId ?? null) === currentAccount`, so an aggregate -- which has no profileId --
would have been handed to every DEFAULT-account run as its "previous run", diffing a
whole-fleet roll-up against one account's report. Both sites now exclude aggregates
explicitly, with regression tests. Anything else that groups runs by account has to do the
same: `kind === undefined` means "account run" forever and cannot be backfilled.

Two smaller judgement calls:

- Fan-out is capped at 2 concurrent member runs. The per-account lock deliberately allows
  unlimited cross-account concurrency (Unit 3 W6), but each member run is a full
  interactive `claude` PTY plus a headless extraction, and "run all" across five accounts
  must not put five Claude TUIs on the machine at once.
- The synthesis pass gets NO tools (`-p --output-format json`, no `--allowedTools`): the
  KPI JSON travels on stdin, so it reads nothing. Strictly less privilege than the per-run
  KPI extraction, which needs `Read` for one archived HTML file. It runs under the primary
  account's home -- claude needs a signed-in identity to start, but a whole-fleet roll-up
  should not be attributed to an arbitrary member. Accounts reach the model only as opaque
  keys (A1, A2, ...) plus a display label, and narrative for an unknown key is dropped
  rather than guessed at.

Renderer needed batch state it did not have before. While a fan-out is live, member-run
`insights:statusChanged` events update the catalogue ONLY: letting them through would
overwrite the batch's progress line with a single account's and, worse, each member
completing would pull the selected report out from under whatever the user was reading.
A roll-up left in flight by a reload is recovered from the catalogue for the same reason.

Gate: 3379 unit tests pass (35 new across four files), typecheck clean. Not yet verified in
the running app -- the desktop check and the ADR-009 adversarial pass (this touches IPC and
preload) both come before the PR.
