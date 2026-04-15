# Contributing to Claude Command Center

Thanks for your interest in contributing! This document covers setup, coding standards, and the PR process.

## Prerequisites

- Node.js 20+
- npm 9+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Windows 10/11 or macOS 12+ (Linux support is untested)

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

- `beta` - default working branch (all development happens here)
- `main` - stable releases only (updated by merging the `beta` → `main` GitHub PR with a merge commit)

### For contributors

1. Fork the repo and create a feature branch from `beta`
2. Make your changes and ensure tests pass
3. Submit a PR targeting `beta`

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
