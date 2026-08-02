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

### 3b. Computing the numbers is not enough — the ALIGNMENT must be proven too

Rule 3 as first written was necessary and insufficient, and the gap shipped as a
false report. `buildComparisonRows` merged two accounts' metrics on
`category + metricKey` alone and took the row's label from whichever account came
first. Verified against real archives: both accounts report
`Outcomes.successRate`, one meaning "Fully Achieved Rate" (0.4231), the other
"Mostly or Fully Achieved Rate" (0.787) — and the second account's *own*
fully-achieved rate is 0.128, the worse of the two, dropped because its
`fullyAchievedRate` key had no counterpart. The table rendered that account green
at 78.7% "Fully Achieved Rate": the exact inverse of the truth, in colour,
presented as a measurement. No value was invented. The *meaning* was.

So the rule extends: **a roll-up may not assert that two accounts measure the
same thing unless they agree that they do.** Concretely — merge on key *and*
agreement:

- Labels differing by more than wording noise (case, punctuation, spacing) mark
  the row `labelVariants`, display it by its raw metric key, drop its total, and
  suppress its colouring. The numbers are still shown; the equivalence is not
  claimed. Same for `format` disagreement.
- `goodDirection` disagreement clears the direction. Otherwise which account is
  painted green depends on member ORDER — non-determinism in rendered output.
- Metrics only one account reported are no longer discarded. Measured, they are
  the majority of the union (59 of 88 across two real accounts), because the
  extraction step names keys freely: `commandFailed` vs `errorCommandFailed`,
  `environmentIssue` vs `environmentIssues`. They are carried as
  `uniqueMetrics`, shown, and sent to the synthesis pass — "only A2 has any
  subagent calls" is exactly the kind of fact a comparison table cannot hold.
- Totals require comparable reporting windows. `period.days` cannot decide that:
  the extraction model emits ACTIVE days there (a 23-day window arrives carrying
  `days: 10`), so the span is computed from the dates. When spans differ by more
  than 25%, or any span is unknown, no row carries a total, and the UI and the
  prompt both say why.

### 3c. The synthesis pass receives the computed table, not the raw KPI blobs

The first cut sent every member's full `kpis.json` verbatim (~13-15 KB each) and
asked for narrative only. That is the wrong payload on both axes.

Measured on real archives, sending the assembled comparison instead is **~88%
smaller** (30,477 -> 3,619 bytes for two accounts; ~89% extrapolated at four).
Where each account's `kpis.json` spends 27% of its bytes on per-metric
`label`/`format`/`goodDirection` scaffolding that is identical across accounts —
and 0.9% on the actual numbers — the aligned table carries each metric's metadata
once.

It is also the better payload. The model no longer has to align metrics itself
across blobs tens of thousands of tokens apart; the key -> label -> window mapping
sits at the top instead of scattered through the payload; label conflicts are
declared rather than left to be inferred; and the prompt is built from the *same*
assembled roll-up that gets persisted, so the model cannot have reasoned over a
different table than the user sees.

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
