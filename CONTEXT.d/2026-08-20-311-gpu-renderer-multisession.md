## 2026-08-20 -- #311 make the GPU (WebGL) renderer multi-session-safe

The opt-in GPU renderer (`gpuRendering`, off by default since #308 / beta.16)
corrupts multi-session use: `@xterm/addon-webgl@0.19` shares one `TextureAtlas`
across every terminal whose render config matches (see `acquireTextureAtlas`),
so a `clearTextureAtlas()` from one terminal empties the shared texture and only
the caller repaints. The other live terminals then render against the emptied
atlas and lose their glyphs until they happen to repaint. This is the beta.16
"characters gone, backgrounds intact" report.

Fix (renderer-only):

- New `terminal/atlasCoordinator.ts`: live WebGL terminals register a `refresh`
  callback; when one rebuilds the shared atlas it calls `notifyCleared`, and
  every OTHER terminal is repainted on the next animation frame. Calls coalesce
  to one pass per frame; a terminal that cleared this frame is skipped (it
  already repainted itself). Process-wide singleton, because the atlas is
  process-global. `createAtlasCoordinator(raf)` is injectable for tests.
- `terminalWebgl.ts`: cap consecutive context-loss recreations
  (`DEFAULT_MAX_RECREATES = 3`). A flapping GPU context (driver reset / Windows
  TDR) previously recreated the addon every frame -- the garbled-glyph / white
  / renderer-crash storm the original report described. After the cap we stay on
  the DOM renderer and repaint the garbled viewport.
- `TerminalView.tsx`: registers each WebGL terminal with the coordinator and
  routes the repainter's `clearAtlas` through `notifyCleared`; unregisters on
  teardown.

Tests: `terminal-atlas-coordinator.test.ts` (5) and new cap cases in
`terminal-webgl-recovery.test.ts` (2). Full suite for the two files: 15 passed;
`tsc --noEmit` clean.

`gpuRendering` stays OFF by default until this is verified on the desktop with
several busy sessions (render-structure behavior cannot be unit-tested). Flip
the default in a follow-up once it holds. Fallback if coordination proves
insufficient: per-terminal atlas isolation via `patch-package` (recorded on the
issue, not implemented).
