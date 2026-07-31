# Claude Command Center — agent & contributor brief

Canonical instructions for any AI agent or contributor working in this repo. This
is the cross-tool standard file (read by Claude Code via `@AGENTS.md` in
`CLAUDE.md`, and directly by Codex, Cursor, Copilot, and others). Read it before
making changes.

Multi-session Claude Code terminal orchestrator built with Electron 42 + React 19
+ TypeScript.

## Build & Run

```bash
npm run dev          # Development with HMR (prefer the `ccc` launcher — see below)
npm run build        # Production build (electron-vite)
npm run typecheck    # tsc --noEmit
npm run test:unit    # vitest
npm run test:e2e     # playwright
npm run test         # both
```

- Prefer the `ccc` launcher for dev — it isolates dev data from prod and cleans
  up all dev processes on exit. See `docs/dev-alongside-prod.md`.

## Architecture

- **Main process** (`src/main/`): Electron main, PTY management (node-pty), IPC handlers, config persistence, statusline, vision MCP server, cloud agents, tokenomics
- **Renderer** (`src/renderer/`): React 19 SPA with Zustand stores, xterm.js terminals, Tailwind CSS v4
- **Preload** (`src/preload/`): IPC bridge - all renderer↔main communication goes through typed channels
- **Shared** (`src/shared/`): Types and IPC channel constants used by both processes

### Key patterns

- IPC handlers are in `src/main/ipc/` - one file per domain (pty, config, logs, etc.)
- Config persistence via `src/main/config-manager.ts` - JSON files in a user-selected resources directory
- Stores in `src/renderer/stores/` - Zustand, hydrated from config on startup
- Terminal rendering via xterm.js with WebGL addon
- SSH sessions use node-pty to spawn ssh.exe, with automated setup scripts for statusline/vision

## Coding Conventions

- No default exports (except React components that are the sole export of their file)
- Tailwind v4 with `@theme` in `src/renderer/styles.css` - no tailwind.config file
- Catppuccin Mocha color palette (base, mantle, crust, surface0-2, overlay0-2, subtext0-1, text, etc.)
- Never import Node.js modules (path, fs, etc.) in renderer - use IPC
- Never use `\u{...}` Unicode escapes in JSX - esbuild doesn't support them. Use `String.fromCodePoint()` or SVG
- PTY writes: only chunk large pastes (>256B). Never queue all writes - causes severe input lag
- xterm.js scrollback: keep at 10000 max. Higher values cause ~1GB RAM per terminal

## Testing

- Unit tests: `vitest` in `tests/unit/`
- E2E tests: Playwright in `tests/e2e/`
- Run `npx vitest run` for fast unit test feedback
- Tests mock Electron APIs - no real PTY/window in unit tests

## Release Process

RC-branch model (adopted with #89): `beta` is never frozen — features merge there continuously; each release stabilizes on its own branch.

- Feature/fix work: branch off `beta`, PR back into `beta` (owner review + green CI required)
- To stabilize a release: cut `release/vX.Y.Z` from `beta`; on that branch bump `package.json` (e.g. `2.0.0-rc.2`), commit `build(release): <version>`, push, then `gh workflow run release.yml --ref release/vX.Y.Z -f channel=beta -f skip_vt=false` and watch it to green
- RC-branch fixes are back-ported to `beta`; features never merge into a release branch
- Prerelease tags: `-beta.N` and `-rc.N` — both ride the beta update channel; rc outranks beta, final outranks rc
- Promote to stable: merge `release/vX.Y.Z` → `main`, run the release workflow from `main` with `channel=stable`, then delete the release branch
- Changelog is generated from `src/renderer/changelog.ts` (single source; also drives the in-app "What's New" modal). Before a release, add the version's entry there, run `npm run changelog` to refresh `CHANGELOG.md`, and commit both. `release.js` already syncs the version line; the release workflow auto-populates the GitHub release notes from the same file (`scripts/gen-changelog.js --notes <version>`) — no hand-pasting. CI (`Changelog in sync`) fails on drift
- Commits/PR titles follow Conventional Commits, enforced by a Husky `commit-msg` hook and the `PR Title` workflow (`commitlint.config.js`)
- **Security-sensitive changes need an adversarial-review PASS before merge is recommended** (ADR-009). Touching IPC/preload, the Conductor MCP server, PTY argv construction, credential/keychain code, the updater's verification path, Electron `webPreferences`, or bumping a *runtime* dependency's major version? Run `/adversarial-review` — independent attacker sub-agents, not a re-read of your own diff. The author never attacks their own change. Docs/styling/changelog-only work is exempt. Unsure → it's required (fail closed). Dismissing a CodeQL/Dependabot alert as a false positive goes through the same pass
- Issue lifecycle: label an issue `in-beta` (don't close it) when its fix merges to `beta`. Closing on promotion to `main` is AUTOMATIC (`.github/workflows/close-in-beta-on-promotion.yml`, #134) and keys off that label — an unlabeled issue is never closed by a promotion, so applying the label is the step that matters. See CONTRIBUTING.md ("Issue lifecycle")
- GitHub Actions builds Windows (.exe) + macOS (.dmg) + Linux (.AppImage, experimental) installers; the release job tags the exact built commit (`--target`) so the in-app updater orders releases correctly
- Linux builds on ubuntu-latest → glibc 2.39 floor (Ubuntu 24.04+/Rocky 10+); older distros need a container build. Vision on Linux requires a deb/rpm Chrome/Chromium (snap confinement blocks the CDP profile dir)
- Never commit secrets, .env files, or personal paths

## Security embargo — read before writing ANY doc about a security finding

**This repository is public. Anything that gets pushed is publication.** If you have found
or been handed an unfixed vulnerability, it does not go into a `CONTEXT.d/` fragment, an
ADR, a commit message, a branch name, the changelog, an issue, or a PR — it goes into a
private GitHub Security Advisory, and the fix is developed in the private fork attached to
that advisory. See `SECURITY.md` ("Embargo") for the rule and
`docs/security-embargo-runbook.md` for the **executable procedure**.

You can do this yourself — you do not need to be the repo owner. Private vulnerability
reporting is enabled, so any account can file the advisory and get a private fork. The
obvious API call is the wrong one: `POST .../security-advisories` needs admin and 403s;
`POST .../security-advisories/reports` is the open one. Do not conclude from that 403 that
you have no private channel (ADR-011).

`CONTEXT.d/` is the trap. The running log *feels* like a scratch notebook and is in fact a
tracked file; a fragment describing a live bug is a disclosure with a repro attached. A
fragment written during an embargo may say *that* a finding exists and was routed
privately — never the component, the mechanism, or the repro. The public record (fragment,
changelog entry, advisory) is written **after** the fix ships, all at once.

## Documentation protocol (CARP)

- **Running log:** add a dated fragment under `CONTEXT.d/` for your work (see `CONTEXT.d/README.md`). `CONTEXT.md` is generated + gitignored — never commit it.
- **Architecture decisions:** add an ADR under `architecture/decisions/` (`YYYY-MM-DD-adr-NNN-title.md`).
- **README / AGENTS.md:** update only on a *structural* change (new subsystem, changed conventions), not per feature.
- Don't add status/summary docs; summarize in the PR. Keep docs at the right scope.

## Deeper references

- `.claude/skills/adversarial-review/SKILL.md` — the adversarial review pass required for security-sensitive changes (ADR-009), plus the path table that decides when it applies.
- `docs/security-embargo-runbook.md` — the executable procedure for an unfixed vulnerability: who can do what, the `gh` recipes, the private-fork workflow, and the traps (ADR-011).
- `docs/agent-conventions.md` — the detailed agent/contributor conventions (hard constraints, IPC channel rules, branching & review).
- `CONTRIBUTING.md` — contributor mechanics, commit-message format, changelog workflow.
- `docs/versioning.md` — versioning scheme, prerelease suffixes, update channels, rolling re-release vs. version bump.
- `architecture/decisions/` — ADRs (the *why* behind architectural/tooling calls).
- `docs/dev-alongside-prod.md`, `docs/USER_GUIDE.md`, `docs/code-signing.md` — operational guides.
