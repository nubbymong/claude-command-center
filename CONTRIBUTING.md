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

## Commit Messages

- Keep the first line under 72 characters
- Use imperative mood ("Add feature" not "Added feature")
- Reference issues where applicable (`Fixes #123`)

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
