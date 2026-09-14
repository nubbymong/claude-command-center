# ADR-003: Generated changelog + Conventional Commit enforcement

- **Status:** Accepted (2026-07-18)
- **Deciders:** @nubbymong (owner)
- **Related:** CONTEXT.d/2026-07-18-changelog-and-commit-standards.md, CONTRIBUTING.md ("Commit Messages", "Changelog & Release Notes"), scripts/gen-changelog.js, commitlint.config.js

## Context

The repo shipped 48 tagged releases with no discoverable change history and no
enforced commit convention:

- **No root `CHANGELOG.md`.** The only real change history lived in
  `src/renderer/changelog.ts` — a hand-authored, typed array (`feature` | `fix` |
  `improvement`) that drives the in-app "What's New" modal. Excellent content,
  invisible on GitHub.
- **Empty GitHub release notes.** `release.yml` wrote a hardcoded body (release
  title + channel label + "checksums are in CHECKSUMS.txt") for every release.
  Nothing surfaced the actual changes.
- **Commit convention by habit only.** History already looked like Conventional
  Commits (`feat`/`fix`/`perf`/…), but `CONTRIBUTING.md` asked only for
  "imperative mood, <72 chars." Nothing enforced it, so automated note
  generation could not rely on the format.

The constraint that shaped the decision: the curated, user-facing wording in
`changelog.ts` is the valuable asset. Any solution that regenerated notes from
raw commit subjects (semantic-release style) would regress that quality.

## Decision

**Single source of truth = `src/renderer/changelog.ts`. Derive `CHANGELOG.md` and
GitHub release notes from it. Enforce Conventional Commits. Do not backfill
historical release bodies.**

1. **Generator (`scripts/gen-changelog.js`, zero-dependency CJS).** Parses the
   `changelog` array out of the TS source by bracket-matching the literal and
   evaluating it (no TS toolchain in the path). Modes:
   - default → writes `CHANGELOG.md` in Keep a Changelog format
     (`feature`→Added, `improvement`→Changed, `fix`→Fixed);
   - `--check` → non-zero exit on drift;
   - `--notes <version>` → prints one version's release-note markdown (empty if
     the version has no entry).
   Exposed as `npm run changelog` / `npm run changelog:check`.
2. **`CHANGELOG.md` is generated but TRACKED.** Unlike the CARP `CONTEXT.md`
   aggregate (untracked to avoid merge-queue conflicts, per the running-log
   protocol), `CHANGELOG.md` is the GitHub-facing artifact and must be committed.
   Drift is prevented by a CI gate rather than by leaving it untracked.
3. **Release notes auto-populate.** `release.yml` runs `gen-changelog.js --notes`
   for the built version and passes the result to `gh release create` via
   `--notes-file` (title + channel label + notes, or a checksums-only fallback
   when no entry exists). The existing rolling-re-release path still leaves an
   existing release's notes untouched.
4. **Conventional Commits, enforced two ways.** `commitlint.config.js`
   (`@commitlint/config-conventional` + a `deps` type for Dependabot;
   `header-max-length` 120; body/footer line-length rules disabled to fit the
   repo's detailed commit style). Enforced by a Husky `commit-msg` hook locally
   and by the `PR Title` workflow in CI (squash-merge makes the PR title the
   commit subject).
5. **CI drift gate.** `ci.yml` gains an always-on `changelog` job (NOT gated on
   the `ci-run` label) that runs `gen-changelog.js --check`.

Contributor workflow: edit `changelog.ts` → `npm run changelog` → commit both
files.

## Consequences

- One edit site (`changelog.ts`) feeds the in-app modal, `CHANGELOG.md`, and
  GitHub release notes. No double-maintenance, no paste-at-release-time step.
- **Rejected: full commit automation (semantic-release / conventional-changelog).**
  Lowest manual effort, but it would replace the curated user-facing wording with
  raw commit subjects — a quality regression given the existing `changelog.ts`
  investment.
- **Rejected: `CHANGELOG.md` as the source of truth.** More conventional, but it
  would re-tool the working in-app-modal pipeline and duplicate the typed
  structure already in `changelog.ts`.
- **No backfill of historical release bodies.** The 48 existing releases keep
  their bare bodies; only new releases get generated notes. A future
  `gh release edit` loop over tags with a matching `changelog.ts` entry could
  backfill if wanted.
- **Behavioral change for contributors:** compound commit types (`docs+chore:`,
  `docs+ci:`) used occasionally in history are now rejected — one type per
  subject. Relaxable via `type-enum` if the team wants compounds back.
- **Local hooks require `npm install`.** The `commit-msg` hook only activates
  after Husky's `prepare` runs (i.e. once a contributor installs deps); the
  `PR Title` CI check is the backstop for anyone who bypasses hooks or edits via
  the web UI.
- Cost: one new script, one config, one workflow, one CI job, and three
  devDependencies (`@commitlint/cli`, `@commitlint/config-conventional`,
  `husky`).
