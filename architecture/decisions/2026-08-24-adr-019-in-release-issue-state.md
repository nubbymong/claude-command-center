# ADR-019: An `in-release` issue state between `in-beta` and closed

Date: 2026-08-24
Status: Accepted

## Context

The issue lifecycle (ADR-007, #134) had three states: open → open+`in-beta`
(fix merged to `beta`) → closed (automatic on promotion to `main`). With the
first 2.1 release candidate approaching, the owner observed that "there is
nothing between in-beta and closed": once an rc is cut, its issues' fixes are
no longer merely "on beta, in testing" — they are in a cut release candidate
riding the beta update channel — but the labels could not say so. A milestone's
worth of issues would sit indistinguishable from freshly-merged beta work for
the whole stabilization window.

## Decision

Add one state: **open + `in-release`** — the fix is in a cut `-rc.N` release.

- **The label replaces `in-beta`; it never stacks.** One lifecycle label at a
  time keeps the state readable off the label itself, mirrors how the close
  step already strips the label at the end of life, and spares every consumer
  a two-label decode. Tooling still treats an accidental both-at-once
  defensively (gate: shipped; close: strips both, describes the further state;
  roll: skips — never double-rolls).
- **The roll is automatic.** A new final `roll-rc` job in `release.yml` runs
  `scripts/roll-issues-into-release.mjs` after every successful `-rc.N`
  publish: the rc milestone's open `in-beta` issues get a comment naming the
  rc and their label swapped `in-beta` → `in-release`. The job is separate and
  last so a relabel failure is a loud red X that blocks nothing — the release
  is live before it runs. It is scoped `issues: write` at job level only.
- **Scope = the rc's milestone**, the same set the release gate certified as
  "shipping in this release" when it allowed the cut. An `in-beta` issue that
  never made the milestone was never gate-checked and is not rolled — milestone
  hygiene stays part of the cut checklist.
- **The gate exempts it** (`scripts/release-gate.mjs`): an open `in-release`
  issue is further along than `in-beta`, so it can never block a later cut of
  the same line.
- **Promotion closes it** (`scripts/close-in-beta-issues.js`): the
  close-on-promotion workflow accepts either lifecycle label, removes what the
  issue carries, and words the close comment by the state it was in. An rc cut
  pushes nothing to `main`, so it inherently closes nothing.

## Consequences

- The full lifecycle is: open → `in-beta` (manual, on beta merge — still the
  one manual step everything else keys off) → `in-release` (automatic, on rc
  cut) → closed (automatic, on promotion to `main`).
- `in-release` inherits `in-beta`'s invariants: it must never share an issue
  with `release-2.2` (CONTRIBUTING.md "Release-line labels"), and it is
  excluded from LoopReady scope (the fix is already merged).
- A rolling re-release of the same rc re-runs the roll as a no-op
  (already-`in-release` issues are skipped), and the script is manually
  invokable (`--dry-run` supported) to preview or repair labels for cuts that
  predate this ADR.
- The `in-release` label must exist in the repo (created alongside this
  change: "fix is in a cut release candidate; closes on promotion to stable").
