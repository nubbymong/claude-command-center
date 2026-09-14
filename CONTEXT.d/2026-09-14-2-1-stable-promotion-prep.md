## 2026-09-14 -- 2.1.0 stable promotion prep

Prep for promoting the 2.1 line to `main`. `beta` was at `838f6943`
(`2.1.0-rc.17`); `main` still at `9b63f8e8` (`2.0.0`, 15 Jul) -- 775 commits.

### The auto-close would have closed nothing

`close-in-beta-issues.js` (#134) is what closes `in-beta`/`in-release` issues on
promotion. It harvested every `#NNN` in the range and fetched each one, capped at
`MAX_CANDIDATES = 200` -- and the overflow path `return`ed **before** the close
loop. `v2.0.0..main` carries 475 distinct refs against 128 labeled issues, so the
one run that matters most would have printed "the range looks wrong" and closed
nothing. Cutting an rc never exercises this: the ranges are small.

Inverted the algorithm. The label set now drives the lookups, not the refs:

- `fetchLifecycleIssues()` lists the open `in-beta`/`in-release` issues once, via
  REST `/issues` (not `gh issue list --json`, which returns `"OPEN"` and would
  silently fail `classifyCandidate`'s `state !== 'open'` check), paged explicitly
  because `--paginate` concatenates raw pages into invalid JSON.
- `selectCandidates()` (pure, tested) intersects that set with the refs harvested
  from the commit log. Refs that are PRs, foreign or unlabeled are rejected by set
  lookup instead of by an API call each.
- PR-body expansion survives but is needs-driven: it runs only when a labeled
  issue was not cited directly, and stops the moment the shortfall closes. Hitting
  its ceiling no longer discards the run -- what matched still closes, and the
  shortfall is reported by number.
- A labeled PULL REQUEST is never counted as a shortfall; chasing one would buy
  200 useless lookups.

Second bug, and only a real run found it: `git()` had no `maxBuffer`, so the
1.4 MB `git log --format=%s%n%b` for a release-long range died with `ENOBUFS` --
the margin over Node's 1 MB default was only 40%, which is why this waited for a
release-length range to fire.
`gh()` already had 16 MB; `git()` now has 64 MB.

Verified end to end against the real range, not just in unit tests:
`--range v2.0.0..origin/beta --dry-run` -> 475 refs, 128 labeled, **"Would close
128 issue(s)"**, zero expansion lookups.

Mutation-checked, stated precisely: the old bail-out lived in `main()`, which is
not exported, so it cannot itself be reinstated under test. What was checked is
the equivalent behaviour in the new pure function -- making `selectCandidates`
return nothing above 200 refs fails the 475-ref regression test -- and, after
review, reverting the labeled-PR guard in `expandViaPrBodies` fails its own test.
The live dry run is the real evidence for the whole change.

### User-facing surface sweep (AGENTS.md)

Two surfaces had drifted, both saying GPU terminal rendering is opt-in and
unfixed. It has been default-ON since #374 (2026-08-22) with the shared-atlas
corruption repaired in #311 -- so Ask Conductor, the Feature Guide and the README
were all advising users to turn off a setting that now works.

- `app-knowledge.ts` known-issues entry rewritten: the fault is described as
  repaired, with Ctrl+Alt+G capture as the remedy if it ever recurs.
- `README.md` "Under the hood" corrected from "opt-in" to "on by default".
- `tips-library.ts` was already current (`tip.gpu-rendering` says "by default
  now"). Tour and Feature Guide cards needed nothing.

`changelog.ts` gains a consolidated `2.1.0` entry -- a stable user jumps straight
from 2.0.0 and has seen none of the 33 prerelease entries, so it retells the
whole line: the rename, remote sessions as first-class, the Agent Canvas,
claude.ai in the app, the terminal fix, the watchdog, Linux, Electron 43 and the
security line.

### Rename prep (repo renames to `ai-code-conductor` after this ships)

Confirmed the soft-switch works and that the updater is the only functional
coupling: no `publish` block in electron-builder, no `repository` field in
package.json, releases are created from the workflow's own repo context.
`RENAMED_REPO` is the hyphenated `nubbymong/ai-code-conductor` -- confirmed with
the owner, because an underscored slug would never match and `httpGetJson` is a
bare `https.get` that does not follow the 301 a renamed repo returns.

One consequence worth recording: 2.0.0 predates the soft-switch (17 Aug), so a
user who never takes the 2.1.0 update before the rename is stranded on a dead
update feed and needs a manual reinstall. Shipping 2.1.0 stable *before* the
rename is what carries everyone else across.

README screenshots were 7 absolute `raw.githubusercontent.com/.../claude-command-center/beta/`
URLs; made relative so they survive the rename without depending on whether
`raw.` honours the redirect.

### Still owed before the cut

- Milestone `2.1.0` must exist -- the gate resolves it from the tag and a missing
  milestone fails closed.
- `promote.js` refuses to run from `beta` (it requires `release/X.Y.Z`), so the
  promote goes through a `release/2.1.0` branch cut from beta. No code change.
- The updater soft-switch still owes the adversarial pass its own fragment asked
  for before the official cut.
**Rename checklist -- change these AT rename time, not before** (pointing them at
the new slug early breaks them until the rename lands):

- `scripts/gen-changelog.js` `REPO_URL` -- builds the version links in
  `CHANGELOG.md` AND the "Full changelog" footer of every GitHub release note.
- `README.md:6` -- the shields.io release badge.
- `README.md:127-128` -- `git clone .../claude-command-center.git` + `cd`.

The README screenshots and the `../../releases` / `../../actions` links are
already rename-agnostic and need nothing.

### Review

Two independent reviews (spec compliance, code quality), each re-run after the
fixes. Round 1 returned four real findings, all fixed: the factual error in the 2.1.0 GPU entry (the
atlas is still one per process -- the fix is that only the focused terminal holds
a context and a victim drops its own render model before repainting); the
`labeled.has(n)` skip that also skipped labeled PRs, whose bodies are the reason
the expansion pass exists; unbounded pagination with no non-array guard (now
matching `release-gate.mjs`'s `githubListAll`); and 384 unthrottled mutating API
calls that would trip GitHub's secondary rate limit partway through the close.

Round 2 then found a defect the round-1 fix had INTRODUCED, and both reviewers
found it independently. The close path ran comment -> remove-label -> close, so a
failure at the close left the issue **open and unlabeled** -- and candidates are
discovered by querying open issues BY LABEL, so nothing would ever find it again,
while it carried a comment saying it shipped. The try/catch had turned that from
at-most-one issue into potentially many, and the error message told the operator
to re-run, which would not have recovered them. Fixed by inverting the order to
comment -> CLOSE -> remove-label, which makes every partial state recoverable: a
stale label on a closed issue is cosmetic, an absent label on an open one is
permanent. `closeOne` is extracted and exported for this; 7 tests cover the
orderings, and reverting the order fails 4 of them. `THROTTLE_MS` also went
250 -> 750 and now pauses between every call rather than between issues -- at 250
the measured rate was ~91 content-generating calls/min against a ~80/min limit,
so the throttle was making the trip it was meant to prevent more likely.

Deliberately NOT done, so the "all fixed" above is not read wider than it is:
`classifyCandidate`'s `notFound` branch is kept as defence-in-depth though nothing
produces the marker any more (its stale comment was corrected); `matched` is left
unsorted, so expansion results print out of numeric order; and
`scripts/verify-release-manifest.js` has the same missing-`maxBuffer` latent bug
that bit here -- not on this PR's path, worth a follow-up ticket rather than
widening this change.
