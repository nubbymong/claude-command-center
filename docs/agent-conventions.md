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

## Tests and probes never act on a real home

- **Every vitest run is home-isolated.** `tests/helpers/home-isolation.ts` is the
  first setup file of `vitest.config.ts` and `vitest.native.config.ts` (both run
  in forks): the home variables (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, both CLI
  config-folder overrides, and the XDG folders off Windows) point at a fresh
  folder per worker, re-asserted before every test, and the app's data folder
  (`CCC_E2E_DATA_DIR`) is pinned per test file under the worker's temp folder. The
  guard in `tests/helpers/home-guard-core.mjs` then throws
  `TEST_ISOLATION_VIOLATION`, even when the code under test catches it, for: the
  wrapped fs calls (deletes, moves, writes, creates, write-flag opens and reads, fd
  and FileHandle calls on a real-home file) aimed at a real home; child_process,
  ChildProcess and node-pty spawns whose working folder, child environment (home,
  temp, XDG, git and npm config variables, and the CLI and app
  config-folder variables) or a path written in an argument is in a real home; a
  `cd` / `chdir` / `pushd` (glued forms such as `cd/d`, `cd\` and `cd..`
  included) or PowerShell `Set-Location` / `sl` / `Push-Location` into or above a
  real home, a drive or filesystem root that holds one included, in a shell line
  (exec, `shell: true`, `cmd /c`, `sh -c`, `pwsh -Command`); worker_threads
  Workers other than a toolchain worker (a script in the project's own
  `node_modules`, such as esbuild's, which starts with the guard loaded first and
  no preload in its execArgv); `process.execve`; and `process.binding('fs')`. The
  executable itself is allowed, and so are the running node binary as the command
  word of a hook command written in an argument (never as an operand), a node
  script and the command word (that position only) of a `cmd /c` / `sh -c` line
  inside the real npm or nvm folder. The temp folder, a CI runner's `RUNNER_TEMP`
  (only `<work>/_temp` beside the checkout; a CI step's own home inside it stays
  protected) and the checkout are not real homes. An unlink, rm or rename acts on a
  link itself, so a link into a home as the last component is not refused there.
  Node children load the same guard through NODE_OPTIONS, and a child env that omits
  a home or temp variable gets it filled in.
- **Not covered:** native addons (they write natively); a non-node child beyond
  its environment, working folder and arguments (a native tool that finds the
  profile through the OS, e.g. to expand `~`, reaches the real one); shell
  re-assembly of an argument (quotes or carets inside a word, `%VAR%` / `$VAR`, a
  PowerShell `-EncodedCommand`, a relative path after a `cd` the guard did not
  see); anything started outside these entry points; a refusal inside a toolchain
  worker fails that worker's call but is not recorded in the test. Keep those on
  temporary folders yourself.
- Never loosen the guard to make a test pass: use `os.homedir()` / `os.tmpdir()`
  (already isolated) or mock the code that reaches the real location.
  `originalHomeEnv()` is for locating tools, never for writing.
- **Probes and fake CLIs outside vitest** start with
  `node --import <file URL of tests/helpers/probe-guard.mjs>` and an env from
  `isolatedProbeEnv(root)` (a fresh env with every home variable inside `root`),
  never the inherited `process.env`. On Windows `--import` needs a `file:` URL or
  a `./relative` path. A probe vitest config (`--config`) does not inherit
  `vitest.config.ts`: it must list `tests/helpers/home-isolation.ts` first in its
  `setupFiles` and set `pool: 'forks'`.
- `vitest.live.config.ts` is deliberately not covered (real ssh, real keys).

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
