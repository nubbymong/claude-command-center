## 2026-07-28 -- Automated close-on-promotion for `in-beta` issues (#134)

Decision recorded in architecture/decisions/2026-07-28-adr-007-close-in-beta-on-promotion.md.

#135 documented the `in-beta` lifecycle but left the close step manual. This
automates it.

- `scripts/close-in-beta-issues.js` -- zero-dep CommonJS, `main()` behind
  `require.main === module` so the pure helpers are unit-testable (same shape as
  scripts/promote.js). Harvests `#NNN` from the promoted commit range, resolves one
  level through referenced PRs, then comments + unlabels + closes each issue that
  is open AND labeled `in-beta`.
- `.github/workflows/close-in-beta-on-promotion.yml` -- `push` to `main` plus
  `workflow_dispatch` (range input; `dry_run` defaults TRUE). `issues: write`,
  `fetch-depth: 0` (the script needs real history for the range and
  `git describe`).
- KEY FINDING that shaped the design: GitHub's `closingIssuesReferences` is EMPTY
  for every PR in this repo, because closing references are only recorded when a
  PR targets the DEFAULT branch. Our feature PRs target `beta`. Verified before
  building -- PR #92's body says "Closes #74" and the GraphQL query returns `[]`;
  same for #133, #138, #122. The obvious implementation would have run green and
  closed nothing. Hence text-harvesting from commit messages instead.
- Squash subjects carry the PR number, not the issue (`... (#92)` -> issue #74), so
  a PR candidate's title+body are scanned for further refs, one level deep.
- Fail-safe is the LABEL, not the parse: PRs, unlabeled issues, already-closed
  issues and unresolvable refs are all skipped and listed. That is what makes
  greedy ref-harvesting safe. Also: 200-lookup ceiling (a huge ref count means the
  range is wrong -> abort, change nothing); no `before` and no tag -> do nothing
  rather than guess a range; `owner/repo#N` cross-repo form is not read as local.
- Fails loud (non-zero) on unexpected error -- nothing depends on the job, and a
  silent success would recreate the blind spot #134 is about.
- Docs updated in place: CONTRIBUTING.md "Issue lifecycle" no longer says the step
  is manual and documents the dispatch/dry-run path; AGENTS.md now states the label
  is load-bearing (an unlabeled issue is never closed by a promotion).
- Verification: 26 new unit tests in tests/unit/scripts/close-in-beta-issues.test.ts;
  full suite 3117 passed / 4 skipped; typecheck clean. Live dry-run over
  `origin/main..origin/beta` accounted for all 29 harvested refs and selected
  exactly the 6 open `in-beta` issues (#74, #117, #119, #120, #130, #137), skipping
  20 PRs/unlabeled issues and the 3 foreign refs (xterm.js #891/#1194,
  electron-builder #2964).
