# ADR-007: Close-on-promotion harvests issue refs from commit text, not GitHub's linked-issue API

- **Status:** Accepted (2026-07-28)
- **Deciders:** @nubbymong (owner)
- **Related:** CONTEXT.d/2026-07-28-134-close-in-beta-on-promotion.md, #134, #135,
  scripts/close-in-beta-issues.js,
  .github/workflows/close-in-beta-on-promotion.yml,
  CONTRIBUTING.md ("Issue lifecycle")

## Context

The `in-beta` lifecycle (#135) leaves an issue **open** when its fix merges to
`beta`, to be closed when the change promotes to `main`. That close step was
manual and easy to miss — #134.

The obvious implementation is to ask GitHub which issues a promoted PR closes:
the `closingIssuesReferences` field, populated from `Closes #NNN` in a PR body.

**It returns nothing in this repo.** GitHub only records a closing reference when
the PR targets the **default** branch. Every feature PR here targets `beta`, so
the field is empty for all of them. Verified before building: PR #92's body says
"Closes #74", and the GraphQL query returns `[]`. #133, #138 and #122 likewise.

This is the same root cause as the lifecycle convention itself — GitHub's
issue-linking machinery is default-branch-only, which is *why* beta-merged issues
don't self-close. An implementation built on that API would have run green on
every promotion and closed nothing, which is worse than the manual step it
replaced.

A second wrinkle: the `(#NNN)` in a squash-merge subject is the **PR** number, not
the issue. `feat(config): … (#92)` must resolve to issue #74.

## Decision

**Harvest `#NNN` refs from the promoted commit text, resolve one level through
referenced PRs, and gate every close on the `in-beta` label.**

1. `git log --format=%s%n%b <range>` over the promotion range yields candidate
   refs (subject `(#NNN)` trailers plus body text such as `Closes #NNN`).
2. Each candidate is fetched via `/issues/{n}`. `has("pull_request")` distinguishes
   a PR from an issue. For a PR, its title+body are scanned for further refs — one
   level deep only (a PR's linked issues, not an issue's onward references).
3. **The label is the fail-safe, not the harvest.** A candidate is closed only if
   it is an issue, is currently open, **and** carries `in-beta`. Deliberate
   consequence: over-collecting refs is harmless, so the parser can stay simple
   and greedy.
4. Range comes from the push event's `before..after`; all-zeros (first push) or an
   unreachable `before` (force push) falls back to `<previous tag>..HEAD`. With
   neither, the script does **nothing** rather than guess — a wrong range would
   sweep in issues from earlier releases.
5. Refs are capped at 200 lookups. Hundreds of distinct refs means the range is
   wrong, so it aborts without changing anything.
6. `#` glued to a word character or slash is not a local ref, so GitHub's
   cross-repo `owner/repo#123` form can't close a same-numbered local issue.
   Bare cross-project prose ("xterm.js #1194", "electron-builder #2964" — both
   real in this history) still matches, doesn't resolve, and is reported as
   `not found`.

Rejected alternatives: **`closingIssuesReferences`** (returns nothing here, and
would fail silently — the worst failure mode for a step whose purpose is not being
forgotten); **retargeting feature PRs at `main`** to make the API work (inverts
the whole RC-branch model); **closing on the `beta` merge instead** (exactly what
#135 decided against — it hides "shipped" behind "merged, still baking").

## Consequences

- Applying `in-beta` at beta-merge time becomes load-bearing: it is the *only*
  input that decides what a promotion closes. An issue that never got labeled is
  never closed by a promotion. AGENTS.md and CONTRIBUTING.md both say so.
- The job runs on **every** push to `main`, not just promotions. `build(release):`
  bump pushes reference no issues, so they harvest nothing and exit.
- It fails **loud** (non-zero) on an unexpected error. Nothing depends on the job,
  so a red X blocks no release — and a silent success would reintroduce precisely
  the blind spot #134 exists to close.
- `dry_run` defaults to **true** on manual dispatch, so an operator reaching for
  the Actions tab gets a preview, not a surprise bulk close.
- Verified against live repo state before merge: dry-run over
  `origin/main..origin/beta` accounted for all 29 harvested refs and selected
  exactly the 6 open `in-beta` issues (#74, #117, #119, #120, #130, #137),
  skipping 20 PRs/unlabeled issues and 3 foreign refs.
- If GitHub ever populates closing references for non-default-branch PRs, this
  becomes redundant rather than wrong; the label gate would still hold.
