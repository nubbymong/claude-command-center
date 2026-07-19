## 2026-07-18 -- Changelog generation + Conventional Commit enforcement

Decision recorded in architecture/decisions/2026-07-18-adr-003-changelog-and-commit-standards.md.

Added standard changelog/release-note tooling. Gap before: 48 tags but no root
CHANGELOG.md, GitHub release bodies were a hardcoded placeholder + checksums line
(release.yml), and the commit convention was habit-only (CONTRIBUTING said just
"imperative, <72 chars"). The rich user-facing notes already lived in
src/renderer/changelog.ts (in-app "What's New" modal); nothing surfaced them
elsewhere.

Decision: single source of truth = src/renderer/changelog.ts. Derive everything
from it rather than maintain notes twice. Full commit enforcement. No backfill of
historical GitHub release bodies (going forward only).

- scripts/gen-changelog.js (zero-dep, CJS): parses the changelog array out of the
  TS source by bracket-matching the literal and eval-ing it (no TS toolchain).
  Modes: default writes CHANGELOG.md (Keep a Changelog format, feature->Added,
  improvement->Changed, fix->Fixed); `--check` fails on drift; `--notes <ver>`
  prints one version's release-note markdown (empty if no entry).
  - Parser gotcha fixed: must start the array scan AFTER the `=`, else
    indexOf('[') matches the `[` in the `ChangelogEntry[]` type annotation and
    yields an empty array.
- CHANGELOG.md generated (70 versions) and committed. It is TRACKED (unlike the
  CARP CONTEXT.md aggregate) because it is the GitHub-facing artifact; drift is
  guarded by CI instead of being untracked.
- package.json: scripts `changelog`, `changelog:check`, `prepare: husky`; devDeps
  @commitlint/cli, @commitlint/config-conventional, husky. Installed with
  --ignore-scripts to avoid the electron-rebuild postinstall.
- commitlint.config.js: config-conventional + `deps` type (Dependabot prefix),
  header-max-length 120, body/footer line-length rules disabled to fit the repo's
  detailed commit style.
- Enforcement: .husky/commit-msg (commitlint --edit) blocks local bad commits;
  .github/workflows/pr-title.yml lints the PR title (squash-merge -> title is the
  subject). Historical compound types (docs+chore:, docs+ci:) are now invalid.
- release.yml: `Generate release notes` step runs gen-changelog.js --notes for the
  built version; the create step builds RELEASE_BODY.md (title + channel label +
  notes or checksums-only fallback) and passes --notes-file. Rolling re-release
  branch still leaves existing notes untouched.
- ci.yml: new always-on `changelog` job (not gated on the `ci-run` label) runs
  gen-changelog.js --check.
- CONTRIBUTING.md + CLAUDE.md updated to document the commit convention and the
  generate-then-commit changelog workflow.

Workflow now: edit changelog.ts -> `npm run changelog` -> commit both files. Release
notes populate automatically from the same source.
