# Contributing to AI Code Conductor

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
- **Every cut is gated** (`scripts/release-gate.mjs`, run by `release.js` and as the first job of `release.yml`): the GitHub milestone titled after the version must have no open issue without the `excluded`, `in-beta`, or `in-release` label, and the model registry must cover every model in Anthropic's Claude Code model configuration article. No bypass — see [`docs/versioning.md`](docs/versioning.md#release-gate-the-cut-is-refused-until-it-passes).
- **Before a cut, re-read the [Claude Code model configuration](https://support.claude.com/en/articles/11940350-claude-code-model-configuration) article** and refresh `resources/claude-code-model-configuration.json` if it moved. That article is the reference for the model/effort options the app offers (aliases, `--model` values, 1M variants, effort levels) — see [`docs/versioning.md`](docs/versioning.md#the-model-configuration-article-is-the-reference).

For the versioning scheme, prerelease suffixes (`-beta.N`/`-rc.N`), update channels, and when a rebuild ships to users vs. requires a version bump, see [`docs/versioning.md`](docs/versioning.md).

### Issue lifecycle (beta vs. main)

Because fixes merge to `beta` (in testing) long before they ship in a stable
`main` release, an issue has four states — don't close an issue the moment its
fix hits `beta`:

- **Open, no status label** — not yet fixed (todo / in progress).
- **Open, labeled `in-beta`** — the fix is merged to `beta` and in testing, but
  not yet shipped. Apply `in-beta` when the fixing PR merges to `beta`, and add a
  comment naming that PR.
- **Open, labeled `in-release`** — the fix is in a **cut release candidate**
  (`-rc.N`), one step past "on beta". When an rc is cut, the open `in-beta`
  issues on its milestone are relabeled `in-beta` → `in-release`
  **automatically** by the release workflow's `roll-rc` job
  (`scripts/roll-issues-into-release.mjs`); an issue carries one lifecycle
  label at a time, never both.
- **Closed (completed)** — the fix has promoted to `main` (shipped in a stable
  release). Only then close the issue.

Rationale: GitHub only auto-closes issues on merges to the **default** branch
(`main`), never on `beta` merges — so beta-merged issues won't self-close, and
closing them early hides "shipped" behind "merged, still baking." The generated
`CHANGELOG.md`/release notes show the same distinction per version.

At `main` promotion the close step is **automatic**: the `Close in-beta issues on
promotion` workflow (`.github/workflows/close-in-beta-on-promotion.yml`) runs on
every push to `main`, walks the promoted commit range, and for each referenced
issue that is open **and** labeled `in-beta` or `in-release` it comments, removes
the lifecycle label, and closes it as completed. Anything else it finds — pull
requests, unlabeled issues, already-closed issues, refs to other projects' issue
numbers — is skipped and listed in the run log. An rc cut promotes nothing to
`main`, so it closes nothing — it only advances labels to `in-release`.

Applying `in-beta` on the beta merge is therefore the one step that stays manual,
and it is what makes both automatic steps (the rc roll and the promotion close)
possible. An issue that never got the label will not be rolled or closed. To
repair labels after a cut that predates the roll job, or to preview one:

```bash
node scripts/roll-issues-into-release.mjs --version 2.1.0-rc.1 --dry-run
```

To preview what a promotion would close, or to catch up after a promotion that
predates this workflow, run it from the Actions tab (`workflow_dispatch`) with a
range such as `v2.0.0..main`; `dry_run` defaults to **true**. Locally:

```bash
node scripts/close-in-beta-issues.js --range origin/main..origin/beta --dry-run
```

### Release-line labels (`release-2.1` / `release-2.2`)

Orthogonal to the `in-beta` lifecycle above, these two labels say **which release
line** an issue belongs to:

- **`release-2.1`** — targets the current 2.1 line. **Apply it** to any issue or
  PR on this line; in particular, every `in-beta` issue should also carry
  `release-2.1`, so a "what ships in 2.1?" query stays accurate.
- **`release-2.2`** — **apply it** to work explicitly **deferred** past 2.1.

**Invariant: `in-beta`/`in-release` and `release-2.2` must never sit on the same
issue.** Either lifecycle label means the fix is already merged to `beta` (which
ships as the next 2.1 release) or in a cut 2.1 rc, so also calling it
`release-2.2` ("deferred") is self-contradictory. If a `release-2.2` issue later
gets a fix merged to `beta`, drop `release-2.2` and add `in-beta`. This invariant
is enforced by the reconcile job below.

### Issue disposition — nothing in limbo (#437)

Every **open** issue must carry exactly **one disposition**, so nothing falls
through the cracks:

- a release line — `release-<major.minor>` (scheduled to ship in that line), **or**
- `backlog` — real work, accepted, not yet scheduled, **or**
- `triage` — undecided; a human must decide (the default on a brand-new issue), **or**
- `wontfix` / `duplicate` / `excluded` — will not ship.

And once an issue reaches a **committed state** — `in-beta`, `in-release`,
`loop-claimed`, `loop-in-progress`, or `loop-done` — it must carry a
`release-<major.minor>` label: work started or shipped means the target line is
decided. `in-beta` and `in-release` specifically must carry the **active** line
(the invariant above); other committed states may target a future line.

Enforcement is durable, not by hand — `.github/workflows/issue-disposition.yml`
(schedule + `workflow_dispatch`, plus auto-`triage` on newly opened issues) runs
`scripts/reconcile-issue-dispositions.js`, which:

- adds `triage` to any open issue with no disposition (never leaves limbo);
- adds the active `release-<x.y>` (computed from `package.json`) to an
  `in-beta`/`in-release` issue that has no release line;
- **flags for a human** — never guesses — a committed issue with no line, an
  `in-beta`/`in-release` issue on a deferred line, or any issue carrying more than
  one disposition.

It runs on a **schedule**, not an `on: labeled` listener: a label applied with the
Actions `GITHUB_TOKEN` does not fire `labeled`, so the scheduled full scan is the
reliable path. Preview locally:

```bash
node scripts/reconcile-issue-dispositions.js --dry-run
```

### Desktop-test gate (`desktop-tested` / `skip-desktop-test`)

Headless CI (typecheck, unit tests, build) can pass while the packaged app fails
to run usefully on a real desktop — that has happened. So a PR does not merge on
green CI alone: **a human must open the app and exercise the change**, and that
fact is recorded as a label, enforced by the `Desktop test gate` check.

- **`desktop-tested`** — the app was launched and exercised on a real desktop for
  this change. Apply it once you (or the tester) have actually driven the feature
  in the running app, not just watched CI go green.
- **`skip-desktop-test`** — this PR needs no desktop test: docs-, deps-, CI- or
  changelog-only changes with no runtime surface. Apply it instead of
  `desktop-tested` for those.

The `Desktop test gate` check **fails until one of these two labels is present**,
so it is the inverse of `ci-run` (which is opt-in — apply it to *run* the matrix;
this one must be present to *allow* the merge). Removing the label turns the check
red again.

Maintainer note: the check only becomes a hard merge block once it is marked a
**required status check** in branch protection for `beta` (and `main`) — that step
is admin-only. Until then the check is advisory (a red X, not a stop).

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

### The other user-facing surfaces (no CI guard — check them by hand)

The changelog is the only one of these CI protects, so the rest drift quietly.
Before a release, walk every surface for each feature added or changed since the
last one, and either update it or satisfy yourself it needs nothing:

| Surface | File | Miss looks like |
| --- | --- | --- |
| What's New / CHANGELOG | `src/renderer/changelog.ts` | (CI catches this one) |
| Feature Guide reference + what Ask Conductor knows | `src/shared/app-knowledge.ts` | Asking the app about a live bug and being told the docs don't cover it |
| Tips | `src/renderer/tips-library.ts` | Tips for deleted features; nothing for anything shipped recently |
| Guided tour + Feature Guide cards | tour steps, guide cards | A whole page nothing mentions |
| README + screenshots | `README.md` | Describes features that were never built |

Ship anything with a known workaround? Add it to the **known-issues** section of
`app-knowledge.ts` in the same PR, so users hitting it can be told the fix rather
than concluding there isn't one.

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
