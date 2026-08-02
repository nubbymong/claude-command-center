# ADR-013: Cross-account insights roll-up

- Status: Accepted
- Date: 2026-08-02
- Issue: #191

## Context

Insights generates one report per account. `insights:run` takes a single optional
`profileId`, the page offers a per-account picker, and the previous-run comparison
is deliberately scoped to the same account (Unit 3 W5) so a multi-account setup
never diffs one account against another.

That leaves a real gap for anyone running two or more accounts: producing every
account's report is N manual runs, and nothing ever compares the accounts to each
other. The interesting questions -- where the volume actually is, which account
carries the friction, what one account should copy from another -- are exactly the
questions a per-account report cannot answer.

Three things had to be decided to add a cross-account report: where a roll-up
lives, what its artifact is, and who is allowed to produce its numbers.

## Decision

### 1. A roll-up is a catalogue run, not a separate store

`InsightsRun` gains `kind?: 'account' | 'aggregate'` (absent means `'account'`,
because every run written before this change is one), plus `memberRunIds` and a
`members[]` row per targeted account.

Considered and rejected: a parallel `aggregates.json` store. The catalogue already
solves persistence, atomic read-modify-write under concurrency, the
`cleanupStuckRuns` restart sweep, and the run picker. A second store would have to
reimplement all four and stay in sync with the first.

The cost is that every reader matching runs by account has to exclude aggregates
explicitly -- an aggregate has no `profileId`, so `(r.profileId ?? null) ===
currentAccount` matches it against *default-account* runs. That defect was live in
`loadPreviousKpis()` and in `InsightsPage`'s previous-run selection the moment the
field existed; both are fixed here and both are covered by tests.

### 2. The artifact is JSON only -- no synthetic report.html

An account run archives the Claude CLI's own `report.html` and parses it for
display. A roll-up does not: its only artifact is a `kpis.json` holding
`CrossAccountInsights`, rendered by a dedicated `CrossAccountReport` view.

Considered and rejected: having the synthesis pass emit HTML in the CLI's shape so
the existing `parseInsightsReport` path could render it unchanged. That makes the
report's structure a model output -- a wrong tag or a dropped section becomes a
broken report -- to save writing one component. Data in, component renders it.

### 3. Numbers are computed; prose is model-written

This is the load-bearing rule. Every value in the roll-up's `comparison` table is
copied from a member run's own `kpis.json` by `buildComparisonRows()`. The
synthesis pass is asked *only* for narrative (`summary`, per-account `highlights`,
`crossAccount.observations/recommendations`) and is explicitly told not to restate
the metric tables.

Consequences, all deliberate:

- A roll-up cannot report a metric no account produced.
- Only metrics at least two accounts reported appear -- a single-account metric has
  nothing to compare against and is already in that account's own report.
- Totals appear only for `format: 'number'`. Percentages and durations need weights
  we do not have, and an untagged metric gets no total either: summing an untagged
  rate as if it were a count is precisely the invented number this rule exists to
  prevent.
- When the synthesis pass fails or returns unusable JSON, the roll-up still
  completes as a numbers-only comparison flagged `synthesis: 'deterministic'`, and
  the UI says so. Degrading is possible *because* the numbers were never the
  model's to produce.

### 4. Failure is per-member; refusal is explicit

An account whose run fails, or which is already running under its own per-account
lock, is recorded in `members[]` and left out of the synthesis. The roll-up itself
fails only when fewer than two accounts produced KPIs, because below two there is
nothing to compare. A fan-out holds its own `(cross-account)` in-flight key,
separate from every `accountKey()`, so an aggregate lock can never collide with a
member's.

Fan-out is capped at `CROSS_ACCOUNT_MAX_PARALLEL = 2`. The per-account lock permits
unlimited cross-account concurrency by design (Unit 3 W6), but each member run is a
full interactive `claude` PTY plus a headless extraction; a "run all" across five
accounts must not put five Claude TUIs on the machine at once.

### 5. The synthesis pass gets no tools

`buildCrossAccountSpawnArgs()` is `['-p', '--output-format', 'json']` -- no
`--allowedTools`, no `--dangerously-skip-permissions`. The member KPI JSON travels
in the prompt on stdin, so the step reads no files at all. This is strictly less
privilege than the per-run KPI extraction, which needs `--allowedTools Read` to
open one archived HTML report.

It runs under the *primary* account's home rather than any one member's: `claude`
needs a signed-in identity to start, but nothing about this step should attribute a
whole-fleet roll-up to an arbitrary account.

Accounts are identified to the model only by an opaque per-roll-up key (`A1`, `A2`,
...) alongside their display label, and the reply is matched back on that key.
Narrative for an unknown key is discarded rather than guessed at.

## Consequences

- Multi-account users get one action that produces every account's report plus a
  combined comparison; single-account users see no change (the button appears only
  at two or more profiles).
- The renderer gained batch state: while a fan-out is live, member-run status events
  update the catalogue only. Without that, each member finishing would overwrite the
  batch's progress line and pull the selected report away mid-run.
- Readers of the catalogue must treat `kind === undefined` as an account run
  forever; the field cannot be backfilled onto historical runs.
- A roll-up costs N account runs plus one synthesis call. It is manual by design --
  no scheduling, no automatic roll-up on account add.
