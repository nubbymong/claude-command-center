# Claude Command Center

Multi-session Claude Code terminal orchestrator built with Electron 33 + React 18 + TypeScript.

## Build & Run

```bash
npm run dev          # Development with HMR
npm run build        # Production build (electron-vite)
npm run typecheck    # tsc --noEmit
npm run test:unit    # vitest
npm run test:e2e     # playwright
npm run test         # both
```

## Architecture

- **Main process** (`src/main/`): Electron main, PTY management (node-pty), IPC handlers, config persistence, statusline, vision MCP server, cloud agents, tokenomics
- **Renderer** (`src/renderer/`): React 18 SPA with Zustand stores, xterm.js terminals, Tailwind CSS v4
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

- Work on `beta` branch. Cut beta releases with `npm run release -- --beta`
- Promote to stable: merge beta→main PR, then `npm run release -- --stable --no-bump` from main
- GitHub Actions builds Windows (.exe) + macOS (.dmg) installers
- Never commit secrets, .env files, or personal paths
