# 2026-08-21 — Minimal mode for the account footer, and usage that survives a restart

Two separate things that both came out of the same owner review of the bottom
strip. Mode A (identity dot removed, rim 26% / fill 6%) was already shipped in
#332 and is unchanged here — the owner picked it from a canvas mockup labelled
A1, against a softer A2.

## Minimal mode (`footerAccountDisplay: 'dots'`)

Off unless turned on; absent means the meters, so no existing footer changes
shape on upgrade. Each account becomes its NAME plus one traffic-light dot for
usage and one per model bucket. The figures move to the tooltip.

Design calls, all decided on the canvas before implementing:

- **The label is the name only where a name exists.** `LiveAccount.name` already
  resolves alias → profile name → the full email, so "friendly name if set, else
  the full address" needed no new code. An earlier mockup fell back to the local
  part of the email (`moger`, `moger3`, `moger4`) and the owner rejected it —
  three near-identical pills.
- **B1 over B2.** The labelled variant ("use" / "Fable" keys before each dot) was
  measured on the canvas at 67px band height against B1's 38px: the keys cost
  more width than the meters saved and lost minimal mode its single row, which
  was the entire point.
- **Usage is the WORST time window, not an average.** The strip answers "is
  anything about to run out". Averaging a fresh 5h with an exhausted Weekly
  answers it wrongly.
- **Thresholds are RateLimitBar's own** (peach at 70, red at 90). Reusing them
  means a dot can never disagree with the bar the same number draws in the other
  mode, and there is no second set to keep in step.
- **Shape carries the state as well as hue** — ring / half-filled / solid with a
  halo. The pill's tint is the account IDENTITY, so a state told in colour alone
  would be a second colour language in the same nine pixels.
- **Nothing reported yet is a NEUTRAL dashed dot, never green.** Green is a claim
  the account has room; nobody has measured it. Same reasoning as
  `RateLimitBarPending`, which shows no colour and no number until there is one.

### The trap: `group` cannot tell Fable from Weekly

`usage-buckets.ts` gives a per-model weekly `group: 'weekly'`, identical to
weekly-all. What it *does* do is encode the model into the key as
`<kind>:<model display name>`, leaving that segment empty for the time windows.
So `isModelBucket` reads the key, not the group. The legacy synthesis inside
`MultiAccountStatusline` uses bare keys with no colon at all, which lands on
"not a model bucket" — correct. Mutating this to `group === 'weekly'` fails six
tests.

Minimal mode reads the SAME `footerHiddenUsageBuckets` denylist as the meters,
so hiding Fable drops its dot and hiding Weekly leaves the usage dot tracking 5h
alone. No new setting was needed for that — it already existed and was already in
Settings, which is worth checking before building the next one.

## Usage snapshots (`usage-snapshots.json`)

The handoff said to check whether the multi-account last-known-good cache already
*was* the snapshot store before adding a second one. It nearly was.
`resolveUsageOutcome` already models "stale figures with an age" and the UI
already renders `stale` + `fetchedAt`. The only thing wrong with it was
`account-usage.ts:292`: a plain in-memory `Map`, commented *"Cleared naturally on
app restart."*

So this persists that one map rather than building anything beside it. The disk
half is `usage-snapshots.ts`; `account-usage.ts` gains a lazy `hydrateSnapshots()`
and a write-through on success. No decision logic changed.

Every parse failure DROPS the entry rather than repairing it — a snapshot is a
convenience, so falling back to a live fetch costs nothing while trusting a
half-parsed record paints wrong numbers over a real account. A `fetchedAt` in the
future is rejected too: it would render as a negative age.

**Inherent limit, and the owner called it before I did:** nothing shows until one
fetch has succeeded and been persisted, so a fresh install sees this from its
second run onward. There is no honest figure to show before there is a figure.

## Verification

Full suite **6229 passed / 15 skipped**, typecheck clean.

Two new files, 33 cases. Mutation-tested:

| mutation | tests failed |
| --- | --- |
| `isModelBucket` keyed on `group` instead of the key | 6 |
| worst-window reduce flipped to best-window | 3 |
| pending dot painted green instead of neutral | 1 |
| bucket shape validation dropped from `parseSnapshots` | 3 |
| future-`fetchedAt` guard removed | 1 |

ADR-009 does not apply: renderer display code, one new settings field, and a
non-secret config file that holds usage percentages already shown on screen.
