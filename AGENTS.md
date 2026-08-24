# AI Code Conductor — agent & contributor brief

Canonical instructions for any AI agent or contributor working in this repo. This
is the cross-tool standard file (read by Claude Code via `@AGENTS.md` in
`CLAUDE.md`, and directly by Codex, Cursor, Copilot, and others). Read it before
making changes.

Multi-session Claude Code terminal orchestrator built with Electron 42 + React 19
+ TypeScript.

## Session isolation — do this FIRST

Several agents run against this repo simultaneously. **One session = one worktree
= one branch.** Before changing anything, claim your own:

```bash
node scripts/session-guard.mjs claim --base beta   # or: adopt (already in one)
```

Work only in the directory it prints, and prefer `git -C "<that dir>" …` over
relying on the current directory. Never work in the primary checkout or another
session's worktree — their branch can change under you and they may hold
uncommitted work. A `PreToolUse` hook denies writes and mutating git outside the
worktree you own; `CCC_SESSION_GUARD=off` is the escape hatch. See
`docs/session-isolation.md` and ADR-012.

## Ticket creation & premise review — policy

**Every repo change starts from a GitHub issue, and every issue carries a premise
review.** Two standing gates bracket a change: a *premise* review at creation, and
an *adversarial* review before merge (ADR-009). This is the first one.

Before you file an issue — whether you are a human or an agent — state its
**premise** and check it holds:

- **The problem, and the evidence it is real.** Not "X would be nice" but "X is
  broken/absent, here is where (`file:line`), here is what happens." Ground it in
  the code as it is now, not as you remember it.
- **Why it is still open.** This repo moves fast; a surprising amount of proposed
  work is already shipped or half-shipped. Check recent merges before asserting a
  problem exists — a STALE premise is the most common and most wasteful defect.
- **Why now / what it blocks.** Enough for triage to place it on a release line.

An agent that files an issue **must** include a short premise-assessment section in
the body (problem · evidence · still-open · why-now). An issue without one is
incomplete and should be sent back, exactly as a security-sensitive PR without an
adversarial pass would be.

For the existing backlog that predates this policy, the `/LoopReady` skill runs the
premise review in bulk (a cheap Fable fan-out) and labels each ticket
`loop-ready` / `loop-needs-human`; `/StartLoop` re-checks the premise once more
before spending real model budget executing it. See
`.claude/skills/LoopReady/SKILL.md` and `.claude/skills/StartLoop/SKILL.md`. These
are AI Code Conductor-only; they encode this repo's `beta` / session-guard /
ADR-009 / label conventions and are not the aai-core loop skills.

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
- **User-facing surface sweep — required before any release.** The changelog is not the only thing a user reads, and the others have no CI guard, so they drift silently: beta.15 shipped with a README describing features that were never built, and a tips library whose newest entry predated the Agent Canvas, the Feature Guide and pages-as-tabs by two months. For every feature added or changed since the last release, walk this list and either update the surface or record that it needs nothing:
  - `src/renderer/changelog.ts` — What's New + `CHANGELOG.md` (CI-guarded, the only one that is)
  - `src/shared/app-knowledge.ts` — the Feature Guide reference AND what "Ask Conductor" knows; **add a known-issues entry for anything shipping with a live workaround**, so users are not left believing a bug has no fix
  - `src/renderer/tips-library.ts` — a tip for anything discoverable that a user would not find alone; delete tips for removed features
  - the guided tour + Feature Guide cards — a new page or panel that no card mentions is invisible
  - `README.md` — screenshots included; a shot of a superseded UI is worse than none
- Commits/PR titles follow Conventional Commits, enforced by a Husky `commit-msg` hook and the `PR Title` workflow (`commitlint.config.js`)
- **Security-sensitive changes need an adversarial-review PASS before merge is recommended** (ADR-009). Touching IPC/preload, the Conductor MCP server, PTY argv construction, credential/keychain code, the updater's verification path, Electron `webPreferences`, or bumping a *runtime* dependency's major version? Run `/adversarial-review` — independent attacker sub-agents, not a re-read of your own diff. The author never attacks their own change. Docs/styling/changelog-only work is exempt. Unsure → it's required (fail closed). Dismissing a CodeQL/Dependabot alert as a false positive goes through the same pass
- **Required means run it, not offer it.** When the change touches one of those paths, dispatch the pass — do not stop and ask whether to. "It spawns several agents" and "I wrote it so I can't review it" are the reasons the skill exists, not reasons to defer; the author orchestrates and the sub-agents attack. The skill is model-tiered for cost: `fable` scopes the surface and runs a thesis-assertion check, then `opus`/`sonnet` attack only what that narrowed down. Writing security-sensitive code and leaving the gate unrun is the one outcome to avoid
- Issue lifecycle: label an issue `in-beta` (don't close it) when its fix merges to `beta`. When an rc is cut, the milestone's open `in-beta` issues are relabeled `in-release` AUTOMATICALLY (the `roll-rc` job in `release.yml`, `scripts/roll-issues-into-release.mjs`) — the fix is in a cut release candidate, one step past beta. Closing on promotion to `main` is AUTOMATIC too (`.github/workflows/close-in-beta-on-promotion.yml`, #134) and keys off either lifecycle label — an unlabeled issue is never rolled or closed, so applying `in-beta` on the beta merge is the step that matters. See CONTRIBUTING.md ("Issue lifecycle")
- Release-line labels: apply `release-2.1` to any issue/PR on the current 2.1 line — every `in-beta` issue should also carry it so "what ships in 2.1?" stays accurate; apply `release-2.2` to work deferred past 2.1. **Invariant: `in-beta` (or `in-release`) + `release-2.2` on the same issue is a contradiction** — either lifecycle label means the fix already ships in 2.1, so it can't also be deferred. See CONTRIBUTING.md ("Release-line labels")
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

**File it with `node scripts/file-advisory.mjs` (`--dry-run` first). Do not hand-build the
payload and do not call the endpoint directly.** The report needs `vulnerabilities[]` and
`cvss_vector_string`, and omitting either returns a **bodyless `500`, not a `422`** naming the
field — which reads as a GitHub outage and is not one. Read
`docs/security-embargo-runbook.md` BEFORE the first API call, not after it fails: the
procedure is already written down, and re-deriving it from the GitHub docs cost five wasted
attempts and a wrong diagnosis (#207). The script also refuses a description file written
inside the repo, because `CONTEXT.d/` is tracked.

`CONTEXT.d/` is the trap. The running log *feels* like a scratch notebook and is in fact a
tracked file; a fragment describing a live bug is a disclosure with a repro attached. A
fragment written during an embargo may say *that* a finding exists and was routed
privately — never the component, the mechanism, or the repro. The public record (fragment,
changelog entry, advisory) is written **after** the fix ships, all at once.

## Showing visual work — use the Agent Canvas

**Anything the user has to LOOK at goes on the Agent Canvas, not into an HTML
file you tell them to open.** A mockup, a proposed screen, a design comparison,
the built site — invoke the `agent-canvas` skill and `canvas_render` it. They
annotate it in place, anchored to the elements they are pointing at, and you
fetch the notes as one review.

This is written here because it keeps being missed: the file is the artifact,
the canvas is the mechanism, and an agent that has seen `.canvas-scratch/*.html`
in the repo reproduces the artifact and drops the mechanism. Two separate
sessions did exactly that on 2026-08-20.

Two traps worth knowing before you hit them:

- **The canvas serves ONLY this session's configured project folder and the
  worktree CCC set aside for it.** A scratch or temp directory is refused, and
  the standing "put temporary files in the scratchpad" instruction does not
  apply to anything you intend to render. Write it under
  `<your worktree>/.ccc-canvas/`.
- **A render is a handover.** Batch what you know, render once, then stop
  touching that surface until their notes arrive. Rendering again while they are
  annotating means they are marking up something already stale.

## Documentation protocol (CARP)

- **Running log:** add a dated fragment under `CONTEXT.d/` for your work (see `CONTEXT.d/README.md`). `CONTEXT.md` is generated + gitignored — never commit it.
- **Architecture decisions:** add an ADR under `architecture/decisions/` (`YYYY-MM-DD-adr-NNN-title.md`).
- **README / AGENTS.md:** update only on a *structural* change (new subsystem, changed conventions), not per feature.
- Don't add status/summary docs; summarize in the PR. Keep docs at the right scope.

## Deeper references

- `.claude/skills/adversarial-review/SKILL.md` — the adversarial review pass required for security-sensitive changes (ADR-009), plus the path table that decides when it applies.
- `.claude/skills/LoopReady/SKILL.md`, `.claude/skills/StartLoop/SKILL.md` — the model-tiered autonomous-backlog pair (premise-review fan-out → labelled plan → autonomous run to PRs), and `docs/loop-autonomy.md` for the contract a "don't ask" run must respect and the blockers it cannot cross.
- `docs/security-embargo-runbook.md` — the executable procedure for an unfixed vulnerability: who can do what, the `gh` recipes, the private-fork workflow, and the traps (ADR-011).
- `docs/agent-conventions.md` — the detailed agent/contributor conventions (hard constraints, IPC channel rules, branching & review).
- `CONTRIBUTING.md` — contributor mechanics, commit-message format, changelog workflow.
- `docs/versioning.md` — versioning scheme, prerelease suffixes, update channels, rolling re-release vs. version bump.
- `architecture/decisions/` — ADRs (the *why* behind architectural/tooling calls).
- `docs/session-isolation.md` — running parallel agents without collisions (`scripts/session-guard.mjs`, the `PreToolUse` hook, ADR-012).
- `docs/dev-alongside-prod.md`, `docs/USER_GUIDE.md`, `docs/code-signing.md` — operational guides.
