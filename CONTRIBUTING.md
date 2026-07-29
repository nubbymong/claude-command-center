# Contributing to Claude Command Center

Thanks for your interest in contributing! This document covers setup, coding standards, and the PR process.

## Prerequisites

- Node.js 20+
- npm 9+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Windows 10/11, macOS 12+, or Linux with glibc 2.39+ (Linux support is experimental — verified on Ubuntu 24.04 and Rocky 10)

## Getting Started

```bash
git clone https://github.com/nubbymong/claude-command-center.git
cd claude-command-center
npm install
npm run dev
```

This starts the app in development mode with hot module reloading. Changes to renderer code (React components, styles) update instantly. Main process changes require a restart.

## Project Structure

```
src/
  main/           # Electron main process (PTY, IPC, config, vision, agents)
  renderer/       # React UI (components, pages, stores, utils)
    components/   # Reusable UI components
    pages/        # Full-page views (Tokenomics, Memory, Agents, etc.)
    stores/       # Zustand state stores
    utils/        # Shared utilities
  shared/         # Types and constants shared between main/renderer
  preload/        # Electron preload scripts (IPC bridge)
scripts/          # Build, release, and promotion scripts
tests/            # Unit tests (Vitest)
```

## Running Tests

```bash
npx vitest run         # Run all tests once
npx vitest --watch     # Watch mode
npx tsc --noEmit       # Type-check only
```

## Code Style

- **TypeScript** everywhere - no `any` unless unavoidable
- **Tailwind CSS v4** with `@theme` in `src/renderer/styles.css` (no tailwind.config)
- **Zustand** for state management - keep stores focused and minimal
- **No unnecessary abstractions** - prefer simple, direct code over premature generalization
- **Catppuccin Mocha** color palette - use theme tokens (`text`, `subtext0`, `surface0`, `blue`, etc.)

## Branching Model

- `beta` - default working branch; all feature development happens here, continuously. `beta` is **never frozen** for a release.
- `release/vX.Y.Z` - a release-candidate branch cut from `beta` for **every** release. All RC stabilization happens here, not on `beta`.
- `main` - stable releases only (updated by merging the accepted `release/vX.Y.Z` branch with a merge commit).

### For contributors

1. Fork the repo (or create a feature branch in-repo) from `beta`
2. Make your changes and ensure tests pass
3. Submit a PR targeting `beta`

That's the whole contributor surface — everything below this line is maintainer/release-manager process, documented for transparency.

### Release process (maintainers)

We cut a dedicated RC branch for every release cycle so that `beta` stays open for feature development at all times — features never wait for a release to finish stabilizing.

- When a release is ready to stabilize, cut a `release/vX.Y.Z` branch from `beta` and tag the `-rc.N` release candidates **there**.
- **`beta`:** feature branches and fix branches merge here continuously; it is never frozen.
- **`release/vX.Y.Z`:** bug fixes and stabilization only — **no features**. The RC branch is the proposed stable release; merging a feature into it invalidates the candidate.
- Fixes made on the RC branch are back-ported to `beta` so the next cycle keeps them.
- When the RC is accepted, merge `release/vX.Y.Z` → `main`, then delete the RC branch.

### Issue lifecycle (beta vs. main)

Because fixes merge to `beta` (in testing) long before they ship in a stable
`main` release, an issue has three states — don't close an issue the moment its
fix hits `beta`:

- **Open, no status label** — not yet fixed (todo / in progress).
- **Open, labeled `in-beta`** — the fix is merged to `beta` and in testing, but
  not yet shipped. Apply `in-beta` when the fixing PR merges to `beta`, and add a
  comment naming that PR.
- **Closed (completed)** — the fix has promoted to `main` (shipped in a stable
  release). Only then close the issue.

Rationale: GitHub only auto-closes issues on merges to the **default** branch
(`main`), never on `beta` merges — so beta-merged issues won't self-close, and
closing them early hides "shipped" behind "merged, still baking." The generated
`CHANGELOG.md`/release notes show the same distinction per version.

At `main` promotion the close step is **automatic**: the `Close in-beta issues on
promotion` workflow (`.github/workflows/close-in-beta-on-promotion.yml`) runs on
every push to `main`, walks the promoted commit range, and for each referenced
issue that is open **and** labeled `in-beta` it comments, removes the label, and
closes it as completed. Anything else it finds — pull requests, unlabeled issues,
already-closed issues, refs to other projects' issue numbers — is skipped and
listed in the run log.

Applying `in-beta` on the beta merge is therefore the one step that stays manual,
and it is what makes the automatic close possible. An issue that never got the
label will not be closed by a promotion.

To preview what a promotion would close, or to catch up after a promotion that
predates this workflow, run it from the Actions tab (`workflow_dispatch`) with a
range such as `v2.0.0..main`; `dry_run` defaults to **true**. Locally:

```bash
node scripts/close-in-beta-issues.js --range origin/main..origin/beta --dry-run
```

## Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/).
The format is enforced two ways, so a non-conforming message is caught before it lands:

- **Locally:** a Husky `commit-msg` hook runs commitlint on every `git commit`
  (installed automatically the first time you run `npm install`).
- **In CI:** because PRs are squash-merged, the **PR title** becomes the commit
  subject — the `PR Title` workflow lints it against the same rules.

Format:

```
<type>(<optional scope>): <imperative subject>
```

- **Allowed types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
  `ci`, `chore`, `style`, `revert`, `deps` (`deps` is reserved for Dependabot).
- Use imperative mood ("add feature", not "added feature").
- Aim for a subject under 72 characters (hard cap 120).
- One type per subject — compound types like `docs+chore:` are **not** valid.
- Reference issues/PRs where applicable (`Fixes #123`).

Examples: `feat(sessions): add per-session rename`, `fix(terminal): restore caret under WebGL`.

Rules live in `commitlint.config.js`.

## Changelog & Release Notes

The changelog is **generated**, not hand-edited. The single source of truth is
`src/renderer/changelog.ts` (it also drives the in-app "What's New" modal).

- When your change is user-facing, add an entry to the top of the array in
  `src/renderer/changelog.ts` (type: `feature` | `fix` | `improvement`).
- Run `npm run changelog` to regenerate the root `CHANGELOG.md`, and commit both files.
- CI (`Changelog in sync`) fails if `CHANGELOG.md` is stale — run
  `npm run changelog:check` locally to verify.
- The release workflow reads the same source to populate the **GitHub release
  notes** automatically (`scripts/gen-changelog.js --notes <version>`), so there
  is nothing to paste by hand at release time.

## What We're Looking For

- Bug fixes with reproduction steps
- Performance improvements with before/after measurements
- New features that align with the project's scope (Claude Code orchestration)
- Test coverage for untested code paths
- Documentation improvements

## What to Avoid

- Large refactors without prior discussion
- Adding dependencies without justification
- Changes that break the update/release pipeline
- Platform-specific code without cross-platform fallbacks

## Questions?

Open a [Discussion](../../discussions) for questions about architecture, feature proposals, or anything else.
