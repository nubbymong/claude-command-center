# Copilot Instructions — Claude Command Center

## Project Overview

Claude Command Center is a multi-session Claude Code terminal orchestrator built with Electron 33, React 18, TypeScript, and Tailwind CSS v4. It manages multiple Claude Code CLI sessions in parallel, with features like SSH remoting, vision/browser control, cloud agents, tokenomics tracking, and a memory visualizer.

## Tech Stack

- **Runtime**: Electron 33 (main + renderer + preload)
- **UI**: React 18 with Zustand 5 for state management
- **Styling**: Tailwind CSS v4 with `@theme` directive in `src/renderer/styles.css` (no tailwind.config)
- **Terminal**: xterm.js 5.5 with WebGL addon, node-pty for PTY management
- **Build**: electron-vite, electron-builder for packaging
- **Testing**: Vitest (unit), Playwright (E2E)
- **Color palette**: Catppuccin Mocha — use theme tokens (base, mantle, crust, surface0-2, overlay0-2, subtext0-1, text, blue, green, red, yellow, peach, mauve, teal, etc.)

## Architecture Rules

- All renderer↔main communication goes through IPC channels defined in `src/shared/ipc-channels.ts`
- Never import Node.js modules (fs, path, os, child_process) in renderer code — use the preload bridge
- IPC handlers live in `src/main/ipc/` with one file per domain
- Config is persisted as JSON files via `src/main/config-manager.ts`
- Stores are in `src/renderer/stores/` using Zustand — hydrated from config on startup

## Coding Style

- Use named exports. Default exports only for React components that are the sole export of their file
- Prefer `const` over `let`. No `var`
- Use TypeScript strict mode patterns — avoid `any` where possible
- Keep components focused — if a file exceeds ~400 lines, consider splitting
- Use Catppuccin color tokens in Tailwind classes, not raw hex values
- Inline SVG icons — no icon library dependencies

## Common Gotchas

- esbuild (used by electron-vite) does not support `\u{...}` Unicode escapes in JSX — use `String.fromCodePoint()` or inline SVGs instead
- PTY write chunking: only chunk large writes (>256 bytes, 12ms delay). Never queue all PTY writes — this was tried in v1.2.113 and caused severe input lag
- xterm.js scrollback must stay at 10000 max — higher values cause ~1GB RAM per terminal
- Modal backdrop clicks: never put `onClick={onCancel}` on backdrop divs because Ctrl+C triggers click events
- SSH sessions use base64-encoded setup scripts — comments in the script body break single-lining

## Testing

- Unit tests in `tests/unit/` using Vitest with mocked Electron APIs
- E2E tests in `tests/e2e/` using Playwright
- Run `npx vitest run` for unit tests, `npx playwright test` for E2E
- When adding IPC handlers, add corresponding Zod validation schemas

## Branching Model

- `beta` is the working branch — all features land here first
- `main` is stable-only — updated via reviewed PRs from beta
- Beta releases: `npm run release -- --beta` from beta branch
- Stable releases: merge beta→main, then `npm run release -- --stable --no-bump` from main
