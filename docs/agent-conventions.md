# Agent & contributor conventions

Working conventions for AI agents and contributors in this repo. Read this
before making changes. It expands on `AGENTS.md` (the canonical, cross-tool agent
brief; `CLAUDE.md` just imports it via `@AGENTS.md`) and complements `README.md`
(what the product is) and `CONTRIBUTING.md` (contributor mechanics).

## Build, run, test

```bash
npm run dev          # dev with HMR (prefer the `ccc` launcher — see below)
npm run build        # production build (electron-vite)
npm run typecheck    # tsc --noEmit (node + web projects)
npm run test:unit    # vitest (fast; run `npx vitest run` for one-shot)
npm run test:e2e     # Playwright
```

- **Run dev via `ccc`** when you can — it isolates dev data from prod and cleans
  up all dev processes on exit. See `docs/dev-alongside-prod.md`.
- Some logging/db tests are **native** (better-sqlite3 built for Electron's ABI):
  `npm run test:unit:native` / `*.native.test.ts`.

## Architecture (where things live)

- **Main** (`src/main/`): Electron main — PTY (node-pty), IPC handlers
  (`src/main/ipc/`, one file per domain), config/session persistence, statusline,
  vision MCP, cloud agents, tokenomics, the forked logging/tokenomics workers.
- **Renderer** (`src/renderer/`): React 19 SPA, Zustand stores
  (`src/renderer/stores/`), xterm.js terminals (WebGL addon), Tailwind v4.
- **Preload** (`src/preload/`): the typed IPC bridge — ALL renderer↔main traffic.
- **Shared** (`src/shared/`): types + IPC channel constants used by both sides.

## Hard constraints (don't violate)

- **Renderer never imports Node** (`path`, `fs`, …) — go through IPC/preload.
- **`src/main/data-paths.ts` stays electron-free** (it runs inside the hooks
  utilityProcess). No `electron` imports; there's a unit test guarding this.
- **IPC channels** are declared once in `src/shared/ipc-channels.ts` and typed in
  both the preload `ElectronAPI` interface and `src/renderer/types/electron.d.ts`.
  Add a channel in all three places.
- **No default exports** except a React component that is the sole export of its
  file.
- **Terminal perf:** xterm scrollback ≤ 10000; only chunk PTY writes > 256B; never
  queue all writes.
- **dev/prod isolation:** new dev-only behavior gates on `!app.isPackaged` and
  must be a no-op when packaged. New long-lived ports must be split dev/prod (see
  `resolveHooksPort` / `resolveConductorMcpPort` / `resolveCdpPort`). See ADR-001.

## Session isolation (parallel agents)

- **One session = one worktree = one branch.** Several agents run against this
  repo at once. Claim your own before you change anything:
  `node scripts/session-guard.mjs claim --base beta` (or `adopt`, if you are
  already in a worktree made for you).
- **Never work in the primary checkout or another session's worktree.** Their
  branch can change under you, and they may hold uncommitted work. A
  `PreToolUse` hook enforces this — writes and mutating git outside the worktree
  you own are denied. `CCC_SESSION_GUARD=off` is the escape hatch.
- Prefer `git -C "<your worktree>" …` over relying on the current directory.
- Before adding commits to an existing PR branch, check
  `git log --oneline origin/<head>..<local-branch>` — a local ref can carry
  unpushed commits that are not part of that PR.
- Full guide: `docs/session-isolation.md`; rationale in ADR-012.

## Branching & review

- Branch off `beta`; PR back into `beta`. `beta` is never frozen; releases
  stabilize on their own `release/vX.Y.Z` branch (see `CONTRIBUTING.md`).
- Protected branches (`beta`/`main`) require a **code-owner (@nubbymong)** review
  — you cannot self-approve. CI (`Test` matrix, Win + macOS) is gated on a
  `ci-run` PR label.
- Commit messages: imperative subject, explain the *why*; end with the
  `Co-Authored-By:` trailer when authored with an assistant.

## Documentation protocol (CARP)

- **Running log:** add a dated fragment under `CONTEXT.d/` for your work (see
  `CONTEXT.d/README.md`). `CONTEXT.md` is generated + gitignored — never commit
  it.
- **Architecture decisions:** add an ADR under `architecture/decisions/`
  (`YYYY-MM-DD-adr-NNN-title.md`).
- **README / AGENTS.md:** update only on a *structural* change (new subsystem,
  changed conventions), not per feature.
- Don't add status/summary docs; summarize in the PR. Keep docs at the right
  scope (root = project-wide; subdir = component-specific).
